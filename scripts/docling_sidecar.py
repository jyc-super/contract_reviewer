# -*- coding: utf-8 -*-
"""
Docling 사이드카 서버 — FastAPI + pdfplumber + Docling
PDF/DOCX를 시맨틱 구조로 파싱하여 Next.js에 JSON으로 반환.
포트: 8766 (DOCLING_SIDECAR_PORT 환경변수로 변경 가능)

설치: pip install -r scripts/requirements-docling.txt
실행: python -X utf8 scripts/docling_sidecar.py
      또는 scripts/start_sidecar.bat

Lazy import 전략:
- 서버 시작 시 docling/torch 계열 import를 하지 않음 → /health 즉시 응답
- DOCLING_PRELOAD_MODEL=true  → startup 시 백그라운드 스레드로 preload (기본값)
- DOCLING_PRELOAD_MODEL=false → 첫 /parse 요청 시 lazy load (Windows Defender 회피)

파이프라인: pdfplumber 우선 + Docling fallback
- PDF: pdfplumber 기반 네이티브 텍스트/표 추출 (래스터라이제이션 없음, bad_alloc 불가)
  - 텍스트 커버리지 100%, 처리 시간 15~25초, 표 구조 벡터 라인 기반 Markdown 변환
  - pdfplumber 결과 없을 경우 Docling TextOnlyPdfPipeline으로 fallback
- DOCX: Docling 경로 그대로 유지

Docling TextOnlyPdfPipeline (fallback, Docling 2.77 기준):
- LegacyStandardPdfPipeline 서브클래스 — DocLayNet 및 래스터라이제이션 완전 제거
- 이유: StandardPdfPipeline(threaded)의 PagePreprocessingModel이 page.get_image(scale=1.0)을
        무조건 호출하여 대용량 PDF에서 std::bad_alloc 발생 (force_backend_text=True 무효)
- 네이티브 PDF 텍스트 셀을 Cluster 로 직접 변환 → OOM 없이 226+ 페이지 처리 가능

메모리 절감 설정:
- DOCLING_BATCH_SIZE=20     → Docling fallback 시 페이지 배치 크기 (0 = 배치 비활성, 기본 20)
                               pdfplumber는 페이지 배치 없이 전체 문서 스트리밍 처리
"""

import gc
import os
import io
import sys
import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# ─── UTF-8 stdout/stderr (Windows cp949 UnicodeEncodeError 방지) ──────────────
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ─── 로깅 설정 (import 전에 먼저) ────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("docling_sidecar")

# ─── FastAPI/uvicorn (경량 의존성, 즉시 import) ───────────────────────────────
try:
    from fastapi import FastAPI, UploadFile, File, HTTPException
    from fastapi.responses import JSONResponse
    import uvicorn
except ImportError:
    print("[ERROR] fastapi/uvicorn not installed. Run: pip install -r scripts/requirements-docling.txt")
    sys.exit(1)

# ─── HF_HUB_OFFLINE 설정 (docling import 전에 결정) ──────────────────────────
import pathlib as _pathlib
_hf_cache = _pathlib.Path(os.environ.get("HF_HOME", _pathlib.Path.home() / ".cache" / "huggingface")) / "hub"
if _hf_cache.exists() and any(_hf_cache.iterdir()):
    os.environ["HF_HUB_OFFLINE"] = "1"
    log.info("HuggingFace 캐시 발견 — 오프라인 모드로 실행합니다.")
else:
    os.environ.pop("HF_HUB_OFFLINE", None)
    log.info("HuggingFace 캐시 없음 — 첫 실행 시 모델을 다운로드합니다.")

# ─── 메모리 절감 환경변수 파싱 ────────────────────────────────────────────────
def _env_bool(key: str, default: bool) -> bool:
    v = os.environ.get(key, "").lower()
    if v in ("true", "1", "yes"):
        return True
    if v in ("false", "0", "no"):
        return False
    return default

def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, str(default)))
    except (ValueError, TypeError):
        return default

def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except (ValueError, TypeError):
        return default

# Page batch size for large PDFs. 0 = disabled. Default 20.
# 대용량 PDF를 청크로 분할하여 피크 RAM 제한 (TextOnlyPdfPipeline은 이미 OOM-safe).
_BATCH_SIZE: int = _env_int("DOCLING_BATCH_SIZE", 20)

log.info(f"Memory config: BATCH_SIZE={_BATCH_SIZE} (TextOnlyPdfPipeline — 래스터라이제이션/DocLayNet 없음)")

# ─── 상태 변수 (docling import 없이 관리) ─────────────────────────────────────
_docling_imported: bool = False   # docling 모듈 import 완료 여부
_converter: Optional[object] = None
_models_ready: bool = False
_models_error: str = ""
_import_lock = threading.Lock()   # 중복 import 방지

# preload 정책: 기본값 true, 환경변수로 false 가능
_PRELOAD = os.environ.get("DOCLING_PRELOAD_MODEL", "true").lower() not in ("false", "0", "no")

# ─── Lazy import 함수 ─────────────────────────────────────────────────────────

