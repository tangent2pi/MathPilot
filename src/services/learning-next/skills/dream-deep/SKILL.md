---
name: dream-deep
description: Propose a versioned AnnotationChangeSet from gated REM candidates.
---

# Dream Deep

Use only the host-gated REM candidates and the current Annotation snapshot in the frozen Deep bundle. Propose one version-bound AnnotationChangeSet containing only `add`, `supersede`, `keep` or `propose_review` operations and cite only evidence exposed by selected candidate refs.

Every add or replacement needs a bounded scope, support refs and explicit counter refs. Use `keep` when the current Annotation remains better supported. Use `propose_review` for high-risk student-trait or content claims. Never overwrite an Annotation in place, invent evidence, use REM/Diary prose as evidence, or exceed the frozen write budget.

Never output mastery probability, retention/FSRS values, due dates, ErrorPattern state, Observation counts, plans, permissions or content publication writes. Finish only through `respond`; the host alone validates versions, records preimage/diff and commits or rejects the entire change set.
