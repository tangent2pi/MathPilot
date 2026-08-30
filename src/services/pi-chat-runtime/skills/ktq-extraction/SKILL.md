---
name: ktq-extraction
description: Extract and validate K/T/Q candidates from teaching material during an ordinary MathPilot conversation when the user asks for KTQ content work.
---

# KTQ extraction

This Skill owns knowledge components, question types, and questions only. Do not create E/R entities and do not start ER automatically. A teacher may use this in an ordinary thread; the host creates a review candidate set only after a validated `respond` call.

## Workflow

1. Inspect every relevant file under `input/original/` and `input/sources/` before making semantic claims. Use `ocr-routing` for scans or difficult layout.
2. Use `content-library` to search for matching K/T/Q entities before assigning IDs. Never use a database shell or invent a scope.
3. Preserve exact wording, order, choices, diagrams, and source page/bbox evidence. Do not invent an answer when the source does not provide one.
4. Write the complete candidate to `output/ktq-result.json` using `assets/result-template.json` as a guide. Keep all image references workspace-relative.
5. Validate the exact file before calling the host:

   ```sh
   python3 {{SKILLS_ROOT}}/ktq-extraction/scripts/validate.py \
     output/ktq-result.json --workspace . \
     --receipt output/ktq-result.validation.json
   ```

   The receipt must contain `schema: "mathpilot.validation-receipt/v1"`,
   `skill: "ktq-extraction"`, `result_file: "output/ktq-result.json"`, the
   SHA-256 of the result bytes, `valid: true`, and a count.
6. Call `respond` exactly once with `{"result_file":"output/ktq-result.json","validation_file":"output/ktq-result.validation.json"}`. Do not rewrite either file after that call.

Each question needs a non-empty stem, supported `stem_format`, named `K_` components, one named `T_` type, difficulty in `[0,1]`, measurement targets tied to those IDs, a non-empty rubric, an answer object, source evidence, and an explicit `dedup_action` (`new`, `duplicate`, or `merge`). Exact normalized duplicates must not be marked `new`.
