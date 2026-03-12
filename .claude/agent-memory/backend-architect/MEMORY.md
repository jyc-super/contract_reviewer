# Backend Architect Agent Memory

## Docling Sidecar Integration

### Error Codes
- `DOCLING_UNAVAILABLE` — sidecar not reachable (503)
- `DOCLING_PARSE_FAILED` — sidecar reachable but parse failed (503)

### Key Constants (lib/docling-adapter.ts)
- `DOCLING_READY_WAIT_MS` = 30_000 (30s) — wait for health on upload
- `DOCLING_PARSE_TIMEOUT_MS` = 300_000 (300s) — raised from 180s to cover large-PDF batch processing
- `DOCLING_PARSE_RETRIES` = 2
- Default sidecar URL: `http://127.0.0.1:8766`

### Large-PDF Memory Crash — TextOnlyPdfPipeline (2026-03-12)

Windows std::bad_alloc on 226-page PDF. Root cause: `PagePreprocessingModel._populate_page_images()`
calls `page.get_image(scale=1.0)` unconditionally — no option disables it in StandardPdfPipeline.
`force_backend_text=True` on `PdfPipelineOptions` is completely ignored by StandardPdfPipeline (only vlm_pipeline uses it).
`SimplePipeline` does not support PDF backends.

Fix: `TextOnlyPdfPipeline` — `LegacyStandardPdfPipeline` subclass with `BasePipeline.__init__` only
(skips DocLayNet + enrichment models), custom `build_pipe` with no rasterization.
See: `.claude/agent-memory/backend-architect/docling-2.77-layout-disable.md`

Current env vars (scripts/docling_sidecar.py):
- `DOCLING_BATCH_SIZE=20` — pypdfium2 page-range slicing, default 20, still needed because
  `get_segmented_page()` also OOMs on full 226-page doc (text extraction layer)
- `DOCLING_LOW_MEMORY`, `DOCLING_IMAGES_SCALE`, `DOCLING_DO_PAGE_ENRICH` — REMOVED (no longer used)

### Auto-start Architecture (instrumentation.ts + lib/sidecar-manager.ts)
- `instrumentation.ts` at project root, `instrumentationHook: true` in next.config.mjs
- `lib/sidecar-manager.ts` uses `globalThis.__docling_sidecar__` singleton — survives HMR
- Python exe path: `{project root}/.venv/Scripts/python.exe` (Windows venv)
- Sidecar script: `scripts/docling_sidecar.py`
- Spawned with `DOCLING_PRELOAD_MODEL=true` — models pre-loaded at startup to avoid first-request delay
- Health poll timeout: 60s in sidecar-manager, 30s in docling-adapter
- Shutdown: SIGTERM then SIGKILL after 3s (Windows ignores SIGTERM)
- Skip conditions: `VERCEL=1`, `DOCLING_AUTO_START=false`, non-nodejs runtime

### Async 202 Upload Architecture (2026-03-11, supersedes withTimeout approach)
Root cause of timeout: sidecar batches 50 pages at a time sequentially inside a single HTTP call.
215-page PDF = 5 batches × ~60s = ~300s+. No partial streaming from sidecar.

`POST /api/contracts` now:
1. Validates file type (extension only — fast).
2. Inserts contract row with `status="parsing"` → returns `202 Accepted + {ok:true, contractId, status:"parsing"}` immediately.
3. Fires `void runParseAndPersist(supabase, contractId, file)` — background, no await.
4. Background: `processContract()` → `persistParseResult()` → updates contract to `ready|filtering|error`.

Client polls `GET /api/contracts/[id]/status` (returns `{status, done, updatedAt, pageCount}`).
`done: true` when status is NOT `parsing` or `uploading`.

Path B fallback (no Supabase): synchronous 200 inline with `data`, unchanged behavior.

DB status flow: `parsing` → `ready` | `filtering` | `error`
`page_count` and `source_languages` are null until parse completes (set in persistParseResult).

Upload page client timeout reduced from 300s to 30s (just covers the initial POST + DB insert).

### Pipeline Observability (2026-03-11)
- `[DoclingAdapter]` prefix: per-stage timing logs added to lib/docling-adapter.ts
- `[processContract]` prefix: per-step timing in lib/pipeline/process-contract.ts
- clause count mismatch (rawClauses vs qc.clauses) logs a console.warn — zoneIndex clamps to 0

