---
name: Docling 2.77 layout model disable findings
description: How to fully disable DocLayNet and rasterization in Docling 2.77 StandardPdfPipeline for OOM-safe large PDF processing
type: project
---

## Root Cause Analysis (Docling 2.77.0)

### What does NOT work

- `force_backend_text=True` on `PdfPipelineOptions`: **only read by `vlm_pipeline.py`**, completely ignored by `StandardPdfPipeline` (threaded). Setting this has zero effect.
- `SimplePipeline`: only supports `DeclarativeDocumentBackend`, fails with "Pipeline SimplePipeline failed" for PDF files.
- `layout_options.model_spec = None`: crashes — required field type `LayoutModelConfig`, not optional.
- `do_page_enrichment`: field does not exist in Docling 2.77 `PdfPipelineOptions`.

### Root cause of std::bad_alloc

`PagePreprocessingModel._populate_page_images()` calls `page.get_image(scale=1.0)` **unconditionally** (hardcoded, not controlled by any option). On a 226-page PDF loaded as a single document, pypdfium2 runs out of memory rasterizing all pages.

`LayoutModel.__init__` imports `LayoutPredictor` immediately — no `enabled=False` path exists.

### Correct Solution: TextOnlyPdfPipeline

Subclass `LegacyStandardPdfPipeline`, call **only `BasePipeline.__init__`** (skip all intermediate `__init__` methods to avoid DocLayNet + enrichment model loading), then replace `build_pipe` with:

1. `_TextOnlyPreprocessing`: calls `page._backend.get_segmented_page()` only (no `page.get_image()`)
2. `_NullModel`: OCR pass-through
3. `_TextCellLayoutModel`: converts `page.cells` → `Cluster(label=DocItemLabel.TEXT)` list → `LayoutPrediction`, so `PageAssembleModel` can collect text without DocLayNet
4. `_NullModel`: table structure pass-through
5. `PageAssembleModel`: standard assembly

MRO: `TextOnlyPdfPipeline → LegacyStandardPdfPipeline → PaginatedPipeline → ConvertPipeline → BasePipeline`
- Skip `LegacyStandardPdfPipeline.__init__`: calls `layout_factory.create_instance()` → DocLayNet load
- Skip `ConvertPipeline.__init__`: instantiates `DocumentPictureClassifier` etc.
- Call only `BasePipeline.__init__`: initializes `build_pipe=[]`, `enrichment_pipe=[]`, `artifacts_path`, `keep_images=False`

### OOM remains in get_segmented_page

`page._backend.get_segmented_page()` (PDFium text extraction) still OOMs past ~page 22 on the 226-page PDF when processing the full document in one shot. The existing `_BATCH_SIZE=20` (pypdfium2 page slicing via `_parse_pdf_in_batches()`) resolves this — 20-page slices all return `SUCCESS`.

### Verified results

Tested with `test_contract.pdf` (226 pages):
- Pages 1-20: SUCCESS, 61,396 chars
- Pages 100-120: SUCCESS, 57,482 chars
- Pages 200-220: SUCCESS, 21,611 chars
- No OOM, no DocLayNet, no rasterization

### Implementation file

`scripts/docling_sidecar.py`: `_make_text_only_pipeline_cls()` + `_get_converter()`
