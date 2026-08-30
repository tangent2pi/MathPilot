import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth, authenticate, bootstrapAuthUsers, requireRole, AuthError, type Principal } from "./auth.ts";
import { createPool, startService, withTenant } from "./lib.ts";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
const runtimeUrl = process.env.PI_CHAT_RUNTIME_URL ?? "http://127.0.0.1:3105";
const gatewaySecret = process.env.PI_GATEWAY_SECRET ?? "";
const classCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newClassCode(length = 8): string {
  return [...randomBytes(length)].map((value) => classCodeAlphabet[value % classCodeAlphabet.length]).join("");
}

function normalizeClassCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

async function principalOf(request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  try { return await authenticate(pool, request.headers); }
  catch (error) {
    if (error instanceof AuthError) { reply.code(error.status).send({ error: error.message }); return null; }
    throw error;
  }
}

async function relayPi(principal: Principal, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (gatewaySecret.length < 32) return reply.code(503).send({ error: "Pi gateway is not configured" });
  const suffix = request.url.replace(/^\/api\/pi(?=\/|$)/, "") || "/";
  const isEvents = request.method === "GET" && suffix.includes("/events");
  const response = await fetch(`${runtimeUrl}/pi${suffix}`, {
    method: request.method,
    headers: {
      ...(request.headers["content-type"] ? { "content-type": String(request.headers["content-type"]) } : {}),
      "x-tenant-id": principal.tenantId,
      "x-user-id": principal.userId,
      "x-user-roles": principal.roles.join(","),
      "x-mathpilot-gateway-secret": gatewaySecret,
    },
    ...(request.body !== undefined && !["GET", "HEAD"].includes(request.method) ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!isEvents) {
    reply.code(response.status);
    for (const name of ["content-type", "content-disposition", "cache-control", "x-content-type-options"]) {
      const value = response.headers.get(name); if (value) reply.header(name, value);
    }
    return reply.send(Buffer.from(await response.arrayBuffer()));
  }
  reply.hijack();
  reply.raw.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
  });
  if (!response.body) { reply.raw.end(); return; }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  request.raw.on("close", () => stream.destroy());
  stream.on("error", () => reply.raw.end());
  stream.pipe(reply.raw);
}

await bootstrapAuthUsers();

