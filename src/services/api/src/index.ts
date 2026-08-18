/**
 * api 网关：前端唯一入口（OpenAPI 在 WP-05 由契约生成）。
 * WP-03：OIDC 验签 + JIT 映射（auth.ts）。OIDC 路径下 principal 来自服务端：
 * - 学生角色：student_id/快照查询强制为本人（请求体伪造被覆盖）；
 * - 教师纠正、内容管线、复核裁决要求 teacher 角色；
 * - 客户端 x-tenant-id 头在 OIDC 路径一律忽略。
 * dev fallback（无 Authorization + AUTH_DEV_FALLBACK=true）保留流程验证直通。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { startService, createPool, longFetch } from "./lib.ts";
import { authenticate, requireRole, AuthError, type Principal } from "./auth.ts";

const LEARNING_URL = process.env.LEARNING_URL ?? "http://localhost:3002";
const PROFILE_URL = process.env.PROFILE_URL ?? "http://localhost:3003";
const CONTENT_URL = process.env.CONTENT_URL ?? "http://localhost:3006";
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");

async function principalOf(req: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  try {
    const p = await authenticate(pool, req.headers.authorization);
    // dev 直通保留旧行为：信任 x-tenant-id 头（生产 AUTH_DEV_FALLBACK=false 时无此路径）
    if (p.via === "dev_fallback") {
      const t = req.headers["x-tenant-id"];
      if (typeof t === "string" && t.length > 0) p.tenantId = t;
    }
    return p;
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

async function forward(p: Principal, url: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return longFetch(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": p.tenantId,
      "x-user-id": p.userId,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }, FORWARD_TIMEOUT_MS);
}

async function relay(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  return reply.code(res.status).send(await res.json());
}

/** 学生只能操作本人会话（D.5：OIDC 路径强制归属校验；教师可代查） */
async function assertSessionOwner(
  p: Principal,
  reply: FastifyReply,
  learningUrl: string,
  sessionId: string,
): Promise<boolean> {
  if (p.via !== "oidc" || p.roles.includes("teacher")) return true;
  const res = await longFetch(`${learningUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { "x-tenant-id": p.tenantId },
  }, 30_000).catch(() => null);
  if (!res || !res.ok) {
    reply.code(404).send({ error: "session not found" });
    return false;
  }
  const d = (await res.json()) as { student_id?: string };
  if (d.student_id !== p.userId) {
    reply.code(403).send({ error: "not your session" });
    return false;
  }
  return true;
}

startService({
  name: "api",
  port: Number(process.env.PORT ?? 3001),
  register(app) {
    app.get("/api/me", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      return { user_id: p.userId, tenant_id: p.tenantId, roles: p.roles, via: p.via };
    });

    // ── 学习 ────────────────────────────────────────────
    app.post("/api/sessions", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = { ...(req.body as Record<string, unknown>) };
      // 学生只能为自己开 Session；教师可代查（OIDC 路径强制，dev 直通信任请求体）
      if (p.via === "oidc" && !p.roles.includes("teacher")) body.student_id = p.userId;
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions`, { method: "POST", body }));
    });

    app.get("/api/sessions/:id", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      return relay(reply, await forward(p, `${LEARNING_URL}/sessions/${encodeURIComponent(id)}`));
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
      if (p.via === "oidc" && !p.roles.includes("teacher")) body.student_id = p.userId;
      return relay(reply, await forward(p, `${LEARNING_URL}/assessment-runs`, { method: "POST", body }));
    });
    app.post("/api/assessment-runs/:id/next", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
      return relay(reply, await forward(p, `${LEARNING_URL}/assessment-runs/${encodeURIComponent(id)}/next`, { method: "POST", body: req.body }));
    });
    app.post("/api/assessment-runs/:id/decide", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const { id } = req.params as { id: string };
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
    // 最小画像采集（§3.1）：学生只能填写/查看本人（OIDC 强制自域）
    app.put("/api/students/:studentId/profile", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`, { method: "PUT", body: req.body }));
    });
    app.get("/api/students/:studentId/profile", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`));
    });
    app.post("/api/students/:studentId/plans", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/plans`, { method: "POST", body: req.body }));
    });
    app.get("/api/students/:studentId/plans", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/plans`));
    });
    app.get("/api/students/:studentId/projection", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/students/${encodeURIComponent(studentId)}/projection`));
    });

    app.get("/api/snapshots/:studentId", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      let { studentId } = req.params as { studentId: string };
      if (p.via === "oidc" && !p.roles.includes("teacher")) studentId = p.userId;
      return relay(reply, await forward(p, `${PROFILE_URL}/snapshots/${encodeURIComponent(studentId)}`));
    });

    app.post("/api/dream/run", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      const body = { ...(req.body as Record<string, unknown>) };
      if (p.via === "oidc" && !p.roles.includes("teacher")) body.student_id = p.userId;
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
      if (p.via === "oidc") body.assignee_id = p.userId;
      const res = await longFetch(`${REVIEW_URL}/review/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-tenant-id": p.tenantId, "x-user-id": p.userId },
        body: JSON.stringify(body),
      }, 60_000);
      return relay(reply, res);
    });

    app.post("/api/review/corrections", async (req, reply) => {
      const p = await principalOf(req, reply);
      if (!p) return;
      try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
      const body = { ...(req.body as Record<string, unknown>) };
      if (p.via === "oidc") body.reviewer_id = p.userId; // 改判责任人以鉴权主体为准
      return relay(reply, await forward(p, `${REVIEW_URL}/review/corrections`, { method: "POST", body }));
    });

    // ── 内容管线（教师） ─────────────────────────────────
    const contentForward = (path: string, method: "POST" | "GET" = "POST") =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const p = await principalOf(req, reply);
        if (!p) return;
        try { requireRole(p, "teacher"); } catch (e) { return reply.code((e as AuthError).status).send({ error: (e as Error).message }); }
        const params = req.params as Record<string, string>;
        const resolved = path.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? ""));
        return relay(reply, await forward(p, `${CONTENT_URL}${resolved}`,
          method === "POST" ? { method, body: req.body } : {}));
      };

    app.post("/api/content/documents", contentForward("/documents"));
    app.post("/api/content/documents/ocr", contentForward("/documents/ocr"));
    app.post("/api/content/ktq/run", contentForward("/ktq/run"));
    app.post("/api/content/er/run", contentForward("/er/run"));
    app.post("/api/content/publish", contentForward("/publish"));
    app.get("/api/content/questions/:id", contentForward("/questions/:id", "GET"));
    app.get("/api/content/questions/:id/lineage", contentForward("/questions/:id/lineage", "GET"));
  },
});
