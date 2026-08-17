/**
 * agent-runtime 骨架：Pi SDK/RPC 适配与 Session 编排的接入点。
 * 真实编排（工作区挂载、AGENTS.md 编译、沙箱）在 WP-05 落地；
 * 骨架仅暴露编排占位与能力声明。
 */
import { startService } from "@agmath/service-kit";

startService({
  name: "agent-runtime",
  port: Number(process.env.PORT ?? 3005),
  register(app) {
    app.get("/capabilities", async () => ({
      harness: "pi-planned",
      sessionIsolation: "per-question",
      tools: ["bash", "search"],
      status: "skeleton",
    }));
    app.post("/runtime/sessions", async (_req, reply) =>
      reply.code(501).send({
        error: "not_implemented",
        note: "Pi 编排与工作区编译在 WP-05 落地；先经 learning-service 走骨架流程",
      }),
    );
  },
});
