import { configureInternalService } from "@mathpilot/internal-service";
import { ObjectStore } from "./object-store.ts";
import { createPool, startService, withPrincipal } from "./lib.ts";
import { registerStorageRoutes, type RunWithPrincipal } from "./storage-routes.ts";

// Identity configuration is validated before any database, object-store, or
// listener is created. Production therefore fails at startup, not on the first
// authenticated request.
const identity = configureInternalService("storage-next");
const databaseUrl=process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required by storage-next");
const pool = createPool(databaseUrl);
const accessKey = process.env.MINIO_ROOT_USER ?? process.env.MINIO_ACCESS_KEY ?? "";
const secretKey = process.env.MINIO_ROOT_PASSWORD ?? process.env.MINIO_SECRET_KEY ?? "";
const endpoint = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const region = process.env.MINIO_REGION ?? "us-east-1";
if (!accessKey || !secretKey) throw new Error("MinIO credentials are required by storage-next");

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const connectionTimeoutMs = positiveIntegerEnvironment("OBJECT_STORE_CONNECTION_TIMEOUT_MS", 5_000);
const requestTimeoutMs = positiveIntegerEnvironment("OBJECT_STORE_REQUEST_TIMEOUT_MS", 120_000);
const socketTimeoutMs = positiveIntegerEnvironment("OBJECT_STORE_SOCKET_TIMEOUT_MS", 120_000);
const maxAttempts = positiveIntegerEnvironment("OBJECT_STORE_MAX_ATTEMPTS", 3);
const startupTimeoutMs = positiveIntegerEnvironment("OBJECT_STORE_STARTUP_TIMEOUT_MS", 120_000);
const objects = new ObjectStore({
  endpoint,
  publicEndpoint,
  accessKey,
  secretKey,
  region,
  connectionTimeoutMs,
  requestTimeoutMs,
  socketTimeoutMs,
  maxAttempts,
});

// A listener must never advertise readiness with an unusable object store or
// the pre-integrity schema.  These checks also make deployment ordering an
// optimization rather than a correctness dependency.
await objects.ensureBuckets(AbortSignal.timeout(startupTimeoutMs));
const schema = await pool.query(
  "select current_user as database_role,exists(select 1 from infra_schema_migration where version='0041_content_integrity') as migrated",
);
if (schema.rows[0]?.database_role!=="mathpilot_storage") throw new Error("storage-next requires the dedicated mathpilot_storage database role");
if (!schema.rows[0]?.migrated) throw new Error("storage-next requires database migration 0041_content_integrity");

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
    server.addHook("onClose", async () => {
      objects.close();
      await pool.end();
    });
  },
});

void app;
