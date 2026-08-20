---
name: er-research
description: Build, reuse, deduplicate, validate, and submit error causes and diagnosis rules from a frozen KTQ result. Use for ER content-pipeline sessions that must remain separate from KTQ, inspect source media, query the scoped library, and optionally verify external evidence.
---

# ER research

## Boundary

This Skill owns E/R only. The frozen KTQ result in `/workspace/input/frozen/` is the input boundary; do not alter it or rerun KTQ. This must be a separate Pi Session and workspace from KTQ. The current SCNET main model performs any visual reasoning.

## Workflow

1. Use Bash to read the entire frozen KTQ result and any supplied originals. All paths are below `/workspace`; never use host transcript paths.
2. Read `$database` and query existing E/R pages before creating IDs. Reuse existing entities whenever their semantics match.
3. Derive plausible, discriminable learner errors and rules linked to the frozen K/T dimensions. Use `web_search`/`web_extractor` only when external evidence adds value; record sources and uncertainty.
4. Write `/workspace/output/er-result.json` from `assets/result-template.json`.
5. Validate the exact result:

   ```sh
   python3 /opt/agmath-skills/er-research/scripts/validate.py \
     /workspace/output/er-result.json \
     --frozen /workspace/input/frozen/ktq.json \
     --receipt /workspace/output/er-result.validation.json
   ```

6. Fix until valid, then call `respond` once with only:

   ```json
   {"result_file":"output/er-result.json","validation_file":"output/er-result.validation.json"}
   ```

The runtime reruns the validator. Never rewrite validated files after the receipt is produced.

## Required result rules

- Error IDs use `E_`; rule IDs use `R_`; IDs are unique.
- Every rule has a specific trigger, a useful probe, at least one valid error ID, and one or more K/T `dimension_ids` present in frozen KTQ.
- A rule may reference an existing E ID not repeated in `error_causes`, but it must be declared in `reused_error_causes`.
- Citations are structured URL/title records, never invented prose citations.
