import { startService } from "./lib.ts";
import { createPiChatRuntime } from "./pi-chat-server.ts";
import { registerPiChatRoutes } from "./pi-chat-routes.ts";
import { PiObjectStore } from "./pi-object-store.ts";
import { PiThreadStore } from "./pi-thread-store.ts";

const databaseUrl = process.env.PI_DATABASE_URL;
const gatewaySecret = process.env.PI_GATEWAY_SECRET ?? "";

if (!databaseUrl) throw new Error("PI_DATABASE_URL is required");
if (gatewaySecret.length < 32) throw new Error("PI_GATEWAY_SECRET must contain at least 32 characters");

const runtime = await createPiChatRuntime();
const threads = new PiThreadStore(databaseUrl);
const objects = process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY
  ? new PiObjectStore({
      endpoint: process.env.MINIO_ENDPOINT,
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
      bucket: process.env.MINIO_BUCKET ?? "mathpilot-workspaces",
      useSSL: process.env.MINIO_USE_SSL === "true",
    })
  : undefined;

await startService({
  name: "pi-chat-runtime",
  port: Number(process.env.PORT ?? 3105),
  async register(app) {
    registerPiChatRoutes(app, runtime, threads, objects);
  },
});
