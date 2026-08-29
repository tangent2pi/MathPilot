---
name: teaching-card
description: Build MathPilot native question cards or offline sandboxed teaching HTML as non-blocking, auditable artifacts. Use when interaction materially improves a teaching reply and a file-based card reference should be rendered in the learning conversation.
---

# MathPilot teaching cards

Use a card only when interaction materially helps the learner. Cards are optional and non-blocking; skipping or switching to free text is never a wrong answer.

- Simple choice, multiple-choice, judgment, fill-in, or short-answer interactions use `mathpilot.question-card/v1`; call `present_question_card` with the complete card object so the host renders the registered assistant-ui Tool UI.
- Rich visual explanation uses `$teaching-artifact-adapter` together with `$qwen-mm-plugins-edu-agent` and an offline `sandboxed_html` artifact. Do not call Qwen-MM `api`, DashScope, Qwen-TTS, or another model.
- Write rich formal artifacts to `/workspace/output/artifacts/<artifact_id>/` with an `mathpilot.learning-artifact/v1` manifest and only local files, then call `present_learning_artifact` with its identity and entrypoint. Read `input/session/thread.json` for the manifest `session_id`.
- HTML sends only `card.answer_submitted`, `card.skipped`, or `card.free_text_requested` through `parent.postMessage`; copy the one-time `interaction_token` from the iframe URL.
- A card does not grade itself, change mastery, or write formal content. The Teaching Agent and domain service keep those authorities.
- Include accessible labels, keyboard focus, reduced-motion handling, and text alternatives.

Read the adapter first and then the full upstream Edu Agent Skill before authoring Hyperframes HTML or video.

Start native cards from `assets/question-card-template.json`. Before leaving the file in an artifact directory, run:

```sh
python3 /opt/mathpilot-skills/teaching-card/scripts/validate_card.py /workspace/output/artifacts/<artifact_id>/card.json
```
