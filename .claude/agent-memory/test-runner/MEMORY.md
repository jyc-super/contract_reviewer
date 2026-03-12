# Test Runner - Contract Risk Review (2026-03-12)

## Latest Test Run Status (2026-03-12)
- **Timestamp**: 2026-03-12 23:30 UTC
- **Framework**: Next.js 14 + TypeScript (strict mode)
- **Test Suite**: Vitest v2.1.9
- **Working Directory**: D:/coding/contract risk
- **Duration**: ~8.6 seconds

### Test Results
- **Total Test Files**: 3 passed
- **Total Tests**: 22 passed (0 failed, 0 skipped)
- **Status**: ALL TESTS PASSING ✓

### Test Files & Results
1. **lib/quota-manager.test.ts**: 3 tests PASSED
   - Quota manager functionality validated
2. **lib/docling-adapter.test.ts**: 11 tests PASSED
   - Health check: ✓
   - Retry logic (3 total attempts, 2 retries): ✓
   - Error codes (DOCLING_UNAVAILABLE, DOCLING_PARSE_FAILED): ✓
   - Buffer→Uint8Array→Blob conversion: ✓
   - Timeout/backoff behavior: ✓
3. **lib/document-parser.test.ts**: 8 tests PASSED
   - PDF parsing: ✓
   - DOCX parsing: ✓
   - Error handling: ✓
   - Parser always returns 'docling' type: ✓

## Services Status
- **Next.js Server**: Running on port 3000 (HTTP 200)
- **Docling Sidecar**: Running on port 8766/health (HTTP 200, status: ok)
- **Supabase**: NOT RUNNING (requires Docker Desktop)
- **.env.local**: Properly configured

## Key Observations

### Passing Critical Paths
1. **Docling sidecar health check**: 5-second timeout + polling every 1s ✓
2. **Parse retry strategy**: 1 original attempt + 2 retries (500ms, 1000ms backoff) ✓
3. **Error codes returned correctly**: 
   - HTTP 503 → DOCLING_UNAVAILABLE
   - HTTP 422/500 → DOCLING_PARSE_FAILED
   - Sidecar down → DOCLING_UNAVAILABLE timeout
4. **Data integrity**: Buffer→Uint8Array→Blob conversion validated ✓
5. **Always uses Docling**: parser field always "docling" (no fallback)

### Infrastructure Dependency
- Tests use vi.fn() mocks to simulate HTTP responses (unit tests, not integration)
- Real sidecar integration works correctly (confirmed startup)
- Supabase required for API contract upload (port 54321, needs Docker Desktop)

## Docling Sidecar Behavior
- **Status**: ok
- **Docling imported**: false (lazy mode)
- **Models ready**: false (preload_mode: true, will load on demand)
- **Response time**: <5ms for mocked/test requests
- **Port**: 8766 (configured via DOCLING_SIDECAR_URL env var)

## Notes for Next Session
- Docker Desktop NOT running → can't test full contract upload API
- Next.js dev server compiles routes on demand (~1.3-1.5s first request)
- All unit tests pass without Supabase (mocks HTTP layer)
- Real integration test (PDF upload) requires Supabase + Docker
- Sidecar startup time ~10 seconds, lazy model loading adds time on first parse
