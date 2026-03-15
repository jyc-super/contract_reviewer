# Test Runner - Contract Risk Review (2026-03-14)

## Latest Test Run Status (2026-03-14)
- **Timestamp**: 2026-03-14 16:18 UTC
- **Framework**: Next.js 14 + TypeScript (strict mode)
- **Test Suite**: Vitest v2.1.9
- **Working Directory**: (프로젝트 루트)
- **Duration**: ~7.04 seconds

### Test Results
- **Total Test Files**: 3 passed
- **Total Tests**: 22 passed (0 failed, 0 skipped)
- **Status**: ALL TESTS PASSING

### Test Files & Results
1. **lib/quota-manager.test.ts**: 3 tests PASSED
2. **lib/docling-adapter.test.ts**: 11 tests PASSED
   - Health check, retry logic, error codes, Buffer->Blob conversion
3. **lib/document-parser.test.ts**: 8 tests PASSED
   - PDF/DOCX parsing, error handling, parser always 'docling'

### TypeScript Check
- `npx tsc --noEmit`: 0 errors (clean)
- Checked after: splitContentByClauses() + sectionsToClauses() multi-clause split in adapter

## Services Status
- **Docling Sidecar**: Running on port 8766 (status: ok, models_ready: true, pipeline: pdfplumber+Docling)
- **Supabase**: NOT RUNNING (requires Docker Desktop)
- **.env.local**: Properly configured

## Validated Fixes (2026-03-14, multi-clause split)
- `lib/docling-adapter.ts`: `splitContentByClauses()` added — splits content with 2+ clause boundaries
- `lib/docling-adapter.ts`: `sectionsToClauses()` uses splitContentByClauses for sub-clause split; heading fallback from content first line when section.heading is null
- `scripts/docling_sidecar.py`: `is_heading()` — structured numeric pattern bypass for length/comma early-return
- `scripts/docling_sidecar.py`: `_DEEP_NUMERIC_PATTERN` changed from `{3,}` to `{2,}` — protects 3-level+ clause numbers (1.1.1 and above) from merge
- `scripts/docling_sidecar.py`: `_split_multi_clause_sections()` added (Phase 3.6) — server-side content re-split before section list is returned
- Python syntax check: `python -m py_compile scripts/docling_sidecar.py` — EXIT 0 (clean)
- All 22 tests pass; tsc --noEmit clean after these changes

## Coverage Gap for Multi-Clause Split
- No test asserts that splitContentByClauses() correctly splits compound content
- No test validates that sectionsToClauses() heading fallback (from content first line) works
- Existing tests only check `result.clauses.length > 0`, not sub-split behavior

## Key Observations

### Passing Critical Paths
1. Docling retry strategy: 1 original + 2 retries (500ms, 1000ms backoff)
2. Error codes: HTTP 503 -> DOCLING_UNAVAILABLE, 422/500 -> DOCLING_PARSE_FAILED
3. Buffer->Uint8Array->Blob conversion validated
4. parser field always "docling" (no fallback)

### Infrastructure Notes
- Tests use vi.fn() mocks (unit tests, not integration)
- Supabase required for contract upload API (port 54321, needs Docker Desktop)
- Sidecar port: 8766 via DOCLING_SIDECAR_URL env var
- DOCLING_UNAVAILABLE tests use vi.useFakeTimers() + vi.advanceTimersByTimeAsync(32_000)
- Retry-delay tests (422/503 scenarios) take ~1.5s each due to real 500ms/1000ms sleep delays

## Known Code Issues (confirmed)
- `app/api/contracts/route.ts`: Shadow variable `message` declared twice in catch block
- `lib/quota-manager.ts`: `flash31Lite` and `flash3` have RPD_LIMITS of 0 — canCall() always false
- `lib/gemini.ts`: `gemini-3-flash` model ID for `flash3` may not exist

## Test Execution
- Test command: `npm test` → runs `vitest run`
- No `test-runner.md` at project root
- Include pattern: `**/*.test.ts`, `**/*.spec.ts`

## Critical Coverage Gaps
No test files exist for:
- `lib/pipeline/process-contract.ts`
- `app/api/contracts/route.ts`
- `lib/pipeline/steps/quality-check.ts`
- `lib/pipeline/steps/zone-rules.ts`
- `lib/pipeline/steps/split-clauses.ts`
- splitContentByClauses() unit behavior
- sectionsToClauses() heading-from-content-first-line fallback
