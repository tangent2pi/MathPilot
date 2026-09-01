import { configureInternalService } from "@mathpilot/internal-service";
import { startFastifyService } from "@mathpilot/internal-service/fastify";
import { ObjectGarbageCollector } from "./object-garbage-collector.ts";
import { ObjectStore } from "./object-store.ts";
import { createPool, withPrincipal } from "./lib.ts";
import {
  DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE,
  startStorageGarbageCollectionRuntime,
  type StorageGarbageCollectionRuntime,
} from "./storage-temporal.ts";
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

let garbageCollectionRuntime: StorageGarbageCollectionRuntime | undefined;
let closing = false;
let resourceCleanup: Promise<void> | undefined;

function closeStorageResources(): Promise<void> {
  if (resourceCleanup) return resourceCleanup;
  closing = true;
  resourceCleanup = (async () => {
    const failures: unknown[] = [];
    const temporal = await Promise.allSettled([
      garbageCollectionRuntime?.close() ?? Promise.resolve(),
    ]);
    if (temporal[0]?.status === "rejected") failures.push(temporal[0].reason);

    const ownedResources = await Promise.allSettled([
      Promise.resolve().then(() => objects.close()),
      pool.end(),
    ]);
    for (const result of ownedResources) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "storage resource cleanup failed");
    }
  })();
  return resourceCleanup;
}

const app = await startFastifyService({
  name: "storage-next",
  port: Number(process.env.PORT ?? 3017),
  bodyLimit: 2 * 1024 * 1024,
  async register(server) {
    // Install the owner before starting Temporal or registering routes so a
    // register/listen failure follows the same idempotent shutdown path.
    server.addHook("onClose", closeStorageResources);
    // A listener must never advertise readiness with an unusable object store
    // or the pre-integrity schema. The close owner is installed first so both
    // preflight failure paths release every already-created resource.
    await objects.ensureBuckets(AbortSignal.timeout(startupTimeoutMs));
    const schema = await pool.query(
      "select current_user as database_role,exists(select 1 from infra_schema_migration where version='0041_content_integrity') as migrated",
    );
    if (schema.rows[0]?.database_role!=="mathpilot_storage") throw new Error("storage-next requires the dedicated mathpilot_storage database role");
    if (!schema.rows[0]?.migrated) throw new Error("storage-next requires database migration 0041_content_integrity");

    const collector = new ObjectGarbageCollector({ pool, objects, logger: server.log });
    garbageCollectionRuntime = await startStorageGarbageCollectionRuntime({
      address: process.env.TEMPORAL_ADDRESS?.trim() || "127.0.0.1:7233",
      namespace: process.env.TEMPORAL_NAMESPACE?.trim() || "default",
      taskQueue: process.env.TEMPORAL_TASK_QUEUE?.trim() || DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE,
      collector,
      logger: server.log,
    });
    const requestServerClose = (message: string, error?: unknown): void => {
      if (closing) return;
      server.log.error(error === undefined ? {} : { err: error },message);
      void server.close().catch((closeError: unknown) => {
        server.log.error({ err: closeError },"storage shutdown after Temporal termination failed");
      });
    };
    void garbageCollectionRuntime.completion.then(
      () => requestServerClose("storage Temporal worker stopped unexpectedly"),
      (error: unknown) => requestServerClose("storage Temporal worker failed",error),
    );
    registerStorageRoutes(server, { identity, objects, runWithPrincipal });
  },
});

void app;
