---
name: ktq-extraction
description: Extract and validate K/T/Q candidates from teaching material during an ordinary MathPilot conversation when the user asks for KTQ content work.
---

# KTQ extraction

This Skill owns knowledge components, question types, and questions only. Do not create E/R entities and do not start ER automatically. A teacher may use this in an ordinary thread; the host creates a review candidate set only after a validated `respond` call.

## Workflow

1. Inspect every relevant file under `input/original/` and `input/sources/` before making semantic claims. Use Core's `media_info`/`read_image`/`read_video` for visual originals. For searchable PDFs use the preinstalled `pdfinfo`, `pdftotext`, `qpdf`, or Python `PyPDF2`; use `ocr-routing` for scans or difficult layout.
2. Use `content-library` to search for matching K/T/Q entities before assigning IDs. Search question stems in small batches and follow cursors when needed; inspect likely matches with content_library_get before marking duplicate or merge. Reuse matching entity IDs. Never claim full deduplication from one limited search or when the search failed. Never use a database shell or invent a scope.
3. Preserve exact wording, order, choices, diagrams, and source page/bbox evidence. Do not invent an answer when the source does not provide one.
4. Write the complete candidate to `output/ktq-result.json` using `assets/result-template.json` as a guide. Keep all image references workspace-relative.
   When the host message supplies a `supersedes_candidate_set_id`, preserve that exact value at the result top level and keep the original entity IDs for items being revised.
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
7. After successful registration, give a short Chinese final reply summarizing the actual question count, deduplication results and unresolved source/answer issues. Tell the teacher to review the card below. Registration is NOT approval or completion of the library package; wait for the teacher's explicit review decision before ER.

Each question needs a non-empty stem, supported `stem_format`, named `K_` components, one named `T_` type, difficulty in `[0,1]`, measurement targets tied to those IDs, a non-empty rubric, an answer object, source evidence, and an explicit `dedup_action` (`new`, `duplicate`, or `merge`). Exact normalized duplicates must not be marked `new`.

For a duplicate, set `question_id` to the verified existing question entity ID; a `dedup_action` label alone does not reuse the database entity. For suspected merges, explain differences to the teacher and leave the item for review rather than silently claiming that different source versions were merged.
