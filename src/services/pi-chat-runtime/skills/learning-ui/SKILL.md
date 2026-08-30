---
name: learning-ui
description: Present MathPilot question cards and validated learning artifacts during a teaching conversation.
---

# Learning UI

Use `present_question_card` for a native choice, fill-blank, true/false, or short-answer card. Keep every card optional: the learner may skip it or continue with free text. Use a fresh `art_...` artifact ID and `card_...` card ID.

Use `present_learning_artifact` only after writing a complete candidate below `output/artifacts/<artifact_id>/`. Every candidate must contain `manifest.json`; native cards use `card.json`, sandboxed HTML uses `index.html`, and media entries live below `media/`. The manifest and every declared file must satisfy the tool schema exactly before presentation.

These tools present teaching UI only. Do not start a next-question fork, background grading, Dream, or any later workflow.