await startService({
  name: "api-next",
  port: Number(process.env.PORT ?? 3101),
  register(app) {
    app.route({
      method: ["GET", "POST"], url: "/api/auth/*",
      async handler(request, reply) {
        const url = new URL(request.url, process.env.BETTER_AUTH_URL ?? "http://localhost:5174");
        const headers = fromNodeHeaders(request.headers);
        headers.delete("content-length");
        const response = await auth.handler(new Request(url, {
          method: request.method, headers,
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        }));
        reply.code(response.status);
        response.headers.forEach((value, key) => { if (key !== "set-cookie") reply.header(key, value); });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        return reply.send(await response.text() || null);
      },
    });

    app.get("/api/me", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      return { uid: principal.uid, user_id: principal.userId, tenant_id: principal.tenantId, roles: principal.roles, via: "better_auth", name: principal.name, email: principal.email };
    });

    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"], url: "/api/pi/*",
      async handler(request, reply) {
        const principal = await principalOf(request, reply); if (!principal) return;
        return relayPi(principal, request, reply);
      },
    });

    app.get("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const avatar = (await pool.query<{ mime_type: string; image_bytes: Buffer; updated_at: Date }>(
        "select mime_type,image_bytes,updated_at from identity_user_avatar where auth_user_id=$1", [principal.authUserId],
      )).rows[0];
      if (!avatar) return reply.code(404).send({ error: "avatar not found" });
      return reply.header("content-type", avatar.mime_type).header("cache-control", "private, max-age=300")
        .header("last-modified", avatar.updated_at.toUTCString()).send(avatar.image_bytes);
    });

    app.post("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const body = request.body as { image_base64?: unknown; mime_type?: unknown };
      const mime = typeof body?.mime_type === "string" ? body.mime_type : "";
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || typeof body?.image_base64 !== "string") return reply.code(422).send({ error: "png, jpeg or webp image required" });
      const bytes = Buffer.from(body.image_base64, "base64");
      if (!bytes.length || bytes.length > 1_572_864) return reply.code(422).send({ error: "avatar must be at most 1.5 MiB" });
      await pool.query(
        `insert into identity_user_avatar(auth_user_id,mime_type,image_bytes) values($1,$2,$3)
         on conflict(auth_user_id) do update set mime_type=excluded.mime_type,image_bytes=excluded.image_bytes,updated_at=now()`,
        [principal.authUserId, mime, bytes],
      );
      return { image: `/api/account/avatar?v=${Date.now()}` };
    });

    app.delete("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      await pool.query("delete from identity_user_avatar where auth_user_id=$1", [principal.authUserId]);
      return reply.code(204).send();
    });

    app.get("/api/classes", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      try { requireRole(principal, "teacher"); } catch (error) { return reply.code((error as AuthError).status).send({ error: (error as Error).message }); }
      const classes = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `select cl.class_id,cl.name,cl.join_code,cl.join_code_updated_at,cl.created_at,count(cm.student_id)::int as student_count
         from identity_class cl left join identity_class_member cm on cm.class_id=cl.class_id
         where $2::boolean or cl.teacher_id=$1 group by cl.class_id order by cl.created_at desc`,
        [principal.userId, principal.roles.includes("tenant_admin")],
      )).rows);
      return { classes };
    });

    app.post("/api/classes", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      try { requireRole(principal, "teacher"); } catch (error) { return reply.code((error as AuthError).status).send({ error: (error as Error).message }); }
      const name = typeof (request.body as { name?: unknown })?.name === "string" ? (request.body as { name: string }).name.trim() : "";
      if (!name || name.length > 80) return reply.code(422).send({ error: "class name must contain 1..80 characters" });
      const classId = `cls_${randomUUID().replaceAll("-", "")}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const row = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
            `insert into identity_class(class_id,tenant_id,name,teacher_id,join_code) values($1,$2,$3,$4,$5)
             returning class_id,name,join_code,join_code_updated_at,created_at`,
            [classId, principal.tenantId, name, principal.userId, newClassCode()],
          )).rows[0]);
          return reply.code(201).send(row);
        } catch (error) { if ((error as { code?: string }).code !== "23505") throw error; }
      }
      return reply.code(503).send({ error: "could not allocate a unique class code" });
    });

    app.post("/api/classes/join", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      if (!principal.roles.includes("student")) return reply.code(403).send({ error: "student role required" });
      const code = normalizeClassCode((request.body as { code?: unknown })?.code);
      if (code.length < 6 || code.length > 12) return reply.code(422).send({ error: "invalid class code" });
      const result = await withTenant(pool, principal.tenantId, async (client) => {
        const classroom = (await client.query(
          `select cl.class_id,cl.name,cl.teacher_id,u.display_name as teacher_name from identity_class cl
           join identity_user u on u.user_id=cl.teacher_id where cl.join_code=$1`, [code],
        )).rows[0];
        if (!classroom) return { status: 404 as const, error: "class code not found" };
        const active = (await client.query(
          `select teacher_id from identity_teacher_student_binding where student_id=$1 and status='active'`, [principal.userId],
        )).rows[0];
        if (active && active.teacher_id !== classroom.teacher_id) return { status: 409 as const, error: "student is already bound to another teacher" };
        await client.query(
          `insert into identity_class_member(tenant_id,class_id,student_id) values($1,$2,$3)
           on conflict(class_id,student_id) do nothing`, [principal.tenantId, classroom.class_id, principal.userId],
        );
        if (!active) await client.query(
          `insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by,payload)
           values($1,$2,$3,$4,'active',$4,$5)`,
          [`bind_${randomUUID().replaceAll("-", "")}`, principal.tenantId, classroom.teacher_id, principal.userId, JSON.stringify({ source: "class_code", class_id: classroom.class_id })],
        );
        return { status: 200 as const, classroom };
      });
      if ("error" in result) return reply.code(result.status).send({ error: result.error });
      return { class: result.classroom };
    });

    app.get("/api/my-class", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const classes = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `select cl.class_id,cl.name,u.display_name as teacher_name,cm.created_at as joined_at
         from identity_class_member cm join identity_class cl on cl.class_id=cm.class_id
         join identity_user u on u.user_id=cl.teacher_id where cm.student_id=$1 order by cm.created_at desc`, [principal.userId],
      )).rows);
      return { classes };
    });

    app.get("/api/my-teacher", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const binding = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `select b.binding_id,b.teacher_id,u.display_name as teacher_name,b.created_at
         from identity_teacher_student_binding b join identity_user u on u.user_id=b.teacher_id
         where b.student_id=$1 and b.status='active'`, [principal.userId],
      )).rows[0]);
      return { binding: binding ?? null };
    });
  },
});
