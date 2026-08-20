import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileSystemPrompt, taskPromptVersion, taskRole, type TaskContext, type TaskType } from "../src/skills.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const manifest = JSON.parse(readFileSync(path.join(root, "policies/tasks.manifest.json"), "utf8")) as {
  schema: string;
  tasks: Record<TaskType, { file: string; prompt_version: string; role: "main" | "aux" }>;
};
const context: TaskContext = {
  question: "QUESTION_CONTEXT", rubric: "RUBRIC_CONTEXT", userData: "USER_CONTEXT",
  fragments: "FRAGMENTS_CONTEXT", frozenProjection: "FROZEN_CONTEXT",
  profileWindow: "PROFILE_WINDOW", priorSnapshot: "PRIOR_SNAPSHOT",
  diagnosisContext: "DIAGNOSIS_CONTEXT", schemaNote: "SCHEMA_CONTEXT",
  verdict: "VERDICT_CONTEXT", studentProfile: "STUDENT_PROFILE", planDraft: "PLAN_DRAFT",
  sessionSummary: "SESSION_SUMMARY", studentProjection: "STUDENT_PROJECTION",
  previousContinuity: "PREVIOUS_CONTINUITY", currentSession: "CURRENT_SESSION",
  scientificEvaluation: "SCIENTIFIC_EVALUATION", teachingSummary: "TEACHING_SUMMARY",
};

test("task policies are versioned prompts and compile without unresolved placeholders", () => {
  assert.equal(manifest.schema, "mathpilot.task-policy-manifest/v1");
  assert.equal(Object.keys(manifest.tasks).length, 10);
  for (const taskType of Object.keys(manifest.tasks) as TaskType[]) {
    const entry = manifest.tasks[taskType];
    assert.equal(taskRole(taskType), entry.role);
    assert.equal(taskPromptVersion(taskType), entry.prompt_version);
    assert.match(entry.prompt_version, /^[a-z-]+@\d+\.\d+\.\d+$/);
    const prompt = compileSystemPrompt(taskType, context, "唯一工作区：/workspace");
    assert.match(prompt, /## 当前任务/);
    assert.match(prompt, /唯一工作区：\/workspace/);
    assert.doesNotMatch(prompt, /\{\{[A-Za-z0-9_]+\}\}/);
    assert.doesNotMatch(prompt, /比赛|赛题|评委|竞赛|硬门槛/);
  }
});

test("task isolation does not inject another task goal", () => {
  const ktq = compileSystemPrompt("ktq_extract", context, "/workspace");
  const dream = compileSystemPrompt("dream_profile", context, "/workspace");
  assert.match(ktq, /KTQ 任务目标/);
  assert.doesNotMatch(ktq, /Dream \/ Profile Update Agent/);
  assert.match(dream, /Dream \/ Profile Update Agent/);
  assert.doesNotMatch(dream, /KTQ 任务目标/);
});
