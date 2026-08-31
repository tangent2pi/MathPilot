import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseHardSelectionConstraints,
  parseSelectionDecision,
  sha256Json,
} from "../src/selection-core.ts";

test("SelectionDecision is intent-bound and cannot smuggle answers or commit authority", () => {
  const selected = {
    schema_version: 3,
    decision_type: "selected",
    intent_id: "int_selector0001",
    intent_revision: 2,
    chosen_question_revision_id: "qrev_selector0001",
    satisfied_requirements: ["需要比较面积关系"],
    unsatisfied_preferences: [],
    scientific_purpose: "measure",
    target_dimensions: ["krev_selector0001"],
    target_error_causes: [],
    evidence_refs: ["catalog-page://cpg_selector0001"],
    decision_summary: "候选符合当前正式测量要求。",
  };
  assert.equal(parseSelectionDecision(selected,{
    intentId: "int_selector0001",
    intentRevision: 2,
  }).decision_type,"selected");
  assert.throws(() => parseSelectionDecision({ ...selected, answer: "42" }));
  assert.throws(() => parseSelectionDecision(selected,{
    intentId: "int_selector0001",
    intentRevision: 3,
  }));
});

test("catalog cursors are scoped to one intent and hard constraints stay allowlisted", () => {
  const scope = sha256Json({ intent: "int_selector0001", revision: 1 });
  const cursor = encodeCatalogCursor(scope,12);
  assert.equal(decodeCatalogCursor(cursor,scope),12);
  assert.throws(() => decodeCatalogCursor(cursor,sha256Json({ intent: "int_selector0002" })));
  assert.deepEqual(parseHardSelectionConstraints({
    measurement_eligibility: "formal",
    minimum_difficulty: "0.3",
    maximum_difficulty: "0.8",
    allow_recent_revisit: "false",
  }),{
    measurementEligibility: "formal",
    minimumDifficulty: 0.3,
    maximumDifficulty: 0.8,
    allowRecentRevisit: false,
  });
  assert.throws(() => parseHardSelectionConstraints({ sql_where: "true" }));
});
