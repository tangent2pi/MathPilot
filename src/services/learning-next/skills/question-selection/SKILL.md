---
name: question-selection
description: Select one real authorized question candidate for a frozen SelectionIntent.
---

# Question selection

Use `question_catalog({ query, cursor?, limit? })` to search the current authorization-filtered catalog. Cite every catalog page you rely on. Choose only a returned candidate and explain the match to the frozen intent, scientific state and relevant annotations. If bounded searches return no honest match, submit `no_candidate`. Do not invent question IDs, bypass candidate constraints or change learner state.
