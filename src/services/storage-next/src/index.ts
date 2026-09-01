import { configureInternalService } from "@mathpilot/internal-service";
import { ObjectStore } from "./object-store.ts";
import { createPool, startService, withPrincipal } from "./lib.ts";
import { registerStorageRoutes, type RunWithPrincipal } from "./storage-routes.ts";

// Identity configuration is validated before any database, object-store, or
// listener is created. Production therefore fails at startup, not on the first
// authenticated request.
const identity = configureInternalService("storage-next");
const pool = createPool();
const accessKey = process.env.MINIO_ROOT_USER ?? process.env.MINIO_ACCESS_KEY ?? "";
const secretKey = process.env.MINIO_ROOT_PASSWORD ?? process.env.MINIO_SECRET_KEY ?? "";
const endpoint = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const region = process.env.MINIO_REGION ?? "us-east-1";
if (!accessKey || !secretKey) throw new Error("MinIO credentials are required by storage-next");
const objects = new ObjectStore({ endpoint, publicEndpoint, accessKey, secretKey, region });

const runWithPrincipal: RunWithPrincipal = (principal, operation) => withPrincipal(
  pool,
  principal,
  (client) => operation({
    async query<Row>(text: string, values?: readonly unknown[]) {
      const result = values
        ? await client.query(text, [...values])
        : await client.query(text);
      return { rows: result.rows as Row[] };
    },
  }),
);

const app = await startService({
  name: "storage-next",
  port: Number(process.env.PORT ?? 3017),
  register(server) {
    registerStorageRoutes(server, { identity, objects, runWithPrincipal });
    server.addHook("onClose", async () => { await pool.end(); });
  },
});

void app;
