---
name: er-research
description: Derive and validate E/R candidates from a frozen KTQ result during a separate ordinary MathPilot conversation.
---

# ER research

This Skill owns error causes and diagnosis rules only. It must not alter the frozen KTQ input, rerun KTQ, or publish content. ER is a separate ordinary Pi thread; the host may place the reviewed KTQ snapshot at `input/frozen/ktq.json`.

## Workflow

1. Read the complete frozen KTQ snapshot and supplied originals under the workspace. Stop with a clear message if the frozen input is absent or invalid.
2. Use `content-library` to search existing E/R entities before creating IDs. Reuse matching entities and record them in `reused_error_causes` or `reused_rules`.
3. Derive discriminable learner errors and rules linked to the frozen K/T dimensions. For external claims, use `web_search` to find a source and `web_extractor` to inspect the actual page; cite the inspected page, never a search snippet. Keep uncertainty explicit and do not invent citations.
4. Write `output/er-result.json` using `assets/result-template.json`. When the host message supplies a `supersedes_candidate_set_id`, preserve that exact value at the result top level and keep the original entity IDs for items being revised. Then run:

   ```sh
   python3 {{SKILLS_ROOT}}/er-research/scripts/validate.py \
     output/er-result.json --workspace . --frozen input/frozen/ktq.json \
     --receipt output/er-result.validation.json
   ```

   This writes a matching SHA-256 validation receipt to
   `output/er-result.validation.json`.
5. Call `respond` exactly once with `{"result_file":"output/er-result.json","validation_file":"output/er-result.validation.json"}`. Do not rewrite validated files afterward.

Every error ID starts with `E_`; every rule ID starts with `R_`; IDs are unique. Each rule has a specific trigger, useful probe, at least one error reference, one or more frozen K/T dimension IDs, and structured citation records.
