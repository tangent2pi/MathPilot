---
name: ocr-routing
description: Decide when to inspect original media with Qwen Core and when to use PaddleOCR-VL for precise text, layout, formula, bbox, or page extraction. Use for any uploaded scan, image, PDF, Office file, photographed worksheet, or handwritten draft.
---

# Original media and OCR routing

Use this Skill whenever an image, scan, PDF, Office document, photographed worksheet, or handwritten draft must be understood.

1. Inspect the original first with the SCNET image input or Qwen Core. Preserve visual semantics such as geometry, auxiliary lines, arrows, circling, spatial grouping, handwriting, and color.
2. If the whole page is already readable and precise structure is not needed, continue from the original. Do not OCR merely to satisfy a workflow.
3. Use `paddleocr_vl` when text/formulas are too small, the page is curved/skewed, layout is complex, reading order or tables matter, or precise page/block positions are required.
4. Treat OCR as a derived evidence layer. Keep its Markdown/layout/bbox/image output together with the original path and never replace the original. Move every result needed after this run from `/workspace/tmp` into `/workspace/output/ocr-evidence/<document>/`; `tmp` is released when the turn ends.
5. When OCR identifies a relevant bbox, use Core `crop`, `draw_bbox`, or `save_view` on the original and visually verify it.
6. For student drafts, OCR text alone is insufficient. Always return to the original before reasoning about geometry, auxiliary lines, annotations, or method structure.
7. Work with paths below `/workspace`; never send credentials or database exports to OCR.

If OCR is used, copy `assets/evidence-template.json` to `/workspace/output/ocr-evidence.json`, record the original and every retained derived file below `output/ocr-evidence/`, then run:

```sh
python3 /opt/mathpilot-skills/ocr-routing/scripts/validate_evidence.py /workspace/output/ocr-evidence.json --workspace /workspace
```

External API use may incur cost. Use the smallest necessary file/region and report when OCR was actually invoked.
