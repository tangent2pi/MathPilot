import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth, authenticate, bootstrapAuthUsers, requireRole, AuthError, type Principal } from "./auth.ts";
import { createPool, startService, withTenant } from "./lib.ts";
import { reviseSelectionIntent, SelectionCommandError } from "./learning-selection.ts";
import { registerLearningHttp } from "./learning-http.ts";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
const runtimeUrl = process.env.PI_CHAT_RUNTIME_URL ?? "http://127.0.0.1:3105";
const gatewaySecret = process.env.PI_GATEWAY_SECRET ?? "";
const contentNextUrl = (process.env.CONTENT_NEXT_URL ?? "http://127.0.0.1:3016").replace(/\/$/, "");
const contentNextSecret = process.env.CONTENT_NEXT_SECRET ?? gatewaySecret;
const storageNextUrl = (process.env.STORAGE_NEXT_URL ?? "http://127.0.0.1:3017").replace(/\/$/, "");
const storageNextSecret = process.env.STORAGE_NEXT_SECRET ?? gatewaySecret;
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

async function relayContent(principal: Principal, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (contentNextSecret.length < 32) return reply.code(503).send({ error: "content-next is not configured" });
  const suffix = request.url.replace(/^\/api\/content(?=\/|$)/, "") || "/";
  const response = await fetch(`${contentNextUrl}${suffix}`, {
    method: request.method,
    headers: {
      ...(request.headers["content-type"] ? { "content-type": String(request.headers["content-type"]) } : {}),
      "x-tenant-id": principal.tenantId,
      "x-user-id": principal.userId,
      "x-user-roles": principal.roles.join(","),
      "x-mathpilot-runtime-secret": contentNextSecret,
    },
    ...(request.body !== undefined && !["GET", "HEAD"].includes(request.method) ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  reply.code(response.status);
  for (const name of ["content-type", "content-disposition", "cache-control", "x-content-type-options"]) {
    const value = response.headers.get(name); if (value) reply.header(name, value);
  }
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

async function relayStorage(principal: Principal, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (storageNextSecret.length < 32) return reply.code(503).send({ error: "storage-next is not configured" });
  const suffix = request.url.replace(/^\/api\/storage(?=\/|$)/, "") || "/";
  const response = await fetch(`${storageNextUrl}/internal${suffix}`, {
    method: request.method,
    headers: {
      ...(request.headers["content-type"] ? { "content-type": String(request.headers["content-type"]) } : {}),
      "x-tenant-id": principal.tenantId,
      "x-user-id": principal.userId,
      "x-user-roles": principal.roles.join(","),
      "x-mathpilot-runtime-secret": storageNextSecret,
    },
    ...(request.body !== undefined && !["GET", "HEAD"].includes(request.method) ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  reply.code(response.status);
  for (const name of ["content-type", "content-disposition", "cache-control", "x-content-type-options"]) {
    const value = response.headers.get(name); if (value) reply.header(name, value);
  }
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

await bootstrapAuthUsers();

await startService({
  name: "api-next",
  port: Number(process.env.PORT ?? 3101),
  register(app) {
    registerLearningHttp(app, pool, principalOf);

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

    app.post("/api/learning/selection-intents", async (request, reply) => {
      const principal = await principalOf(request,reply); if (!principal) return;
      try {
        const result = await reviseSelectionIntent(pool,principal,request.body);
        return reply.code(result.created ? 202 : 200).send(result);
      } catch (error) {
        if (error instanceof SelectionCommandError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    });

    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"], url: "/api/pi/*",
      async handler(request, reply) {
        const principal = await principalOf(request, reply); if (!principal) return;
        return relayPi(principal, request, reply);
      },
    });

    // The browser talks to the same-origin API.  Only api-next turns the
    // authenticated session into the trusted principal headers understood by
    // the isolated content-next service.
    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"], url: "/api/content/*",
      async handler(request, reply) {
        const principal = await principalOf(request, reply); if (!principal) return;
        return relayContent(principal, request, reply);
      },
    });

    // Storage management stays behind the authenticated same-origin API. The
    // returned presigned URL is the only value the browser sends to MinIO.
    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"], url: "/api/storage/*",
      async handler(request, reply) {
        const principal = await principalOf(request, reply); if (!principal) return;
        return relayStorage(principal, request, reply);
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
        `select cl.class_id,cl.name,cl.join_code,cl.join_code_updated_at,cl.created_at,
                cl.created_by_user_id,cl.allow_official_content,cl.status,
                count(distinct students.user_id)::int as student_count
           from identity_class cl
           join identity_class_user mine
             on mine.tenant_id=cl.tenant_id and mine.class_id=cl.class_id
            and mine.user_id=$1 and mine.class_role='teacher' and mine.status='active'
           left join identity_class_user students
             on students.tenant_id=cl.tenant_id and students.class_id=cl.class_id
            and students.class_role='student' and students.status='active'
          where cl.tenant_id=$2 and cl.status='active'
          group by cl.class_id order by cl.created_at desc`,
        [principal.userId, principal.tenantId],
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
          const row = await withTenant(pool, principal.tenantId, async (client) => {
            const created = (await client.query(
              `insert into identity_class(class_id,tenant_id,name,teacher_id,created_by_user_id,join_code)
               values($1,$2,$3,$4,$4,$5)
               returning class_id,name,join_code,join_code_updated_at,created_at,created_by_user_id,allow_official_content,status`,
              [classId, principal.tenantId, name, principal.userId, newClassCode()],
            )).rows[0];
            await client.query(
              `insert into identity_class_user(tenant_id,class_id,user_id,class_role,status,added_by_user_id)
               values($1,$2,$3,'teacher','active',$3)`,
              [principal.tenantId, classId, principal.userId],
            );
            return created;
          });
          return reply.code(201).send(row);
        } catch (error) { if ((error as { code?: string }).code !== "23505") throw error; }
      }
      return reply.code(503).send({ error: "could not allocate a unique class code" });
    });

    app.patch("/api/classes/:classId", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      try { requireRole(principal, "teacher"); } catch (error) { return reply.code((error as AuthError).status).send({ error: (error as Error).message }); }
      const { allow_official_content: allowOfficialContent } = (request.body ?? {}) as { allow_official_content?: unknown };
      if (typeof allowOfficialContent !== "boolean") return reply.code(422).send({ error: "allow_official_content must be boolean" });
      const classId = (request.params as { classId: string }).classId;
      const classroom = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `update identity_class cl
            set allow_official_content=$3,updated_at=now()
          where cl.tenant_id=$1 and cl.class_id=$2 and cl.status='active'
            and exists (
              select 1 from identity_class_user cu
               where cu.tenant_id=cl.tenant_id and cu.class_id=cl.class_id
                 and cu.user_id=$4 and cu.class_role='teacher' and cu.status='active'
            )
        returning cl.class_id,cl.name,cl.allow_official_content,cl.status,cl.updated_at`,
        [principal.tenantId, classId, allowOfficialContent, principal.userId],
      )).rows[0]);
      return classroom ? classroom : reply.code(404).send({ error: "class not found" });
    });

    app.post("/api/classes/join", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      if (!principal.roles.includes("student")) return reply.code(403).send({ error: "student role required" });
      const code = normalizeClassCode((request.body as { code?: unknown })?.code);
      if (code.length < 6 || code.length > 12) return reply.code(422).send({ error: "invalid class code" });
      const result = await withTenant(pool, principal.tenantId, async (client) => {
        const classroom = (await client.query(
          `select cl.class_id,cl.name,cl.allow_official_content,
                  cl.created_by_user_id as teacher_id,
                  u.display_name as teacher_name
             from identity_class cl
             join identity_user u on u.user_id=cl.created_by_user_id
            where cl.tenant_id=$1 and cl.join_code=$2 and cl.status='active'`, [principal.tenantId, code],
        )).rows[0];
        if (!classroom) return { status: 404 as const, error: "class code not found" };
        await client.query(
          `insert into identity_class_user(tenant_id,class_id,user_id,class_role,status,added_by_user_id)
           values($1,$2,$3,'student','active',$3)
           on conflict (class_id,user_id) do update set status='active'
             where identity_class_user.class_role='student'`, [principal.tenantId, classroom.class_id, principal.userId],
        );
        return { status: 200 as const, classroom };
      });
      if ("error" in result) return reply.code(result.status).send({ error: result.error });
      return { class: result.classroom };
    });

    app.get("/api/my-class", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const classes = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `select cl.class_id,cl.name,cl.allow_official_content,
                cl.created_by_user_id as teacher_id,
                u.display_name as teacher_name,cu.joined_at
           from identity_class_user cu
           join identity_class cl on cl.class_id=cu.class_id and cl.tenant_id=cu.tenant_id
           join identity_user u on u.user_id=cl.created_by_user_id
          where cu.tenant_id=$1 and cu.user_id=$2 and cu.class_role='student'
            and cu.status='active' and cl.status='active'
          order by cu.joined_at desc`, [principal.tenantId, principal.userId],
      )).rows);
      return { classes };
    });

    app.get("/api/my-teacher", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const teachers = await withTenant(pool, principal.tenantId, async (client) => (await client.query(
        `select t.user_id as teacher_id,t.display_name as teacher_name,
                count(distinct cu.class_id)::int as class_count,
                min(cu.joined_at) as first_joined_at
           from identity_class_user mine
           join identity_class_user cu
             on cu.tenant_id=mine.tenant_id and cu.class_id=mine.class_id
            and cu.class_role='teacher' and cu.status='active'
           join identity_user t on t.user_id=cu.user_id
           join identity_class cl on cl.class_id=mine.class_id and cl.tenant_id=mine.tenant_id
          where mine.tenant_id=$1 and mine.user_id=$2 and mine.class_role='student'
            and mine.status='active' and cl.status='active'
          group by t.user_id,t.display_name order by min(cu.joined_at)`, [principal.tenantId, principal.userId],
      )).rows);
      return { teachers };
    });
  },
});