def _import_docling() -> bool:
    """
    docling 관련 모듈을 최초 1회 import.
    성공 시 True, 실패 시 False 반환.
    Windows Defender DLL 스캔은 이 함수 호출 시점에 발생함.
    """
    global _docling_imported, _models_error

    if _docling_imported:
        return True

    with _import_lock:
        if _docling_imported:   # double-checked locking
            return True

        log.info("Docling import 시작... (Windows Defender 스캔으로 수 분 소요될 수 있습니다)")
        try:
            # 전역 네임스페이스에 직접 주입 (함수 스코프 밖에서 사용 가능하게)
            global DocumentConverter, PdfFormatOption, PdfPipelineOptions, InputFormat, DocumentStream

            from docling.document_converter import DocumentConverter, PdfFormatOption
            from docling.datamodel.pipeline_options import PdfPipelineOptions
            from docling.datamodel.base_models import InputFormat
            from docling_core.types.io import DocumentStream

            _docling_imported = True
            log.info("Docling import 완료.")
            return True
        except ImportError as e:
            _models_error = f"Docling import 실패: {e}"
            log.error(_models_error)
            log.error("Run: pip install -r scripts/requirements-docling.txt")
            return False


def _build_pipeline_options() -> "PdfPipelineOptions":
    """
    PdfPipelineOptions — 레이아웃 모델 / OCR / 이미지 생성 모두 비활성.
    TextOnlyPdfPipeline 에서 사용. 래스터라이제이션 없이 네이티브 텍스트만 추출.
    """
    opts = PdfPipelineOptions()
    opts.do_ocr = False
    opts.do_table_structure = False
    for attr in (
        "generate_page_images", "generate_picture_images", "generate_table_images",
        "do_picture_classification", "do_picture_description",
        "do_chart_extraction", "do_code_enrichment", "do_formula_enrichment",
    ):
        if hasattr(opts, attr):
            setattr(opts, attr, False)
    # images_scale=None → PagePreprocessingOptions 전달 시 두 번째 get_image() 호출 생략.
    # TextOnlyPdfPipeline 은 _populate_page_images 자체를 호출하지 않으므로 사실상 무관.
    opts.images_scale = 1.0  # 기본값 유지 (파이프라인에서 읽히지 않음)
    _doc_timeout = _env_float("DOCLING_DOCUMENT_TIMEOUT", 120.0)
    if hasattr(opts, "document_timeout"):
        opts.document_timeout = _doc_timeout
    return opts


