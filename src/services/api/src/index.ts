/**
 * api 网关：前端唯一入口（OpenAPI 在 WP-05 由契约生成）。
 * WP-03：Better Auth Session + JIT 领域映射（auth.ts）。principal 来自服务端：
 * - 学生角色：student_id/快照查询强制为本人（请求体伪造被覆盖）；
 * - 教师纠正、内容管线、复核裁决要求 teacher 角色；
 * - 客户端 x-tenant-id 头一律忽略，租户来自 Better Auth 领域映射。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { startService, createPool, longFetch, withTenant } from "./lib.ts";
import { auth, authenticate, bootstrapAuthUsers, requireRole, AuthError, type Principal } from "./auth.ts";
import { fromNodeHeaders } from "better-auth/node";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const LEARNING_URL = process.env.LEARNING_URL ?? "http://localhost:3002";
const PROFILE_URL = process.env.PROFILE_URL ?? "http://localhost:3003";
const CONTENT_URL = process.env.CONTENT_URL ?? "http://localhost:3006";
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const PI_GATEWAY_SECRET = process.env.PI_GATEWAY_SECRET ?? "";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");

const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newClassCode(length = 8): string {
  const bytes = randomBytes(length);
  return [...bytes].map((value) => CLASS_CODE_ALPHABET[value % CLASS_CODE_ALPHABET.length]).join("");
}

function normalizeClassCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

async function principalOf(req: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  try {
    return await authenticate(pool, req.headers);
  } catch (err) {
    if (err instanceof AuthError) {
      reply.code(err.status).send({ error: err.message });
      return null;
    }
    throw err;
  }
}

/** 转发超时：下流长任务（模型判答/OCR/抽取）可达 7 分钟；默认 undici headersTimeout=300s 会提前断开 */
const FORWARD_TIMEOUT_MS = 420_000;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDocument(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!columns.length) return "\uFEFF";
  return `\uFEFF${columns.map(csvCell).join(",")}\r\n${rows.map((row) => columns.map((c) => csvCell(row[c])).join(",")).join("\r\n")}\r\n`;
}

