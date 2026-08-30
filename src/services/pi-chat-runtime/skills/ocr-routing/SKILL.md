---
name: ocr-routing
description: Decide whether original teaching media needs visual inspection or bounded OCR before content extraction.
---

# Original media and OCR routing

Use this Skill for scans, images, PDFs, Office files, photographed worksheets, or handwritten drafts.

1. Inspect the original first with the available Pi image input or file tools. Preserve geometry, diagrams, arrows, handwriting, and color.
2. Do not OCR a page that is already readable when precise text/layout is unnecessary.
3. Use the host's OCR capability only for small or unclear text, complex layout/tables, formulas, reading order, or exact page/block positions. Process at most four consecutive pages per request.
4. Treat OCR as derived evidence. Read the complete checkpoint before requesting another batch and retain page/bbox references below `output/ocr-evidence/`.
5. Return to the original before reasoning about a student's geometry, annotations, or method.
6. Keep every path below the current workspace. Never send credentials or database exports to OCR.
7. If OCR was used, copy `assets/evidence-template.json` to
   `output/ocr-evidence.json`, retain the derived files under `output/`, and
   run:

   ```sh
   python3 {{SKILLS_ROOT}}/ocr-routing/scripts/validate_evidence.py \
     output/ocr-evidence.json --workspace .
   ```
