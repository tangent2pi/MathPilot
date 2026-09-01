import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiSdkTaskExecutor } from "../src/pi-task-executor.ts";
import { TASK_REGISTRY } from "../src/task-registry.ts";

test("PiTaskExecutor removes its attempt workspace when setup fails", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "mathpilot-attempt-cleanup-"));
  const agentAttemptId = "aat_cleanup001";
  const workspace = path.join(runtimeRoot, "attempts", agentAttemptId);
  const executor = new PiSdkTaskExecutor({
    modelRuntime: {} as never,
    mainModel: { id: "main" } as never,
    auxiliaryModel: { id: "aux" } as never,
    runtimeRoot,
    skillsRoot: path.join(runtimeRoot, "missing-skills"),
  });
  try {
    await assert.rejects(executor.execute({
      agentAttemptId,
      tenantId: "tnt_primary01",
      operationId: "op_cleanup001",
      workflowId: "workflow-cleanup-001",
      inputRef: "agent-artifact:art_cleanup001",
      inputBundle: { schema_version: 3 },
      taskSpec: TASK_REGISTRY.grade,
      signal: new AbortController().signal,
      heartbeat() {},
    }), /ENOENT/);
    await assert.rejects(access(workspace), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
