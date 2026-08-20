---
name: teaching-artifact-adapter
description: Adapt the complete local Qwen-MM Edu Agent workflow into an offline, auditable MathPilot Learning Artifact. Use with qwen-mm-plugins-edu-agent when a teaching reply needs rich HTML, animation, or media rather than an ordinary text explanation or native question card.
---

# Teaching artifact adapter

Read `$qwen-mm-plugins-edu-agent` for its design system, components, examples, and deterministic visual checks. This adapter defines the MathPilot runtime and publication boundary around that upstream workflow.

## Runtime profile

- The current Pi Agent and SCNET main model perform all reasoning and visual interpretation.
- Do not call Qwen-MM `api`, DashScope, Qwen-VL, Qwen-Omni, Qwen-TTS, or another model. The runtime does not provide those credentials or tools.
- Use `$qwen-mm-plugins-core` for local media inspection, `$ocr-routing` for precision text/layout extraction, and Bash for workspace discovery and construction.
- Work offline. `hyperframes`, Chromium, ffmpeg, fonts, KaTeX, GSAP, and the complete Edu Agent asset tree are preinstalled.
- Treat `/workspace/input` as evidence. Build below `/workspace/tmp`; place candidates only below `/workspace/output/artifacts/<artifact_id>`.

The upstream voice step is optional in MathPilot. Prefer captioned interactive HTML. A video may be silent and must include visible captions plus a text alternative.

## Build and validate

1. Read the relevant upstream Edu Agent references and reuse its supplied assets.
2. Create the problem analysis, teaching script, storyboard, and one composition per scene in `/workspace/tmp`.
3. Initialize or refresh the local build without downloading packages:

   ```sh
   /opt/agmath-skills/teaching-artifact-adapter/scripts/init_hyperframes_offline.sh /workspace/tmp/dist
   ```

4. Run the upstream checks until they pass:

   ```sh
   python3 /opt/agmath-skills/edu-agent/scripts/precheck.py /workspace/tmp/dist
   ```

5. Copy only browser/runtime files into `/workspace/output/artifacts/<artifact_id>/`, create `manifest.json` from `assets/manifest-template.json`, then validate:

   ```sh
   python3 /opt/agmath-skills/teaching-artifact-adapter/scripts/validate_artifact.py \
     /workspace/output/artifacts/<artifact_id>
   ```

The runtime publisher independently validates hashes, MIME types, paths, and renderer policy before returning an `artifact://` reference.

## Publication contract

- Schema: `agmath.learning-artifact/v1`.
- Renderer: `sandboxed_html`, `native_card`, or `media`.
- HTML is self-contained and offline. It cannot use forms, browser storage, cookies, network APIs, external URLs, or dynamic code loading.
- Interactive HTML communicates only through `parent.postMessage` using `card.answer_submitted`, `card.skipped`, or `card.free_text_requested`, and echoes the one-time interaction token from the iframe URL.
- A card never grades itself, writes mastery, or changes a learner profile.
