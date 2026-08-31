import {
  WorkflowClient,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/common";
import pg from "pg";
import { directWorkflowRoute, workflowInputFromOutbox } from "./outbox-routing.ts";
import { OUTBOX_EVENT_TYPES, type OutboxEventType, type OutboxWorkflowStart } from "./runtime-types.ts";

interface PendingWorkflowRow {
  event_id: string;
  tenant_id: string;
  operation_id: string;
  event_type: string;
  aggregate_ref: string;
  aggregate_version: string;
  payload_ref: string;
  occurred_at: Date | string;
  delivery_attempts: number;
}

export interface OutboxRelayStore {
  pending(limit: number): Promise<OutboxWorkflowStart[]>;
  markStarted(eventId: string, workflowId: string, taskQueue: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
  close(): Promise<void>;
}

const eventTypes = new Set<string>(OUTBOX_EVENT_TYPES);

const asOutboxStart = (row: PendingWorkflowRow): OutboxWorkflowStart => {
  const aggregateVersion = Number(row.aggregate_version);
  if (!eventTypes.has(row.event_type)) throw new Error(`unknown science-v3 event type ${row.event_type}`);
  if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) throw new Error("invalid aggregate version from outbox");
  return {
    schemaVersion: 3,
    eventId: row.event_id,
    tenantId: row.tenant_id,
    operationId: row.operation_id,
    eventType: row.event_type as OutboxEventType,
    aggregateRef: row.aggregate_ref,
    aggregateVersion,
    payloadRef: row.payload_ref,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
};

export class PostgresOutboxRelayStore implements OutboxRelayStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
  }

  async pending(limit: number): Promise<OutboxWorkflowStart[]> {
    const result = await this.pool.query<PendingWorkflowRow>(
      "select * from mathpilot_science_v3_pending_workflow_starts($1)",
      [limit],
    );
    return result.rows.map(asOutboxStart);
  }

  async markStarted(eventId: string, workflowId: string, taskQueue: string): Promise<void> {
    const result = await this.pool.query<{ marked: boolean }>(
      "select mathpilot_science_v3_mark_workflow_started($1,$2,$3) as marked",
      [eventId, workflowId, taskQueue],
    );
    if (!result.rows[0]?.marked) throw new Error(`outbox event ${eventId} disappeared before delivery acknowledgement`);
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      "select mathpilot_science_v3_mark_workflow_start_failed($1,$2)",
      [eventId, error.slice(0, 1000)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface OutboxPollResult {
  selected: number;
  started: number;
  duplicates: number;
  deferred: number;
  failed: number;
}

export interface OutboxRelayOptions {
  taskQueue: string;
  batchSize?: number;
  pollIntervalMs?: number;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly client: WorkflowClient,
    private readonly store: OutboxRelayStore,
    private readonly options: OutboxRelayOptions,
  ) {
    this.batchSize = Math.min(Math.max(options.batchSize ?? 32, 1), 100);
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 1_000, 100);
  }

  async pollOnce(): Promise<OutboxPollResult> {
    const events = await this.store.pending(this.batchSize);
    const result: OutboxPollResult = { selected: events.length, started: 0, duplicates: 0, deferred: 0, failed: 0 };
    for (const event of events) {
      const route = directWorkflowRoute(event.eventType);
      if (!route) {
        result.deferred += 1;
        continue;
      }
      const workflowId = `${event.eventType}:${event.eventId}`;
      try {
        let duplicate = false;
        try {
          await this.client.start(route.workflowType, {
            args: [workflowInputFromOutbox(event, route.taskType)],
            taskQueue: this.options.taskQueue,
            workflowId,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
          duplicate = true;
        }
        await this.store.markStarted(event.eventId, workflowId, this.options.taskQueue);
        if (duplicate) result.duplicates += 1;
        else result.started += 1;
      } catch (error) {
        result.failed += 1;
        await this.store.markFailed(event.eventId, errorText(error)).catch(() => undefined);
      }
    }
    return result;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce();
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new Error("outbox relay stopped"));
          };
          const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, this.pollIntervalMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      } catch {
        if (!signal.aborted) throw new Error("outbox relay wait failed");
      }
    }
  }
}