async function forward(p: Principal, url: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return longFetch(url, {
    method: init.method ?? "GET",
    headers: {
      // 无 body 的 POST（next/close 等）不得携带 content-type，否则 fastify 报空 JSON body
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      "x-tenant-id": p.tenantId,
      "x-user-id": p.userId,
      "x-user-roles": p.roles.join(","),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }, FORWARD_TIMEOUT_MS);
}

async function relay(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  return reply.code(res.status).send(await res.json());
}

/**
 * Pi 的 HTTP/SSE 协议只允许经此网关到达 runtime。身份来自 Better Auth Cookie，
 * 绝不接受浏览器提交的 tenant/user/role 头；runtime 用这组服务间事实查询线程
 * 映射并执行 RLS/学生-教师绑定校验。
 */
async function relayPiRequest(
  p: Principal,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (PI_GATEWAY_SECRET.length < 32) {
    return reply.code(503).send({ error: "Pi gateway is not configured" });
  }
  const suffix = request.url.replace(/^\/api\/pi(?=\/|$)/, "") || "/";
  const isSse = request.method === "GET" && suffix.includes("/events");
  const accessibleStudentIds = p.roles.includes("teacher")
    ? await withTenant(pool, p.tenantId, async (client) => (await client.query<{ student_id: string }>(
        `select student_id from identity_teacher_student_binding
         where teacher_id=$1 and status='active'
         order by student_id limit 500`,
        [p.userId],
      )).rows.map((row) => row.student_id))
    : [];
  const response = await fetch(`${AGENT_RUNTIME_URL}/pi${suffix}`, {
    method: request.method,
    headers: {
      ...(request.headers["content-type"] ? { "content-type": String(request.headers["content-type"]) } : {}),
      "x-tenant-id": p.tenantId,
      "x-user-id": p.userId,
      "x-user-roles": p.roles.join(","),
      "x-accessible-student-ids": accessibleStudentIds.join(","),
      "x-mathpilot-gateway-secret": PI_GATEWAY_SECRET,
    },
    ...(request.body !== undefined && !["GET", "HEAD"].includes(request.method) ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!isSse) {
    reply.code(response.status);
    for (const name of ["content-type", "content-disposition", "cache-control", "x-content-type-options"]) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(Buffer.from(await response.arrayBuffer()));
  }

  reply.hijack();
  reply.raw.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  if (!response.body) {
    reply.raw.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  request.raw.on("close", () => stream.destroy());
  stream.on("error", () => reply.raw.end());
  stream.pipe(reply.raw);
}

/** 测评轮按当前用户或有效教学绑定校验访问范围。 */
async function assertRunOwner(
  p: Principal,
  reply: FastifyReply,
  runId: string,
): Promise<boolean> {
  const res = await longFetch(`${LEARNING_URL}/assessment-runs/${encodeURIComponent(runId)}`, {
    headers: { "x-tenant-id": p.tenantId },
  }, 30_000).catch(() => null);
  if (!res || !res.ok) {
    reply.code(404).send({ error: "assessment run not found" });
    return false;
  }
  const d = (await res.json()) as { student_id?: string };
  if (!d.student_id || !(await canAccessStudent(p,d.student_id))) {
    reply.code(403).send({ error: "not your assessment run" });
    return false;
  }
  return true;
}

/** 学习会话按当前用户或有效教学绑定校验访问范围。 */
async function assertSessionOwner(
  p: Principal,
  reply: FastifyReply,
  learningUrl: string,
  sessionId: string,
): Promise<boolean> {
  const res = await longFetch(`${learningUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { "x-tenant-id": p.tenantId },
  }, 30_000).catch(() => null);
  if (!res || !res.ok) {
    reply.code(404).send({ error: "session not found" });
    return false;
  }
  const d = (await res.json()) as { student_id?: string };
  if (!d.student_id || !(await canAccessStudent(p,d.student_id))) {
    reply.code(403).send({ error: "not your session" });
    return false;
  }
  return true;
}

async function canAccessStudent(p: Principal, studentId: string): Promise<boolean> {
  if (studentId===p.userId || p.roles.includes("tenant_admin")) return true;
  if (!p.roles.includes("teacher")) return false;
  return withTenant(pool,p.tenantId,async(c)=>(await c.query(
    `select exists(select 1 from identity_teacher_student_binding
      where teacher_id=$1 and student_id=$2 and status='active') as allowed`,[p.userId,studentId])).rows[0]?.allowed===true);
}

async function scopedStudentId(p: Principal,reply: FastifyReply,requested: string): Promise<string|null> {
  const studentId=p.roles.includes("student")&&!p.roles.includes("teacher")?p.userId:requested;
  if(await canAccessStudent(p,studentId))return studentId;
  reply.code(403).send({error:"student is outside your teaching scope"});return null;
}

/** Agent 工作区既可对应正式题目 Session，也可对应 teaching-only 对话。 */
async function assertWorkspaceOwner(p: Principal, reply: FastifyReply, workspaceRef: string): Promise<boolean> {
  const access = await withTenant(pool, p.tenantId, async (c) => {
    const learning = await c.query(
      `select student_id from runtime_question_session where session_id=$1
       union all
       select student_id from runtime_teaching_conversation where conversation_id=$1
       limit 1`,
      [workspaceRef],
    );
    if (learning.rows[0]?.student_id) return {kind:"student" as const,owner:learning.rows[0].student_id as string};
    const content = await c.query(
      `select created_by from content_pipeline_run where ktq_session_ref=$1 or er_session_ref=$1 limit 1`,[workspaceRef]);
    return content.rows[0]?.created_by ? {kind:"content" as const,owner:content.rows[0].created_by as string} : null;
  });
  if (!access) { reply.code(404).send({ error: "agent workspace not found" }); return false; }
  const allowed=access.kind==="student"?await canAccessStudent(p,access.owner):access.owner===p.userId||p.roles.includes("tenant_admin");
  if (!allowed) { reply.code(403).send({ error: "not your agent workspace" }); return false; }
  return true;
}

await bootstrapAuthUsers();

startService({
  name: "api",
  port: Number(process.env.PORT ?? 3001),
  register(app) {
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      async handler(request, reply) {
        const url = new URL(request.url, process.env.BETTER_AUTH_URL ?? "http://localhost:8080");
        const headers = fromNodeHeaders(request.headers);
        headers.delete("content-length");
        const authRequest = new Request(url, {
          method: request.method,
          headers,
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        });
        const response = await auth.handler(authRequest);
        reply.code(response.status);
        response.headers.forEach((value, key) => {
          if (key !== "set-cookie") reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        const text = await response.text();
        return reply.send(text || null);
      },
    });

    app.get("/api/me", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      return { uid: p.uid, user_id: p.userId, tenant_id: p.tenantId, roles: p.roles, via: p.via, name: p.name, email: p.email };
    });

    // assistant-ui/react-pi 的完整 PiClient wire contract。此处刻意不按路由
    // 手写 threads/messages/events：API 网关只做 Cookie→主体转换；agent-runtime
    // 是 Pi 会话、工作区和线程归属映射的唯一执行者。
    app.route({
      method: ["GET", "POST", "PATCH", "DELETE"],
      url: "/api/pi/*",
      async handler(req, reply) {
        const p = await principalOf(req, reply);
        if (!p) return;
        return relayPiRequest(p, req, reply);
      },
    });

    app.get("/api/account/avatar", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const row = (await pool.query(
        "select mime_type,image_bytes,updated_at from identity_user_avatar where auth_user_id=$1",
        [p.authUserId],
      )).rows[0] as { mime_type: string; image_bytes: Buffer; updated_at: Date } | undefined;
      if (!row) return reply.code(404).send({ error: "avatar not found" });
      return reply.header("content-type", row.mime_type).header("cache-control", "private, max-age=300").header("last-modified", row.updated_at.toUTCString()).send(row.image_bytes);
    });

    app.post("/api/account/avatar", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = req.body as { image_base64?: unknown; mime_type?: unknown };
      const mimeType = typeof body?.mime_type === "string" ? body.mime_type : "";
      if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || typeof body?.image_base64 !== "string") {
        return reply.code(422).send({ error: "png, jpeg or webp image required" });
      }
      const bytes = Buffer.from(body.image_base64, "base64");
      if (!bytes.length || bytes.length > 1_572_864) return reply.code(422).send({ error: "avatar must be at most 1.5 MiB" });
      await pool.query(
        `insert into identity_user_avatar(auth_user_id,mime_type,image_bytes)
         values($1,$2,$3) on conflict(auth_user_id) do update
           set mime_type=excluded.mime_type,image_bytes=excluded.image_bytes,updated_at=now()`,
        [p.authUserId, mimeType, bytes],
      );
      return { image: `/api/account/avatar?v=${Date.now()}` };
    });

    app.delete("/api/account/avatar", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      await pool.query("delete from identity_user_avatar where auth_user_id=$1", [p.authUserId]);
      return reply.code(204).send();
    });

    // ── 学习 ────────────────────────────────────────────
    app.post("/api/sessions", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = { ...(req.body as Record<string, unknown>) };
      const studentId=await scopedStudentId(p,reply,typeof body.student_id==="string"?body.student_id:p.userId);if(!studentId)return;body.student_id=studentId;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions`, { method: "POST", body }));
    });

    app.get("/api/sessions/:id", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}`));
    });

    app.get("/api/sessions/:id/agent-trace", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/agent-trace`));
    });

    /** 内容/教学共用的 Pi Session 公开事件；教师可查看当前租户的内容生产 run。 */
    app.get("/api/agent-sessions/:id/events", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${AGENT_RUNTIME_URL}/runtime/sessions/${encodeURIComponent(id)}/events`));
    });

    /** 教师给正在运行的 KTQ/ER Pi Session 排队一条引导，不开放任意任务/工具参数。 */
    app.post("/api/agent-sessions/:id/messages", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { id } = req.params as { id: string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${AGENT_RUNTIME_URL}/runtime/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: req.body }));
    });

    /** Learning Artifact 文件代理：Better Auth + 会话归属后才读取 agent-runtime 的不可变副本。 */
    app.get("/api/sessions/:id/artifacts/:artifactId/*", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id, artifactId, "*": file } = req.params as { id: string; artifactId: string; "*": string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      const safeFile = file.split("/").map(encodeURIComponent).join("/");
      const response = await longFetch(`${AGENT_RUNTIME_URL}/runtime/sessions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/${safeFile}`, {
        headers: { "x-tenant-id": p.tenantId },
      }, 30_000);
      reply.code(response.status);
      for (const name of ["content-type", "cache-control", "content-security-policy", "x-content-type-options"]) {
        const value = response.headers.get(name); if (value) reply.header(name, value);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    });

    app.post("/api/sessions/:id/interact", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/interact`, { method: "POST", body: req.body }));
    });

    app.post("/api/sessions/:id/draft", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/draft`, { method: "POST", body: req.body }));
    });

    app.post("/api/ask", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/ask`, { method: "POST", body: req.body }));
    });

    app.post("/api/teaching-conversations/:id/card-event", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/teaching-conversations/${encodeURIComponent(id)}/card-event`, { method: "POST", body: req.body }));
    });

    /** Cookie 鉴权后的 SSE，只转发公开对话与 Pi 阶段事件。 */
    app.get("/api/sessions/:id/agent-events", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertWorkspaceOwner(p, reply, id))) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      let previous = "";
      req.raw.on("close", () => { closed = true; });
      const started = Date.now();
      while (!closed && Date.now() - started < 120_000) {
        try {
          const trace = await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/agent-trace`);
          if (trace.ok) {
            const data = await trace.json();
            const encoded = JSON.stringify(data);
            if (encoded !== previous) {
              previous = encoded;
              reply.raw.write(`event: trace\ndata: ${encoded}\n\n`);
            } else reply.raw.write(": keepalive\n\n");
          }
        } catch { reply.raw.write(": downstream-unavailable\n\n"); }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!closed) reply.raw.end();
    });

    app.post("/api/sessions/:id/submit", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/submit`, { method: "POST", body: req.body }));
    });

    // ── 自适应测评（§10 / §7.4） ─────────────────────────
    app.post("/api/assessment-runs", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = { ...(req.body as Record<string, unknown>) };
      const studentId=await scopedStudentId(p,reply,typeof body.student_id==="string"?body.student_id:p.userId);if(!studentId)return;body.student_id=studentId;
      return relay(reply, await forward(p, `${LEARNING_URL}/assessment-runs`, { method: "POST", body }));
    });
    app.post("/api/assessment-runs/:id/next", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertRunOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/assessment-runs/${encodeURIComponent(id)}/next`, { method: "POST", body: req.body }));
    });
    app.post("/api/assessment-runs/:id/decide", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertRunOwner(p, reply, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/assessment-runs/${encodeURIComponent(id)}/decide`, { method: "POST", body: req.body }));
    });

    // 跳过探针即闭合（§1.1-10；学生只能操作自己的会话）
    app.post("/api/sessions/:id/probe-skip", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/probe-skip`, { method: "POST" }));
    });

    // 学生主动结束会话（§10.2 终止条件；P1：前端"完成本题"不再只改文字）
    app.post("/api/sessions/:id/close", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/close`, { method: "POST" }));
    });

    // 卡片交互事件（§5.4；学生只能操作自己的会话）
    app.post("/api/sessions/:id/card-event", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/card-event`, { method: "POST", body: req.body }));
    });

    // 错因追问作答（§8.3 消歧追问；学生只能操作自己的会话）
    app.post("/api/sessions/:id/probe", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      if (!(await assertSessionOwner(p, reply, LEARNING_URL, id))) return;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}/probe`, { method: "POST", body: req.body }));
    });

    // ── 画像 ────────────────────────────────────────────
    // 最小画像采集（§3.1）：学生只能填写/查看本人。
    app.put("/api/students/:studentId/profile", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`, { method: "PUT", body: req.body }));
    });
    app.get("/api/students/:studentId/profile", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`));
    });
    app.post("/api/students/:studentId/plans", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/plans`, { method: "POST", body: req.body }));
    });
    app.get("/api/students/:studentId/plans", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/plans`));
    });
    app.get("/api/students/:studentId/projection", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/projection`));
    });
    app.get("/api/students/:studentId/history", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/history`));
    });

    app.get("/api/students/:studentId/evidence", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${LEARNING_URL}/students/${encodeURIComponent(studentId)}/evidence`));
    });

    app.get("/api/snapshots/:studentId", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const requested=(req.params as {studentId:string}).studentId;const studentId=await scopedStudentId(p,reply,requested);if(!studentId)return;
      return relay(reply, await forward(p, `${PROFILE_URL}/snapshots/${encodeURIComponent(studentId)}`));
    });

    app.post("/api/dream/run", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = { ...(req.body as Record<string, unknown>) };
      const studentId=await scopedStudentId(p,reply,typeof body.student_id==="string"?body.student_id:p.userId);if(!studentId)return;body.student_id=studentId;
      return relay(reply, await forward(p, `${PROFILE_URL}/dream/run`, { method: "POST", body }));
    });

    // ── 复核与纠正（教师） ───────────────────────────────
    app.get("/api/review/tasks", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const query = new URLSearchParams(req.query as Record<string, string>).toString();
      return relay(reply, await forward(p, `${REVIEW_URL}/review/tasks${query ? `?${query}` : ""}`));
    });

    app.patch("/api/review/tasks/:id", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { id } = req.params as { id: string };
      const body = { ...(req.body as Record<string, unknown>) };
      body.assignee_id = p.userId;
      const res = await longFetch(`${REVIEW_URL}/review/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-tenant-id": p.tenantId, "x-user-id": p.userId, "x-user-roles": p.roles.join(",") },
        body: JSON.stringify(body),
      }, 60_000);
      return relay(reply, res);
    });

    app.post("/api/review/tasks/bulk", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      return relay(reply, await forward(p, `${REVIEW_URL}/review/tasks/bulk`, { method: "POST", body: req.body }));
    });

    app.post("/api/review/corrections", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const body = { ...(req.body as Record<string, unknown>) };
      body.reviewer_id = p.userId; // 改判责任人以鉴权主体为准
      return relay(reply, await forward(p, `${REVIEW_URL}/review/corrections`, { method: "POST", body }));
    });

    // ── 内容管线（教师） ─────────────────────────────────
    const contentForward = (path: string, method: "POST" | "GET" | "DELETE" = "POST") =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const p = await principalOf(req, reply);
        if (!p) return;
        try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
        const params = req.params as Record<string, string>;
        const resolved = path.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? ""));
        const init = method === "GET" ? {} : { method, ...(req.body !== undefined ? { body: req.body } : {}) };
        return relay(reply, await forward(p, `${CONTENT_URL}${resolved}`, init));
      };

    app.post("/api/content/pipelines", contentForward("/pipelines"));
    app.post("/api/content/pipelines/:id/files", contentForward("/pipelines/:id/files"));
    app.delete("/api/content/pipelines/:id/files/:documentId", contentForward("/pipelines/:id/files/:documentId", "DELETE"));
    app.post("/api/content/pipelines/:id/confirm", contentForward("/pipelines/:id/confirm"));
    app.post("/api/content/pipelines/:id/retry", contentForward("/pipelines/:id/retry"));
    app.post("/api/content/pipelines/:id/dismiss", contentForward("/pipelines/:id/dismiss"));
    app.get("/api/content/pipelines", contentForward("/pipelines", "GET"));
    app.get("/api/content/pipelines/:id", contentForward("/pipelines/:id", "GET"));
    app.post("/api/content/publish", contentForward("/publish"));
    app.get("/api/content/questions/:id/review", contentForward("/questions/:id/review", "GET"));
    app.get("/api/content/entities/:type/:id/review", contentForward("/entities/:type/:id/review", "GET"));
    app.get("/api/content/questions/:id", contentForward("/questions/:id", "GET"));
    app.get("/api/content/questions/:id/diagnosis-context", contentForward("/questions/:id/diagnosis-context", "GET"));
    app.get("/api/content/questions/:id/lineage", contentForward("/questions/:id/lineage", "GET"));
    app.get("/api/content/questions", contentForward("/questions", "GET"));
    app.get("/api/content/library", contentForward("/library", "GET"));
    app.get("/api/content/packages", contentForward("/packages", "GET"));
    app.get("/api/content/packages/:id", contentForward("/packages/:id", "GET"));

    // 学生读已发布题目（P0-3：单题页动态渲染题干；P0-5：创建会话时携带真实包版本）
    app.get("/api/questions/:id", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      return relay(reply, await forward(p, `${CONTENT_URL}/questions/${encodeURIComponent(id)}/student`));
    });

    app.get("/api/questions", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      return relay(reply, await forward(p, `${CONTENT_URL}/questions`));
    });

    app.get("/api/library", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      // KTQRE 全库只提供给教师工作台；教学 Agent 通过服务间身份读取只读快照，
      // 学生浏览器不得取得标准答案、错因规则或测量目标。
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { question_id: questionId } = req.query as { question_id?: string };
      const query = questionId ? `?question_id=${encodeURIComponent(questionId)}` : "";
      return relay(reply, await forward(p, `${CONTENT_URL}/library${query}`));
    });

    /** 教师与学生的当前绑定及历史。一个学生同一时间只绑定一位教师。 */
    app.get("/api/teacher-student-bindings", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      return withTenant(pool, p.tenantId, async (c) => {
        const r = await c.query(
          `select b.binding_id,b.teacher_id,b.student_id,b.status,b.created_at,b.revoked_at,
                  s.display_name as student_name,t.display_name as teacher_name
             from identity_teacher_student_binding b
             join identity_user s on s.user_id=b.student_id join identity_user t on t.user_id=b.teacher_id
            where $2::boolean or b.teacher_id=$1 order by b.created_at desc`,
          [p.userId, p.roles.includes("tenant_admin")],
        );
        return { bindings: r.rows };
      });
    });

    app.post("/api/teacher-student-bindings", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { student_id: requestedStudentId, student_email: studentEmail } = req.body as { student_id?: string; student_email?: string };
      if (!requestedStudentId && !studentEmail?.trim()) return reply.code(422).send({ error: "student email required" });
      const bindingId = `bind_${randomUUID().replaceAll("-", "")}`;
      try {
        const row = await withTenant(pool, p.tenantId, async (c) => {
          const student = requestedStudentId
            ? await c.query("select user_id,roles from identity_user where user_id=$1",[requestedStudentId])
            : await c.query(`select u.user_id,u.roles from identity_user u join "user" a on a.id=u.oidc_sub where lower(a.email)=lower($1)`,[studentEmail!.trim()]);
          if (!student.rows[0]?.roles?.includes("student")) return null;
          const studentId=student.rows[0].user_id as string;
          return (await c.query(
            `insert into identity_teacher_student_binding
               (binding_id,tenant_id,teacher_id,student_id,status,created_by,payload)
             values($1,$2,$3,$4,'active',$3,$5)
             returning binding_id,teacher_id,student_id,status,created_at`,
            [bindingId,p.tenantId,p.userId,studentId,JSON.stringify({source:"teacher_workspace"})],
          )).rows[0];
        });
        if (!row) return reply.code(404).send({ error: "student not found" });
        return reply.code(201).send(row);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "student already has an active teacher" });
        throw error;
      }
    });

    app.delete("/api/teacher-student-bindings/:id", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, p.tenantId, async (c) => {
        const binding = (await c.query(
          `update identity_teacher_student_binding set status='revoked',revoked_by=$2,revoked_at=now()
            where binding_id=$1 and status='active' and ($3::boolean or teacher_id=$2)
            returning binding_id,teacher_id,student_id,status,revoked_at`,
          [id,p.userId,p.roles.includes("tenant_admin")],
        )).rows[0];
        if (binding) {
          await c.query(
            `delete from identity_class_member cm using identity_class cl
              where cm.class_id=cl.class_id and cm.student_id=$1 and cl.teacher_id=$2`,
            [binding.student_id,binding.teacher_id],
          );
        }
        return binding;
      });
      if (!row) return reply.code(404).send({ error: "active binding not found" });
      return row;
    });

    /** 班级是教师组织学生的入口；加入班级时同步建立现有权限模型中的教师绑定。 */
    app.get("/api/classes", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const classes = await withTenant(pool,p.tenantId,async(c)=>(await c.query(
        `select cl.class_id,cl.name,cl.join_code,cl.join_code_updated_at,cl.created_at,
                count(cm.student_id)::int as student_count
           from identity_class cl left join identity_class_member cm on cm.class_id=cl.class_id
          where $2::boolean or cl.teacher_id=$1
          group by cl.class_id order by cl.created_at desc`,
        [p.userId,p.roles.includes("tenant_admin")],
      )).rows);
      return { classes };
    });

    app.post("/api/classes", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const name = typeof (req.body as {name?:unknown})?.name === "string" ? (req.body as {name:string}).name.trim() : "";
      if (!name || name.length > 80) return reply.code(422).send({ error: "class name must contain 1..80 characters" });
      const classId = `cls_${randomUUID().replaceAll("-","")}`;
      for (let attempt=0;attempt<5;attempt++) {
        const code = newClassCode();
        try {
          const row = await withTenant(pool,p.tenantId,async(c)=>(await c.query(
            `insert into identity_class(class_id,tenant_id,name,teacher_id,join_code)
             values($1,$2,$3,$4,$5)
             returning class_id,name,join_code,join_code_updated_at,created_at`,
            [classId,p.tenantId,name,p.userId,code],
          )).rows[0]);
          return reply.code(201).send(row);
        } catch (error) {
          if ((error as {code?:string}).code !== "23505") throw error;
        }
      }
      return reply.code(503).send({ error: "could not allocate a unique class code" });
    });

    app.post("/api/classes/:id/regenerate-code", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const {id}=req.params as {id:string};
      for (let attempt=0;attempt<5;attempt++) {
        try {
          const row=await withTenant(pool,p.tenantId,async(c)=>(await c.query(
            `update identity_class set join_code=$2,join_code_updated_at=now()
              where class_id=$1 and ($4::boolean or teacher_id=$3)
              returning class_id,name,join_code,join_code_updated_at`,
            [id,newClassCode(),p.userId,p.roles.includes("tenant_admin")],
          )).rows[0]);
          if(!row)return reply.code(404).send({error:"class not found"});
          return row;
        } catch(error) {
          if((error as {code?:string}).code!=="23505")throw error;
        }
      }
      return reply.code(503).send({error:"could not allocate a unique class code"});
    });

    app.post("/api/classes/join", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      if (!p.roles.includes("student")) return reply.code(403).send({error:"student role required"});
      const code=normalizeClassCode((req.body as {code?:unknown})?.code);
      if(code.length<6||code.length>12)return reply.code(422).send({error:"invalid class code"});
      const result=await withTenant(pool,p.tenantId,async(c)=>{
        const classroom=(await c.query(
          `select cl.class_id,cl.name,cl.teacher_id,u.display_name as teacher_name
             from identity_class cl join identity_user u on u.user_id=cl.teacher_id
            where cl.join_code=$1`,[code])).rows[0];
        if(!classroom)return {status:404 as const,error:"class code not found"};
        const active=(await c.query(
          `select binding_id,teacher_id from identity_teacher_student_binding
            where student_id=$1 and status='active'`,[p.userId])).rows[0];
        if(active&&active.teacher_id!==classroom.teacher_id)return {status:409 as const,error:"student is already bound to another teacher"};
        await c.query(
          `insert into identity_class_member(tenant_id,class_id,student_id)
           values($1,$2,$3) on conflict(class_id,student_id) do nothing`,
          [p.tenantId,classroom.class_id,p.userId],
        );
        if(!active)await c.query(
          `insert into identity_teacher_student_binding
             (binding_id,tenant_id,teacher_id,student_id,status,created_by,payload)
           values($1,$2,$3,$4,'active',$4,$5)`,
          [`bind_${randomUUID().replaceAll("-","")}`,p.tenantId,classroom.teacher_id,p.userId,
           JSON.stringify({source:"class_code",class_id:classroom.class_id})],
        );
        return {status:200 as const,classroom};
      });
      if("error" in result)return reply.code(result.status).send({error:result.error});
      return {class:result.classroom};
    });

    app.get("/api/my-class", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      const classes=await withTenant(pool,p.tenantId,async(c)=>(await c.query(
        `select cl.class_id,cl.name,u.display_name as teacher_name,cm.created_at as joined_at
           from identity_class_member cm join identity_class cl on cl.class_id=cm.class_id
           join identity_user u on u.user_id=cl.teacher_id
          where cm.student_id=$1 order by cm.created_at desc`,[p.userId])).rows);
      return {classes};
    });

    app.get("/api/my-teacher", async (req, reply) => {
      const p = await principalOf(req, reply); if (!p) return;
      const row = await withTenant(pool,p.tenantId,async(c)=>(await c.query(
        `select b.binding_id,b.teacher_id,u.display_name as teacher_name,b.created_at
           from identity_teacher_student_binding b join identity_user u on u.user_id=b.teacher_id
          where b.student_id=$1 and b.status='active'`,[p.userId])).rows[0]);
      return { binding: row ?? null };
    });

    /** 管理工作台：班级、趋势、包版本与 golden 回归只读聚合。 */
    app.get("/api/admin/overview", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      return withTenant(pool, p.tenantId, async (c) => {
        const admin=p.roles.includes("tenant_admin");
        const classes = await c.query(`select cl.class_id,cl.name,cl.join_code,cl.join_code_updated_at,count(cm.student_id)::int as students
                     from identity_class cl left join identity_class_member cm on cm.class_id=cl.class_id
                    where $2::boolean or cl.teacher_id=$1 group by cl.class_id order by cl.name`,[p.userId,admin]);
        const trends = await c.query(`select o.student_id,o.dimension_id,count(*)::int as observations,
                          count(*) filter(where o.outcome='success')::int as successes,max(o.created_at) as last_observed_at
                     from runtime_state_observation o
                    where $2::boolean or exists(select 1 from identity_teacher_student_binding b
                      where b.teacher_id=$1 and b.student_id=o.student_id and b.status='active')
                    group by o.student_id,o.dimension_id order by last_observed_at desc limit 200`,[p.userId,admin]);
        const packages = await c.query(`select * from (
                    select distinct on(p.package_id) p.package_id,p.chapter_id,p.version,p.manifest_hash,p.published_at,s.visibility
                      from content_chapter_package p join content_entity_scope s on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
                     where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1
                     order by p.package_id,(s.visibility='public') desc
                  ) visible_packages order by published_at desc limit 100`,[p.userId,admin]);
        const golden = await c.query(`select evaluation_id,eval_kind,golden_set,metrics,created_at from review_evaluation_run order by created_at desc limit 100`);
        const students = await c.query(`select u.user_id,u.display_name,p.current_score,p.target_score,
                          (select count(*)::int from runtime_question_session s where s.student_id=u.user_id and s.state='CLOSED') as completed_sessions,
                          (select max(ss.published_at) from state_student_snapshot ss where ss.student_id=u.user_id) as latest_snapshot_at
                     from identity_user u left join state_student_profile p on p.student_id=u.user_id
                    where u.roles @> array['student']::text[] and ($2::boolean or exists(
                      select 1 from identity_teacher_student_binding b where b.teacher_id=$1 and b.student_id=u.user_id and b.status='active'))
                    order by u.display_name`,[p.userId,admin]);
        const pendingReviews = await c.query(
          `select count(*)::int as count from review_review_task r
            where r.status='pending' and ($2::boolean
              or (r.queue='content' and r.payload->>'owner_teacher_id'=$1)
              or (r.queue='student_diagnosis' and exists(select 1 from identity_teacher_student_binding b
                where b.teacher_id=$1 and b.student_id=r.payload->>'student_id' and b.status='active')))`,
          [p.userId,admin],
        );
        const contentStats = await c.query(
          `select count(distinct q.question_id)::int as questions,
                  count(distinct q.question_id) filter(where q.published)::int as published_questions,
                  count(distinct cp.package_id)::int as packages
             from content_entity_scope s
             left join content_question q on s.entity_type='question' and q.question_id=s.entity_id
             left join content_chapter_package cp on s.entity_type='chapter_package' and cp.package_id=s.entity_id
            where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1`,
          [p.userId,admin],
        );
        const learningStats = await c.query(
          `select count(*) filter(where s.state='CLOSED')::int as completed_sessions,
                  count(*) filter(where s.started_at>=date_trunc('week',now()))::int as sessions_this_week
             from runtime_question_session s
            where $2::boolean or exists(select 1 from identity_teacher_student_binding b
              where b.teacher_id=$1 and b.student_id=s.student_id and b.status='active')`,
          [p.userId,admin],
        );
        return { classes: classes.rows, students: students.rows, trends: trends.rows, packages: packages.rows, golden_runs: golden.rows,
          stats: { pending_reviews: pendingReviews.rows[0]?.count ?? 0,
            ...contentStats.rows[0], ...learningStats.rows[0] } };
      });
    });

    app.get("/api/admin/export", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const { format, dataset } = req.query as { format?: string; dataset?: string };
      const data = await withTenant(pool, p.tenantId, async (c) => {
        const admin=p.roles.includes("tenant_admin");
        const knowledge = await c.query(`select distinct c.dimension_id,c.name,c.payload from content_knowledge_component c join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='knowledge_component' and s.entity_id=c.dimension_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by c.dimension_id`,[p.userId,admin]);
        const questionTypes = await c.query(`select distinct c.dimension_id,c.name,c.payload from content_question_type c join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='question_type' and s.entity_id=c.dimension_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by c.dimension_id`,[p.userId,admin]);
        const errorCauses = await c.query(`select distinct c.dimension_id,c.name,c.payload from content_error_cause c join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='error_cause' and s.entity_id=c.dimension_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by c.dimension_id`,[p.userId,admin]);
        const questions = await c.query(`select distinct on(q.question_id) q.payload from content_question q join content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by q.question_id`,[p.userId,admin]);
        const diagnosisRules = await c.query(`select distinct r.rule_id,r.payload from content_diagnosis_rule r join content_entity_scope s on s.tenant_id=r.tenant_id and s.entity_type='diagnosis_rule' and s.entity_id=r.rule_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by r.rule_id`,[p.userId,admin]);
        const studentCases = await c.query(`select u.user_id,u.display_name,p.payload as profile,
                          (select jsonb_agg(s.payload order by s.started_at) from runtime_question_session s where s.student_id=u.user_id) as sessions,
                          (select ss.payload from state_student_snapshot ss where ss.student_id=u.user_id order by ss.published_at desc limit 1) as snapshot,
                          (select lp.payload from state_learning_plan lp where lp.student_id=u.user_id order by lp.created_at desc limit 1) as plan
                     from identity_user u left join state_student_profile p on p.student_id=u.user_id
                    where u.roles @> array['student']::text[] and ($2::boolean or exists(select 1 from identity_teacher_student_binding b where b.teacher_id=$1 and b.student_id=u.user_id and b.status='active')) order by u.user_id`,[p.userId,admin]);
        const lineage = await c.query(`select distinct l.entity_type,l.entity_id,l.field_path,l.provenance_status,l.derivation_type,l.source_fragment_id,l.agent_run_id,l.prompt_version,l.model_id,l.reviewer_id,l.review_decision,l.confidence,l.created_at from content_field_lineage l join content_entity_scope s on s.tenant_id=l.tenant_id and s.entity_type=l.entity_type and s.entity_id=l.entity_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by l.created_at`,[p.userId,admin]);
        const packages = await c.query(`select distinct on(p.package_id) p.payload from content_chapter_package p join content_entity_scope s on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id where $2::boolean or s.visibility='public' or s.owner_teacher_id=$1 order by p.package_id,p.published_at`,[p.userId,admin]);
        return { schema: "mathpilot.content-export/v1", exported_at: new Date().toISOString(), tenant_id: p.tenantId,
          knowledge_points: knowledge.rows, question_types: questionTypes.rows, error_causes: errorCauses.rows,
          questions: questions.rows.map((r) => r.payload), diagnosis_rules: diagnosisRules.rows,
          student_cases: studentCases.rows, field_lineage: lineage.rows,
          packages: packages.rows.map((r) => r.payload) };
      });
      if (format === "csv") {
        const aliases: Record<string, keyof typeof data> = {
          knowledge_points: "knowledge_points", question_types: "question_types", error_causes: "error_causes",
          questions: "questions", diagnosis_rules: "diagnosis_rules", student_cases: "student_cases", field_lineage: "field_lineage",
        };
        const key = aliases[dataset ?? ""];
        if (!key) return reply.code(422).send({ error: "dataset must be knowledge_points|question_types|error_causes|questions|diagnosis_rules|student_cases|field_lineage" });
        const rows = data[key];
        if (!Array.isArray(rows)) return reply.code(422).send({ error: "dataset is not tabular" });
        reply.type("text/csv; charset=utf-8");
        reply.header("content-disposition", `attachment; filename=${dataset}.csv`);
        return csvDocument(rows as Record<string, unknown>[]);
      }
      reply.header("content-disposition", `attachment; filename=mathpilot-${p.tenantId}.json`);
      return data;
    });
  },
});
