import { randomBytes, randomUUID } from "node:crypto";
import { canonicalObjectReference, storageObjectIdSchema, storageObjectResolveResponseSchema } from "@mathpilot/content-integrity";
import { configureInternalService } from "@mathpilot/internal-service";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth, authenticate, bootstrapAuthUsers, requireRole, AuthError, type Principal } from "./auth.ts";
import { relayContent, relayStorage } from "./internal-relay.ts";
import { createPool, startService, withPrincipal, withTenant } from "./lib.ts";
import { registerLearningHttp } from "./learning-http.ts";

const internalService = configureInternalService("api-next", process.env);
const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
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

    // The browser talks to the same-origin API. Only api-next turns the
    // authenticated session into a short-lived, request-bound assertion for
    // the isolated content-next service.
    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"], url: "/api/content/*",
      async handler(request, reply) {
        const principal = await principalOf(request, reply); if (!principal) return;
        return relayContent(internalService, principal, request, reply);
      },
    });

    // Storage management stays behind the authenticated same-origin API. The
    // returned presigned URL is the only value the browser sends to MinIO.
    const storageRelay = async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await principalOf(request,reply); if (!principal) return;
      return relayStorage(internalService,principal,request,reply);
    };
    app.post("/api/storage/objects/init",storageRelay);
    app.post("/api/storage/objects/:id/complete",storageRelay);
    app.post("/api/storage/objects/resolve",storageRelay);
    app.delete("/api/storage/objects/:id",storageRelay);

    app.get("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const avatar = await withPrincipal(pool,principal,async (client) => (await client.query<{
        storage_object_id:string; updated_at:Date;
      }>("select storage_object_id,updated_at from identity_user_avatar where auth_user_id=$1",[principal.authUserId])).rows[0]);
      if (!avatar) return reply.code(404).send({ error: "avatar not found" });
      const body={ object_refs:[canonicalObjectReference(avatar.storage_object_id)] };
      const resolved=await internalService.request("api-to-storage",principal,"/internal/objects/resolve",{
        method:"POST",json:body,timeoutMs:10_000,signal:AbortSignal.timeout(10_000),
      });
      if (!resolved.ok) return reply.code(resolved.status===404?404:502).send({ error:"avatar unavailable" });
      const object=storageObjectResolveResponseSchema.parse(await resolved.json()).objects[0];
      if (!object) return reply.code(404).send({ error:"avatar not found" });
      return reply.code(302).header("location",object.download.url)
        .header("cache-control","private, max-age=240")
        .header("last-modified",avatar.updated_at.toUTCString()).send();
    });

    app.post("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      const objectId=storageObjectIdSchema.safeParse((request.body as { object_id?:unknown } | undefined)?.object_id);
      if (!objectId.success) return reply.code(422).send({ error:"completed avatar object required" });
      await withPrincipal(pool,principal,(client) => client.query(
        "select * from mathpilot_identity_set_avatar($1,$2,$3,$4)",
        [principal.tenantId,principal.userId,principal.authUserId,objectId.data],
      ));
      return { image: `/api/account/avatar?v=${Date.now()}` };
    });

    app.delete("/api/account/avatar", async (request, reply) => {
      const principal = await principalOf(request, reply); if (!principal) return;
      await withPrincipal(pool,principal,(client) => client.query(
        "select mathpilot_identity_remove_avatar($1,$2,$3)",
        [principal.tenantId,principal.userId,principal.authUserId],
      ));
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
