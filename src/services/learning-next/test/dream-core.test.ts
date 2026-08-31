import assert from "node:assert/strict";
import test from "node:test";
import {
  DreamValidationError,
  gateRemCandidate,
  parseAnnotationChangeSet,
  parseLightAtomProposal,
  parseRemOutput,
  type WindowAtom,
} from "../src/dream-core.ts";

const light = () => ({
  schema_version: 3,
  status: "ready",
  dream_run_id: "drm_light0001",
  student_id: "stu_student01",
  question_session_id: "qsn_session001",
  dimensions: ["krev_dimension1"],
  error_causes: [],
  observed_behaviors: ["独立完成了等价变形"],
  method_signals: ["先整理再代入"],
  hint_dependency: "none",
  self_correction: "successful",
  transfer_context: { representation: "symbolic" },
  supports: ["observation://obs_evidence01"],
  counters: ["judgment://jdg_evidence01"],
  unresolved: [],
  source_refs: ["observation://obs_evidence01", "judgment://jdg_evidence01"],
  summary: "该题只形成可追溯的题级语义原子。",
});

test("Light accepts a bound atom and rejects scientific-state fields", () => {
  const parsed = parseLightAtomProposal(light(), {
    dreamRunId: "drm_light0001",
    studentId: "stu_student01",
    questionSessionId: "qsn_session001",
  });
  assert.equal(parsed.status, "ready");
  assert.throws(
    () => parseLightAtomProposal({ ...light(), p_mastery: 0.9 }, {
      dreamRunId: "drm_light0001",
      studentId: "stu_student01",
      questionSessionId: "qsn_session001",
    }),
    DreamValidationError,
  );
});

test("REM recomputes evidence diversity and keeps high-risk claims in review", () => {
  const candidate = {
    candidate_id: "remc_model0001",
    target_kind: "dimension",
    target_ref: "dimension:krev_dimension1",
    proposed_claim: "在两种表示下都能先整理再代入。",
    proposed_scope: { topic: "algebra" },
    support_atom_refs: ["light-atom://lat_atom000001", "light-atom://lat_atom000002"],
    counter_atom_refs: ["light-atom://lat_atom000003"],
    contradictions: ["第三次仍出现一次符号错误"],
    actionability: "后续用一次近迁移题验证。",
    distinct_session_count: 3,
    context_diversity: 3,
    recency: "mixed",
    source_trust: "verified_facts",
    recommended_action: "deep_review",
  } as const;
  const output = parseRemOutput({
    schema_version: 3,
    dream_run_id: "drm_rem000001",
    window_id: "rwin_window001",
    student_id: "stu_student01",
    candidates: [candidate],
    summary: "一个通过宿主复算的候选。",
  }, {
    dreamRunId: "drm_rem000001",
    windowId: "rwin_window001",
    studentId: "stu_student01",
  });
  const atoms = new Map<string, WindowAtom>([
    ["lat_atom000001", {
      atomId: "lat_atom000001", questionSessionId: "qsn_session001",
      dimensions: ["krev_dimension1"], errorCauses: [],
      context: { representation: "symbolic", difficulty: "near" },
      supports: ["observation://obs_evidence01"], counters: [],
    }],
    ["lat_atom000002", {
      atomId: "lat_atom000002", questionSessionId: "qsn_session002",
      dimensions: ["krev_dimension1"], errorCauses: [],
      context: { representation: "symbolic", difficulty: "far" },
      supports: ["observation://obs_evidence02"], counters: [],
    }],
    ["lat_atom000003", {
      atomId: "lat_atom000003", questionSessionId: "qsn_session003",
      dimensions: ["krev_dimension1"], errorCauses: [],
      context: { representation: "symbolic", difficulty: "near" },
      supports: ["judgment://jdg_evidence03"], counters: [],
    }],
  ]);
  assert.equal(gateRemCandidate(output.candidates[0]!, atoms).status, "accepted");
  assert.equal(gateRemCandidate({
    ...output.candidates[0]!,
    target_kind: "student_trait",
    target_ref: "student:stu_student01",
    distinct_session_count: 3,
  }, atoms).status, "review_required");
});

test("Deep ChangeSet is version-bound and cannot smuggle numeric state", () => {
  const value = {
    schema_version: 3,
    change_set_id: "acs_model00001",
    student_id: "stu_student01",
    dream_run_id: "drm_deep00001",
    expected_annotation_set_version: 0,
    operations: [{
      op: "add",
      annotation: {
        target_kind: "dimension",
        target_ref: "dimension:krev_dimension1",
        claim: "在代数题中通常先整理再代入。",
        scope: { topic: "algebra" },
        support_refs: ["observation://obs_evidence01"],
        counter_refs: ["judgment://jdg_evidence03"],
        confidence: "medium",
        trend: "mixed",
        action_hint: "用近迁移题复核。",
        valid_from: "2026-08-31T00:00:00Z",
      },
    }],
    source_refs: ["rem-candidate://remc_source001"],
    policy_version: "deep-gate-v1",
    model_id: "deepseek-v4-flash-vision-exp",
    prompt_version: "deep-prompt-v1",
    skill_version: "dream-deep@v1",
    created_at: "2026-08-31T00:00:00Z",
  };
  assert.equal(parseAnnotationChangeSet(value, {
    dreamRunId: "drm_deep00001",
    studentId: "stu_student01",
    annotationSetVersion: 0,
  }).operations.length, 1);
  const operation = value.operations[0]!;
  assert.throws(() => parseAnnotationChangeSet({
    ...value,
    operations: [{ ...operation, annotation: { ...operation.annotation, p_final: 0.92 } }],
  }, {
    dreamRunId: "drm_deep00001",
    studentId: "stu_student01",
    annotationSetVersion: 0,
  }), DreamValidationError);
});
