# Debugging Notes

## Windows Defender DLL Scan — Docling Sidecar Hang

### Symptom
`scripts\start_sidecar.bat` 실행 시 다음 위치에서 hang:
```
from docling.datamodel.pipeline_options import PdfPipelineOptions
  → pipeline_options_vlm_model.py
    → from transformers import StoppingCriteria  ← hang
```
첫 실행 시 10분~수 시간 소요 가능. 이후 실행은 빠름 (캐시됨).

### Root Cause
Windows Defender 실시간 보호가 `.venv/Lib/site-packages/torch/*.dll` 수백 개를 스캔.
Python process가 DLL을 load하려 할 때 Defender가 각각 검사 → blocking I/O.

### Solution Applied (2026-03-11)
Lazy import 전략으로 `docling_sidecar.py` 재작성 (v1.1 → v1.2):
1. 서버 시작 시 docling/torch import를 하지 않음
2. FastAPI + uvicorn만 import → 서버 즉시 기동
3. `/health` 엔드포인트는 import 전에도 즉시 응답
4. `DOCLING_PRELOAD_MODEL=false` 환경변수로 제어
5. `/parse` 첫 호출 시 `_import_docling()` → `_get_converter()` 실행
6. `_import_lock` (threading.Lock)으로 중복 import 방지

`run.bat` 변경:
- Python 모드 시작 시 `set DOCLING_PRELOAD_MODEL=false` 전달
- WAIT_SECONDS: 300 → 60 (서버 기동만 확인, 모델 로드 불필요)
- health check 조건: `models_ready: true` → `status: "ok"`

`lib/docling-adapter.ts` 변경:
- `isDoclingAvailable()`: `docling === true && models_ready === true` → `status === "ok" || docling === true`
- DOCLING_PARSE_TIMEOUT_MS = 120,000ms (2분) 유지 — 첫 parse DLL 스캔 시간 포함

### User Impact
- `run.bat` 실행 후 Next.js dev server가 빠르게 뜸 (이전: 5분 대기)
- 첫 파일 업로드 시 "처리 중..." 상태가 수 분 유지될 수 있음
- 두 번째 업로드부터는 빠름

### Permanent Fix (사용자 직접)
Windows Defender에 `.venv` 폴더 제외 추가:
```
Windows 보안 → 바이러스 및 위협 방지 → 설정 관리 → 제외 추가 → 폴더
→ D:\coding\contract risk\.venv 추가
```
이후에는 DOCLING_PRELOAD_MODEL=true로도 정상 동작.

---

## Large PDF Crash — std::bad_alloc / exit code 3221225477

### Symptom
215-page EPC contract PDF. Sidecar process exits mid-parse (around page 22-215) with:
- Python process exit code 3221225477 (0xC0000005 = Windows STATUS_ACCESS_VIOLATION)
- "std::bad_alloc" logged before crash (C++ heap exhaustion inside pdfium native library)
- The crash happens inside the pdfium page rasterization call, not in Python GC or torch

### Root Cause Chain (traced through Docling internals)

