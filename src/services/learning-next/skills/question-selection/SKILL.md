---
name: question-selection
description: Select one real authorized question candidate for a frozen SelectionIntent.
---

# Question selection

Use `question_catalog({ query, cursor?, limit? })` to search the current authorization-filtered catalog. Cite every catalog page you rely on. Choose only a returned candidate and explain the match to the frozen intent, scientific state and relevant annotations. If bounded searches return no honest match, submit `no_candidate`. Do not invent question IDs, bypass candidate constraints or change learner state.

## Candidate rules

- Pick `chosen_question_revision_id` ONLY from the `candidates[].question_revision_id` values actually returned by a `question_catalog` call you made in this attempt.
- Prefer candidates whose `measurement_eligibility === "formal"` (they carry a rubric and measurement targets, so the learner's answer can produce scientific evidence). Fall back to `teaching_only` only when the frozen intent is explicitly non-measurement practice and no formal candidate is an honest match.
- `target_dimensions` MUST be the `dimension_revision_id` strings (e.g. `krev_official_…` / `trev_official_…`) listed in the chosen candidate's `dimensions[]`; never fabricate one.
- `target_error_causes` MUST come from the chosen candidate's `error_roles[].error_cause_revision_id` (`erev_…`); empty `[]` is allowed.
- `evidence_refs` MUST contain at least one `catalog-page://…` ref equal to a `page_ref` returned by a `question_catalog` call you made (never invent one).

## Output contract (SelectionDecision, strict flat JSON)

`respond` validates the result field-by-field and REJECTS any unknown top-level key, any wrong value type and any wrong enum. The submission must contain EXACTLY these keys and nothing else.

### Selected form

```json
{
  "schema_version": 3,
  "decision_type": "selected",
  "intent_id": "<frozen intent_id from the bundle, e.g. int_…>",
  "intent_revision": 1,
  "chosen_question_revision_id": "qrev_…",
  "satisfied_requirements": ["可直接作答", "正弦定理解三角形"],
  "unsatisfied_preferences": [],
  "scientific_purpose": "practice",
  "target_dimensions": ["krev_official_…", "trev_official_…"],
  "target_error_causes": [],
  "evidence_refs": ["catalog-page://cpg_…"],
  "decision_summary": "选择一道可直接作答的正弦定理题用于练习。"
}
```

Field rules:
- `decision_type` literal is `"selected"` — never `"select"`.
- `chosen_question_revision_id` is a STRING revision id — never an object.
- `scientific_purpose` one of: `measure | discriminate | remediate | verify | practice`.
- `target_dimensions` items are `krev_…`/`trev_…` revision-id strings — never `{name, dimension_revision_id}` objects.
- `satisfied_requirements` must be a non-empty string array.
- `evidence_refs` must be a non-empty array of `catalog-page://…` strings.
- `decision_summary` is required (1..1000 chars).

### No-candidate form (use when no honest match exists)

```json
{
  "schema_version": 3,
  "decision_type": "no_candidate",
  "intent_id": "<frozen intent_id>",
  "intent_revision": 1,
  "unsatisfied_preferences": ["没有同时满足难度与维度的正式题"],
  "evidence_refs": ["catalog-page://cpg_…"],
  "decision_summary": "暂未找到同时满足要求的题目。",
  "search_summary": "以相关关键词检索多次，结果均为空或无正式候选。"
}
```

## Forbidden top-level keys (validation rejects them)

`candidate`, `selected_candidate`, `selection`, `question`, `selected_question`, `chosen_question`, `choice`, `recommended_question`, `decision`, `purpose`, `rationale`, `match_rationale`, `catalog_evidence`, `catalog_page_evidence`, `scientific_state_used`, `rejected_candidates`, `selected`, `question_id`, `revision_id`, `selected_revision_id`, `question_revision_id` (top-level), `candidate_revision_id`, `stem`, `difficulty`, `measurement_eligibility`, `no_candidate` — none of these belong at the top level. Put the chosen revision inside `chosen_question_revision_id` only.

Call `respond` exactly once with the complete valid object; do not guess field names or add commentary keys.