def _make_text_only_pipeline_cls() -> type:
    """
    LegacyStandardPdfPipeline 을 서브클래싱하여 레이아웃 모델과 래스터라이제이션을
    완전히 제거한 TextOnlyPdfPipeline 클래스를 반환.

    Docling 2.77 분석 결과:
    - StandardPdfPipeline (threaded): PagePreprocessingModel._populate_page_images()가
      page.get_image(scale=1.0) 을 **무조건** 호출 → 226페이지 PDF에서 std::bad_alloc
    - LayoutModel.__init__: LayoutPredictor 를 즉시 import/로드 — enabled=False 없음
    - force_backend_text=True (PdfPipelineOptions): vlm_pipeline.py 에서만 읽힘,
      StandardPdfPipeline 에서는 완전히 무시됨
    - 해결책: LegacyStandardPdfPipeline 서브클래스로 build_pipe 를 교체하여
      래스터라이제이션과 레이아웃 모델을 모두 스킵

    파이프라인 구성:
      TextOnlyPreprocessing → NullOcr → NullLayout → NullTableStructure → PageAssemble
    """
    from docling.pipeline.legacy_standard_pdf_pipeline import LegacyStandardPdfPipeline
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.models.stages.page_assemble.page_assemble_model import (
        PageAssembleModel, PageAssembleOptions,
    )
    from docling.models.stages.reading_order.readingorder_model import (
        ReadingOrderModel, ReadingOrderOptions,
    )
    from docling.datamodel.base_models import (
        BoundingBox, Cluster, LayoutPrediction, Page,
    )
    from docling_core.types.doc import DocItemLabel
    import warnings as _warnings

    class _TextOnlyPreprocessing:
        """
        래스터라이제이션 없이 네이티브 PDF 텍스트 셀만 추출.
        PagePreprocessingModel._populate_page_images() 호출을 완전히 생략한다.

        get_segmented_page() 실패(std::bad_alloc 등) 시 빈 페이지로 대체:
        - page.parsed_page 를 None 으로 두면 하위 _TextCellLayoutModel 이 page.cells 에
          접근할 때 AttributeError 또는 암묵적 None 순회로 크래시 → 배치 전체 실패로 이어짐.
        - 실패 페이지는 parsed_page 를 빈 목업(cells=[]) 으로 설정하여 _TextCellLayoutModel 이
          빈 cluster 를 생성, PageAssembleModel 이 해당 페이지를 빈 결과로 처리하도록 함.
        - 이렇게 하면 OOM 이 발생한 페이지는 텍스트 없이 건너뛰되 나머지 페이지는 정상 처리됨.
        """
        def __call__(self, conv_res, page_batch):
            for page in page_batch:
                if page._backend is None or not page._backend.is_valid():
                    yield page
                    continue
                try:
                    page.parsed_page = page._backend.get_segmented_page()
                except Exception as e:
                    log.warning(
                        f"get_segmented_page 실패 (page {page.page_no}): {e} — "
                        f"빈 페이지로 대체합니다 (텍스트 손실)."
                    )
                    # parsed_page 를 None 으로 두면 page.cells 가 정의되지 않아 하위 모델 크래시.
                    # 빈 cells 목록을 가진 최소 SegmentedPage 를 할당하거나,
                    # cells 속성만 빈 리스트로 패치하여 _TextCellLayoutModel 이 안전하게 순회하도록 함.
                    if page.parsed_page is None:
                        try:
                            from docling.backend.pdf_backend import SegmentedPdfPage  # type: ignore[import]
                            page.parsed_page = SegmentedPdfPage(cells=[], tables=[])
                        except Exception:
                            # SegmentedPdfPage import 불가 시 duck-typing fallback.
                            # page.cells 프로퍼티는 내부적으로 parsed_page.textline_cells 를 참조하므로
                            # 클래스 변수 cells 만으로는 AttributeError 를 막을 수 없다.
                            # textline_cells 를 인스턴스 속성으로 명시하여 page.cells 가 빈 리스트를 반환하도록 함.
                            class _EmptyParsedPage:
                                def __init__(self) -> None:
                                    self.textline_cells: list = []
                                    self.cells: list = []
                                    self.tables: list = []
                            page.parsed_page = _EmptyParsedPage()
                yield page

    class _NullModel:
        """아무것도 하지 않는 pass-through 모델."""
        def __call__(self, conv_res, page_batch):
            yield from page_batch

    class _TextCellLayoutModel:
        """
        네이티브 PDF 텍스트 셀을 Cluster 로 변환하여 LayoutPrediction 을 구성.
        DocLayNet 없이도 PageAssembleModel 이 텍스트를 수집할 수 있게 한다.
        """
        def __call__(self, conv_res, page_batch):
            for page in page_batch:
                clusters: list[Cluster] = []
                cell_id = 0
                try:
                    page_cells = page.cells
                except AttributeError:
                    log.warning(
                        f"page.cells 접근 실패 (page {getattr(page, 'page_no', '?')}): "
                        f"parsed_page 에 textline_cells 없음 — 빈 페이지로 건너뜁니다."
                    )
                    page_cells = []
                for cell in page_cells:
                    try:
                        bbox = cell.to_bounding_box()
                    except Exception:
                        continue
                    clusters.append(
                        Cluster(
                            id=cell_id,
                            label=DocItemLabel.TEXT,
                            bbox=bbox,
                            cells=[cell],
                            confidence=1.0,
                        )
                    )
                    cell_id += 1
                page.predictions.layout = LayoutPrediction(clusters=clusters)
                yield page

    class TextOnlyPdfPipeline(LegacyStandardPdfPipeline):
        """
        레이아웃 모델(DocLayNet) 과 래스터라이제이션을 제거한 경량 PDF 파이프라인.
        텍스트 네이티브 PDF 에서 OOM 없이 대용량 문서를 처리할 수 있다.
        """

        def __init__(self, pipeline_options: PdfPipelineOptions) -> None:
            # MRO: TextOnlyPdfPipeline → LegacyStandardPdfPipeline → PaginatedPipeline
            #       → ConvertPipeline → BasePipeline
            # LegacyStandardPdfPipeline.__init__ : layout_factory.create_instance() 로
            #   DocLayNet 즉시 로드 → 스킵
            # PaginatedPipeline.__init__ → ConvertPipeline.__init__ : DocumentPictureClassifier
            #   등 enrichment 모델 instantiate → 스킵
            # BasePipeline.__init__ 만 직접 호출: build_pipe=[], enrichment_pipe=[],
            #   artifacts_path, keep_images=False 초기화 → 안전
            from docling.pipeline.base_pipeline import BasePipeline
            BasePipeline.__init__(self, pipeline_options)
            self.pipeline_options: PdfPipelineOptions = pipeline_options

            with _warnings.catch_warnings():
                _warnings.filterwarnings("ignore", category=DeprecationWarning)
                self.keep_images = (
                    pipeline_options.generate_page_images
                    or pipeline_options.generate_picture_images
                    or getattr(pipeline_options, "generate_table_images", False)
                )

            self.reading_order_model = ReadingOrderModel(options=ReadingOrderOptions())
            self.keep_backend = False

            # 레이아웃/OCR/이미지 없는 경량 파이프라인
            self.build_pipe = [
                _TextOnlyPreprocessing(),   # 래스터라이제이션 없이 텍스트 셀만 추출
                _NullModel(),               # OCR 스킵
                _TextCellLayoutModel(),     # 텍스트 셀 → Cluster (DocLayNet 없음)
                _NullModel(),               # 표 구조 스킵
                PageAssembleModel(options=PageAssembleOptions()),
            ]
            self.enrichment_pipe = []

        @classmethod
        def get_default_options(cls) -> PdfPipelineOptions:
            return PdfPipelineOptions()

        @classmethod
        def is_backend_supported(cls, backend) -> bool:
            from docling.backend.pdf_backend import PdfDocumentBackend
            return isinstance(backend, PdfDocumentBackend)

    return TextOnlyPdfPipeline


