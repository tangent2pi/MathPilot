import { configureInternalService } from "@mathpilot/internal-service";
import { startFastifyService } from "@mathpilot/internal-service/fastify";
import { CandidateRepository } from "./candidate-repository.ts";
import { dispatchErCommands, dispatchReviewFeedbackCommands } from "./command-dispatch.ts";
import { createPool } from "./lib.ts";
import { registerContentNextRoutes } from "./routes.ts";

// Configuration is resolved before opening the database pool, registering the
// poller, or listening. A missing edge keyring/target therefore fails startup.
const internalService = configureInternalService("content-next", process.env);
const pool = createPool();
const repository = new CandidateRepository(pool);

const app = await startFastifyService({
  name: "content-next",
  port: Number(process.env.PORT ?? 3016),
  bodyLimit: 40 * 1024 * 1024,
  register(server) {
    const shutdown = new AbortController();
    let polling: Promise<void> | null = null;
    let timer: NodeJS.Timeout | undefined;
    server.addHook("onClose", async () => {
      if (timer) clearInterval(timer);
      shutdown.abort();
      await polling;
      await pool.end();
    });

    registerContentNextRoutes(server, repository, internalService);

    const pollHostCommands = (): Promise<void> => {
      if (polling) return polling;
      polling = Promise.all([
        dispatchErCommands(repository, internalService, server.log, shutdown.signal),
        dispatchReviewFeedbackCommands(repository, internalService, server.log, shutdown.signal),
      ]).then(() => undefined).finally(() => { polling = null; });
      return polling;
    };
    timer = setInterval(() => void pollHostCommands(), 5_000);
    timer.unref();
    void pollHostCommands();
  },
});

void app;
