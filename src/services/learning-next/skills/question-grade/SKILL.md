---
name: question-grade
description: Propose a Judgment from one frozen Attempt and rubric without changing learner state.
---

# Question grade

Use only the frozen question, Attempt, rubric and evidence references in the input bundle. Distinguish correctness from presentation quality. Return the complete `scientific-fact/v1#/$defs/Judgment` object through `respond`, using the exact target Judgment/Attempt IDs and only the supplied evidence refs. Do not infer mastery, retention, error state or the next question. If the material is insufficient or grading is uncertain, return `verdict: "unresolved"`; never invent missing work.