### run.bat Behavior
- Default: jumps to `npm run dev` immediately (auto-start via instrumentation.ts)
- Fallback/manual mode: set `DOCLING_AUTO_START=false` to use old sidecar pre-start logic

## Project Structure
- `lib/docling-adapter.ts` — Buffer→Uint8Array→Blob pattern, parse+health logic
- `lib/document-parser.ts` — parsePdf/parseDocx, throws DocumentParseError
- `lib/pipeline/process-contract.ts` — parserUsed value must be `"docling"`
- `lib/sidecar-manager.ts` — Node.js child_process singleton for sidecar lifecycle
- `instrumentation.ts` — Next.js 14 hook, project root (no src/ directory)
- `app/api/contracts/route.ts` — 503 on Docling failure

## Supabase Client Timeout Issues (CRITICAL)

### Windows ~600s TCP Hang
`@supabase/supabase-js` auth.getUser() and all postgrest queries have NO built-in timeout.
When Supabase URL resolves but the instance is stopped (e.g. local dev at 127.0.0.1:54321),
calls hang ~600s (Windows default TCP timeout). Fix: Promise.race with setTimeout sentinel.

Applied in:
- `lib/auth/server.ts`: AUTH_TIMEOUT_MS=4_000 wraps supabase.auth.getUser()
- `app/api/contracts/route.ts`: 5_000ms race wraps the initial placeholder insert

### postgrest-js v2.98.0 — .abortSignal() does NOT exist
`PostgrestBuilder` in `@supabase/postgrest-js` v2.98.0 has no `.abortSignal()` method.
Must use Promise.race pattern. Cast: `queryChain as unknown as Promise<T>` to satisfy strict.
Error: "Property 'abortSignal' does not exist on type 'PostgrestBuilder<any,...>'"

### Full Supabase Error Code Set (2026-03-12)
- `SUPABASE_UNAVAILABLE` — 503, `getAdminSupabaseClientIfAvailable()` returned null (no config)
- `SUPABASE_UNREACHABLE` — 503, TCP timeout (5s race) on insert or status query
- `SUPABASE_SCHEMA_MISSING` — 503, PG code PGRST205/42P01 or "schema cache" in message
- `SUPABASE_PERMISSION_DENIED` — 503, PG code 42501 or "permission denied" in message
- `SUPABASE_INSERT_FAILED` — 503, any other insert error not matched above

See also: `.claude/agent-memory/backend-architect/supabase-error-handling.md`

### 5s Timeout Applied In
- `app/api/contracts/route.ts` — initial contract insert (Path A)
- `app/api/contracts/[id]/status/route.ts` — status query GET handler

## Docker Desktop WSL2 Port Forwarding — CRITICAL (2026-03-12)

Docker Desktop with WSL2 backend: `127.0.0.1:54321` (and all container ports) appear LISTENING
in `netstat` but TCP connections TIME OUT from Windows processes (node.exe, PowerShell, curl).

Root cause: Docker Desktop's Windows-side port-forwarding proxy (`com.docker.backend.exe` /
`wslrelay.exe`) accepts TCP SYN but does not relay traffic.

Fix: Use the docker-desktop WSL distro's eth0 IP instead of 127.0.0.1.
To find it: `wsl -d docker-desktop ip addr show eth0`
Set in `.env.local`: `NEXT_PUBLIC_SUPABASE_URL=http://<WSL_IP>:54321`

Example (2026-03-12): `172.18.98.146` — this IP changes on WSL2 restart, so check after reboots.

Diagnosis commands:
- `wsl -d docker-desktop ip addr show eth0` — get current WSL IP
- `Test-NetConnection -ComputerName 172.18.98.146 -Port 54321` — verify reachability
- Docker containers internal access still works: `docker exec <container> curl http://kong:8000`

This ALSO means: always test connectivity from node.exe (Windows), not from bash/MSYS2 tools,
since MSYS2 curl/node may use different socket layers and give different results.

## TypeScript
- Strict mode, no `any`
- `globalThis` declarations need `declare global { var ... }` block
- `__dirname` available in Node.js runtime (used in sidecar-manager for path resolution)

## Cost Constraints
- Vercel Hobby + Supabase Free + Gemini Free Tier only
- No paid services

See: `docs/` for migration and setup guides.
