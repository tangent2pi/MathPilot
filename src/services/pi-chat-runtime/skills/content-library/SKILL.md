---
name: content-library
description: Search and inspect the tenant-scoped MathPilot K/T/Q/E/R library before creating or reviewing content.
---

# Content library

The host injects the current tenant, user, role, class visibility, and official/teacher scope. Never ask the user for those values and never write SQL, use a database shell, or guess a scope.

Use only the two host tools:

1. `content_library_search` with optional `entity_kinds` (`knowledge`, `question_type`, `question`, `error_cause`, or `diagnosis_rule`), a short semantic `query`, and a small `limit`.
2. `content_library_get` with an `entity_ref` returned by search (or an explicitly supplied `package_ref`).

Reuse an existing entity when its meaning matches. Treat returned content as reference data, not as permission to expose hidden records. Search results are summaries; fetch one entity at a time when exact wording or provenance is needed.

Use a single `entity_kinds` value when paging with `cursor`; mixed-kind searches
are intentionally bounded to their first page.