1. `docling_sidecar.py` calls `converter.convert(stream)` — no page limit, no page_range, no document_timeout set
2. `base_pipeline.py` `_build_document()` creates all 215 `Page` objects upfront, iterates in batches of `settings.perf.page_batch_size` (default=4)
3. `legacy_standard_pdf_pipeline.py` `initialize_page()` calls `conv_res.input._backend.load_page(i)` — this opens a pypdfium2 page handle backed by the ENTIRE document PDF already in C heap
4. `page_preprocessing_model.py` `_populate_page_images()` calls `page.get_image(scale=1.0)` then `page.get_image(scale=images_scale)` — both call `pypdfium2_backend.py` `get_page_image(scale=...)` which calls `pdfium.render(scale=scale*1.5)` — the 1.5x multiplier is hardcoded in the backend
5. Even with `images_scale=1.0` (the default), each page is rendered at 1.5x internally. A standard A4 page at 72 DPI base x 1.5 = 108 DPI. At that scale, each page raster is roughly (595*1.5) x (842*1.5) = 893 x 1263 pixels = ~3.3MB as RGB24. For 215 pages: 215 x 3.3MB = ~710MB heap pressure
6. Although `_image_cache` is cleared per page batch (`p._image_cache = {}`), pdfium's C-level bitmap allocations may not be immediately freed by CPython GC under Windows heap fragmentation. The pypdfium2 `PdfDocument` object stays fully loaded in the C heap for the full document lifetime
7. The layout model (DocLayNet) also holds its own intermediate tensors per batch, adding ~100-200MB on top
8. Total: ~700-900MB of raster data + torch model weights + Python overhead → crosses available virtual address space or physical RAM → pdfium `FPDFBitmap_Create` returns nullptr → C++ throws `std::bad_alloc` → Windows terminates the process with STATUS_ACCESS_VIOLATION (0xC0000005)

### Why exit code 3221225477 specifically
`std::bad_alloc` thrown inside pdfium's native code causes unhandled C++ exception propagation through the pypdfium2 ctypes boundary. Windows then terminates the process with a structured exception code: 0xC0000005 = `EXCEPTION_ACCESS_VIOLATION`. This is distinct from a Python-level exception — it cannot be caught by Python's `try/except`.

### What is Already Set Correctly
- `do_ocr=False` in `_get_converter()` — eliminates OCR model memory
- `do_table_structure=False` — eliminates table model memory
- `asyncio.to_thread()` used for the blocking `converter.convert()` call — correct

### What is Missing (Root Fix Options)

Option A — Lower `images_scale` to 0.5 (highest impact, ~75% memory reduction):
```python
pipeline_options.images_scale = 0.5
# Raster per page: 893x1263 → 447x631 px → ~0.8MB
# Total for 215 pages: ~175MB peak — within safe range
```

Option B — Set `document_timeout` to 120s (graceful partial result instead of crash):
```python
pipeline_options.document_timeout = 120.0
# After 120s, docling returns ConversionStatus.PARTIAL_SUCCESS with pages processed so far
# Sidecar must handle partial result (sections may be incomplete)
```

Option C — Reduce `page_batch_size` via environment variable (DOCLING_PERF_PAGE_BATCH_SIZE):
```
DOCLING_PERF_PAGE_BATCH_SIZE=1
# Docling's AppSettings reads DOCLING_ prefixed env vars (env_prefix="DOCLING_", delimiter="_")
# Setting=1 ensures Python GC runs between every page, reducing peak concurrent memory
```

Option D — Set `OMP_NUM_THREADS=1` in start_sidecar.bat before launching Python:
```
set OMP_NUM_THREADS=1
# Prevents OpenMP from spawning threads inside the layout model inference, reducing peak per-batch overhead
```

Option E — Page-range batching in the sidecar (most robust, requires sidecar code change):
The `converter.convert()` API accepts `page_range=(start, end)` as a tuple.
A batching wrapper could parse the document to get page count first, then call convert() in
batches of e.g. 30 pages, merging sections. This is the correct architectural fix for very large PDFs.

### Recommended Fix Priority
1. Apply Option A immediately (images_scale=0.5) — single line change in `_get_converter()`
2. Apply Option B (document_timeout=120) — safety net, returns partial data gracefully
3. Apply Option D (OMP_NUM_THREADS=1) in start_sidecar.bat — free win, no code change
4. Apply Option C (DOCLING_PERF_PAGE_BATCH_SIZE=1) — further reduces peak, slight throughput cost
5. Option E is the long-term correct fix but requires sidecar redesign

### Files to Change
- `scripts/docling_sidecar.py`: `_get_converter()` function, lines 117-124
- `scripts/start_sidecar.bat`: add `set OMP_NUM_THREADS=1` before the Python launch line (line 83)
- `.env.local` (or sidecar launch env): add `DOCLING_PERF_PAGE_BATCH_SIZE=1`
