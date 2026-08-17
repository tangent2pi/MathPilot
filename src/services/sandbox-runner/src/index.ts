/**
 * sandbox-runner 骨架：沙箱规格的接收与审计占位。
 * 真实隔离（rootless、只读挂载、禁外网、配额）在 WP-05 落地；
 * 骨架只验证 spec 形状并显式声明未隔离，拒绝执行命令。
 */
import { startService, newId } from "@agmath/service-kit";

interface SandboxSpecBody {
  sessionId: string;
  tenantId: string;
  writablePaths?: string[];
  network?: string;
}

startService({
  name: "sandbox-runner",
  port: Number(process.env.PORT ?? 3009),
  register(app) {
    app.post("/sandbox/sessions", async (req, reply) => {
      const body = req.body as SandboxSpecBody;
      if (body.network !== "none") {
        return reply.code(422).send({ error: "network must be 'none'" });
      }
      const allowed = new Set(["/workspace/tmp", "/workspace/output"]);
      for (const p of body.writablePaths ?? []) {
        if (!allowed.has(p)) {
          return reply.code(422).send({ error: `writable path not allowed: ${p}` });
        }
      }
      return reply.code(201).send({
        handle: newId("sbx"),
        isolated: false,
        note: "skeleton: 未启用真实隔离；runCommand 在本骨架中不可用",
      });
    });
    app.post("/sandbox/run", async (_req, reply) =>
      reply.code(501).send({ error: "not_implemented", note: "命令执行仅在真实沙箱隔离落地后开放" }),
    );
  },
});
