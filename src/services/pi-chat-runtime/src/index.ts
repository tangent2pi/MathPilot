import { configureInternalService } from "@mathpilot/internal-service";
import { startService } from "./lib.ts";
import { createPiChatRuntime } from "./pi-chat-server.ts";
import { registerPiChatRoutes } from "./pi-chat-routes.ts";
import { PiThreadStore } from "./pi-thread-store.ts";

const databaseUrl = process.env.PI_DATABASE_URL;
const internalService = configureInternalService("pi-chat-runtime", process.env);

if (!databaseUrl) throw new Error("PI_DATABASE_URL is required");

const runtime = await createPiChatRuntime();
const threads = new PiThreadStore(databaseUrl);

await startService({
  name: "pi-chat-runtime",
  port: Number(process.env.PORT ?? 3105),
  async register(app) {
    registerPiChatRoutes(app, runtime, threads, internalService);
  },
});
