# Contract Risk Review - Test Runner Memory

## Test Execution
- Test command: `npm test` → runs `vitest run`
- Test runner: Vitest v2.1.9, config at `vitest.config.ts`
- Include pattern: `**/*.test.ts`, `**/*.spec.ts`
- No `test-runner.md` at project root — agent instructions are in `.cursor/agents/test-runner.md`

## Test Files
- `lib/quota-manager.test.ts` — 3 tests, all pass consistently (unit, no external deps)
- `lib/docling-adapter.test.ts` — 11 tests, 1 failing (timeout); 10 pass
- `lib/document-parser.test.ts` — 8 tests, 3 failing (timeout); 5 pass
- No test files exist for: process-contract, API routes, upload page

## Environment (updated 2026-03-11)
- `.env.local` NOW contains:
  - `DOCLING_SIDECAR_URL=http://127.0.0.1:8766` (port 8766, NOT 8765)
  - `DOCLING_REQUIRED=true`
  - `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` (local Supabase)
  - `SUPABASE_SERVICE_ROLE_KEY=` (demo local key)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY=` (demo local key)
  - GEMINI_API_KEY — NOT in .env.local but `/api/settings/status` reports geminiConfigured:true (set in system env or process)
  - ENCRYPTION_KEY — NOT in .env.local
- Docling sidecar: UNAVAILABLE as of 2026-03-11 (curl exit 7 = connection refused on both 8765 and 8766)
- Next.js dev server: RUNNING on localhost:3000 as of 2026-03-11

## Critical Coverage Gaps
These files have ZERO test coverage:
- `lib/docling-adapter.ts` (core parsing, timeout/retry logic)
- `lib/document-parser.ts`
- `lib/pipeline/process-contract.ts`
- `app/api/contracts/route.ts`
- `lib/pipeline/steps/quality-check.ts`
- `lib/pipeline/steps/zone-rules.ts`
- `lib/pipeline/steps/split-clauses.ts`

## Live API Upload Test (2026-03-11, QNLP.ITB.P2 EPC Contract.pdf, 1.85MB)
- POST /api/contracts returned HTTP 503 in 10.7s
- Response: `{"ok":false,"code":"DOCLING_UNAVAILABLE","message":"Docling sidecar is not ready. Prepare the sidecar and retry upload.","error":"Docling sidecar is not ready. Prepare the sidecar and retry upload."}`
- Behavior matches policy exactly: 10s health-wait exhausted, threw DoclingParseError(DOCLING_UNAVAILABLE), caught in route.ts, returned 503 + structured error body
- Note: parse timeout is 120s (DOCLING_PARSE_TIMEOUT_MS=120_000), NOT 10s. The 10s is DOCLING_READY_WAIT_MS for health polling.

## Known Code Issues (confirmed 2026-03-10)
- `lib/docling-adapter.ts` line 40-42: Constant names use `DOCILING_*` (typo, missing 'N') — not a runtime bug but misleading
- `lib/pipeline/steps/extract-text.ts`: Still imports `pdf-parse` and `mammoth` (fallback parsers) — contradicts Docling-required policy. These are in `optionalDependencies` so may not be installed, but the code path exists.
- `extract-text.ts` is UNUSED by the main pipeline (`process-contract.ts` does not call it) — dead code risk
- `app/api/contracts/route.ts`: Shadow variable `message` declared twice in the catch block (outer `const message` then inner `const message` inside `if (err instanceof DocumentParseError)`) — outer variable is dead
- `lib/quota-manager.ts`: `flash31Lite` and `flash3` have RPD_LIMITS of 0 — `canCall()` will always return false for these models
- `lib/gemini.ts`: References `gemini-3-flash` as MODEL_CONFIG for `flash3` — this model ID may not exist in Gemini API

## run.bat Behavior
- Checks Node.js, optional firewall rule, npm install
- Checks Docker → tries `npx supabase start` if Docker available
- Runs `scripts/ensure-local-env.js`
- Checks Docling sidecar health (10-second wait loop)
- Launches `npm run dev` (Next.js on 0.0.0.0:3000)
- Does NOT run tests — tests must be run separately via `npm test`

## TypeScript
- `npx tsc --noEmit` passes cleanly (no type errors as of 2026-03-10)
- Still passes after adding docling-adapter.ts and document-parser.ts

## Known Flaky/Failing Tests (as of 2026-03-10)
### Root cause: "DOCLING_UNAVAILABLE" timeout tests hang 10+ seconds each
- `parseWithDoclingRequired` calls `isDoclingAvailable()` first (2s AbortSignal timeout)
- If false, enters `waitForDoclingReady(10_000)` — 10-second polling loop with 1s sleep intervals
- Tests mocking `fetch` to reject immediately still trigger the full 10s wait loop
- Vitest default testTimeout is 5000ms → test times out before `waitForDoclingReady` completes
- Affected tests (all use `mockRejectedValue(new Error("ECONNREFUSED"))` on ALL fetch calls):
  - `docling-adapter > parseWithDoclingRequired > throws DOCLING_UNAVAILABLE when sidecar is not available`
  - `document-parser > parsePdf > throws DocumentParseError with DOCLING_UNAVAILABLE when sidecar is down`
  - `document-parser > parsePdf > error is instance of DocumentParseError`
  - `document-parser > parseDocx > throws DocumentParseError with DOCLING_UNAVAILABLE when sidecar is down`
- FIX OPTION A: Add `{ timeout: 15000 }` to each affected `it()` call
- FIX OPTION B: Reduce `DOCLING_READY_WAIT_MS` constant via env var in tests
- FIX OPTION C (preferred): Mock `waitForDoclingReady` or `isDoclingAvailable` directly using `vi.mock`
  so the polling loop is bypassed entirely in unit tests
- Tests that mock /health separately (returning ok:true for health, error for /parse) work fine
  because `isDoclingAvailable()` returns true → skips polling → proceeds to parse immediately
