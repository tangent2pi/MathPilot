---
name: question-grade
description: Propose a Judgment from one frozen Attempt and rubric without changing learner state.
---

# Question grade

Use only the frozen question, Attempt, rubric and evidence references in the input bundle. Distinguish correctness from presentation quality. Return the complete `scientific-fact/v1#/$defs/Judgment` object through `respond`, using the exact target Judgment/Attempt IDs and only the supplied evidence refs. Do not infer mastery, retention, error state or the next question. If the material is insufficient or grading is uncertain, return `verdict: "unresolved"`; never invent missing work.

The host validates the returned object strictly against the frozen bundle. If your response is rejected you MUST retry `respond` with a corrected object; do not end the session without a compliant result.

## Input fields you can rely on

- `output_requirements` — the identity the returned object MUST carry (`schema_version`, `fact_version`, `fact_type`, `judgment_id`, `attempt_id`) and `evidence_refs_must_come_from` (the only evidence refs you may cite).
- `attempt.response_parts[].part.snapshot.data.response_parts[].text` — the learner's submitted answer.
- `question.answer_items[].answer_text` — the standard answer(s) the response is compared against.
- `question.rubric_items[]` — rubric items with `rubric_item_id` / `criterion` / `score`.
- `question.measurement_targets[]` and `question_session.frozen_measurement_contract.dimension_revision_ids` — the frozen dimensions measured by this question.
- `target_judgment_id` — equals `output_requirements.judgment_id`.

## Output contract (exact, flat object)

Return a single flat JSON object through `respond` with EXACTLY these fields. All string values must be the literal IDs copied from the input bundle — never re-encode, abbreviate or invent them.

| field | type / value | rule |
|---|---|---|
| `schema_version` | integer | copy `output_requirements.schema_version` (3) |
| `fact_version` | integer | copy `output_requirements.fact_version` (1) |
| `fact_type` | string | `"judgment"` |
| `judgment_id` | string | copy `output_requirements.judgment_id` verbatim |
| `attempt_id` | string | copy `output_requirements.attempt_id` verbatim |
| `verdict` | enum | `correct` / `partially_correct` / `incorrect` / `unresolved` |
| `rubric_results` | array, ≥1 | one entry per rubric item you can judge: `{ "rubric_item_id", "status": "met"\|"not_met"\|"unclear", "evidence_refs": [...] }` |
| `dimension_proposals` | array | one entry per frozen dimension you can project: `{ "dimension_revision_id", "rubric_item_id", "outcome": "success"\|"failure"\|"unresolved" }` |
| `uncertainty` | enum | `low` / `medium` / `high` |
| `decision_summary` | string | concise Chinese summary of why this verdict was reached (1–2000 chars) |
| `evidence_refs` | array, ≥1 | every ref MUST be one of `output_requirements.evidence_refs_must_come_from` |

Hard rules:

1. `rubric_item_id` inside `dimension_proposals` MUST also appear in `rubric_results` (the rubric result the dimension is projected from).
2. `dimension_revision_id` MUST come from `question_session.frozen_measurement_contract.dimension_revision_ids`; do not invent dimensions.
3. Consistency between rubric status and dimension outcome:
   - `status: "met"` → that rubric item projects `outcome: "success"`.
   - `status: "not_met"` → that rubric item projects `outcome: "failure"`.
   - `status: "unclear"` or unknown → `outcome: "unresolved"`.
4. `evidence_refs` everywhere MUST be a subset of `output_requirements.evidence_refs_must_come_from`.
5. Whole-question rubric mapping (单评分点): when `question.rubric_items` has exactly one item whose criterion covers the whole question (e.g. "整题作答与标准答案一致"), project that single rubric result onto EVERY dimension in `frozen_measurement_contract.dimension_revision_ids`. When there are multiple rubric items (one per sub-question / score point), map each dimension to the rubric item that governs the corresponding sub-part.
6. Do NOT include `model_id`, `prompt_version`, `skill_version`, `created_at` or any other field — the host fills them at commit time.
7. Do NOT use invented envelopes such as `measurements`, `score`, `criterion`, `source_attempt_ref`, `candidate`, `selection`. The only accepted shape is the one above.

## Verdict guidance

- All judged rubric items `met` and no failure → `correct` (uncertainty `low` when the standard-answer comparison is unambiguous).
- Some items `met` and some `not_met` (multi-part question) → `partially_correct`.
- Any judged item `not_met` on a single whole-question rubric → `incorrect`.
- Evidence insufficient (no usable answer text, cannot compare to the standard answer, or grading genuinely ambiguous) → `verdict: "unresolved"` with `uncertainty: "high"`; never guess.

## Example (single-choice, whole-question rubric, all correct)

```json
{
  "schema_version": 3,
  "fact_version": 1,
  "fact_type": "judgment",
  "judgment_id": "jdg_…",        // copy output_requirements.judgment_id verbatim
  "attempt_id": "att_…",         // copy output_requirements.attempt_id verbatim
  "verdict": "correct",
  "rubric_results": [
    {
      "rubric_item_id": "rubr_…",  // copy question.rubric_items[0].rubric_item_id verbatim
      "status": "met",
      "evidence_refs": ["answer://att_…/part/1"]
    }
  ],
  "dimension_proposals": [
    { "dimension_revision_id": "krev_…", "rubric_item_id": "rubr_…", "outcome": "success" },
    { "dimension_revision_id": "krev_…", "rubric_item_id": "rubr_…", "outcome": "success" },
    { "dimension_revision_id": "trev_…", "rubric_item_id": "rubr_…", "outcome": "success" }
  ],
  "uncertainty": "low",
  "decision_summary": "学生作答与标准答案一致，整题判对，冻结维度均形成成功观测。",
  "evidence_refs": ["answer://att_…/part/1"]
}
```
