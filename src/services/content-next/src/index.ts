import { configureInternalService } from "@mathpilot/internal-service";
import { internalServiceGuard } from "@mathpilot/internal-service/fastify";
import multipart from "@fastify/multipart";
import { CandidateRepository } from "./candidate-repository.ts";
import { dispatchAutoPrivateApprovals, dispatchErCommands, dispatchKtqCommands, dispatchReviewFeedbackCommands } from "./command-dispatch.ts";
import { createPool, startService } from "./lib.ts";
import { registerOcrRoutes } from "./ocr-routes.ts";
import { registerPaperAnswerRoutes } from "./paper-answer-routes.ts";
import { registerPaperExportRoutes } from "./paper-export.ts";
import { PaperRepository } from "./paper-repository.ts";
import { registerPaperRoutes } from "./paper-routes.ts";
import { registerContentNextRoutes } from "./routes.ts";
import { registerTeacherChatRoutes } from "./teacher-chat-routes.ts";

// Configuration is resolved before opening the database pool, registering the
// poller, or listening. A missing edge keyring/target therefore fails startup.
const internalService = configureInternalService("content-next", process.env);
const pool = createPool();
const repository = new CandidateRepository(pool);
const paperRepository = new PaperRepository(pool);

const app = await startService({
  name: "content-next",
  port: Number(process.env.PORT ?? 3016),
  register(server) {
    const fromApi = internalServiceGuard(internalService, ["api-to-content"]);
    server.register(multipart, { limits: { fileSize: 40 * 1024 * 1024, files: 1 } });
    registerContentNextRoutes(server, repository, internalService);
    registerPaperRoutes(server, paperRepository, internalService);
    registerPaperExportRoutes(server, paperRepository, pool, internalService);
    registerPaperAnswerRoutes(server, paperRepository, pool, internalService);
    registerOcrRoutes(server, pool, internalService);
    registerTeacherChatRoutes(server, repository, internalService, fromApi);

    const shutdown = new AbortController();
    let polling: Promise<void> | null = null;
    const pollHostCommands = (): Promise<void> => {
      if (polling) return polling;
      polling = Promise.all([
        dispatchErCommands(repository, internalService, server.log, shutdown.signal),
        dispatchKtqCommands(repository, internalService, server.log, shutdown.signal),
        dispatchReviewFeedbackCommands(repository, internalService, server.log, shutdown.signal),
        dispatchAutoPrivateApprovals(repository, server.log, shutdown.signal),
      ]).then(() => undefined).finally(() => { polling = null; });
      return polling;
    };
    const timer = setInterval(() => void pollHostCommands(), 5_000);
    timer.unref();
    void pollHostCommands();
    server.addHook("onClose", async () => {
      clearInterval(timer);
      shutdown.abort();
      await polling;
      await pool.end();
    });
  },
});

void app;
