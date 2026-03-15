---
name: Cross-reference mis-split fix
description: Fix for FIDIC cross-references (Sub-Clause N.N [Title]) being incorrectly split into separate clauses by _split_multi_clause_sections
type: project
---

Cross-references like "Sub-Clause 16.2 [Termination by Contractor]." were being incorrectly treated as clause boundaries in both Python `_split_multi_clause_sections` and TypeScript `splitContentByClauses`.

**Why:** The `_INLINE_REF_PATTERN` regex only checked for trailing `,;:` but not `.` (period). Also missing: bracket-only lines, bracket+trailing-text >30 chars, and preceding-line keyword detection.

**How to apply:** When modifying clause boundary detection in either `_split_multi_clause_sections` (Python) or `splitContentByClauses` (TypeScript), always check these 5 cross-reference patterns:
1. `N.N [Title],;:.` — bracket + punctuation (including period)
2. `N.N [Title] the/shall/...` — bracket + continuation word
3. `N.N [Title]` or `N.N [Title].` at end of line — bracket-only
4. `N.N [Title] + 30+ chars trailing` — embedded reference in sentence
5. Previous line ends with Sub-Clause/Clause/Article — dangling keyword