def _get_converter() -> object:
    """DocumentConverter 싱글톤 반환. 없으면 생성."""
    global _converter, _models_ready, _models_error

    if _converter is not None:
        return _converter

    if not _import_docling():
        raise RuntimeError(_models_error or "Docling import failed")

    log.info("DocumentConverter 초기화 중...")

    opts = _build_pipeline_options()
    TextOnlyPdfPipeline = _make_text_only_pipeline_cls()
    _converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=TextOnlyPdfPipeline,
                pipeline_options=opts,
            ),
        }
    )
    log.info(
        "TextOnlyPdfPipeline 초기화 완료 "
        "(래스터라이제이션 없음 / DocLayNet 없음 / OCR 없음)"
    )

    _models_ready = True
    log.info("DocumentConverter 준비 완료.")
    return _converter


def _preload_models() -> None:
    """백그라운드 스레드에서 모델 preload."""
    global _models_error
    try:
        _get_converter()
    except Exception as e:
        _models_error = str(e)
        log.error(f"모델 preload 실패: {e}")


# ─── 페이지 범위 슬라이싱 (pypdfium2 사용) ────────────────────────────────────

def _extract_pdf_page_range(pdf_bytes: bytes, page_start: int, page_end: int) -> bytes:
    """
    pypdfium2로 PDF 바이트에서 page_start~page_end 범위를 추출하여
    새 PDF 바이트로 반환. 1-based 페이지 번호.
    pypdfium2 는 docling 의존성으로 자동 설치됨.
    """
    try:
        import pypdfium2 as pdfium  # type: ignore[import-untyped]
    except ImportError:
        # pypdfium2 없으면 전체 문서 반환 (배치 비활성과 동일)
        log.warning("pypdfium2 미설치 — 페이지 배치 비활성, 전체 문서 처리")
        return pdf_bytes

    src = pdfium.PdfDocument(pdf_bytes)
    total = len(src)
    # 0-based 인덱스 변환, 범위 클램프
    start_idx = max(0, page_start - 1)
    end_idx = min(total - 1, page_end - 1)
    if start_idx > end_idx:
        return b""

    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, list(range(start_idx, end_idx + 1)))
    buf = io.BytesIO()
    dst.save(buf)
    result_bytes = buf.getvalue()
    buf.close()   # BytesIO 버퍼 즉시 해제
    src.close()
    dst.close()
    return result_bytes


def _count_pdf_pages(pdf_bytes: bytes) -> int:
    """PDF 전체 페이지 수 반환. 실패 시 0."""
    try:
        import pypdfium2 as pdfium  # type: ignore[import-untyped]
        doc = pdfium.PdfDocument(pdf_bytes)
        n = len(doc)
        doc.close()
        return n
    except Exception:
        return 0


# ─── 섹션 변환 헬퍼 ───────────────────────────────────────────────────────────

