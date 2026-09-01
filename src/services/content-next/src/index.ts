import { configureInternalService } from "@mathpilot/internal-service";
import { CandidateRepository } from "./candidate-repository.ts";
import { dispatchErCommands, dispatchReviewFeedbackCommands } from "./command-dispatch.ts";
import { createPool, startService } from "./lib.ts";
import { registerContentNextRoutes } from "./routes.ts";

// Configuration is resolved before opening the database pool, registering the
// poller, or listening. A missing edge keyring/target therefore fails startup.
const internalService = configureInternalService("content-next", process.env);
const pool = createPool();
const repository = new CandidateRepository(pool);

const app = await startService({
  name: "content-next",
  port: Number(process.env.PORT ?? 3016),
  register(server) {
    registerContentNextRoutes(server, repository, internalService);

    const shutdown = new AbortController();
    let polling: Promise<void> | null = null;
    const pollHostCommands = (): Promise<void> => {
      if (polling) return polling;
      polling = Promise.all([
        dispatchErCommands(repository, internalService, server.log, shutdown.signal),
        dispatchReviewFeedbackCommands(repository, internalService, server.log, shutdown.signal),
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
