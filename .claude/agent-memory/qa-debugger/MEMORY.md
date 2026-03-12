# QA Debugger Agent Memory

## Project Structure (Key Files)
- `scripts/docling_sidecar.py` — FastAPI sidecar v1.2.0, lazy import mode
- `scripts/start_sidecar.bat` — venv at root `.venv`, port 8766
- `lib/docling-adapter.ts` — DOCLING_PARSE_TIMEOUT_MS=300_000ms (5 min), DOCLING_READY_WAIT_MS=30_000ms, isDoclingAvailable() checks status:"ok"
- `lib/sidecar-manager.ts` — HEALTH_POLL_TIMEOUT_MS=60_000ms, spawns with DOCLING_PRELOAD_MODEL=true (preload mode)
- `run.bat` — Python mode waits 60s for /health (not models_ready), sets DOCLING_PRELOAD_MODEL=false
- `lib/document-parser.ts`, `lib/pipeline/process-contract.ts` — pipeline core

## Confirmed Patterns

### Windows Defender DLL Scan (Critical)
- Root cause: torch/*.dll scanned by Defender on first Python import of docling/transformers
- Symptom: hang at `from transformers import StoppingCriteria` in pipeline_options_vlm_model.py
- Fix applied: lazy import mode in docling_sidecar.py (DOCLING_PRELOAD_MODEL=false)
  - Server starts immediately, /health responds before any docling import
  - DLL scan happens only at first /parse request
  - run.bat now only waits for /health status:"ok" (not models_ready:true)

### isDoclingAvailable() Logic
- v1.1 sidecar returned `{ docling: true, models_ready: bool }`
- v1.2 sidecar returns `{ status: "ok", docling_imported: bool, models_ready: bool }`
- adapter checks `status === "ok" || docling === true` for backward compat
- DO NOT require models_ready:true in availability check (breaks lazy mode)

### Port Configuration (verified and fixed 2026-03-11)
- Canonical sidecar port: **8766** everywhere
- `start_sidecar.bat`: SIDECAR_PORT=8766, sets DOCLING_SIDECAR_PORT before python launch
- `docling_sidecar.py`: default port now **8766** (was 8765 — bug fixed)
- `run.bat` curl health check: http://127.0.0.1:8766
- `docling-adapter.ts` getSidecarUrl() fallback: http://127.0.0.1:8766
- `.env.local` / `.env.example`: DOCLING_SIDECAR_URL=http://127.0.0.1:8766
- OLD BUG: sidecar default was 8765 but everything else used 8766; direct python invocation without
  DOCLING_SIDECAR_PORT env would bind 8765, causing DOCLING_UNAVAILABLE on every upload

### isDoclingAvailable() Timeout
- Health check AbortSignal.timeout: **5_000ms** (raised from 2s on 2026-03-11)
- Rationale: FastAPI init on lazy-start Python can take >2s; 5s gives a buffer
- DOCLING_READY_WAIT_MS = 10_000 (10s poll window, 1s sleep interval)
- With 5s health timeout + 1s sleep: ~2 attempts fit in 10s window

### Timeout Values
- DOCLING_PARSE_TIMEOUT_MS = 300_000 (5 min) — covers DLL scan + large-PDF multi-batch (e.g. 215 pages × 40s/batch)
- DOCLING_READY_WAIT_MS = 30_000 (30s) — health poll before parse attempt (extended for auto-start sidecar)
- run.bat WAIT_SECONDS = 60 (Python lazy mode, server startup only)
- sidecar-manager HEALTH_POLL_TIMEOUT_MS = 60_000 (60s) — wait after spawn for /health

### Async 202 Upload Pattern (route.ts)
- POST /api/contracts inserts a contract row (status="parsing"), returns 202 immediately
- Background runParseAndPersist() runs processContract() + DB writes after 202 is sent
- Supabase insert is race-conditioned with 5s timeout → 503 SUPABASE_UNREACHABLE on timeout
- If supabase is null (no config), falls back to sync path (Path B) — returns full result inline
- Client polls /api/contracts/[id]/status (3s interval, 3 failure limit)

### Error Message Quality
- parseWithDoclingRequired() error includes the sidecarUrl in message for easy diagnosis
- Format: "Docling sidecar is not responding at <URL>. Ensure the sidecar is running..."

### Large PDF Memory Crash (std::bad_alloc / exit 3221225477)
- Exit code 3221225477 = 0xC0000005 = Windows STATUS_ACCESS_VIOLATION (heap corruption from OOM)
- std::bad_alloc is C++ OOM raised inside pypdfium2's native pdfium library during page rasterization
- Root causes in priority order:
  1. `get_page_image()` calls pdfium `render(scale=1.5*images_scale)` for EVERY page, holding all PIL images in `_image_cache` dict simultaneously (layout model reads them); 215 pages × ~A4 at scale 1.5 = massive heap
  2. `page_batch_size = 4` (settings.perf) means only 4 pages processed at once, BUT the pypdfium2 `PdfDocument` object keeps all 215 pages open in the C heap simultaneously — the document is not streamed
  3. `do_ocr=False`, `do_table_structure=False` already set in sidecar — good, but layout model still rasterizes every page
  4. `_image_cache` is cleared after each page batch (`p._image_cache = {}`) but PIL GC may not release the C-level pdfium bitmap memory fast enough under Windows heap pressure
- Key levers available in `_get_converter()` via PdfPipelineOptions:
  - `images_scale` (default 1.0 in PdfPipelineOptions): lower to 0.5 to cut raster memory by 75%
  - `generate_page_images=False` (already default) — do NOT enable
  - `generate_picture_images=False` (already default) — do NOT enable
  - `document_timeout`: set to ~120s to get PARTIAL_SUCCESS instead of crash
  - `accelerator_options`: force CPU, set `num_threads=1` to reduce per-page parallelism
- Environment lever: `DOCLING_PERF_PAGE_BATCH_SIZE=1` (maps to settings.perf.page_batch_size) — process 1 page at a time, allows GC between pages
- Environment lever: `OMP_NUM_THREADS=1` reduces OpenMP thread parallelism inside torch/layout model
- See debugging.md for proposed fix code sketch
