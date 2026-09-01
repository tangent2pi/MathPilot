import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { reconcileTemporalSchedule } from "@mathpilot/internal-service/temporal";
import {
  Client,
  ScheduleOverlapPolicy,
  type ScheduleOptionsStartWorkflowAction,
  type ScheduleUpdateOptions,
} from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { FastifyBaseLogger } from "fastify";
import type { ObjectGarbageCollector } from "./object-garbage-collector.ts";

export const STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID = "mathpilot:storage:object-garbage-collection";
export const DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE = "mathpilot_storage_next";

type StorageGarbageCollectionWorkflow = () => Promise<void>;

export const storageGarbageCollectionScheduleDefinition = (
  taskQueue: string,
): ScheduleUpdateOptions<ScheduleOptionsStartWorkflowAction<StorageGarbageCollectionWorkflow>> => ({
  spec: { intervals: [{ every: "1m" }] },
  action: {
    type: "startWorkflow",
    workflowType: "storageGarbageCollectionWorkflow",
    args: [],
    taskQueue,
    workflowId: `${STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID}:sweep`,
    workflowExecutionTimeout: "5m",
  },
  policies: {
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: "5m",
    pauseOnFailure: false,
  },
  state: {},
});

export const createStorageGarbageCollectionActivities = (
  collector: Pick<ObjectGarbageCollector, "sweepOnce">,
  cancellationSignal: () => AbortSignal = () => Context.current().cancellationSignal,
) => ({
  async sweepStorageGarbage(): Promise<void> {
    await collector.sweepOnce(cancellationSignal());
  },
});

export interface StorageGarbageCollectionRuntime {
  readonly completion: Promise<void>;
  close(): Promise<void>;
}

export interface StorageTemporalRuntimeDependencies {
  connect(options: Parameters<typeof NativeConnection.connect>[0]): ReturnType<typeof NativeConnection.connect>;
  createWorker(options: Parameters<typeof Worker.create>[0]): ReturnType<typeof Worker.create>;
  createClient(options: ConstructorParameters<typeof Client>[0]): Client;
  ensureSchedule(client: Client, taskQueue: string): Promise<void>;
}

const productionTemporalRuntime: StorageTemporalRuntimeDependencies = {
  connect: (options) => NativeConnection.connect(options),
  createWorker: (options) => Worker.create(options),
  createClient: (options) => new Client(options),
  ensureSchedule: (client, taskQueue) => reconcileTemporalSchedule(
    client.schedule,
    STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID,
    storageGarbageCollectionScheduleDefinition(taskQueue),
  ),
};

export async function startStorageGarbageCollectionRuntime(input: {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly collector: Pick<ObjectGarbageCollector, "sweepOnce">;
  readonly logger: Pick<FastifyBaseLogger, "info" | "error">;
}, dependencies: StorageTemporalRuntimeDependencies = productionTemporalRuntime): Promise<StorageGarbageCollectionRuntime> {
  const connection = await dependencies.connect({ address: input.address });
  let worker: Worker | undefined;
  let completion: Promise<void> | undefined;
  try {
    worker = await dependencies.createWorker({
      connection,
      namespace: input.namespace,
      taskQueue: input.taskQueue,
      workflowsPath: fileURLToPath(new URL("./storage-workflows.ts", import.meta.url)),
      activities: createStorageGarbageCollectionActivities(input.collector),
      shutdownGraceTime: "30s",
    });
    const client = dependencies.createClient({ connection, namespace: input.namespace });
    completion = worker.run();
    // Worker failure may race schedule reconciliation; observe it immediately
    // while retaining the original promise for the owning service to handle.
    void completion.catch(() => undefined);
    await dependencies.ensureSchedule(client, input.taskQueue);
    input.logger.info({
      temporalAddress: input.address,
      temporalNamespace: input.namespace,
      taskQueue: input.taskQueue,
      scheduleId: STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID,
    }, "durable storage garbage collection started");
    let closed = false;
    const running = completion;
    return {
      completion: running,
      async close() {
        if (closed) return;
        closed = true;
        worker?.shutdown();
        await Promise.allSettled([running]);
        await connection.close();
      },
    };
  } catch (error) {
    worker?.shutdown();
    if (completion) await Promise.allSettled([completion]);
    await connection.close().catch(() => undefined);
    input.logger.error({ err: error }, "durable storage garbage collection failed to start");
    throw error;
  }
}