def _check_result_status(result, warnings: list[str]) -> None:
    """
    convert() 결과 상태를 확인하여 PARTIAL_SUCCESS/FAILURE를 경고/예외로 처리.
    Docling 버전에 따라 status 속성이 없을 수 있어 hasattr로 안전하게 처리.
    """
    try:
        status = getattr(result, "status", None)
        if status is None:
            return
        status_name = getattr(status, "name", str(status))
        if status_name == "PARTIAL_SUCCESS":
            msg = f"문서가 부분적으로만 변환됐습니다 (status={status_name}). document_timeout 또는 메모리 제한에 도달했을 수 있습니다."
            log.warning(msg)
            warnings.append(msg)
        elif status_name not in ("SUCCESS", "PARTIAL_SUCCESS"):
            msg = f"문서 변환 실패 (status={status_name})"
            log.error(msg)
            raise HTTPException(status_code=500, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        log.warning(f"result.status 확인 중 오류 (무시됨): {e}")

ZONE_KEYWORD_MAP = [
    (["general condition", "general provision", "conditions of contract"], "general_conditions"),
    (["particular condition", "special condition"], "particular_conditions"),
    (["definition", "glossary", "interpretation"], "definitions"),
    (["technical specification", "scope of work", "scope of supply"], "technical_specifications"),
    (["commercial term", "price", "payment", "contract price"], "commercial_terms"),
    (["appendix", "appendices", "annex", "attachment", "schedule", "exhibit"], "appendices"),
    (["table of content", "contents"], "toc"),
    (["agreement", "this contract", "witnesseth", "recital"], "contract_agreement"),
]

def _detect_zone_hint(heading_text: str) -> str:
    t = heading_text.lower()
    for keywords, zone in ZONE_KEYWORD_MAP:
        if any(k in t for k in keywords):
            return zone
    return "general_conditions"


def _get_page(item) -> int:
    try:
        if hasattr(item, "prov") and item.prov:
            return item.prov[0].page_no
    except Exception:
        pass
    return 1


def _build_sections_from_doc(doc) -> list[dict]:
    """
    DoclingDocument → sections 리스트 변환.
    SectionHeaderItem → 새 섹션, TextItem/ListItem/TableItem → 본문 축적.
    iterate_items() 시그니처가 버전별로 다를 수 있어 안전하게 처리.
    """
    import importlib
    SectionHeaderItem = TextItem = TableItem = ListItem = None
    for mod_path in [
        "docling_core.transforms.chunker.hierarchical_chunker",
        "docling.datamodel.document",
        "docling_core.types.doc.document",
    ]:
        try:
            mod = importlib.import_module(mod_path)
            SectionHeaderItem = SectionHeaderItem or getattr(mod, "SectionHeaderItem", None)
            TextItem = TextItem or getattr(mod, "TextItem", None)
            TableItem = TableItem or getattr(mod, "TableItem", None)
            ListItem = ListItem or getattr(mod, "ListItem", None)
        except Exception:
            pass

    sections: list[dict] = []
    current: dict | None = None

    def flush():
        nonlocal current
        if current and (current["heading"] or current["content"].strip()):
            sections.append(current)
        current = None

    def new_section(heading: str, level: int, page: int):
        nonlocal current
        flush()
        current = {
            "heading": heading,
            "level": level,
            "content": "",
            "page_start": page,
            "page_end": page,
            "zone_hint": _detect_zone_hint(heading),
        }

    def ensure_current(page: int):
        nonlocal current
        if current is None:
            current = {
                "heading": "",
                "level": 1,
                "content": "",
                "page_start": page,
                "page_end": page,
                "zone_hint": "contract_body",
            }

    try:
        for item, level in doc.iterate_items():
            page = _get_page(item)
            cls_name = type(item).__name__

            if SectionHeaderItem and isinstance(item, SectionHeaderItem):
                lv = getattr(item, "level", None) or level or 1
                new_section(item.text.strip(), int(lv), page)

            elif cls_name == "SectionHeaderItem":
                lv = getattr(item, "level", None) or level or 1
                new_section(item.text.strip(), int(lv), page)

            elif (TextItem and isinstance(item, TextItem)) or cls_name == "TextItem":
                ensure_current(page)
                current["content"] += item.text.strip() + "\n"
                current["page_end"] = max(current["page_end"], page)

            elif (ListItem and isinstance(item, ListItem)) or cls_name == "ListItem":
                ensure_current(page)
                current["content"] += item.text.strip() + "\n"
                current["page_end"] = max(current["page_end"], page)

            elif (TableItem and isinstance(item, TableItem)) or cls_name == "TableItem":
                ensure_current(page)
                try:
                    # doc 인수 전달: Docling 2.x에서 필수 (없으면 deprecation 경고)
                    md = item.export_to_markdown(doc)
                except TypeError:
                    # 구버전 Docling이 doc 인수를 지원하지 않을 경우 fallback
                    try:
                        md = item.export_to_markdown()
                    except Exception:
                        md = "[TABLE]"
                except Exception:
                    md = "[TABLE]"
                current["content"] += "\n" + md + "\n"
                current["page_end"] = max(current["page_end"], page)

    except Exception as e:
        log.warning(f"iterate_items failed ({e}), 지금까지 축적된 섹션을 폐기하고 export_to_markdown fallback으로 전환합니다")
        sections = []   # 불완전한 부분 결과를 버리고 fallback에서 전체를 재처리
        current = None  # flush 방지 (아래 flush()가 중복 추가하지 않도록)

    flush()

    # 섹션이 없으면 마크다운 전체를 단일 섹션으로
    if not sections:
        try:
            full_text = doc.export_to_markdown()
        except Exception:
            full_text = ""
        total_pages = 1
        try:
            # num_pages는 버전에 따라 프로퍼티이거나 메서드일 수 있음
            raw_pages = doc.num_pages
            total_pages = (raw_pages() if callable(raw_pages) else raw_pages) or 1
        except Exception:
            pass
        if full_text:
            sections = [{
                "heading": "",
                "level": 1,
                "content": full_text,
                "page_start": 1,
                "page_end": total_pages,
                "zone_hint": "contract_body",
            }]

    return sections


def _parse_pdf_native(pdf_bytes: bytes, filename: str) -> tuple[list[dict], int]:
    """
    pdfplumber 기반 PDF 파싱 (래스터라이즈 없음).
    - 텍스트: PDF 텍스트 스트림 직접 추출 (메모리 수십 KB/페이지)
    - 표: 벡터 라인 기반 감지 → Markdown 변환 (래스터라이즈 없음)
    - bad_alloc 구조적으로 불가능
    반환: (sections, total_pages) — _build_sections_from_doc()과 동일 형식
    """
    try:
        import pdfplumber
    except ImportError:
        log.warning("pdfplumber 미설치 — Docling fallback 사용. pip install pdfplumber")
        return [], 0

    import re

    # 조항 번호 패턴: "1.", "1.1", "14.1.2", "Article 1", "CLAUSE 1", "PART I" 등
    HEADING_PATTERNS = [
        re.compile(r'^\s*(\d+\.)+\d*\s+\S'),          # 1.1 / 14.1.2 Title
        re.compile(r'^\s*\d+\.\s+[A-Z]'),              # 1. TITLE
        re.compile(r'^\s*(ARTICLE|CLAUSE|PART|SECTION|CHAPTER)\s+[\dIVXivx]+', re.I),
        re.compile(r'^\s*[A-Z][A-Z\s]{4,30}$'),        # ALL CAPS SHORT LINE
    ]

    def is_heading(text: str, avg_size: float, char_sizes: list) -> bool:
        t = text.strip()
        if not t or len(t) > 120:
            return False
        for pat in HEADING_PATTERNS:
            if pat.match(t):
                return True
        # 폰트 크기가 평균보다 20% 이상 크면 heading
        if char_sizes and avg_size > 0:
            line_avg = sum(char_sizes) / len(char_sizes)
            if line_avg > avg_size * 1.2:
                return True
        return False

    sections: list[dict] = []
    current: dict | None = None

    def flush():
        nonlocal current
        if current and (current["heading"] or current["content"].strip()):
            sections.append(current)
        current = None

    def new_section(heading: str, level: int, page: int):
        nonlocal current
        flush()
        current = {
            "heading": heading,
            "level": level,
            "content": "",
            "page_start": page,
            "page_end": page,
            "zone_hint": _detect_zone_hint(heading),
        }

    def ensure_current(page: int):
        nonlocal current
        if current is None:
            current = {
                "heading": "",
                "level": 1,
                "content": "",
                "page_start": page,
                "page_end": page,
                "zone_hint": "contract_body",
            }

    def table_to_markdown(table: list) -> str:
        """pdfplumber 표 데이터 → Markdown 표 형식."""
        rows = []
        for row in table:
            cells = [str(c).strip() if c is not None else "" for c in row]
            rows.append("| " + " | ".join(cells) + " |")
        if not rows:
            return ""
        # 헤더 구분선 추가
        header = rows[0]
        sep = "| " + " | ".join(["---"] * len(table[0])) + " |"
        body = rows[1:] if len(rows) > 1 else []
        return "\n".join([header, sep] + body)

    total_pages = 0

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total_pages = len(pdf.pages)

            # 전체 문서 평균 폰트 크기 계산 (heading 감지 기준)
            sample_sizes = []
            for p in pdf.pages[:min(10, total_pages)]:
                for ch in (p.chars or []):
                    if ch.get("size"):
                        sample_sizes.append(ch["size"])
            avg_font_size = sum(sample_sizes) / len(sample_sizes) if sample_sizes else 12.0

            for page_num, page in enumerate(pdf.pages, 1):
                # 1) 표 추출 (벡터 라인 기반, 래스터라이즈 없음)
                tables = []
                try:
                    tables = page.extract_tables() or []
                except Exception as e:
                    log.warning(f"page {page_num} 표 추출 실패: {e}")

                # 표 bounding box 수집 (텍스트 중복 방지)
                table_bboxes = []
                try:
                    for t_obj in (page.find_tables() or []):
                        table_bboxes.append(t_obj.bbox)
                except Exception:
                    pass

                # 2) 텍스트 줄 단위 추출
                try:
                    # extract_text_lines()로 줄 단위 추출 (pdfplumber 0.10+)
                    lines = page.extract_text_lines(return_chars=True) or []
                except Exception:
                    # fallback: extract_words로 근사
                    lines = []
                    raw_text = page.extract_text() or ""
                    for ln in raw_text.splitlines():
                        if ln.strip():
                            lines.append({"text": ln, "chars": []})

                # 표 영역과 겹치는 줄 제거
                def in_table(line) -> bool:
                    if not table_bboxes:
                        return False
                    x0 = line.get("x0", 0)
                    top = line.get("top", 0)
                    x1 = line.get("x1", 9999)
                    bottom = line.get("bottom", 9999)
                    for tb in table_bboxes:
                        if x0 >= tb[0] - 2 and top >= tb[1] - 2 and x1 <= tb[2] + 2 and bottom <= tb[3] + 2:
                            return True
                    return False

                # 3) 줄별로 섹션 구성
                for line in lines:
                    if in_table(line):
                        continue
                    text = line.get("text", "").strip()
                    if not text:
                        continue
                    char_sizes = [ch.get("size", 0) for ch in (line.get("chars") or []) if ch.get("size")]

                    if is_heading(text, avg_font_size, char_sizes):
                        # heading 레벨: 숫자 depth로 결정
                        level = 1
                        m = re.match(r'^\s*((\d+\.)+)', text)
                        if m:
                            level = m.group(1).count(".")
                        new_section(text, level, page_num)
                    else:
                        ensure_current(page_num)
                        current["content"] += text + "\n"
                        current["page_end"] = max(current["page_end"], page_num)

                # 4) 표를 Markdown으로 섹션에 추가
                for tbl in tables:
                    if not tbl:
                        continue
                    md = table_to_markdown(tbl)
                    if md:
                        ensure_current(page_num)
                        current["content"] += "\n" + md + "\n"
                        current["page_end"] = max(current["page_end"], page_num)

    except Exception as e:
        log.error(f"pdfplumber 파싱 실패: {e}")
        return [], 0

    flush()

    # 섹션이 없으면 단순 텍스트 전체를 단일 섹션으로
    if not sections:
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                full_text = "\n".join(
                    p.extract_text() or "" for p in pdf.pages
                )
                total_pages = len(pdf.pages)
            if full_text.strip():
                sections = [{
                    "heading": "",
                    "level": 1,
                    "content": full_text,
                    "page_start": 1,
                    "page_end": total_pages,
                    "zone_hint": "contract_body",
                }]
        except Exception:
            pass

    log.info(f"pdfplumber 파싱 완료: {len(sections)} sections, {total_pages} pages")
    return sections, total_pages


def _parse_pdf_in_batches(
    pdf_bytes: bytes,
    converter: object,
    filename: str,
    batch_size: int,
) -> tuple[list[dict], int]:
    """
    PDF 를 batch_size 페이지 단위로 분할하여 순차 파싱.
    각 배치의 섹션 페이지 번호를 절대 페이지 번호로 오프셋 보정하여 병합.
    반환: (merged_sections, total_pages)
    """
    total_pages = _count_pdf_pages(pdf_bytes)
    if total_pages == 0:
        # pypdfium2 없거나 페이지 수 파악 불가 → 전체 처리 fallback
        log.warning("페이지 수 파악 실패 — 전체 문서를 단일 배치로 처리합니다.")
        fallback_warnings: list[str] = []
        stream = DocumentStream(name=filename, stream=io.BytesIO(pdf_bytes))
        result = converter.convert(stream)
        _check_result_status(result, fallback_warnings)
        sections = _build_sections_from_doc(result.document)
        tp = 1
        try:
            raw_pages = result.document.num_pages
            tp = (raw_pages() if callable(raw_pages) else raw_pages) or 1
        except Exception:
            if sections:
                tp = max(s["page_end"] for s in sections)
        return sections, tp

    all_sections: list[dict] = []
    page = 1
    batch_num = 0

    while page <= total_pages:
        batch_end = min(page + batch_size - 1, total_pages)
        batch_num += 1
        log.info(
            f"배치 {batch_num}: 페이지 {page}–{batch_end} / {total_pages} 처리 중..."
        )

        batch_bytes = _extract_pdf_page_range(pdf_bytes, page, batch_end)
        if not batch_bytes:
            log.warning(f"배치 {batch_num} 슬라이싱 결과가 비어있습니다. 건너뜁니다.")
            page = batch_end + 1
            continue

        batch_filename = f"batch_{batch_num}_{filename}"
        stream = DocumentStream(name=batch_filename, stream=io.BytesIO(batch_bytes))
        # batch_bytes는 stream 생성 후 즉시 해제 — 배치 PDF 사본을 더 이상 보유하지 않음
        del batch_bytes
        batch_warnings: list[str] = []
        try:
            result = converter.convert(stream)
            del stream  # 스트림 객체 즉시 해제
            _check_result_status(result, batch_warnings)
            if batch_warnings:
                log.warning(f"배치 {batch_num} 경고: {batch_warnings}")
        except HTTPException as e:
            log.error(f"배치 {batch_num} 변환 실패 (status={e.detail}) — 건너뜁니다.")
            page = batch_end + 1
            gc.collect()
            continue
        except Exception as e:
            log.error(f"배치 {batch_num} 파싱 실패: {e}")
            # 실패한 배치는 건너뛰고 계속 (partial result)
            page = batch_end + 1
            gc.collect()
            continue

        batch_sections = _build_sections_from_doc(result.document)
        # result (ConversionResult + 내부 DoclingDocument C++ 객체 포함)를 섹션 추출 후 즉시 해제
        del result
        page_offset = page - 1  # batch page 1 = absolute page `page`

        for s in batch_sections:
            adjusted = dict(s)
            adjusted["page_start"] = s["page_start"] + page_offset
            adjusted["page_end"] = s["page_end"] + page_offset
            all_sections.append(adjusted)

        page = batch_end + 1

        # 배치 간 명시적 GC — pypdfium2 / Docling 내부 C++ 힙 참조를 Python 레퍼런스 카운트
        # 기반 해제에 의존하지 않고 즉시 수집하여 Windows 가상 메모리 고갈 방지
        gc.collect()
        log.info(f"배치 {batch_num} 완료. GC 수행됨.")

    return all_sections, total_pages


# ─── FastAPI 앱 ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup
    if _PRELOAD:
        log.info("DOCLING_PRELOAD_MODEL=true — 백그라운드에서 모델 preload 시작")
        threading.Thread(target=_preload_models, daemon=True).start()
    else:
        log.info("DOCLING_PRELOAD_MODEL=false — 첫 /parse 요청 시 lazy load합니다")
    yield
    # shutdown (필요 시 정리 로직 추가)


app = FastAPI(title="Docling Sidecar", version="1.3.0", lifespan=lifespan)


# ─── 엔드포인트 ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """
    항상 즉시 응답.
    - docling_imported: docling 모듈 로드 여부
    - models_ready: DocumentConverter 초기화 완료 여부
    """
    return {
        "status": "ok",
        "docling_imported": _docling_imported,
        "models_ready": _models_ready,
        "models_error": _models_error or None,
        "preload_mode": _PRELOAD,
        "pipeline": "pdfplumber+Docling",
        "batch_size": _BATCH_SIZE,
    }


@app.post("/parse")
async def parse_document(file: UploadFile = File(...)):
    filename = file.filename or "upload.pdf"
    ext = Path(filename).suffix.lower()
    if ext not in (".pdf", ".docx"):
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}. Only PDF and DOCX.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")

    log.info(f"Parsing {filename} ({len(data):,} bytes)...")

    try:
        warnings: list[str] = []

        if ext == ".pdf":
            # pdfplumber 우선 시도 (래스터라이즈 없음, bad_alloc 없음, 표 구조 보존)
            # Docling 로드 없이 먼저 시도 → 성공하면 Docling 초기화 시간 완전 절감
            sections, total_pages = await asyncio.to_thread(_parse_pdf_native, data, filename)
            if not sections:
                # pdfplumber 실패 시 Docling 배치 fallback — 이때만 Docling 로드
                log.warning("pdfplumber 파싱 결과 없음 — Docling TextOnlyPipeline fallback 시도")
                try:
                    converter = await asyncio.to_thread(_get_converter)
                except RuntimeError as e:
                    raise HTTPException(
                        status_code=503,
                        detail=f"Docling 모델 로드 실패: {e}. pip install -r scripts/requirements-docling.txt 를 실행하세요."
                    )
                if _BATCH_SIZE > 0:
                    total_pages_check = await asyncio.to_thread(_count_pdf_pages, data)
                    if total_pages_check > _BATCH_SIZE:
                        log.info(
                            f"대용량 PDF 감지 ({total_pages_check}p > batch_size={_BATCH_SIZE}) "
                            f"— Docling 배치 모드로 처리합니다."
                        )
                        sections, total_pages = await asyncio.to_thread(
                            _parse_pdf_in_batches, data, converter, filename, _BATCH_SIZE
                        )
                    else:
                        stream = DocumentStream(name=filename, stream=io.BytesIO(data))
                        result = await asyncio.to_thread(converter.convert, stream)
                        _check_result_status(result, warnings)
                        doc = result.document
                        sections = _build_sections_from_doc(doc)
                        total_pages = 1
                        try:
                            raw_pages = doc.num_pages
                            total_pages = (raw_pages() if callable(raw_pages) else raw_pages) or 1
                        except Exception:
                            if sections:
                                total_pages = max(s["page_end"] for s in sections)
                else:
                    stream = DocumentStream(name=filename, stream=io.BytesIO(data))
                    result = await asyncio.to_thread(converter.convert, stream)
                    _check_result_status(result, warnings)
                    doc = result.document
                    sections = _build_sections_from_doc(doc)
                    total_pages = 1
                    try:
                        raw_pages = doc.num_pages
                        total_pages = (raw_pages() if callable(raw_pages) else raw_pages) or 1
                    except Exception:
                        if sections:
                            total_pages = max(s["page_end"] for s in sections)
        else:
            # DOCX — Docling 경유 (pdfplumber는 PDF 전용)
            try:
                converter = await asyncio.to_thread(_get_converter)
            except RuntimeError as e:
                raise HTTPException(
                    status_code=503,
                    detail=f"Docling 모델 로드 실패: {e}. pip install -r scripts/requirements-docling.txt 를 실행하세요."
                )
            stream = DocumentStream(name=filename, stream=io.BytesIO(data))
            result = await asyncio.to_thread(converter.convert, stream)
            _check_result_status(result, warnings)
            doc = result.document
            sections = _build_sections_from_doc(doc)
            total_pages = 1
            try:
                raw_pages = doc.num_pages
                total_pages = (raw_pages() if callable(raw_pages) else raw_pages) or 1
            except Exception:
                if sections:
                    total_pages = max(s["page_end"] for s in sections)

        log.info(f"Done: {len(sections)} sections, {total_pages} pages.")

        return JSONResponse({
            "sections": sections,
            "total_pages": total_pages,
            "warnings": warnings,
        })

    except Exception as e:
        log.exception(f"Parse failed: {e}")
        raise HTTPException(status_code=500, detail=f"Parse error: {str(e)}")


# ─── 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("DOCLING_SIDECAR_PORT", "8766"))
    host = os.environ.get("DOCLING_BIND_HOST", "127.0.0.1")
    log.info(f"Starting Docling sidecar on http://{host}:{port}")
    log.info(f"DOCLING_PRELOAD_MODEL={'true' if _PRELOAD else 'false (lazy load)'}")
    uvicorn.run(app, host=host, port=port, log_level="info")
