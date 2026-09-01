import { fileURLToPath } from "node:url";
import { configureInternalService } from "@mathpilot/internal-service";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.ts";
import { OutboxRelay, PostgresOutboxRelayStore } from "./outbox-relay.ts";
import { createPiSdkTaskExecutorFromEnvironment } from "./pi-task-executor.ts";
import { PostgresQuestionStore } from "./question-store.ts";
import { PostgresRuntimeStore } from "./runtime-store.ts";
import { PostgresSelectionStore } from "./selection-store.ts";
import { PostgresDreamStore } from "./dream-store.ts";
import { PostgresForegroundStore } from "./foreground-store.ts";
import { ensureDreamSchedules } from "./schedules.ts";
import { loadLearningTenantIds } from "./production-config.ts";

const internalService = configureInternalService("learning-next", process.env);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const temporalAddress = process.env.TEMPORAL_ADDRESS?.trim() || "127.0.0.1:7233";
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE?.trim() || "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || "mathpilot_learning_next";
  const tenantIds = loadLearningTenantIds(internalService.configuration.environment);

  const runtimeStore = new PostgresRuntimeStore(databaseUrl);
  const questionStore = new PostgresQuestionStore(databaseUrl);
  const selectionStore = new PostgresSelectionStore(databaseUrl);
  const dreamStore = new PostgresDreamStore(databaseUrl);
  const foregroundStore = new PostgresForegroundStore(databaseUrl);
  const relayStore = new PostgresOutboxRelayStore(databaseUrl);
  const connection = await NativeConnection.connect({ address: temporalAddress });
  const controller = new AbortController();
  let worker: Worker | undefined;
  const stop = () => controller.abort(new Error("learning-next is stopping"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const executor = await createPiSdkTaskExecutorFromEnvironment(internalService);
    const activities = createActivities({ store: runtimeStore, questionStore, selectionStore, dreamStore, foregroundStore, executor });
    worker = await Worker.create({
      connection,
      namespace: temporalNamespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities,
      shutdownGraceTime: "30s",
    });
    const client = new Client({ connection, namespace: temporalNamespace });
    await ensureDreamSchedules(client, tenantIds, taskQueue);
    const relay = new OutboxRelay(client.workflow, relayStore, {
      taskQueue,
      batchSize: positiveInteger("OUTBOX_BATCH_SIZE", 32),
      pollIntervalMs: positiveInteger("OUTBOX_POLL_INTERVAL_MS", 1_000),
    });

    console.info(JSON.stringify({
      event: "learning_next_started",
      temporalAddress,
      temporalNamespace,
      taskQueue,
      scheduledTenants: tenantIds,
    }));
    const workerRun = worker.run();
    const relayRun = relay.run(controller.signal);
    try {
      await Promise.race([workerRun, relayRun]);
    } finally {
      stop();
      worker.shutdown();
      await Promise.allSettled([workerRun, relayRun]);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await Promise.allSettled([
      runtimeStore.close(), questionStore.close(), selectionStore.close(), dreamStore.close(),
      foregroundStore.close(), relayStore.close(),
    ]);
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
