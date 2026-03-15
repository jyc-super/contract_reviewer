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

# Page batch size for large PDFs (Docling fallback path). 0 = disabled. Default 30.
# 대용량 PDF를 청크로 분할하여 피크 RAM 제한 (TextOnlyPdfPipeline은 이미 OOM-safe).
_BATCH_SIZE: int = _env_int("DOCLING_BATCH_SIZE", 30)

# pdfplumber 병렬 워커 수. 0 = 자동(페이지 수에 따라 결정). Default 4.
# 각 워커는 독립적인 pdfplumber 핸들로 페이지 청크를 처리한다.
_PDFPLUMBER_WORKERS: int = _env_int("DOCLING_PDFPLUMBER_WORKERS", 4)

log.info(f"Memory config: BATCH_SIZE={_BATCH_SIZE}, PDFPLUMBER_WORKERS={_PDFPLUMBER_WORKERS} (TextOnlyPdfPipeline — 래스터라이제이션/DocLayNet 없음)")

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

# ─── document-part-patterns (document-part-patterns.json 포팅) ───────────────
# TypeScript 측 lib/layout/document-part-patterns.json 과 동일한 패턴을 Python 에 내장.
# heading-likeness 검증을 통과한 텍스트에 대해 regex 매칭 수행.

import re as _re

_DOCUMENT_PART_PATTERNS: list[dict] = [
    {
        "key": "contract_agreement",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?contract\s+agreement\b",
            r"^\s*this\s+contract\s+agreement\b",
            # 한국어 계약서 패턴
            r"^\s*계\s*약\s*서\s*$",                           # "계약서"
            r"^\s*(?:공사|용역|물품|도급|하도급)?\s*계약서\s*$", # "공사계약서", "용역계약서" 등
            r"^\s*계약\s*체결\s*",                              # "계약 체결..."
        ],
    },
    {
        "key": "general_conditions",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?general\s+conditions(?:\s+of\s+contract)?\b",
            r"^\s*gc\b.*\bgeneral\s+conditions\b",
            r"^\s*book\s*(?:ii|2)\b.*\bgeneral\s+conditions\b",
            r"^\s*section\s*[a-z]\b.*\bgeneral\s+conditions\b",
            r"^\s*general\s+provisions\s*$",
            r"^\s*\d+\s+general\s+provisions\b",       # "1 General Provisions"
            # 한국어 일반조건
            r"^\s*일\s*반\s*(?:사항|조건|조항)\s*$",
            r"^\s*공\s*통\s*(?:사항|조건|조항)\s*$",
        ],
    },
    {
        "key": "particular_conditions",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?particular\s+conditions(?:\s+of\s+contract)?\b",
            r"^\s*special\s+conditions(?:\s+of\s+contract)?\b",
            r"^\s*pc\b.*\bparticular\s+conditions\b",
            r"^\s*book\s*(?:iii|3)\b.*\bparticular\s+conditions\b",
            r"^\s*section\s*[b-z]\b.*\bparticular\s+conditions\b",
            # 한국어 특수/특별조건
            r"^\s*특\s*수\s*(?:사항|조건|조항)\s*$",
            r"^\s*특\s*별\s*(?:사항|조건|조항)\s*$",
        ],
    },
    {
        "key": "conditions_of_contract",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?conditions\s+of\s+(?:contract|subcontract)\b",
            r"^\s*\d+\s+conditions\s+of\s+(?:contract|subcontract)\b",  # "1 Conditions of Contract"
            # 과광범위한 r"^\s*(?:fidic\s*)?conditions\b" 패턴 제거:
            # "conditions of payment", "conditions for dispatch" 등 오탐 방지
            r"^\s*fidic\s+conditions\s+of\s+(?:contract|subcontract)\b",
            # 한국어 계약조건
            r"^\s*계약\s*(?:일반)?\s*조건\s*$",
        ],
    },
    {
        "key": "technical_specifications",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?(?:technical\s+)?specifications?\b",
            r"^\s*\d+\s+(?:technical\s+)?specifications?\b",  # "1 Technical Specifications"
            # employer's requirements: FIDIC Silver Book 전용 (employer's requirements 섹션)
            # general employer's requirements → technical_specifications (조달 문서)
            r"^\s*employer'?s\s+requirements\b",
            r"^\s*owner'?s\s+requirements\b",
        ],
    },
    {
        "key": "commercial_terms",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*commercial\s+terms\b",
            r"^\s*price\s+and\s+payment\b",
        ],
    },
    {
        "key": "appendices",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*schedules?\b",
            r"^\s*schedule\s+[a-z0-9]+\b",
            r"^\s*appendi(?:x|ces)\b",
            r"^\s*exhibits?\b",
            r"^\s*annex(?:es)?\b",
        ],
    },
    {
        # Mi-1: 중복 없이 Korean 별표 패턴 추가 (annexure 타입)
        "key": "annexure",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*별표\s*\d+\b",          # 별표 1, 별표1
            r"^\s*\[별표\s*\d+\]",         # [별표 1]
            r"^\s*별첨\s*\d+\b",           # 별첨 1
        ],
    },
    {
        # Amendment zone type 추가
        "key": "amendment",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*amendment(?:\s+no\.?\s*\d+)?\b",
            r"^\s*변경\s*계약서\b",
            r"^\s*계약\s*변경\b",
        ],
    },
    {
        "key": "definitions",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*(?:\d+(?:\.\d+)*)\s*definitions\b",
            r"^\s*\d+\s+definitions\b",                # "1 Definitions"
            r"^\s*definitions\b",
        ],
    },
    {
        "key": "toc",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*table\s+of\s+contents\b",
            r"^\s*contents\b",
            r"^\s*index\b",
        ],
    },
    {
        "key": "cover_page",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*cover\s+(?:page|sheet)\b",
            r"^\s*title\s+page\b",
        ],
    },
    {
        "key": "drawing_list",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*(?:list\s+of\s+)?drawings?\b",
            r"^\s*drawing\s+(?:register|schedule|list)\b",
        ],
    },
    {
        "key": "form_of_tender",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*form\s+of\s+tender\b",
            r"^\s*tender\s+form\b",
        ],
    },
    {
        "key": "letter_of_acceptance",
        "is_analysis_target": True,
        "patterns": [
            r"^\s*letter\s+of\s+(?:acceptance|award|intent)\b",
        ],
    },
    {
        "key": "bill_of_quantities",
        "is_analysis_target": False,
        "patterns": [
            r"^\s*bill\s+of\s+quantities\b",
            r"^\s*(?:schedule\s+of\s+)?rates?\s+and\s+prices?\b",
        ],
    },
]

# 사전 컴파일된 regex (모듈 로드 시 1회만 컴파일)
_COMPILED_PART_PATTERNS: list[tuple[str, bool, list[_re.Pattern]]] = [
    (
        entry["key"],
        entry["is_analysis_target"],
        [_re.compile(p, _re.IGNORECASE) for p in entry["patterns"]],
    )
    for entry in _DOCUMENT_PART_PATTERNS
]

# heading-likeness 검증: 이 조건을 통과해야 패턴 매칭 수행
# (TypeScript detectDocumentPart()의 guard 조건과 일치)
_MAX_HEADING_LEN = 100
_MAX_HEADING_WORDS = 12

def _is_heading_like(text: str, is_heading_signal: bool = False,
                     font_size_ratio: float = 1.0, bold_ratio: float = 0.0) -> bool:
    """heading-likeness 검증. TypeScript detectDocumentPart() 의 guard 조건과 동일."""
    t = text.strip()
    if not t or len(t) > _MAX_HEADING_LEN:
        return False
    if t[-1] in '.;?!':
        return False
    if '"' in t or '[' in t or ']' in t:
        return False
    words = t.split()
    if len(words) > _MAX_HEADING_WORDS:
        return False
    typo_heading = bold_ratio >= 0.55 or font_size_ratio >= 1.10
    if not is_heading_signal and not typo_heading:
        return False
    return True

# 강력한 리터럴 트리거 (항상 매칭, heading-likeness 검증 우선)
# 주의: 패턴은 document_part 경계 heading에만 매칭되어야 함.
# 'This Contract Agreement together with...' 같은 본문 참조는 제외:
# → 'this contract agreement' 뒤에 관계절/전치사구('together', 'together with',
#    'and its', 'or', 'is', 'was', 'shall', 'may', 'dated', 'made') 가 오면 본문
# → 제목으로 쓰이는 경우는 (a) 단독('the "Contract Agreement"' 포함), (b) is made/entered 로 시작
# 실용적 해법: 뒤에 'together|and its|dated|made|entered|shall' 이 바로 오면 제외
_STRONG_TRIGGERS = [
    (
        _re.compile(
            r'^\s*this\s+contract\s+agreement\b(?!\s+(?:together|and\s|dated|made|entered|shall|may|or\s|is\s))',
            _re.IGNORECASE
        ),
        "contract_agreement",
        True,
    ),
    (_re.compile(r'^\s*general\s+provisions\s*$', _re.IGNORECASE), "general_conditions", True),
]

def _detect_zone_hint_from_patterns(heading_text: str,
                                    is_heading_signal: bool = True,
                                    font_size_ratio: float = 1.0,
                                    bold_ratio: float = 0.0) -> tuple[str, bool] | None:
    """
    document-part-patterns 기반 regex 매칭.
    매칭 성공 시 (zone_key, is_analysis_target) 반환, 실패 시 None.
    TypeScript detectDocumentPart() 와 동일한 로직.
    """
    t = (heading_text or "").replace("\n", " ").strip()
    if not t:
        return None

    # 강력한 리터럴 트리거 먼저 확인 (heading-likeness 우회)
    for rx, key, is_target in _STRONG_TRIGGERS:
        if rx.search(t):
            return (key, is_target)

    if not _is_heading_like(t, is_heading_signal, font_size_ratio, bold_ratio):
        return None

    for key, is_target, regexes in _COMPILED_PART_PATTERNS:
        for rx in regexes:
            if rx.search(t):
                return (key, is_target)

    return None

# 하위 호환 레거시 키워드 매칭 (pdfplumber 경로 외 fallback 용)
# Mi-1: 중복 엔트리 제거 — 각 키워드는 한 번만 등장하도록 정리
ZONE_KEYWORD_MAP = [
    (["general condition", "general provision", "conditions of contract",
      "일반사항", "일반조건", "공통사항", "공통조건"], "general_conditions"),
    (["particular condition", "special condition",
      "특수사항", "특수조건", "특별사항", "특별조건"], "particular_conditions"),
    (["definition", "glossary", "interpretation",
      "정의", "용어정의", "용어 정의"], "definitions"),
    (["technical specification", "scope of work", "scope of supply",
      "기술사양", "기술 사양", "공사 범위", "업무범위"], "technical_specifications"),
    (["commercial term", "price and payment",
      "상업조건", "대금조건", "지급조건"], "commercial_terms"),
    (["appendix", "appendices", "annex", "attachment", "schedule", "exhibit"], "appendices"),
    (["별표", "별첨", "첨부"], "annexure"),
    (["amendment", "변경계약서", "계약변경", "변경계약"], "amendment"),
    (["table of content", "목차", "차례"], "toc"),
    (["agreement", "this contract", "witnesseth", "recital",
      "계약서", "계약체결"], "contract_agreement"),
]

def _detect_zone_hint(heading_text: str,
                      is_heading_signal: bool = True,
                      font_size_ratio: float = 1.0,
                      bold_ratio: float = 0.0) -> str:
    """
    zone hint 감지. regex 기반 패턴 매처 우선, fallback 시 키워드 매칭.
    기본 반환값: "contract_body" (이전 "general_conditions" 에서 변경).
    """
    result = _detect_zone_hint_from_patterns(heading_text, is_heading_signal, font_size_ratio, bold_ratio)
    if result is not None:
        return result[0]
    # regex 패턴 미매칭 → 레거시 키워드 fallback
    t = heading_text.lower()
    for keywords, zone in ZONE_KEYWORD_MAP:
        if any(k in t for k in keywords):
            return zone
    return "contract_body"


# ─── 헤더/푸터 감지 ───────────────────────────────────────────────────────────

from dataclasses import dataclass, field as _dc_field

@dataclass
class PageElement:
    text: str
    bbox: tuple[float, float, float, float]   # (x0, y0, x1, y1)
    page_number: int
    font_size: float

@dataclass
class HeaderFooterInfo:
    header_patterns: list[str] = _dc_field(default_factory=list)
    footer_patterns: list[dict] = _dc_field(default_factory=list)
    total_pages: int = 0
    page_number_style: str = ""
    removed_header_count: int = 0
    removed_footer_count: int = 0

    def to_dict(self) -> dict:
        return {
            "header_patterns": self.header_patterns,
            "footer_patterns": self.footer_patterns,
            "total_pages": self.total_pages,
            "page_number_style": self.page_number_style,
            "removed_header_count": self.removed_header_count,
            "removed_footer_count": self.removed_footer_count,
        }

# 페이지 번호 패턴 — 숫자 부분을 # 으로 치환하여 패턴 비교
_PAGE_NUM_PATTERNS = [
    _re.compile(r'^\s*page\s+\d+\s+of\s+\d+\s*$', _re.IGNORECASE),       # Page 5 of 120
    _re.compile(r'^\s*\d+\s*/\s*\d+\s*$'),                                # 5/120
    _re.compile(r'^\s*[-–]\s*\d+\s*[-–]\s*$'),                            # - 5 -
    _re.compile(r'^\s*p\.?\s*\d+\s*$', _re.IGNORECASE),                   # p. 5
    _re.compile(r'^\s*\d+\s*$'),                                           # 5
]
_PAGE_NUM_NORMALIZE = _re.compile(r'\d+')

def _normalize_for_pattern(text: str) -> str:
    """숫자 부분을 # 으로 치환하여 페이지 번호 패턴 비교에 사용."""
    return _PAGE_NUM_NORMALIZE.sub('#', text.strip().lower())

def _is_page_number_line(text: str) -> bool:
    t = text.strip()
    return any(p.match(t) for p in _PAGE_NUM_PATTERNS)

def _detect_headers_footers(
    pages_elements: list[list[PageElement]],
    page_heights: list[float],
) -> HeaderFooterInfo:
    """
    헤더/푸터 감지 알고리즘:
    1. 각 페이지 상위 10% / 하위 10% 영역 텍스트 추출 (Y좌표 기준)
       - pdfplumber Y좌표계: top=0이 페이지 상단, bottom=height가 페이지 하단
       - header_cutoff = height * 0.10 → y <= 이 값은 상단 영역
       - footer_cutoff = height * 0.90 → y >= 이 값은 하단 영역
    2. 2회 이상 또는 전체 페이지의 15% 이상 반복 → 헤더/푸터 후보 (한국어 계약서 큰 여백 고려)
    3. 페이지 번호 패턴 별도 처리 (텍스트 유사도 무시)
    4. 반복 텍스트는 숫자를 # 으로 치환 후 패턴 비교
    """
    import collections

    total_pages = len(pages_elements)
    info = HeaderFooterInfo(total_pages=total_pages)
    if total_pages < 3:
        return info

    # M-5: 헤더/푸터 감지 영역을 15%로 높여 한국어 계약서 오탐 방지
    header_zone_ratio = 0.15
    footer_zone_ratio = 0.15

    header_texts: dict[str, list[int]] = collections.defaultdict(list)  # normalized → [page_nos]
    footer_texts: dict[str, list[int]] = collections.defaultdict(list)

    page_num_header_pages: list[int] = []
    page_num_footer_pages: list[int] = []

    for page_idx, elements in enumerate(pages_elements):
        page_no = page_idx + 1
        height = page_heights[page_idx] if page_idx < len(page_heights) else 792.0
        if height <= 0:
            height = 792.0
        header_cutoff = height * header_zone_ratio
        footer_cutoff = height * (1.0 - footer_zone_ratio)

        for el in elements:
            y0, y1 = el.bbox[1], el.bbox[3]
            line_mid = (y0 + y1) / 2.0
            norm = _normalize_for_pattern(el.text)
            if not norm:
                continue
            if line_mid <= header_cutoff:
                if _is_page_number_line(el.text):
                    page_num_header_pages.append(page_no)
                else:
                    header_texts[norm].append(page_no)
            elif line_mid >= footer_cutoff:
                if _is_page_number_line(el.text):
                    page_num_footer_pages.append(page_no)
                else:
                    footer_texts[norm].append(page_no)

    # M-5: min_repeat 조건도 max(3, total_pages * 0.15)로 높여 오탐 방지
    # 예: 20페이지 문서 → max(3, int(20*0.15)) = max(3, 3) = 3회 이상 반복해야 헤더/푸터로 인정
    min_repeat = max(3, int(total_pages * 0.15))

    for norm, pages in header_texts.items():
        if len(pages) >= min_repeat:
            info.header_patterns.append(norm)

    # 페이지 번호 패턴 감지
    if len(page_num_footer_pages) >= min_repeat:
        info.footer_patterns.append({"pattern": "page_number", "type": "page_number"})
        info.page_number_style = "footer"
    if len(page_num_header_pages) >= min_repeat:
        info.header_patterns.append("page_number")
        if not info.page_number_style:
            info.page_number_style = "header"

    for norm, pages in footer_texts.items():
        if len(pages) >= min_repeat:
            info.footer_patterns.append({"pattern": norm, "type": "repeated_text"})

    return info

def _remove_header_footer_lines(text: str, hf_info: HeaderFooterInfo) -> tuple[str, int, int]:
    """
    섹션 텍스트에서 감지된 헤더/푸터 패턴 라인 제거.
    C-2: 헤더/푸터 제거 카운트를 분리하여 반환.
    반환: (cleaned_text, removed_header_count, removed_footer_count)
    """
    if not text:
        return text, 0, 0
    # 헤더 패턴 집합 (header_patterns는 문자열 목록)
    header_pattern_set = set(hf_info.header_patterns)
    # 푸터 패턴 집합 (footer_patterns는 dict 목록, type != page_number)
    footer_pattern_set = set(info["pattern"] for info in hf_info.footer_patterns
                              if info.get("type") != "page_number")
    has_page_num_footer = any(info.get("type") == "page_number" for info in hf_info.footer_patterns)
    has_page_num_header = "page_number" in header_pattern_set

    lines = text.split("\n")
    cleaned: list[str] = []
    removed_header = 0
    removed_footer = 0
    for line in lines:
        norm = _normalize_for_pattern(line)
        if not norm:
            cleaned.append(line)
            continue
        # 페이지 번호 라인 제거 — 위치 기반으로 헤더/푸터 구분 불가하므로 푸터 카운트로 처리
        if _is_page_number_line(line) and (has_page_num_header or has_page_num_footer):
            removed_footer += 1
            continue
        # 헤더 패턴 라인 제거
        if norm in header_pattern_set:
            removed_header += 1
            continue
        # 푸터 패턴 라인 제거
        if norm in footer_pattern_set:
            removed_footer += 1
            continue
        cleaned.append(line)
    return "\n".join(cleaned), removed_header, removed_footer


def _detect_document_boundaries(sections: list[dict]) -> list[dict]:
    """
    섹션 목록에서 대구획 문서 경계를 감지하여 document_parts 배열 반환.

    Pass 1: 모든 섹션에서 document-part 패턴 매칭 heading 마킹
    Pass 2: 경계 heading 사이의 연속 섹션을 하나의 document_part 로 그룹핑
            M-1: content(섹션)가 없는 빈 part는 이전 part에 병합하거나 건너뜀
    Pass 3: 문서 파트 내 모든 자식 섹션이 부모의 zone_hint 상속
    M-2: 첫 번째 boundary 이전 섹션들을 preamble document_part 로 추가
    C-1: boundary가 없으면 전체 문서를 contract_body 단일 part로 반환

    반환 형식:
    [
      {"part_type": "cover_page", "page_start": 1, "page_end": 2, "title": "Cover Page"},
      ...
    ]
    """
    if not sections:
        return []

    total_pages = max((s.get("page_end", 1) for s in sections), default=1)

    # Pass 1: 경계 heading 식별
    boundary_indices: list[int] = []
    for idx, sec in enumerate(sections):
        heading = sec.get("heading", "")
        if not heading:
            continue
        # level=1 이고 document-part 패턴에 매칭되는 경우만 경계로 처리
        if sec.get("level", 1) != 1:
            continue
        # is_toc=True 섹션은 경계로 사용하지 않음 — TOC가 boundary로 잡히면
        # 이후 섹션 전체가 "toc" part로 분류되는 버그 방지
        if sec.get("is_toc"):
            continue
        result = _detect_zone_hint_from_patterns(heading, is_heading_signal=True)
        if result is not None:
            boundary_indices.append(idx)

    def _make_part(part_type: str, title: str,
                   start_page: int, end_page: int,
                   section_count: int = 0) -> dict:
        return {
            "part_type": part_type,
            "page_start": start_page,
            "page_end": end_page,
            "title": title,
            "section_count": section_count,
        }

    # C-1: boundary가 없으면 전체 문서를 contract_body 단일 part로 반환
    # 단, preamble(zone_hint="preamble") 섹션이 있으면 별도 part로 분리
    if not boundary_indices:
        # preamble 섹션: zone_hint가 "preamble"인 섹션 (첫 번호 조항 이전)
        preamble_secs = [s for s in sections
                         if s.get("zone_hint") == "preamble" and not s.get("is_toc")]
        if preamble_secs:
            p_start = preamble_secs[0].get("page_start", 1)
            p_end = preamble_secs[-1].get("page_end", 1)
            # 첫 non-preamble 섹션의 시작 페이지
            first_body = next(
                (s for s in sections if s.get("zone_hint") != "preamble" and s.get("zone_hint") != "toc"),
                None,
            )
            body_start = first_body.get("page_start", p_end + 1) if first_body else p_end + 1
            return [
                _make_part("preamble", "전문", p_start, p_end, len(preamble_secs)),
                {
                    "part_type": "contract_body",
                    "title": "계약서 본문",
                    "page_start": body_start,
                    "page_end": total_pages,
                    "section_count": len(sections) - len(preamble_secs),
                },
            ]
        return [{
            "part_type": "contract_body",
            "title": "계약서 본문",
            "page_start": 1,
            "page_end": total_pages,
            "section_count": len(sections),
        }]

    # Pass 2: 경계 heading 사이 섹션 그룹핑
    document_parts: list[dict] = []

    # M-2: 첫 번째 boundary 이전 섹션들을 preamble part로 추가
    first_boundary_idx = boundary_indices[0]
    if first_boundary_idx > 0:
        preamble_sections = sections[:first_boundary_idx]
        if preamble_sections:
            p_start = preamble_sections[0].get("page_start", 1)
            # Bug Fix: preamble page_end는 is_toc=True 섹션(page_end가 TOC 마지막 페이지로
            # 팽창됨)을 제외하고 계산해야 함. TOC 섹션이 preamble 범위 안에 들어오면
            # page_end가 TOC 마지막 페이지(p23)로 잘못 설정된다.
            non_toc_pre = [s for s in preamble_sections if not s.get("is_toc")]
            if non_toc_pre:
                p_end = non_toc_pre[-1].get("page_end", 1)
            else:
                # 모두 TOC 섹션이면 첫 boundary 바로 직전 페이지 사용
                p_end = sections[first_boundary_idx].get("page_start", 1) - 1
            document_parts.append(_make_part(
                "preamble", "전문", p_start, p_end, len(preamble_sections)
            ))
            log.info(f"preamble 추가: {len(preamble_sections)}개 섹션 (p{p_start}~{p_end})")

    for i, boundary_idx in enumerate(boundary_indices):
        boundary_sec = sections[boundary_idx]
        result = _detect_zone_hint_from_patterns(
            boundary_sec.get("heading", ""), is_heading_signal=True
        )
        if result is None:
            continue
        part_type, _ = result

        next_boundary_idx = (
            boundary_indices[i + 1] if i + 1 < len(boundary_indices) else len(sections)
        )
        # 이 경계부터 다음 경계 전까지의 섹션 범위
        group = sections[boundary_idx:next_boundary_idx]
        if not group:
            continue

        # M-1: content가 없는 빈 part 건너뜀 (경계 섹션 자신만 있고 나머지 섹션이 없는 경우)
        # 경계 섹션 자신(heading만 있음)을 제외한 나머지 섹션 수 확인
        content_sections = [s for s in group[1:] if s.get("heading") or s.get("content", "").strip()]
        boundary_has_content = bool(boundary_sec.get("content", "").strip())
        if not content_sections and not boundary_has_content:
            log.info(
                f"빈 document_part 건너뜀: '{boundary_sec.get('heading', '')}' "
                f"(섹션 {boundary_idx}, 내용 없음)"
            )
            continue

        page_start = group[0].get("page_start", 1)
        # TOC 섹션(is_toc=True)은 page_end 계산에서 제외:
        # 문서 중간에 TOC가 위치하는 비정형 레이아웃(예: Contract Agreement 본문 뒤 TOC)에서
        # TOC 섹션의 page_end가 해당 part의 마지막 페이지로 잘못 팽창되는 것을 방지.
        non_toc_group = [s for s in group if not s.get("is_toc")]
        if non_toc_group:
            page_end = max(s.get("page_end", 1) for s in non_toc_group)
        else:
            page_end = max(s.get("page_end", 1) for s in group)
        title = boundary_sec.get("heading", part_type)

        document_parts.append(_make_part(part_type, title, page_start, page_end, len(group)))

        # Pass 3: 자식 섹션에 zone_hint 전파 (경계 섹션 자신 제외)
        # Bug B 수정: definitions/toc/cover_page/preamble 타입은 경계 섹션 자체에만 적용하고
        # 이후 섹션에는 전파하지 않음 (Clauses 2-23 전체가 definitions로 잘못 분류되는 문제 방지)
        NON_PROPAGATING_ZONES = {"definitions", "toc", "cover_page", "preamble"}
        for sec in group[1:]:
            if part_type in NON_PROPAGATING_ZONES:
                # 기존 zone_hint가 없거나 기본값이면 contract_body로 유지
                if sec.get("zone_hint") in (None, "contract_body", "unknown"):
                    sec["zone_hint"] = "contract_body"
                # 이미 다른 명시적 zone_hint가 있으면 그대로 유지
            else:
                sec["zone_hint"] = part_type

    return document_parts


# ─── TOC 감지 및 파싱 (Phase 2A/2B/2C) ──────────────────────────────────────

import dataclasses as _dataclasses

@_dataclasses.dataclass
class TocEntry:
    title: str
    page_number: Optional[int]
    level: int           # 1 = 최상위
    numbering: Optional[str]   # "1.1", "ARTICLE IV" 등


_TOC_HEADING_PATTERNS = [
    _re.compile(r'^\s*table\s+of\s+contents?\s*$', _re.IGNORECASE),
    _re.compile(r'^\s*contents?\s*$', _re.IGNORECASE),
    # 한국어 목차 변형: 앞뒤 공백, 중간 공백, 괄호 등 허용
    _re.compile(r'^\s*목\s*차\s*$'),
    _re.compile(r'^\s*\[?\s*목\s*차\s*\]?\s*$'),
    _re.compile(r'^\s*차\s*례\s*$'),            # "차례" (목차와 동의어)
    _re.compile(r'^\s*index\s*$', _re.IGNORECASE),
    # "TABLE OF CONTENTS" 앞뒤 특수 문자 허용
    _re.compile(r'^\s*[-–—]?\s*table\s+of\s+contents?\s*[-–—]?\s*$', _re.IGNORECASE),
]
_TOC_LEADER_PATTERN = _re.compile(r'\.{3,}|-\s*-\s*-')
_TOC_TRAILING_NUM   = _re.compile(r'^(.*?)[.\-\s]*(\d+)\s*$')
_NUMBERING_PREFIX   = _re.compile(r'^(\d+(?:\.\d+)*\s+|ARTICLE\s+[IVX]+\s*)', _re.IGNORECASE)

# TOC 페이지 번호 추출 패턴 (우선순위 순) — 다양한 TOC 형식 지원
# 각 패턴은 (title_group_idx, page_group_idx) 형태가 아니라 전체 라인에 적용되며,
# group(1)이 페이지 번호를 캡처함
_TOC_PAGE_NUM_PATTERNS = [
    _re.compile(r'\.{3,}\s*(\d+)\s*$'),            # "Title ....... 24"
    _re.compile(r'-{3,}\s*(\d+)\s*$'),              # "Title ------- 24"
    _re.compile(r'\t(\d+)\s*$'),                    # "Title\t24"
    _re.compile(r'\s{3,}(\d+)\s*$'),               # "Title         24" (공백 3개 이상)
    _re.compile(r'(\d+)\s*[-\u2013]\s*\d+\s*$'),  # "Title  24-35" (범위, 첫 번째 숫자)
    _re.compile(r'\s+(\d{1,4})\s*$'),              # "Title 24" (trailing number, last resort)
]


def _detect_toc_pages(sections: list[dict]) -> list[int]:
    """
    섹션 목록에서 TOC 섹션의 인덱스를 반환.

    휴리스틱 (우선순위 순):
    1. Heading이 TOC 패턴 매칭 (table of contents, 목차 등)
    2. 텍스트의 50% 이상 라인에 leader dot/dash + 숫자
    3. 텍스트의 30% 이상 라인이 숫자로 끝남
    4. 문서 전체 섹션의 첫 10% 내에 위치
    """
    toc_indices: list[int] = []
    total = len(sections)
    in_toc_mode = False  # TOC heading 발견 후 연속 섹션 감지

    for idx, sec in enumerate(sections):
        # Mi-5: heading의 앞뒤 공백을 strip() 후 패턴 매칭 수행
        heading = (sec.get("heading") or "").strip()
        content = sec.get("content") or ""

        # Phase 3에서 is_toc=True로 이미 마킹된 섹션은 즉시 TOC로 처리
        if sec.get("is_toc"):
            toc_indices.append(idx)
            in_toc_mode = True
            continue

        # 휴리스틱 1: heading 패턴 매칭 (strip() 적용된 heading으로 매칭)
        is_toc_heading = any(p.match(heading) for p in _TOC_HEADING_PATTERNS)

        # 문서 앞부분 여부 (첫 10% 이내)
        in_front = idx < max(1, int(total * 0.10) + 1)

        if is_toc_heading:
            toc_indices.append(idx)
            in_toc_mode = True
            continue

        # TOC 연속 감지 — heading 패턴 이후 leader dot 밀도로 연속 여부 판단
        if in_toc_mode:
            lines = [ln for ln in content.splitlines() if ln.strip()]
            if lines:
                leader_count = sum(
                    1 for ln in lines
                    if _TOC_LEADER_PATTERN.search(ln) and _re.search(r'\d+\s*$', ln)
                )
                dot_density = content.count('.') / max(len(content), 1)
                trailing_num = sum(1 for ln in lines if _re.search(r'\d+\s*$', ln.strip()))
                if (
                    leader_count >= len(lines) * 0.25
                    or (trailing_num >= len(lines) * 0.35 and dot_density >= 0.02)
                ):
                    toc_indices.append(idx)
                    continue
                else:
                    in_toc_mode = False  # 비TOC 섹션 → TOC 종료
            elif not heading:
                toc_indices.append(idx)
                continue
            else:
                in_toc_mode = False

        # heading이 없는 경우 텍스트 기반 휴리스틱 (문서 앞부분만)
        if not in_front:
            continue

        lines = [ln for ln in content.splitlines() if ln.strip()]
        if len(lines) < 3:
            continue

        # Bug A 수정: leader dot density가 낮으면 진짜 TOC가 아님 (계약 본문 텍스트 오탐 방지)
        dot_density = content.count('.') / max(len(content), 1)
        if dot_density < 0.03:
            continue

        # leader dot/dash/tab 선행 패턴: "....5", ". . . 5", "- - - 5", "\t5"
        _TOC_LEADER_WITH_NUM = _re.compile(r'(?:\.{2,}|\.\s+\.|\-\s*\-|\t)\s*\d+\s*$')
        leader_count = sum(1 for ln in lines if _TOC_LEADER_PATTERN.search(ln) and _re.search(r'\d+\s*$', ln))
        trailing_num_count = sum(1 for ln in lines if _re.search(r'\d+\s*$', ln.strip()))
        leader_with_num_count = sum(1 for ln in lines if _TOC_LEADER_WITH_NUM.search(ln))

        # 휴리스틱 2: leader dot 밀도
        if leader_count >= len(lines) * 0.5:
            toc_indices.append(idx)
            continue
        # 휴리스틱 3: 페이지 번호 밀도 — 추가 조건: leader dot/tab 선행 비율 50% 이상 필요
        # (조항별 금액 목록 등 숫자로 끝나는 목록 오탐 방지)
        if (trailing_num_count >= len(lines) * 0.3
                and leader_with_num_count >= trailing_num_count * 0.5):
            toc_indices.append(idx)

    return toc_indices


def _parse_toc_entries(toc_section_indices: list[int], sections: list[dict],
                        total_pages: int = 9999) -> list[dict]:
    """
    TOC 섹션들의 텍스트를 라인 단위로 파싱하여 TocEntry 리스트(dict 형태)로 반환.

    파싱 전략:
    1. TOC 섹션들의 content를 합산
    2. 라인 단위로 분리
    3. 각 라인에서 후행 페이지 번호, leader 제거, 조항 번호 prefix 추출
    4. level은 들여쓰기 대신 조항 번호 패턴 기반으로 추론 (pdfplumber는 공백 보존 불안정)
       - "1.1.1 ..." 형식  → level 3
       - "1.1 ..."   형식  → level 2
       - "1. ..."    형식  → level 1
       - "A. ..."    형식  → level 1
       - 로마숫자 (I, II…) → level 1
       - 번호 없음          → level 1
    5. 페이지 번호는 total_pages 상한으로 검증 (연도/금액 오탐 방지)
    6. 페이지 번호 없는 라인은 이전 엔트리 제목의 연속으로 처리
    """
    if not toc_section_indices:
        return []

    # 조항 번호 기반 level 추론 패턴 (우선순위 내림차순)
    _LEVEL3_PAT = _re.compile(r'^\d+\.\d+\.\d+')
    _LEVEL2_PAT = _re.compile(r'^\d+\.\d+')
    _LEVEL1_NUM_PAT = _re.compile(r'^\d+\.')
    _LEVEL1_ALPHA_PAT = _re.compile(r'^[A-Z]\.')
    _LEVEL1_ROMAN_PAT = _re.compile(r'^[IVXLC]+[\.\s]', _re.IGNORECASE)

    def _infer_level_from_numbering(text: str) -> int:
        t = text.strip()
        if _LEVEL3_PAT.match(t):
            return 3
        if _LEVEL2_PAT.match(t):
            return 2
        if _LEVEL1_NUM_PAT.match(t) or _LEVEL1_ALPHA_PAT.match(t) or _LEVEL1_ROMAN_PAT.match(t):
            return 1
        return 1

    # TOC 섹션 텍스트 합산
    combined_lines: list[str] = []
    for idx in toc_section_indices:
        sec = sections[idx]
        # heading이 TOC 제목이면 첫 라인으로 추가하지 않음 (메타 제목이므로 스킵)
        content = sec.get("content") or ""
        combined_lines.extend(content.splitlines())

    entries: list[TocEntry] = []
    prev_entry: Optional[TocEntry] = None

    for raw_line in combined_lines:
        line = raw_line.rstrip()
        if not line.strip():
            continue

        stripped = line.lstrip()

        # leader dot/dash 제거 후 후행 페이지 번호 추출
        # TOC 페이지 번호 추출 개선: 다양한 패턴 시도 (우선순위 순)
        page_number: Optional[int] = None
        title_text = stripped
        cleaned = _TOC_LEADER_PATTERN.sub(" ", stripped).strip()

        # 1단계: 기존 _TOC_TRAILING_NUM 패턴 시도 (leader 제거 후)
        m = _TOC_TRAILING_NUM.match(cleaned)
        if m:
            candidate_title = m.group(1).strip()
            candidate_page = int(m.group(2))
            # C-3: 4자리이고 1900-2100 범위이면 연도로 간주하여 필터링
            _is_year = (len(str(candidate_page)) == 4 and 1900 <= candidate_page <= 2100)
            if 1 <= candidate_page <= total_pages and candidate_title and not _is_year:
                page_number = candidate_page
                title_text = candidate_title

        # 2단계: 기존 패턴 실패 시 확장 패턴으로 원본 라인에서 재시도
        if page_number is None:
            for _pat in _TOC_PAGE_NUM_PATTERNS:
                _pm = _pat.search(stripped)
                if _pm:
                    try:
                        _candidate_page = int(_pm.group(1))
                    except (IndexError, ValueError):
                        continue
                    _is_year = (len(str(_candidate_page)) == 4 and 1900 <= _candidate_page <= 2100)
                    if 1 <= _candidate_page <= total_pages and not _is_year:
                        # title은 패턴 매칭 시작 위치 이전 텍스트 (leader 제거 후)
                        _title_candidate = stripped[:_pm.start()].strip()
                        _title_candidate = _TOC_LEADER_PATTERN.sub("", _title_candidate).strip()
                        if _title_candidate:
                            page_number = _candidate_page
                            title_text = _title_candidate
                            break

        # title_text가 아직 stripped 그대로면 cleaned로 설정
        if title_text is stripped:
            title_text = cleaned

        if not title_text:
            # 페이지 번호만 있는 라인 — 이전 엔트리 제목의 연속
            if prev_entry and page_number is not None:
                prev_entry = _dataclasses.replace(prev_entry, page_number=page_number)
                entries[-1] = prev_entry
            continue

        # 조항 번호 prefix 추출
        numbering: Optional[str] = None
        nm = _NUMBERING_PREFIX.match(title_text)
        if nm:
            numbering = nm.group(0).strip()
            title_text = title_text[nm.end():].strip() or title_text

        # level: 들여쓰기 대신 조항 번호 패턴 기반 추론
        level = _infer_level_from_numbering(numbering if numbering else stripped)

        entry = TocEntry(
            title=title_text,
            page_number=page_number,
            level=level,
            numbering=numbering,
        )
        entries.append(entry)
        prev_entry = entry

    return [_dataclasses.asdict(e) for e in entries]


def _validate_structure_against_toc(
    document_parts: list[dict],
    toc_entries: list[dict],
    warnings: list[str],
    sections: Optional[list[dict]] = None,
) -> list[dict]:
    """
    document_parts와 TOC 엔트리를 교차 검증.
    level=1 TOC 엔트리에 대응하는 document_part가 없으면:
    - 해당 페이지(±2) 근처에 매칭 섹션이 있으면 새 document_part를 삽입 (confidence: 0.85)
    - 섹션도 없으면 경고만 기록 (기존 동작 유지)
    """
    if not toc_entries or not document_parts:
        return document_parts

    PAGE_TOLERANCE = 2  # ±2페이지 허용

    # Bug A 수정: TOC 페이지 자체의 page_end를 구하여 TOC 이전 페이지 번호 필터링
    # TOC part가 있으면 그 page_end를 toc_page_end로 사용
    toc_page_end: int = 0
    for dp in document_parts:
        if dp.get("part_type") == "toc":
            toc_page_end = max(toc_page_end, dp.get("page_end", 0))

    def _pages_overlap(p1_start: int, p1_end: int, p2_start: int, p2_end: int) -> bool:
        """두 페이지 범위가 겹치는지 확인."""
        return p1_start <= p2_end and p2_start <= p1_end

    # 섹션을 페이지 번호로 빠르게 조회 (삽입 후보 탐색용)
    page_to_sections: dict[int, list[dict]] = {}
    if sections:
        for sec in sections:
            for pg_num in range(sec.get("page_start", 1), sec.get("page_end", 1) + 1):
                page_to_sections.setdefault(pg_num, []).append(sec)

    parts_to_insert: list[dict] = []

    for entry in toc_entries:
        if entry.get("level", 1) != 1:
            continue
        pg = entry.get("page_number")
        if pg is None:
            continue
        title = entry.get("title", "")

        # Bug A 수정: TOC 엔트리의 페이지 번호가 TOC 페이지 이전이면 가짜 엔트리로 건너뜀
        if toc_page_end > 0 and pg <= toc_page_end:
            log.debug(f"TOC 엔트리 '{title}' (p{pg}) — TOC 페이지({toc_page_end}) 이전이므로 건너뜀")
            continue

        # 해당 페이지 근처에 document_part 존재 여부 확인
        matched = any(
            abs(dp.get("page_start", 0) - pg) <= PAGE_TOLERANCE
            for dp in document_parts
        )
        if matched:
            continue

        # 매칭 document_part 없음 — 해당 페이지 근처 섹션에서 삽입 후보 탐색
        nearby_section: Optional[dict] = None
        for offset in range(PAGE_TOLERANCE + 1):
            for check_pg in ([pg] if offset == 0 else [pg - offset, pg + offset]):
                candidates = page_to_sections.get(check_pg, [])
                if candidates:
                    nearby_section = candidates[0]
                    break
            if nearby_section:
                break

        if nearby_section and pg > 0:
            # Bug A 수정: 삽입 전 기존 parts와 페이지 겹침 확인
            new_part_start = pg
            new_part_end = nearby_section.get("page_end", pg)
            overlap_found = any(
                _pages_overlap(new_part_start, new_part_end,
                               ep.get("page_start", 1), ep.get("page_end", 1))
                for ep in document_parts
            )
            if overlap_found:
                log.debug(
                    f"TOC 엔트리 '{title}' (p{pg}~{new_part_end}) — 기존 part와 페이지 겹침으로 삽입 건너뜀"
                )
                continue

            # TOC 기반 새 document_part 삽입
            # Bug D 수정: top-level document_parts와 sub_documents[0].document_parts가
            # 동일한 키 구조를 갖도록 section_count를 포함시킴
            part_type = _detect_zone_hint(title, is_heading_signal=True) or "contract_body"
            new_part: dict = {
                "part_type": part_type,
                "page_start": pg,
                "page_end": new_part_end,
                "title": title,
                "section_count": 0,  # TOC 기반 삽입이므로 실제 섹션 수 미확정
                "confidence": 0.85,  # TOC 기반 삽입 표시
            }
            parts_to_insert.append(new_part)
            log.info(
                f"TOC 기반 document_part 삽입: '{title}' (p{pg}, type={part_type}, confidence=0.85)"
            )
        else:
            warnings.append(
                f"TOC 항목 '{title}'(p{pg})에 대응하는 document_part 없음 — 근처 섹션도 없어 삽입 생략"
            )

    if parts_to_insert:
        document_parts = list(document_parts) + parts_to_insert
        # page_start 기준 정렬하여 순서 보장
        document_parts.sort(key=lambda dp: dp.get("page_start", 0))

        # M-6: TOC-derived part의 page_end를 다음 part의 page_start - 1로 업데이트
        # (삽입된 part의 page_end가 과소 추정되는 문제 수정)
        # 전체 문서 페이지 수 추정 (sections에서 구하거나 마지막 part의 page_end 사용)
        _total_pg = max((dp.get("page_end", 1) for dp in document_parts), default=1)
        for _k, _dp in enumerate(document_parts):
            if _dp.get("confidence") == 0.85:  # TOC-derived part 표시
                if _k + 1 < len(document_parts):
                    next_start = document_parts[_k + 1].get("page_start", _dp.get("page_end", 1))
                    _dp["page_end"] = max(_dp.get("page_end", 1), next_start - 1)
                else:
                    _dp["page_end"] = _total_pg

    return document_parts


@_dataclasses.dataclass
class SubDocument:
    title: str
    page_start: int
    page_end: int
    document_parts: list  # list of document_part dicts


def _detect_sub_documents(
    sections: list[dict],
    document_parts: list[dict],
) -> list[dict]:
    """
    하나의 PDF에 합본된 여러 sub-document 경계를 감지하여
    SubDocument 목록(dict 형태)으로 반환.

    감지 신호 (document_parts 기반):
    1. Page 1 마커 — 섹션 텍스트에 "Page 1 of X" 또는 "Page 1" 패턴 (첫 페이지 제외)
    2. 타이틀 페이지 패턴 — 텍스트 극소 + 큰 폰트 heading만 있는 페이지 (cover_page 파트 타입)
    3. 조항 번호 재시작 — 조항 번호가 "1." 또는 "Article I/1"로 재시작하는 heading
    4. 별도 TOC — 문서 중간(20% 이후) 페이지에 TOC 타입 document_part 등장
    5. 헤더/푸터 패턴 변경 — 연속 document_parts에서 파트 타입이 갑자기 "cover_page"로 전환

    알고리즘:
    1. document_parts를 순회하며 위 신호 중 2개 이상 충족하는 경계 지점 탐색
    2. 경계 지점 기준으로 document_parts를 sub_document로 그룹핑
    3. 경계 없으면 전체를 단일 sub_document 반환 (하위 호환)

    반환 형식:
    [
      {
        "title": "Contract Agreement",
        "page_start": 1,
        "page_end": 15,
        "document_parts": [...]
      },
      ...
    ]
    감지 실패 시 [] 반환.
    """
    if not document_parts:
        # document_parts 없으면 sections에서 직접 경계 탐색
        if not sections:
            return []
        total_pages = max((s.get("page_end", 1) for s in sections), default=1)
        return [{
            "title": _extract_sub_doc_title(sections, 0),
            "page_start": 1,
            "page_end": total_pages,
            "document_parts": [],
        }]

    total_parts = len(document_parts)
    if total_parts == 0:
        return []

    # 문서 전체 페이지 수 추정
    total_pages = max((dp.get("page_end", 1) for dp in document_parts), default=1)
    twenty_pct_page = max(1, int(total_pages * 0.20))

    # ── 경계 후보 탐색: 각 document_part 인덱스에 대한 신호 점수 계산 ──────────
    # 인덱스 0은 항상 첫 번째 sub_document 시작점이므로 1부터 탐색
    boundary_indices: list[int] = []

    # 섹션을 페이지 번호로 빠르게 조회하기 위한 인덱스 (1-based page → section list)
    page_to_sections: dict[int, list[dict]] = {}
    for sec in sections:
        for pg in range(sec.get("page_start", 1), sec.get("page_end", 1) + 1):
            page_to_sections.setdefault(pg, []).append(sec)

    # Mi-2: 한국어 문서 번호 재시작 패턴 추가 (제1조, 제1장 재시작)
    _RESTART_PATTERN = _re.compile(
        r'^\s*(?:article\s+(?:i|1)\b|(?:clause|section|part)\s+1\b|1\.\s+\S'
        r'|제\s*1\s*(?:조|장|절)\b)',
        _re.IGNORECASE,
    )
    # Page-1 마커 패턴 (섹션 콘텐츠 내 검색)
    _PAGE1_PATTERN = _re.compile(
        r'\bpage\s+1\s+(?:of\s+\d+)?\b', _re.IGNORECASE,
    )

    for i in range(1, total_parts):
        dp = document_parts[i]
        part_type = dp.get("part_type", "")
        page_start = dp.get("page_start", 1)

        signals = 0

        # 신호 1: Page 1 마커 — 이 파트의 시작 페이지 섹션에서 "Page 1 of X" 텍스트
        if page_start > 1:
            nearby_sections = page_to_sections.get(page_start, [])
            for sec in nearby_sections:
                content = sec.get("content", "") + sec.get("heading", "")
                if _PAGE1_PATTERN.search(content):
                    signals += 1
                    break

        # 신호 2: 타이틀 페이지 패턴 — cover_page 파트 타입이 등장
        if part_type == "cover_page":
            signals += 1

        # 신호 3: 조항 번호 재시작 — heading이 "1." 또는 "Article I/1"로 시작
        title = dp.get("title", "")
        if title and _RESTART_PATTERN.match(title):
            signals += 1
        # 시작 페이지 근처 섹션의 heading에서도 재시작 신호 탐색
        if signals < 2:
            for sec in page_to_sections.get(page_start, []):
                heading = sec.get("heading", "")
                if heading and _RESTART_PATTERN.match(heading):
                    signals += 1
                    break

        # 신호 4: 별도 TOC — 문서 중간(20% 이후)에 TOC 파트 등장
        if part_type == "toc" and page_start > twenty_pct_page:
            signals += 1

        # 신호 5: 이전 파트 타입이 non-cover_page → 현재가 cover_page (문서 전환 신호)
        prev_type = document_parts[i - 1].get("part_type", "")
        if part_type == "cover_page" and prev_type not in ("cover_page", "toc"):
            signals += 1

        if signals >= 2:
            boundary_indices.append(i)
            log.info(
                f"sub_document 경계 감지: part_index={i}, part_type={part_type}, "
                f"page_start={page_start}, signals={signals}"
            )

    # ── 경계가 없으면 전체를 단일 sub_document로 반환 ────────────────────────
    if not boundary_indices:
        title = document_parts[0].get("title", "") or _extract_sub_doc_title(sections, 0)
        return [{
            "title": title or "Document",
            "page_start": document_parts[0].get("page_start", 1),
            "page_end": document_parts[-1].get("page_end", total_pages),
            "document_parts": document_parts,
        }]

    # ── 경계 기준으로 document_parts를 sub_document로 그룹핑 ─────────────────
    sub_docs: list[dict] = []
    group_starts = [0] + boundary_indices  # 각 그룹의 시작 인덱스

    for k, start_idx in enumerate(group_starts):
        end_idx = group_starts[k + 1] if k + 1 < len(group_starts) else total_parts
        group = document_parts[start_idx:end_idx]
        if not group:
            continue

        page_start = group[0].get("page_start", 1)
        page_end = max(dp.get("page_end", 1) for dp in group)

        # 타이틀: 첫 번째 파트의 title 또는 섹션에서 첫 heading 추출
        title = group[0].get("title", "") or _extract_sub_doc_title(sections, page_start - 1)

        sub_docs.append({
            "title": title or f"Document {k + 1}",
            "page_start": page_start,
            "page_end": page_end,
            "document_parts": group,
        })

    log.info(f"sub_documents 감지 완료: {len(sub_docs)}개 sub-document")
    return sub_docs


def _extract_sub_doc_title(sections: list[dict], min_page: int) -> str:
    """
    min_page 이상의 첫 heading 텍스트를 반환. 없으면 빈 문자열.
    sub_document 타이틀 fallback 추출에 사용.
    """
    for sec in sections:
        if sec.get("page_start", 1) >= min_page and sec.get("heading"):
            return sec["heading"]
    return ""


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
                try:
                    md = item.export_to_markdown(doc)
                except TypeError:
                    try:
                        md = item.export_to_markdown()
                    except Exception:
                        md = item.text.strip()
                except Exception:
                    md = item.text.strip()
                current["content"] += (md or item.text.strip()) + "\n"
                current["page_end"] = max(current["page_end"], page)

            elif (ListItem and isinstance(item, ListItem)) or cls_name == "ListItem":
                ensure_current(page)
                try:
                    md = item.export_to_markdown(doc)
                except TypeError:
                    try:
                        md = item.export_to_markdown()
                    except Exception:
                        md = item.text.strip()
                except Exception:
                    md = item.text.strip()
                current["content"] += (md or item.text.strip()) + "\n"
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


def _extract_heading_number(heading: str) -> str | None:
    """heading에서 조항 번호를 추출한다.

    일반 번호: "7 Equipment..." → "7", "7.1 Manner..." → "7.1"
    "6." 또는 "6.)" 같은 trailing-punct 번호: "6." → "6"
    ARTICLE/SECTION 형식: "ARTICLE 6 COMMENCEMENT" → "6"
    """
    # 일반 숫자 시작 (번호 뒤 공백 또는 마침표/괄호 + 공백)
    # 예: "7 Equipment" → "7", "6. COMMENCEMENT" → "6", "6.1 Title" → "6.1"
    m = _re.match(r'^\s*(\d+(?:\.\d+)*)\s', heading)
    if m:
        return m.group(1)
    m = _re.match(r'^\s*(\d+(?:\.\d+)*)[.)]\s', heading)
    if m:
        return m.group(1)
    # 번호 뒤 마침표/괄호로 끝나는 heading (예: "6." "6)" 같이 번호만 있는 heading)
    m = _re.match(r'^\s*(\d+(?:\.\d+)*)[.)]\s*$', heading)
    if m:
        return m.group(1)
    # ARTICLE/CLAUSE/SECTION/CHAPTER/PART + 숫자
    m = _re.match(r'^\s*(?:ARTICLE|CLAUSE|SECTION|CHAPTER|PART)\s+(\d+(?:\.\d+)*)\b', heading, _re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def _is_parent_child_heading(current_heading: str, next_heading: str) -> bool:
    """
    두 heading이 parent-child 관계인지 판별한다.

    예: current="7 Equipment, Materials and Workmanship", next="7.1 Manner of Execution"
    → current의 조항 번호 "7"이 next의 조항 번호 "7.1"의 prefix → parent-child

    예: current="ARTICLE 6 COMMENCEMENT", next="6.1 Effectiveness"
    → "ARTICLE 6"에서 번호 "6" 추출 → "6.1"의 prefix → parent-child

    parent-child 관계인 경우 병합하면 안 됨 — 둘 다 독립적인 heading이어야 한다.
    non-numbered heading끼리는 parent-child가 아니므로 기존 병합 로직 유지.
    """
    cur_num = _extract_heading_number(current_heading)
    nxt_num = _extract_heading_number(next_heading)

    if not cur_num or not nxt_num:
        return False

    # child: next가 current로 시작 (예: "7" → "7.1", "7.1" → "7.1.1")
    if nxt_num.startswith(cur_num + '.'):
        return True

    return False


# ---------------------------------------------------------------------------
# Line unwrapping — PDF 물리적 줄바꿈을 논리적 문장 단위로 병합
# ---------------------------------------------------------------------------

# 리스트 마커로 시작하는 줄: 줄바꿈 보존 (새 항목의 시작)
_LIST_MARKER_RE = _re.compile(
    r'^\s*(?:'
    r'\([a-z]{1,3}\)'       # (a), (aa)
    r'|\([ivxlcdm]+\)'     # (i), (iv), (xiv)
    r'|\(\d\)'             # (1)~(9) — 한 자릿수만. (14)(30) 등 두 자릿수 이상은 인라인 참조
    r'|[a-z]\.'            # a.
    r'|\d+\.'              # 1.
    r'|\d+\.\d+'           # 1.1
    r'|[•\-–—]\s'          # bullet
    r')',
    _re.IGNORECASE,
)

# 문장 종결 패턴: 마침표, 세미콜론, 콜론, 닫는 따옴표 뒤 마침 등
_SENTENCE_END_RE = _re.compile(r'[.;:!?]\s*$|[.;:!?]["\u201d\u2019]\s*$')

# 괄호 숫자/참조로 시작 — 계약서 관용 표현: "fourteen (14)", "Article (3)"
# 독립 줄 "(14)" 또는 "(14) calendar days" 모두 매칭
_PAREN_NUM_START_RE = _re.compile(r'^\(\d+\)\s*')

# 볼드 마크다운 시작: **로 시작하는 줄은 새 문장일 가능성
_BOLD_START_RE = _re.compile(r'^\*\*')

# 테이블 줄
_TABLE_LINE_RE = _re.compile(r'^\s*\|')


def _unwrap_content_lines(content: str) -> str:
    """
    PDF 물리적 줄바꿈을 논리적 문장/문단 단위로 병합한다.

    병합 규칙 (이전 줄 + 현재 줄 → 한 줄로 합침):
    - 이전 줄이 문장 종결 부호(.;:!?)로 끝나지 않음
    - 현재 줄이 리스트 마커로 시작하지 않음
    - 현재 줄이 테이블(|)이 아님
    - 현재 줄이 **볼드**로 시작하지 않음 (제목/강조 줄 보존)

    특수 케이스:
    - 현재 줄이 괄호 숫자 "(14)" 등으로 시작하면 무조건 병합
      → "fourteen\n(14)\ncalendar days" → "fourteen (14) calendar days"
    """
    if not content:
        return content

    lines = content.split("\n")
    result: list[str] = []

    for line in lines:
        stripped = line.strip()

        # 빈 줄 → 문단 경계 보존
        if not stripped:
            result.append("")
            continue

        # 첫 줄이거나 이전 결과가 빈 줄(문단 경계)이면 새로 시작
        if not result or result[-1] == "":
            result.append(stripped)
            continue

        prev = result[-1]

        # ── 줄바꿈 보존 케이스 ──
        # 리스트 마커 시작 → 새 항목 (단, 이전 줄이 문장 중간이면 병합)
        if _LIST_MARKER_RE.match(stripped):
            # 이전 줄이 문장 종결이면 → 새 리스트 항목
            if _SENTENCE_END_RE.search(prev):
                result.append(stripped)
                continue
            # 이전 줄이 문장 중간 + 괄호 숫자 → 관용 표현 병합
            # 예: "fourteen\n(14)\ncalendar days"
            if _PAREN_NUM_START_RE.match(stripped):
                result[-1] = prev + " " + stripped
                continue
            # 이전 줄이 문장 중간이지만 긴 리스트 마커 항목 → 새 항목
            result.append(stripped)
            continue

        # 테이블 줄
        if _TABLE_LINE_RE.match(stripped):
            result.append(stripped)
            continue

        # 볼드 마크다운으로 시작 → 새 문장/제목
        if _BOLD_START_RE.match(stripped):
            result.append(stripped)
            continue

        # ── 일반 병합 판단 ──
        # 이전 줄이 문장 종결로 끝나면 → 줄바꿈 보존
        if _SENTENCE_END_RE.search(prev):
            result.append(stripped)
            continue

        # 현재 줄이 대문자 단어로 시작하고 이전 줄이 쉼표/and/or 등으로 안 끝나면
        # → 새 문장일 가능성 (단, "The", "A" 등 관사는 문장 중간일 수 있음)
        # 보수적으로: 대문자 시작이어도 이전 줄이 문장 중간이면 병합
        # (문장 종결은 위에서 이미 체크했으므로 여기 도달하면 문장 중간)

        # 병합
        result[-1] = prev + " " + stripped

    return "\n".join(result)


def _merge_fragmented_headings(sections: list[dict]) -> list[dict]:
    """
    연속된 heading-only 섹션을 다음 섹션과 병합한다.

    문제 상황:
    PDF에서 "1.1"과 "Definitions"가 별도 줄로 추출될 때, 각각 is_heading() 판정을
    받아 빈 content를 가진 섹션 두 개로 분리된다:
      section[N]:   { heading: "1.1",         content: "" }
      section[N+1]: { heading: "Definitions", content: "" }
      section[N+2]: { heading: "",            content: "정의..." }

    이 함수는 content가 빈 heading-only 섹션들을 순방향으로 누적한 뒤
    content가 있는 다음 섹션의 heading 앞에 붙여 하나로 병합한다:
      → { heading: "1.1 Definitions", content: "정의..." }

    병합 규칙:
    - 현재 섹션의 content.strip() == "" 이고 heading.strip() != "" 인 경우만 대상
    - 구조적 조항 번호(예: 1.1.1.20)로 시작하는 heading-only 섹션은 병합 제외
      → 단행 정의 조항(예: '1.1.1.20 "Commercial Operation Date"...PPA.')은
        heading에 전체 내용이 담긴 자기 완결 섹션이므로 다음 섹션과 병합하면 안 됨
    - parent-child 관계의 heading-only 섹션은 병합 제외
      → 예: "7 Equipment..." (parent) + "7.1 Manner..." (child)는 각각 독립 섹션
    - 연속된 빈-content heading들을 모두 수집한 뒤 다음 섹션과 병합
    - 뒤에 content 있는 섹션이 없으면 빈 섹션들을 그대로 유지
    - level, page_start, page_end, zone_hint는 첫 번째 heading-only 섹션의 값을 사용
      (방향성: 첫 번째 heading이 번호이고 다음 heading이 제목인 경우 번호의 level/zone이 더 정확)
    """
    if not sections:
        return sections

    # 자기 완결 heading 판별 패턴:
    # 1. 3단계 이상 번호(1.1.1.x): 정의 조항 heading으로 단행 자기 완결
    # 2. 조항 번호 + "[Not Used]" 패턴: 빈 content이지만 완전한 독립 섹션
    # 3. 조항 번호 + "Not Used" 패턴: 대괄호 없는 변형
    _SELF_CONTAINED_HEADING = _re.compile(r'^\s*\d+(?:\.\d+){2,}\s')
    _NOT_USED_HEADING = _re.compile(r'^\s*\d+(?:\.\d+)+\s+\[?Not\s+Used\]?\s*$', _re.IGNORECASE)

    merged: list[dict] = []
    i = 0
    while i < len(sections):
        current = sections[i]
        # heading-only 섹션: content가 비어 있고 heading은 있는 경우
        heading_text = current.get("heading", "").strip()
        content_text = current.get("content", "").strip()
        if content_text == "" and heading_text:
            # 자기 완결 heading: 3단계+ 번호 또는 "[Not Used]" 조항 → 병합 제외
            if _SELF_CONTAINED_HEADING.match(heading_text) or _NOT_USED_HEADING.match(heading_text):
                merged.append(current)
                i += 1
                continue

            # 연속된 빈-content heading들을 모두 수집
            heading_parts: list[str] = [heading_text]
            anchor = current  # level, page_start, zone_hint의 기준 섹션
            j = i + 1
            while j < len(sections):
                nxt = sections[j]
                nxt_heading = nxt.get("heading", "").strip()
                nxt_content = nxt.get("content", "").strip()
                # 다음 섹션도 heading-only이고 자기 완결 heading이 아닌 경우만 수집
                _is_self_contained = (
                    _SELF_CONTAINED_HEADING.match(nxt_heading) or
                    _NOT_USED_HEADING.match(nxt_heading)
                )
                if nxt_heading and nxt_content == "" and not _is_self_contained:
                    # ── Task 1: parent-child heading 병합 방지 ──
                    # 현재 수집된 heading(마지막 heading_part)과 다음 heading이
                    # parent-child 관계이면 병합을 중단하고 각각 독립 섹션으로 유지.
                    # 예: "7 Equipment..." + "7.1 Manner..." → 병합하지 않음
                    last_collected = heading_parts[-1]
                    if _is_parent_child_heading(last_collected, nxt_heading):
                        break
                    # ── 구조적 번호 충돌 감지 ──
                    # 이미 수집된 heading에 구조적 번호(ARTICLE N 또는 숫자)가 있고,
                    # 다음 heading도 다른 구조적 번호를 가지면 병합 중단.
                    # 예: ["ARTICLE 6", "COMMENCEMENT"] + "6.1 Effectiveness" → 중단
                    collected_num = None
                    for hp in heading_parts:
                        n = _extract_heading_number(hp)
                        if n:
                            collected_num = n
                            break
                    nxt_num = _extract_heading_number(nxt_heading)
                    if collected_num and nxt_num and collected_num != nxt_num:
                        break
                    heading_parts.append(nxt_heading)
                    j += 1
                else:
                    break

            if j < len(sections):
                # ── Task 1 보완: 병합 대상(content 있는 섹션)이 parent-child이면 병합 금지 ──
                # 예: heading_parts=["1 General Provisions"], 대상="1.1 Definitions" (content 있음)
                # → "1"과 "1.1"은 parent-child → 병합하지 않고 각각 독립 섹션으로 유지
                target_heading = sections[j].get("heading", "").strip()
                last_collected = heading_parts[-1]
                # 수집된 heading 중 번호가 있는 heading도 parent-child 체크에 사용.
                # 예: heading_parts=["ARTICLE 6", "COMMENCEMENT"], target="6.1 Effectiveness"
                # → last_collected="COMMENCEMENT"에는 번호 없지만 "ARTICLE 6"에서 "6" 추출
                # → "6"과 "6.1"은 parent-child → 병합하지 않음
                _any_parent_child = False
                if target_heading:
                    # last_collected와의 직접 비교
                    if _is_parent_child_heading(last_collected, target_heading):
                        _any_parent_child = True
                    else:
                        # 수집된 모든 heading_parts에서 번호를 가진 heading으로 재검사
                        for _hp in heading_parts:
                            if _is_parent_child_heading(_hp, target_heading):
                                _any_parent_child = True
                                break
                    # ── 보완: target heading에 embedded sub-clause 번호 감지 ──
                    # target_heading이 숫자로 시작하지 않아서 _extract_heading_number → None
                    # 이지만, 내부에 자식 번호를 포함하는 경우.
                    # 예: heading_parts=["ARTICLE 6"], target="COMMENCEMENT 6.1 Effectiveness..."
                    # → target에서 _extract_heading_number → None이지만 "6.1"이 embedded
                    # → "6"의 자식이므로 병합 금지
                    if not _any_parent_child:
                        _embed_m = _EMBEDDED_SUBCLAUSE_RE.search(target_heading)
                        if _embed_m:
                            _embed_num = _embed_m.group(1)
                            for _hp in heading_parts:
                                _hp_num = _extract_heading_number(_hp)
                                if _hp_num and _embed_num.startswith(_hp_num + '.'):
                                    log.info(
                                        f"[merge block] embedded child '{_embed_num}' in target "
                                        f"\"{target_heading}\" is child of \"{_hp}\" (num={_hp_num}) "
                                        f"→ 병합 차단"
                                    )
                                    _any_parent_child = True
                                    break
                if _any_parent_child:
                    # parent heading(들)을 하나의 heading-only 섹션으로 합쳐서 보존.
                    # 예: ["ARTICLE 6", "COMMENCEMENT"] → "ARTICLE 6 COMMENCEMENT" (heading-only)
                    # 이 합쳐진 섹션은 target("6.1 Effectiveness...")과 병합하지 않음.
                    combined_parent = dict(anchor)
                    combined_parent["heading"] = " ".join(heading_parts)
                    combined_parent["page_end"] = sections[j - 1].get("page_end", anchor.get("page_end", 1))
                    merged.append(combined_parent)
                    i = j
                    continue

                # content가 있는 다음 섹션과 병합
                target = dict(sections[j])
                combined_heading = " ".join(heading_parts)
                if target.get("heading", "").strip():
                    combined_heading = combined_heading + " " + target["heading"].strip()
                target["heading"] = combined_heading
                # level과 page_start는 첫 번째(anchor) heading 섹션 기준으로 유지
                target["level"] = anchor.get("level", target.get("level", 1))
                target["page_start"] = anchor.get("page_start", target.get("page_start", 1))
                # zone_hint: anchor가 contract_body가 아닌 구체적인 zone이면 우선 사용
                anchor_zone = anchor.get("zone_hint", "contract_body")
                if anchor_zone != "contract_body":
                    target["zone_hint"] = anchor_zone
                merged.append(target)
                i = j + 1
            else:
                # 뒤에 content 있는 섹션이 없음 — heading-only 섹션들을 그대로 유지
                for k in range(i, j):
                    merged.append(sections[k])
                i = j
        else:
            merged.append(current)
            i += 1

    if len(merged) < len(sections):
        log.info(
            f"조각 heading 병합 (_merge_fragmented_headings): {len(sections)} → {len(merged)} 섹션"
        )

    return merged


# ── _split_compound_headings: Phase 5.1 보완 ─────────────────────────────────
# heading 텍스트 내에 부모+자식 조항 번호가 함께 들어있는 경우 분리.
# 예: "6. COMMENCEMENT 6.1 Effectiveness of the Contract"
# → "6. COMMENCEMENT" (heading-only) + "6.1 Effectiveness..." (content 포함)
#
# 발생 원인: pdfplumber가 서로 다른 줄을 하나로 합치거나,
# _merge_fragmented_headings가 "COMMENCEMENT 6.1 Effectiveness..."를
# 숫자 시작이 아니라서 parent-child로 감지 못하고 병합.

_EMBEDDED_SUBCLAUSE_RE = _re.compile(
    r'\s+(\d+\.\d+(?:\.\d+)*)\s+\S'
)


def _split_compound_headings(sections: list[dict]) -> list[dict]:
    """heading에 embedded sub-clause 번호가 있으면 부모/자식으로 분리한다.

    Case 1 (parent number 있음):
      heading="6. COMMENCEMENT 6.1 Effectiveness of the Contract"
      → "6. COMMENCEMENT" (heading-only) + "6.1 Effectiveness..." (content)

    Case 2 (parent number 없음, 제목 prefix만 있음):
      heading="COMMENCEMENT 6.1 Effectiveness of the Contract"
      → "COMMENCEMENT" (heading-only) + "6.1 Effectiveness..." (content)

    분리 조건:
    - heading 내부에 sub-clause 번호(N.M 형태)가 포함되어 있음
    - Case 1: parent_num 추출 가능 → child_num.startswith(parent_num + ".") 확인
    - Case 2: parent_num 없음 → prefix가 짧은 제목(≤60자, 문장부호 없음),
              구조적 키워드(Sub-Clause, Article 등)가 아닌 경우만 분리
    """
    if not sections:
        return sections

    # 구조적 키워드 prefix — 분리하면 안 되는 패턴
    # 예: "Sub-Clause 14.2 Advance Payment" → 이건 하나의 heading이지 두 개가 아님
    _STRUCT_PREFIX_RE = _re.compile(
        r'^\s*(?:Sub-?\s*)?(?:Clause|Article|Section|Part|Chapter|Schedule|Annex)\s*$',
        _re.IGNORECASE,
    )

    result: list[dict] = []
    split_count = 0

    for sec in sections:
        heading = sec.get("heading", "").strip()
        if not heading:
            result.append(sec)
            continue

        # heading 안에서 embedded sub-clause 번호 검색
        m = _EMBEDDED_SUBCLAUSE_RE.search(heading)
        if not m:
            result.append(sec)
            continue

        child_num = m.group(1)
        parent_num = _extract_heading_number(heading)

        if parent_num:
            # Case 1: parent number 있음 → parent-child 관계 확인
            if not child_num.startswith(parent_num + '.'):
                result.append(sec)
                continue
        else:
            # Case 2: parent number 없음 → prefix 검증
            prefix_text = heading[:m.start(1)].strip()
            if not prefix_text or len(prefix_text) > 60:
                result.append(sec)
                continue
            # 문장부호가 있으면 본문 문장 조각일 가능성 → 분리 안 함
            if any(c in prefix_text for c in '.;!?,'):
                result.append(sec)
                continue
            # 구조적 키워드 prefix (Sub-Clause, Article 등) → 분리 안 함
            if _STRUCT_PREFIX_RE.match(prefix_text):
                result.append(sec)
                continue

        # 분리 위치: child 번호의 시작 지점
        split_pos = m.start(1)
        parent_heading = heading[:split_pos].strip()
        child_heading = heading[split_pos:].strip()

        if not parent_heading or not child_heading:
            result.append(sec)
            continue

        # parent heading-only 섹션 생성
        parent_sec = dict(sec)
        parent_sec["heading"] = parent_heading
        parent_sec["content"] = ""

        # child 섹션: 원본 content 유지
        child_sec = dict(sec)
        child_sec["heading"] = child_heading
        child_sec["level"] = child_num.count('.') + 1

        log.info(
            f"[compound split] \"{heading}\" → parent=\"{parent_heading}\", child=\"{child_heading}\""
        )
        result.append(parent_sec)
        result.append(child_sec)
        split_count += 1

    if split_count > 0:
        log.info(
            f"compound heading 분리 (_split_compound_headings): "
            f"{split_count}개 heading 분리 → {len(result)} 섹션"
        )

    return result


# ── _split_multi_clause_sections: Phase 3.6 ─────────────────────────────────
# 한 섹션의 content 안에 여러 조항 번호가 포함된 경우(sidecar가 섹션 분리에 실패한 경우)
# content를 재분할하여 조항 단위 독립 섹션으로 복원.
#
# 설계 원칙:
# - 조항 번호 패턴은 줄 시작에서 매칭 (인라인 참조 "see Sub-Clause 14.2" 제외)
# - heading의 조항 번호와 같은 깊이 또는 더 깊은 번호만 분할 경계로 인정
#   예: heading "1.1.1.19" → "1.1.1.20" (같은 깊이, 분할), "14.2" (다른 트리, 무시)
# - content 시작 위치 제한 없음 (기존 50자 제한 제거)
# - 1개라도 하위 조항이 발견되면 분할 수행 (기존 2개 최소 제한 제거)
_CLAUSE_BOUNDARY_PATTERN = _re.compile(
    r'(?:^|\n)[ \t]*(\d+(?:\.\d+){1,})[ \t]+\S',
    _re.MULTILINE
)


def _is_sibling_or_child_clause(heading_num: str, candidate_num: str) -> bool:
    """
    candidate_num이 heading_num의 형제 또는 자식 조항인지 판별.
    같은 부모 prefix를 공유하거나(형제), heading_num의 하위 번호(자식)이면 True.

    예: heading "1.1.1.19"
      - "1.1.1.20" → 형제 (같은 부모 "1.1.1") → True
      - "1.1.1.19.1" → 자식 → True
      - "14.2" → 다른 트리 → False
      - "1.10" → 다른 깊이, 다른 부모 → False
      - "2.2" → 다른 트리 → False

    Task 5 확장: 단일 번호 heading (예: "7")
      - heading "7", candidate "7.1" → 자식 → True
      - heading "7", candidate "8" → 형제 (같은 단일 레벨) → True
      - heading "7", candidate "14.2" → 다른 트리 → False
    """
    h_parts = heading_num.split('.')
    c_parts = candidate_num.split('.')

    # 자식: candidate가 heading으로 시작
    if candidate_num.startswith(heading_num + '.'):
        return True

    # 형제: 같은 부모 prefix (마지막 segment만 다름)
    if len(h_parts) == len(c_parts) and len(h_parts) >= 2:
        if h_parts[:-1] == c_parts[:-1]:
            return True

    # Task 5: 단일 번호 heading (예: "7") — 직접 자식(7.1, 7.2)도 형제/자식으로 인정
    if len(h_parts) == 1 and len(c_parts) >= 2:
        # candidate의 최상위 번호가 heading과 같으면 자식 트리
        if c_parts[0] == h_parts[0]:
            return True

    # 같은 최상위 조항 트리 + 깊이 2 이상 차이 없음
    # 예: heading "1.1.1.19", candidate "1.1.2" → 같은 "1.1" 트리, 깊이 차이 1
    if len(h_parts) >= 3 and len(c_parts) >= 3:
        # 최소 앞 2단계가 같으면 같은 트리로 판정
        if h_parts[:2] == c_parts[:2]:
            return True

    return False


def _split_multi_clause_sections(sections: list) -> list:
    """
    content 내에 복수의 조항 번호가 포함된 섹션을 분할한다.

    개선 사항 (기존 대비):
    1. content 시작 위치 제한 제거 — 정의 조항은 본문 텍스트 후에 다음 정의가 올 수 있음
    2. 1개 이상 하위 조항 발견 시 분할 — 기존 2개 최소 요구 제거
    3. 인라인 참조 필터링 — heading의 조항 번호와 관계없는 번호는 무시
       (예: "Sub-Clause 14.2", "Article 6.3" 같은 본문 내 참조)
    4. heading의 본문 텍스트도 보존 — 분할 시 heading~첫 조항 사이의 body 텍스트 유지
    """
    result = []
    for sec in sections:
        content = sec.get('content', '')
        zone = sec.get('zone_hint', '')
        heading = sec.get('heading', '') or ''

        # 비분석 대상 zone은 건너뜀
        if zone in ('toc', 'cover_page', 'annexes'):
            result.append(sec)
            continue

        # content 길이가 너무 짧으면 건너뜀
        if len(content) < 50:
            result.append(sec)
            continue

        # heading의 조항 번호 추출
        # Task 5: 단일 번호(예: "7")도 매칭하도록 확장 — 상위 조항 heading의 content에
        # 하위 조항(7.1, 7.2)이 포함된 경우도 분할 가능하게 함
        heading_num_m = _re.match(r'^\s*(\d+(?:\.\d+)*)', heading)
        if not heading_num_m:
            # 조항 번호가 없는 heading은 분할 대상에서 제외
            result.append(sec)
            continue

        heading_num = heading_num_m.group(1)

        # content에서 모든 조항 번호 경계 찾기
        all_matches = list(_CLAUSE_BOUNDARY_PATTERN.finditer(content))
        if not all_matches:
            result.append(sec)
            continue

        # 인라인 참조 필터링: heading과 형제/자식 관계인 번호만 분할 경계로 사용
        # 추가: FIDIC 인라인 참조 패턴(N.N [Title], / N.N [Title]; 등)은 제외
        _INLINE_REF_PATTERN = _re.compile(
            r'^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*[,;:.]'
        )
        _INLINE_REF_CONTINUATION = _re.compile(
            r'^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*,?\s+'
            r'(?:the|a|an|this|that|may|shall|and|or|to|in|of|for|with|by)\s',
            _re.IGNORECASE
        )
        # 교차참조 전용 패턴: "N.N [Title]" 또는 "N.N [Title]." 로 끝나는 줄은
        # 그 자체가 교차참조이지 새 조항 시작이 아님.
        # 예: "16.2 [Termination by Contractor]." → content 내 인라인 참조
        _INLINE_REF_BRACKET_ONLY = _re.compile(
            r'^\s*\d+(?:\.\d+)+\s+\[.*?\]\.?\s*$'
        )
        # 브라켓 참조 + 후속 텍스트: "N.N [Title] apply to the..." 처럼
        # [Title] 뒤에 30자 이상의 텍스트가 이어지면 본문 내 참조 문장.
        # is_heading()의 Filter 2c와 동일한 로직을 _split_multi_clause_sections에도 적용.
        _INLINE_REF_BRACKET_TRAILING = _re.compile(
            r'^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*,?\s*(.*)'
        )
        # 교차참조 키워드 직전 줄 패턴: 이전 줄이 Sub-Clause/Clause/Article 등으로 끝나면
        # 다음 줄의 "N.N ..." 은 교차참조의 번호 부분이지 새 조항이 아님.
        _PRECEDING_REF_KEYWORD = _re.compile(
            r'(?:Sub-?\s*Clause|Clause|Article|Section|Part|Chapter)\s*$',
            _re.IGNORECASE
        )
        valid_matches = []
        for m in all_matches:
            candidate_num = m.group(1)
            if _is_sibling_or_child_clause(heading_num, candidate_num):
                # 매치된 줄의 전체 텍스트를 가져와서 인라인 참조 패턴 확인
                match_pos = m.start()
                if match_pos > 0 and content[match_pos] == '\n':
                    match_pos += 1
                # 다음 줄바꿈까지의 텍스트
                line_end = content.find('\n', match_pos)
                if line_end == -1:
                    line_end = len(content)
                line_text = content[match_pos:line_end].strip()
                # FIDIC 인라인 참조 패턴이면 분할 경계에서 제외
                if _INLINE_REF_PATTERN.match(line_text):
                    continue
                if _INLINE_REF_CONTINUATION.match(line_text):
                    continue
                # "N.N [Title]" 또는 "N.N [Title]." 만으로 구성된 줄은 교차참조
                if _INLINE_REF_BRACKET_ONLY.match(line_text):
                    continue
                # "N.N [Title] + 30자 이상 텍스트" 는 본문 내 참조 문장
                _bracket_trail_m = _INLINE_REF_BRACKET_TRAILING.match(line_text)
                if _bracket_trail_m:
                    trailing_text = _bracket_trail_m.group(1).strip()
                    if len(trailing_text) > 30:
                        continue
                # 직전 줄이 Sub-Clause/Clause/Article 등으로 끝나면 교차참조 번호
                if match_pos > 1:
                    prev_line_end = match_pos - 1
                    prev_line_start = content.rfind('\n', 0, prev_line_end)
                    prev_line_start = prev_line_start + 1 if prev_line_start >= 0 else 0
                    prev_line = content[prev_line_start:prev_line_end].strip()
                    if _PRECEDING_REF_KEYWORD.search(prev_line):
                        continue
                valid_matches.append(m)

        if not valid_matches:
            result.append(sec)
            continue

        # 분할 수행: heading의 원래 content (첫 경계 이전) + 각 경계별 섹션
        first_boundary_pos = valid_matches[0].start()

        # heading의 본문 텍스트 보존 (첫 경계 이전 content)
        head_body = content[:first_boundary_pos].strip()

        # 원래 heading 섹션 유지 (content를 첫 경계 이전까지로 축소)
        trimmed_sec = dict(sec)
        trimmed_sec['content'] = head_body
        result.append(trimmed_sec)

        # 각 경계별 분할 섹션 생성
        for idx, m in enumerate(valid_matches):
            start = m.start()
            if start > 0 and content[start] == '\n':
                start += 1  # leading newline 제거
            end = valid_matches[idx + 1].start() if idx + 1 < len(valid_matches) else len(content)
            chunk = content[start:end].strip()
            if not chunk:
                continue

            # 분할된 섹션의 heading은 첫 줄
            first_line = chunk.split('\n')[0].strip()
            # 분할된 청크에서 heading 줄은 content에서도 제거하지 않음
            # (heading이 정의의 시작이므로 content에 포함되어야 의미가 완전함)
            clause_num_m = _re.match(r'^\s*(\d+(?:\.\d+)*)', first_line)
            clause_level = clause_num_m.group(1).count('.') + 1 if clause_num_m else sec.get('level', 3)

            result.append({
                'heading': first_line[:120],
                'level': clause_level,
                'content': chunk,
                'page_start': sec.get('page_start'),
                'page_end': sec.get('page_end'),
                'zone_hint': zone,
                'is_auto_split': True,
            })

    return result


def _parse_pdf_native(pdf_bytes: bytes, filename: str) -> tuple[list[dict], int, "HeaderFooterInfo | None"]:
    """
    pdfplumber 기반 PDF 파싱 — ThreadPoolExecutor로 페이지 청크를 병렬 처리.

    Phase 1: 전체 페이지 수 + 평균 폰트 크기 계산 (순차, 빠름)
    Phase 2: 청크 단위 페이지 데이터 추출 (병렬, _PDFPLUMBER_WORKERS 스레드)
             각 워커가 독립적인 pdfplumber 핸들 보유 — 스레드 안전
    Phase 3: 섹션 구성 (순차, 페이지 순서 보장)

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
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # ── 조항 번호 패턴 ─────────────────────────────────────────────────────────
    # heading 판단: 구조적 번호 패턴 OR 폰트 크기/Bold 신호
    #
    # 설계 원칙:
    # - 구조적 패턴(조항 번호 prefix)이 있으면 폰트 신호 없이도 heading으로 인정
    # - ALL CAPS 단독 줄은 문맥 조건 추가 (2단어+, ≤60자, 마침표 없음)
    # - 로마숫자 패턴은 "I." + 대문자 단어로 제한 (본문 문장 오탐 방지)
    # - 폰트 크기/Bold는 패턴 미매칭 시 보조 신호로만 사용

    # 구조적 번호 패턴 (독립적으로 heading 판정)
    STRUCT_HEADING_PATTERNS = [
        re.compile(r'^\s*(\d+\.){1,}\d*\s+\S'),                       # 1. / 1.1 / 14.1.2 Title
        re.compile(r'^\s*(ARTICLE|CLAUSE|PART|SECTION|CHAPTER)\s+[\dIVXivx]+', re.I),
        re.compile(r'^\s*제\s*\d+\s*[조장절]\b'),                       # 한국어: 제3조, 제2장, 제1절
        re.compile(r'^\s*[IVX]{1,5}\.\s+[A-Z]'),                      # 로마숫자: I. TITLE (대문자 시작)
        re.compile(r'^\s*[A-Z]\.\s+[A-Z][A-Z]'),                      # 알파벳: A. TITLE (2자 이상 대문자)
        re.compile(r'^\s*\d{1,2}\s+[A-Z][a-z]'),                      # Task 4: 단일 번호 heading: "7 Equipment", "20 Claims"
    ]

    # 추가 조건 필요 패턴 (폰트 신호 OR 엄격한 조건 필요)
    # ALL CAPS: 2단어 이상, 60자 이하, 문장 부호 없음, 일반 단어(THE/OF/AND/IN) 제외
    _ALL_CAPS_PATTERN = re.compile(r'^[A-Z][A-Z\s]{3,58}$')
    # ALL CAPS에서 제외할 관사/전치사만으로 구성된 경우 방지
    _ALL_CAPS_STRUCTURAL_KW = re.compile(
        r'^\s*(ARTICLE|CLAUSE|PART|SECTION|CHAPTER|SCHEDULE|ANNEX|APPENDIX|EXHIBIT)\b', re.I
    )
    # 본문 문장처럼 보이는 패턴 (heading 제외 조건)
    _SENTENCE_LIKE = re.compile(r'[.!?;,]\s*\S|^\s*(?:the|a|an|this|that|these|those|in|of|for|with|by|to)\s', re.I)

    def is_heading(text: str, avg_size: float, char_sizes: list, char_fonts: list) -> bool:
        t = text.strip()
        if not t:
            return False
        # 구조적 숫자 패턴(예: 1.1.1, 1.1.1.2)으로 시작하는 줄은 길이/쉼표 조기 반환 우회
        _is_structured_numeric = bool(re.match(r'^\s*\d+(?:\.\d+)+\s', t))
        # ── Task 6: 본문 계속 문장 필터 (숫자 + 전치사/단위) ──────────────
        # 본문에서 "14 days after...", "30 calendar days", "28 Days" 등은
        # 단순 숫자 시작이지만 heading이 아닌 body continuation.
        # 조항 번호(N.N)가 아닌 bare 숫자 + 소문자 단위/전치사 패턴을 필터링.
        # 실제 heading "7 Equipment..." 와 구분: heading은 대문자 시작 명사/제목이므로
        # 이 필터는 소문자 단어 또는 단위어(days, months, years, %, percent)에만 적용.
        # 주의: 전치사는 \b (word boundary)로 완전 단어 매칭 필수
        # — "18 Insurance"의 "In"이 "in"으로 오인되지 않도록
        if not _is_structured_numeric:
            _body_continuation_m = re.match(
                r'^\s*\d+\s+'
                r'(?:days?\b|months?\b|years?\b|weeks?\b|hours?\b|calendar\b|business\b|working\b|percent\b|%'
                r'|of\b|in\b|to\b|for\b|from\b|by\b|with\b|at\b|or\b|and\b|under\b|per\b|no\.\b|km\b|m\b|kg\b)',
                t, re.I
            )
            if _body_continuation_m:
                return False
        # 구조적 숫자 패턴이 아닌 경우에만 길이/쉼표 조기 반환 적용
        if not _is_structured_numeric:
            if len(t) > 120:
                return False
            # 쉼표가 2개 이상이면 본문 목록일 가능성이 높음
            if t.count(',') >= 2:
                return False
        # ── 깊은 구조적 숫자 패턴(3단계+)은 ends_punct 검사 전에 매칭 시도 ────
        # 정의 조항(예: 1.1.1.20 "Commercial Operation Date" ... the PPA.)처럼
        # 마침표로 끝나더라도 3단계 이상 조항 번호가 있으면 heading으로 인정.
        #
        # 2단계(14.2, 20.3 등)는 인라인 참조일 가능성이 높으므로 ends_punct 우회하지 않음.
        # 예: "14.2 [Advance Payment]." → 본문 참조 (heading이 아님)
        # 예: "1.1.1.20 "Commercial Operation Date"...PPA." → 정의 heading
        _is_deep_structured = bool(re.match(r'^\s*\d+(?:\.\d+){2,}\s', t))  # 점 2개+ = 3단계+
        if _is_deep_structured:
            for pat in STRUCT_HEADING_PATTERNS:
                if pat.match(t):
                    if pat == STRUCT_HEADING_PATTERNS[1]:
                        if len(t) > 60:
                            break
                        if re.search(r'\d\s*\(', t):
                            break
                        if re.search(r'\d\s+(of|in|under|to|for|from|by|with|at)\s', t, re.I):
                            break
                        if re.search(r'(?:ARTICLE|CLAUSE|SECTION|CHAPTER|PART)\s+\d[\d.]*\s*\[',
                                     t, re.I):
                            break
                    return True

        # 문장처럼 끝나면 heading 불가 (마침표, 세미콜론 등으로 끝나는 줄)
        # 주의: 3단계 이상 구조적 번호(1.1.1.x)는 위에서 이미 True 반환하므로 여기 도달하지 않음.
        # 2단계(14.2 등) + ends_punct는 여전히 heading 불가 처리.
        if t[-1] in '.;!?':
            return False
        # ── Task 2: FIDIC 인라인 참조 필터 (3가지) ─────────────────────────────
        # 2단계 조항 번호(N.N)가 있고 [Title] 뒤에 본문이 계속되는 패턴은 heading이 아님.
        # 이 필터는 ends_punct 이후에 적용되므로, 이미 마침표로 끝나는 줄은 걸러진 상태.
        # 3단계+(N.N.N)는 위에서 _is_deep_structured로 이미 True 반환되었으므로 여기 도달 안 함.
        #
        # Filter 2a: N.N [Title], / N.N [Title]; / N.N [Title]:
        # 예: "8.3 [Programme]," → 본문 내 인라인 참조
        # 예: "7.6 [Remedial Work]; or" → 본문 내 인라인 참조
        if re.match(r'^\s*\d+\.\d+\s+\[.*?\][,;:]', t):
            return False
        # Filter 2b: N.N [Title] + 전치사/접속사로 계속
        # 예: "9.3 [Retesting], the Minimum Performance Guarantees..."
        # 예: "20.3 [Expert], may be referred..."
        # 예: "20.1 [Contractor's Claims] to:" → \b로 단어 경계 매칭 (줄 끝/콜론 포함)
        if re.match(r'^\s*\d+\.\d+\s+\[.*?\]\s*,?\s+(?:the|a|an|this|that|may|shall|and|or|to|in|of|for|with|by)\b', t, re.I):
            return False
        # Filter 2c: N.N [Title] 뒤에 50자 이상 텍스트가 계속되면 본문 문장
        # 예: "14.8 [Statement at Facility Taking Over], the Contractor shall submit..."
        _bracket_ref_m = re.match(r'^\s*\d+\.\d+\s+\[.*?\]\s*,?\s*(.*)', t)
        if _bracket_ref_m:
            trailing = _bracket_ref_m.group(1).strip()
            if len(trailing) > 30:
                return False
        # ── 추가 필터 (STRUCT 패턴 검사 전 적용) ─────────────────────────────
        # bracket 시작 조각: '[●]', '[Note to Bidders –' 등
        # (endswith(']') 는 '8.5 [Not Used]' 같은 정당한 heading도 있으므로 STRUCT 이후 처리)
        # 수정 2: 수치 조항 번호로 시작하는 줄은 '[' 필터 예외 처리.
        # 예: '1.1.1.19 ["Change in Law" means...' 처럼 번호 prefix 뒤에 '"[' 가 오는 경우
        # '[' 필터가 먼저 실행되면 STRUCT 패턴 매칭 기회를 잃음 → 번호 시작 줄은 건너뜀.
        _starts_with_number = bool(re.match(r'^\s*\d+(?:\.\d+)*\s', t))
        if t.startswith('[') and not _starts_with_number:
            return False
        # 소문자로 시작하는 줄은 문장 중간 조각
        if t[0].islower():
            return False
        # ── Task 3: 따옴표 시작 줄 필터 ──────────────────────────────────────
        # 따옴표(", ", ')로 시작하는 줄은 정의 텍스트의 본문 조각이지 heading이 아님.
        # 예: '"Commercial Operation Date" means the date...'
        # 예: '"Contractor" shall mean...'
        # 단, 조항 번호로 시작하는 줄(1.1.1.20 "Term")은 이 필터에 도달하지 않음 —
        # 이미 위의 _is_deep_structured에서 True로 반환되거나, _starts_with_number 경로를 탐.
        if t[0] in ('"', '\u201c', "'"):
            return False

        # ── 수정 2: 키워드 prefix 인라인 참조 필터 ─────────────────────────
        # "(Sub-)Clause/Article/Section/Part/Chapter + N.N + 구두점(:,;)" 형태는
        # 본문 내 인라인 참조이며 heading이 아님.
        # 예: "Clause 5.2:", "Sub-Clause 14.2,", "Article 1;"
        # 번호 뒤에 제목 텍스트가 오는 실제 heading(예: "Clause 5.2 Advance Payment")은
        # 구두점이 아닌 알파벳이 따르므로 이 필터에 걸리지 않음.
        if re.match(
            r'^\s*(?:Sub-?\s*)?(?:ARTICLE|CLAUSE|PART|SECTION|CHAPTER)\s+\d+(?:\.\d+)*\s*[,:;]',
            t, re.I
        ):
            return False
        # 키워드 + 번호만으로 끝나는 짧은 줄도 인라인 참조
        # 예: "Clause 5.2" (줄 끝), "Sub-Clause 14.2" (줄 끝)
        if re.match(
            r'^\s*(?:Sub-?\s*)?(?:ARTICLE|CLAUSE|PART|SECTION|CHAPTER)\s+\d+(?:\.\d+)+\s*$',
            t, re.I
        ):
            return False

        # 구조적 번호 패턴 매칭 — 비숫자 패턴도 매칭 (ARTICLE, CLAUSE 등)
        # 주의: _is_structured_numeric 패턴은 위에서 이미 처리됨.
        #       여기서는 비숫자 구조적 패턴만 매칭.
        for pat in STRUCT_HEADING_PATTERNS:
            if pat.match(t):
                # ARTICLE/CLAUSE/PART 패턴(인덱스 1)은 참조 문장 오인 방지 추가 검증:
                # - 'Article 6.7(h) of this...' 처럼 괄호(h)나 후속 of/in/under가 있으면 참조
                # - heading은 조항 번호 + 짧은 제목(≤60자) 형식이어야 함
                if pat == STRUCT_HEADING_PATTERNS[1]:
                    # 길이가 60자 초과이면 참조 문장 가능성 높음
                    if len(t) > 60:
                        break
                    # ── 수정 1: 콜론 종료 인라인 참조 필터 ──────────────────
                    # "Clause 5.2:", "Article 14:" 처럼 키워드+번호+콜론(:)으로
                    # 끝나는 줄은 본문 내 인라인 참조이지 heading이 아님.
                    # heading은 보통 "Clause 5.2 Advance Payment" 형식으로 제목이 붙음.
                    if t.rstrip().endswith(':'):
                        break
                    # 조항 번호 뒤에 '(' 가 있으면 세부 항목 참조 (예: Article 6.7(h))
                    if re.search(r'\d\s*\(', t):
                        break
                    # 조항 번호 뒤 전치사로 이어지면 참조 문장
                    if re.search(r'\d\s+(of|in|under|to|for|from|by|with|at)\s', t, re.I):
                        break
                    # 조항 번호 뒤 '[제목]' 이 오면 FIDIC 스타일 인라인 참조
                    # 예: 'Article 6.5 [Conditions Precedent Deadline] of the Contract'
                    # 예: 'Clause 3.1 [The Owner's Representative], who acts...'
                    if re.search(r'(?:ARTICLE|CLAUSE|SECTION|CHAPTER|PART)\s+\d[\d.]*\s*\[',
                                 t, re.I):
                        break
                # ── Task 4: 단일 번호 heading 패턴 검증 (인덱스 5) ──
                # "7 Equipment" (heading) vs "7 The Bank shall..." (본문) 구분
                # 길이 60자 이하, 쉼표 2개 미만인 경우만 heading으로 인정
                if pat == STRUCT_HEADING_PATTERNS[5]:
                    if len(t) > 80:
                        break
                    # "7 Any Demand made by the Beneficiary..." 같은 긴 문장 제외
                    # heading은 보통 짧은 제목 형식 (예: "7 Equipment, Materials and Workmanship")
                    words = t.split()
                    if len(words) > 10:
                        break
                return True

        # ── STRUCT 비매칭 후 추가 필터 ────────────────────────────────────────
        # 숫자 prefix 없이 ']' 로 끝나면 bracket 조각 (예: 'VND only]', 'LLA]')
        if t.endswith(']') and not re.match(r'^\s*\d', t):
            return False
        # ')' 로 끝나는 줄은 참조 문장 조각 (예: '...Contract Agreement) unless')
        if t.endswith(')'):
            return False

        # ALL CAPS 짧은 줄 — 추가 조건 필요
        if _ALL_CAPS_PATTERN.match(t):
            words = t.split()
            # 2단어 이상, 8단어 이하
            if 2 <= len(words) <= 8:
                # 구조적 키워드(ARTICLE, CLAUSE 등)가 있으면 즉시 인정
                if _ALL_CAPS_STRUCTURAL_KW.match(t):
                    return True
                # 관사/전치사만으로 구성된 문장 제외
                _STOP_WORDS = {'THE', 'A', 'AN', 'IN', 'OF', 'FOR', 'WITH', 'BY', 'TO', 'AND', 'OR', 'AT'}
                non_stop = [w for w in words if w not in _STOP_WORDS]
                if len(non_stop) >= 2:
                    # 폰트 크기 신호가 있으면 추가 인정 (avg_size 기반)
                    if char_sizes and avg_size > 0:
                        line_avg = sum(char_sizes) / len(char_sizes)
                        if line_avg >= avg_size * 1.05:  # 5% 이상 크면 heading 가능성 높음
                            return True
                    # Bold 폰트이면 인정
                    if char_fonts and any("bold" in f.lower() for f in char_fonts if f):
                        return True

        # 폰트 크기가 평균보다 15% 이상 크면 heading (임계값 20% → 15%로 완화)
        if char_sizes and avg_size > 0:
            line_avg = sum(char_sizes) / len(char_sizes)
            if line_avg > avg_size * 1.15:
                # 단, 문장처럼 보이거나 너무 긴 줄은 제외
                if len(t) <= 100 and not _SENTENCE_LIKE.search(t):
                    return True

        # Bold 폰트 감지 — 짧은 줄(≤60자)에만 적용, 문장 패턴 제외
        if char_fonts and len(t) <= 60 and not _SENTENCE_LIKE.search(t):
            # em-dash/en-dash 포함 줄은 주석/삽입구 연속 문장일 가능성이 높음
            # 예: '[Note to Bidders – subject to revision...]' 의 분리된 줄
            # 이런 줄은 Bold 폰트여도 heading으로 오인하지 않도록 제외
            if '\u2013' in t or '\u2014' in t or ' - ' in t:
                pass  # em/en-dash 포함 → Bold heading 인정 건너뜀
            else:
                bold_count = sum(1 for f in char_fonts if f and "bold" in f.lower())
                # Bold 비율 50% 이상인 경우만 heading으로 인정 (부분 Bold 오탐 방지)
                if char_fonts and bold_count / len(char_fonts) >= 0.5:
                    return True

        return False

    def _is_ghost_table(table: list) -> bool:
        """pdfplumber가 오감지한 '유령 테이블'을 판별한다.

        유령 테이블 조건 (하나라도 충족 시 True):
        - 행이 1개뿐 (separator + header만 생성되어 노이즈 발생)
        - 열이 1개뿐 (단순 텍스트 블록의 오인)
        - 전체 텍스트 길이 < 15자 (극히 짧은 테이블)
        - 대괄호 주석 패턴: 셀 내용이 `[` 또는 `]`로 시작/끝
        """
        if not table:
            return True
        num_rows = len(table)
        num_cols = max((len(row) for row in table), default=0)

        # 1행 테이블 → 유령
        if num_rows == 1:
            return True

        # 1열 테이블 → 유령
        if num_cols <= 1:
            return True

        # 전체 텍스트 길이 확인
        all_text = " ".join(
            str(c).strip() for row in table for c in row if c is not None
        )
        if len(all_text) < 15:
            return True

        # 대괄호 주석 패턴: 과반수 셀이 [ 또는 ]를 포함
        bracket_cells = 0
        total_cells = 0
        for row in table:
            for c in row:
                cell = str(c).strip() if c is not None else ""
                if cell:
                    total_cells += 1
                    if cell.startswith("[") or cell.endswith("]"):
                        bracket_cells += 1
        if total_cells > 0 and bracket_cells / total_cells > 0.5:
            return True

        return False

    def table_to_markdown(table: list) -> str:
        """pdfplumber 표 데이터 → Markdown 표 형식."""
        rows = []
        for row in table:
            cells = [str(c).strip() if c is not None else "" for c in row]
            rows.append("| " + " | ".join(cells) + " |")
        if not rows:
            return ""
        header = rows[0]
        sep = "| " + " | ".join(["---"] * len(table[0])) + " |"
        body = rows[1:] if len(rows) > 1 else []
        return "\n".join([header, sep] + body)

    def apply_bold_markdown(text: str, chars: list) -> str:
        """
        pdfplumber chars 배열에서 볼드 구간을 감지하여 **...**로 감싼다.

        chars가 없거나 전체가 비볼드이면 text를 그대로 반환한다(plain fallback).
        전체가 볼드인 경우에도 **...**로 감싸지 않는다 — 전체 볼드 줄은
        is_heading()이 heading으로 분류하므로 content로 내려오는 경우가 드물며,
        감싸면 markdown 렌더 시 단락 전체가 굵어져 가독성이 저하된다.

        부분 볼드 구간만 마킹한다:
        - 볼드 문자가 1개 이상 있어야 처리
        - 연속된 볼드 문자들을 하나의 span으로 묶음
        - 텍스트 길이와 chars 수가 불일치하는 경우 plain fallback
        """
        if not chars:
            return text

        # 각 문자의 볼드 여부 판정 (fontname에 "bold" 포함 여부)
        bold_flags: list[bool] = [
            bool(ch.get("fontname") and "bold" in ch["fontname"].lower())
            for ch in chars
        ]

        bold_count = sum(1 for b in bold_flags if b)
        # 볼드 문자 없음 → plain 반환
        if bold_count == 0:
            return text
        # 전체 볼드 → 그대로 반환 (heading 경로에서 처리됨)
        if bold_count == len(bold_flags):
            return text

        # chars에서 텍스트 + 볼드 플래그를 재조합하되, x좌표 간격으로 단어 경계를
        # 감지하여 공백을 삽입한다.  pdfplumber의 chars 배열에는 단어 간 synthetic
        # space 문자가 포함되지 않으므로(TextMap→chars 변환 시 None 필터) 수동 삽입 필수.
        tokens: list[tuple[str, bool]] = []  # (char_text, is_bold)
        for idx, ch in enumerate(chars):
            ch_text = ch.get("text", "")
            ch_bold = bold_flags[idx]
            if idx > 0:
                prev = chars[idx - 1]
                gap = ch.get("x0", 0) - prev.get("x1", 0)
                char_w = prev.get("width", 0) or ch.get("width", 0) or 5
                # 간격이 문자 폭의 25% 이상이면 단어 경계 → 공백 삽입
                if gap > char_w * 0.25:
                    # 공백의 bold: 양쪽 모두 bold면 bold (span 내부 공백 보존)
                    space_bold = bold_flags[idx - 1] and ch_bold
                    tokens.append((" ", space_bold))
            tokens.append((ch_text, ch_bold))

        if not tokens:
            return text

        # 연속 볼드/비볼드 구간으로 분리하여 재조합
        result_parts: list[str] = []
        i = 0
        n = len(tokens)
        while i < n:
            cur_bold = tokens[i][1]
            span_chars: list[str] = []
            while i < n and tokens[i][1] == cur_bold:
                span_chars.append(tokens[i][0])
                i += 1
            span_text = "".join(span_chars).strip()
            if not span_text:
                # 공백만 있는 span은 그대로 (스페이스 보존)
                result_parts.append("".join(span_chars))
                continue
            if cur_bold:
                # 볼드 span 앞뒤 공백 분리 후 ** 감싸기
                raw = "".join(span_chars)
                leading = raw[: len(raw) - len(raw.lstrip())]
                trailing = raw[len(raw.rstrip()):]
                result_parts.append(f"{leading}**{span_text}**{trailing}")
            else:
                result_parts.append("".join(span_chars))

        reconstructed = "".join(result_parts).strip()
        # 재조합 결과가 비어 있으면 원본 text 반환
        return reconstructed if reconstructed else text

    # ── Phase 1: 페이지 수 + 평균 폰트 크기 + 페이지 높이 수집 ─────────────────
    total_pages = 0
    avg_font_size = 12.0
    page_heights: list[float] = []
    toc_page_range: set[int] = set()
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total_pages = len(pdf.pages)
            # Mi-3: 전체 문서에서 균등 샘플링하여 폰트 크기 추정 (첫 10페이지 편향 방지)
            # 최대 20페이지를 균등 간격으로 샘플링
            _sample_count = min(20, total_pages)
            _step = max(1, total_pages // _sample_count)
            _sample_indices = list(range(0, total_pages, _step))[:_sample_count]
            sample_sizes: list[float] = []
            for _si in _sample_indices:
                for ch in (pdf.pages[_si].chars or []):
                    if ch.get("size"):
                        sample_sizes.append(ch["size"])
            if sample_sizes:
                # 중앙값 사용 — 이상값(매우 큰 헤딩 폰트 등)에 robust
                _sorted = sorted(sample_sizes)
                _mid = len(_sorted) // 2
                avg_font_size = (
                    _sorted[_mid] if len(_sorted) % 2 == 1
                    else (_sorted[_mid - 1] + _sorted[_mid]) / 2.0
                )
            # 페이지 높이 수집 (헤더/푸터 Y좌표 계산에 사용)
            for p in pdf.pages:
                page_heights.append(float(p.height or 792.0))
            # ── TOC 페이지 범위 pre-scan ──────────────────────────────────────
            # 목차가 문서 중간에 있는 비정형 레이아웃 대응(예: Contract Agreement 본문 이후 TOC).
            # Phase 3에서 TOC 페이지의 번호 매긴 줄(조항 번호 형식)이
            # section heading으로 오파싱되는 것을 방지한다.
            _toc_in_toc = False
            for _toc_pi, _toc_pg in enumerate(pdf.pages):
                _toc_pnum = _toc_pi + 1
                try:
                    _toc_txt = _toc_pg.extract_text() or ""
                except Exception:
                    continue
                _toc_lines = [_l.strip() for _l in _toc_txt.split('\n') if _l.strip()]
                # 첫 5줄에서 TOC heading 패턴 확인 (위치 무관 — 문서 중간 TOC도 감지)
                _toc_hit = any(
                    any(_tp.match(_l) for _tp in _TOC_HEADING_PATTERNS)
                    for _l in _toc_lines[:5]
                )
                if _toc_hit:
                    _toc_in_toc = True
                    toc_page_range.add(_toc_pnum)
                elif _toc_in_toc:
                    if _toc_lines:
                        _dot_dens = _toc_txt.count('.') / max(len(_toc_txt), 1)
                        _leader = sum(
                            1 for _l in _toc_lines
                            if _TOC_LEADER_PATTERN.search(_l) and _re.search(r'\d+\s*$', _l)
                        )
                        _trail = sum(
                            1 for _l in _toc_lines if _re.search(r'\d+\s*$', _l.strip())
                        )
                        # TOC 연속 판정: leader dot ≥25% 또는 숫자 끝 줄 ≥35% + 점 밀도
                        if (
                            _leader >= len(_toc_lines) * 0.25
                            or (_trail >= len(_toc_lines) * 0.35 and _dot_dens >= 0.02)
                        ):
                            toc_page_range.add(_toc_pnum)
                        else:
                            _toc_in_toc = False  # TOC 종료
                    else:
                        _toc_in_toc = False
            if toc_page_range:
                log.info(
                    f"TOC 페이지 범위 감지: {sorted(toc_page_range)[:10]} "
                    f"(총 {len(toc_page_range)}페이지)"
                )
    except Exception as e:
        log.error(f"pdfplumber 초기화 실패: {e}")
        return [], 0

    # ── Phase 2: 페이지 데이터 병렬 추출 ─────────────────────────────────────
    # 페이지를 worker 수만큼 균등 분할. 각 워커는 자체 pdfplumber 핸들 사용.
    num_workers = max(1, min(_PDFPLUMBER_WORKERS or 4, total_pages))
    chunk_size = max(1, (total_pages + num_workers - 1) // num_workers)
    chunks = [
        list(range(i, min(i + chunk_size, total_pages)))
        for i in range(0, total_pages, chunk_size)
    ]

    def process_chunk(page_indices: list[int]) -> list[dict]:
        """페이지 인덱스(0-based) 목록을 받아 raw 페이지 데이터 리스트 반환."""
        chunk_results: list[dict] = []
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                for idx in page_indices:
                    page_num = idx + 1  # 1-based
                    page = pdf.pages[idx]
                    tables: list = []
                    table_bboxes: list = []
                    try:
                        raw_tables = page.extract_tables() or []
                    except Exception as ex:
                        log.warning(f"page {page_num} 표 추출 실패: {ex}")
                        raw_tables = []
                    raw_table_objs: list = []
                    try:
                        raw_table_objs = page.find_tables() or []
                    except Exception:
                        pass
                    # 유령 테이블 필터링: 오감지된 1행/1열/짧은 표 제거
                    for ti in range(len(raw_tables) - 1, -1, -1):
                        if _is_ghost_table(raw_tables[ti]):
                            raw_tables.pop(ti)
                            if ti < len(raw_table_objs):
                                raw_table_objs.pop(ti)
                    tables = raw_tables
                    table_bboxes = [t_obj.bbox for t_obj in raw_table_objs]
                    try:
                        lines = page.extract_text_lines(return_chars=True) or []
                    except Exception:
                        raw_text = page.extract_text() or ""
                        lines = [{"text": ln, "chars": []} for ln in raw_text.splitlines() if ln.strip()]
                    # 헤더/푸터 감지용: 각 줄의 bbox 정보 수집 (top/bottom → y 좌표)
                    hf_elements: list[dict] = []
                    for ln in lines:
                        t = ln.get("text", "").strip()
                        if not t:
                            continue
                        chars = ln.get("chars") or []
                        avg_sz = (sum(ch.get("size", 0) for ch in chars if ch.get("size")) / len(chars)
                                  if chars else 0.0)
                        hf_elements.append({
                            "text": t,
                            "x0": ln.get("x0", 0.0),
                            "y0": ln.get("top", 0.0),
                            "x1": ln.get("x1", 0.0),
                            "y1": ln.get("bottom", 0.0),
                            "font_size": avg_sz,
                        })
                    chunk_results.append({
                        "page_num": page_num,
                        "lines": lines,
                        "tables": tables,
                        "table_bboxes": table_bboxes,
                        "hf_elements": hf_elements,
                    })
        except Exception as e:
            log.warning(f"청크 {page_indices[0]+1}~{page_indices[-1]+1}p 처리 실패: {e}")
        return chunk_results

    all_page_data: list[dict] = []
    # 최대 4개 워커로 cap — 각 워커가 전체 PDF 바이트를 메모리에 보유하므로
    # max_workers=len(chunks)는 대용량 PDF에서 청크 수만큼 사본을 생성함
    with ThreadPoolExecutor(max_workers=min(len(chunks), 4)) as executor:
        futures = {executor.submit(process_chunk, chunk): chunk for chunk in chunks}
        for future in as_completed(futures):
            try:
                all_page_data.extend(future.result())
            except Exception as e:
                log.warning(f"청크 처리 예외: {e}")

    all_page_data.sort(key=lambda x: x["page_num"])

    # ── Phase 3: 섹션 구성 (순차, 페이지 순서 보장) ──────────────────────────
    sections: list[dict] = []
    current: dict | None = None

    def flush() -> None:
        nonlocal current
        if current and (current["heading"] or current["content"].strip()):
            sections.append(current)
        current = None

    def new_section(heading: str, level: int, page: int,
                    font_size_ratio: float = 1.0, bold_ratio: float = 0.0) -> None:
        nonlocal current, _first_numbered_clause_seen
        flush()
        if not _first_numbered_clause_seen and _is_numbered_heading(heading):
            _first_numbered_clause_seen = True
        zone = _detect_zone_hint(heading, is_heading_signal=True,
                                  font_size_ratio=font_size_ratio, bold_ratio=bold_ratio)
        # 대분류 document boundary 타입만 level=1 강제.
        # definitions, toc, cover_page 등 하위 섹션 타입은 자연 level 유지 —
        # "1.1 Definitions"가 definitions 패턴에 매칭되더라도 level=2로 유지해야
        # "1 General Provisions" boundary group이 비어 skip되는 버그를 방지한다.
        _MAJOR_BOUNDARY_TYPES = {
            "contract_agreement", "general_conditions", "particular_conditions",
            "conditions_of_contract", "commercial_terms", "technical_specifications",
            "appendices", "annexure", "amendment", "letter_of_acceptance",
            "form_of_tender", "bill_of_quantities",
        }
        matched = _detect_zone_hint_from_patterns(heading, is_heading_signal=True,
                                                   font_size_ratio=font_size_ratio,
                                                   bold_ratio=bold_ratio)
        effective_level = (
            1 if (matched is not None and matched[0] in _MAJOR_BOUNDARY_TYPES)
            else level
        )
        # 첫 번호 조항 이전의 heading 섹션도 preamble로 분류
        # 단, toc/cover_page 같은 특수 zone은 유지
        effective_zone = zone
        if not _first_numbered_clause_seen and zone == "contract_body":
            effective_zone = "preamble"
        current = {
            "heading": heading,
            "level": effective_level,
            "content": "",
            "page_start": page,
            "page_end": page,
            "zone_hint": effective_zone,
        }

    # 첫 번호 조항이 나오기 전까지를 "preamble"로 분류하기 위한 플래그
    # heading이 있더라도 조항 번호가 없으면 (예: "Contracting structure") 전문으로 간주
    _first_numbered_clause_seen = False
    _NUMBERED_HEADING_RE = re.compile(
        r'^\s*(?:'
        r'(?:ARTICLE|CLAUSE|SECTION|PART|CHAPTER)\s+[\dIVXLCDM]'  # Article 1, Section IV
        r'|제\s*\d+\s*조'                                          # 한국어 조항
        r'|\d+(?:\.\d+)*\s*[.)]\s'                                 # 1. / 1.1 / 1)
        r'|\d+(?:\.\d+)+\s'                                        # 1.1 Title
        r')',
        re.IGNORECASE,
    )

    def _is_numbered_heading(heading_text: str) -> bool:
        return bool(_NUMBERED_HEADING_RE.match(heading_text.strip()))

    def ensure_current(page: int) -> None:
        nonlocal current
        if current is None:
            current = {
                "heading": "",
                "level": 1,
                "content": "",
                "page_start": page,
                "page_end": page,
                # 첫 번호 조항 전 텍스트는 preamble (커버페이지/서문/당사자 정보 등)
                "zone_hint": "contract_body" if _first_numbered_clause_seen else "preamble",
            }

    # ── 페이지 경계를 넘어 유지해야 하는 content-continuation 컨텍스트 ──
    # 페이지 루프 바깥에서 초기화하여 페이지가 넘어가도 이전 content 줄 정보가 보존됨.
    # 예: 페이지 N 마지막 줄 "...subject to Sub-Clause" → 페이지 N+1 첫 줄 "20.1 ..."
    _HYPHEN_CHARS = ('-', '\u00ad', '\u2010', '\u2011', '\u2013')
    _last_content_text = ""
    _DANGLING_REF_RE = re.compile(
        r'(?:^|\s)(?:Sub-?Clause|Clause|Article|Section|Part|Chapter|sub-?clause|clause|article|section|part|chapter)\s*$',
        re.IGNORECASE,
    )

    for page_data in all_page_data:
        page_num = page_data["page_num"]
        table_bboxes = page_data["table_bboxes"]
        lines = page_data["lines"]
        tables = page_data["tables"]

        # 표 영역과 겹치는 텍스트 줄 제거 (표 내용 중복 방지)
        def in_table(line: dict, _bboxes: list = table_bboxes) -> bool:
            if not _bboxes:
                return False
            x0 = line.get("x0", 0)
            top = line.get("top", 0)
            x1 = line.get("x1", 9999)
            bottom = line.get("bottom", 9999)
            for tb in _bboxes:
                if x0 >= tb[0] - 2 and top >= tb[1] - 2 and x1 <= tb[2] + 2 and bottom <= tb[3] + 2:
                    return True
            return False

        # ── TOC 페이지 처리 ──────────────────────────────────────────────────
        # Phase 1에서 감지된 TOC 페이지 범위 내에서는 번호 매긴 줄을
        # section heading으로 파싱하지 않고 단일 TOC 섹션에 content로 축적한다.
        if page_num in toc_page_range:
            _pg_first_texts = [_ln.get("text", "").strip() for _ln in lines[:5]]
            _pg_toc_heading = next(
                (_lt for _lt in _pg_first_texts
                 if any(_tp.match(_lt) for _tp in _TOC_HEADING_PATTERNS)),
                None,
            )
            if _pg_toc_heading:
                # TOC 시작 페이지 → 새 TOC 섹션 생성
                flush()
                current = {
                    "heading": _pg_toc_heading,
                    "level": 1,
                    "content": "",
                    "page_start": page_num,
                    "page_end": page_num,
                    "zone_hint": "toc",
                    "is_toc": True,
                }
            else:
                # TOC 연속 페이지 → 현재 섹션에 축적 (TOC 마킹)
                ensure_current(page_num)
                if current:
                    current["zone_hint"] = "toc"
                    current["is_toc"] = True
            # 모든 줄을 heading 분리 없이 content로 축적
            for _toc_ln in lines:
                if in_table(_toc_ln):
                    continue
                _toc_text = _toc_ln.get("text", "").strip()
                if _toc_text and _toc_text != _pg_toc_heading:
                    ensure_current(page_num)
                    if current:
                        current["zone_hint"] = "toc"
                        current["is_toc"] = True
                    current["content"] += _toc_text + "\n"
                    current["page_end"] = max(current["page_end"], page_num)
            for _toc_tbl in tables:
                if not _toc_tbl:
                    continue
                _toc_md = table_to_markdown(_toc_tbl)
                if _toc_md:
                    ensure_current(page_num)
                    if current:
                        current["zone_hint"] = "toc"
                        current["is_toc"] = True
                    current["content"] += "\n" + _toc_md + "\n"
                    current["page_end"] = max(current["page_end"], page_num)
            continue  # 일반 heading 분리 처리 건너뜀

        # ── 수정 3: 하이픈 줄바꿈 병합 전처리 ──────────────────────────────
        # PDF에서 "Sub-\nClause 5.2:" 처럼 단어 중간 하이픈으로 줄이 끊기면
        # "Clause 5.2:"가 독립 줄로 is_heading()에 진입하여 오판됨.
        # 이전 줄이 하이픈(-)으로 끝나면 현재 줄의 텍스트를 이전 줄에 합쳐서
        # 한 단어로 복원한다 (chars 리스트도 병합).
        merged_lines: list[dict] = []
        for line in lines:
            if in_table(line):
                continue
            text = (line.get("text") or "").rstrip()
            if not text.strip():
                continue
            if (merged_lines
                    and any((merged_lines[-1].get("text") or "").rstrip().endswith(h)
                            for h in ('-', '\u00ad', '\u2010', '\u2011', '\u2013'))
                    and not (merged_lines[-1].get("text") or "").rstrip().endswith('--')):
                prev = merged_lines[-1]
                prev_text = (prev.get("text") or "").rstrip()
                next_text = text.lstrip()
                # 대문자 시작 → compound word (Sub-Clause): 하이픈 유지
                # 소문자 시작 → line-break (provi-sions): 하이픈 제거
                if next_text and next_text[0].isupper():
                    prev["text"] = prev_text + next_text
                else:
                    prev["text"] = prev_text[:-1] + next_text
                # chars 리스트도 병합 (폰트 크기/Bold 판정에 필요)
                prev_chars = prev.get("chars") or []
                cur_chars = line.get("chars") or []
                prev["chars"] = prev_chars + cur_chars
                # page_end 확장
                prev["bottom"] = max(prev.get("bottom", 0), line.get("bottom", 0))
            else:
                merged_lines.append(dict(line))

        # ── content-continuation 컨텍스트 추적 ──────────────────────────
        # 이전 content 줄이 "Sub-", "sub-" 등 하이픈 접두어로 끝나면,
        # 다음 줄의 "Clause/Article..." heading 판정을 무시하고 content로 처리.
        # 이는 merged_lines 하이픈 병합이 실패한 경우의 안전장치.
        # 주의: _last_content_text는 페이지 루프 바깥에서 초기화됨 (페이지 경계 유지)

        for line in merged_lines:
            text = line.get("text", "").strip()
            if not text:
                continue
            chars = line.get("chars") or []
            char_sizes = [ch.get("size", 0) for ch in chars if ch.get("size")]
            char_fonts = [ch.get("fontname", "") for ch in chars]

            # ── 강력 트리거 패턴(document-part boundary)은 is_heading() 우회 ──────
            # _STRONG_TRIGGERS의 패턴이 매칭되면 폰트/Bold 신호 없이도 heading으로 처리.
            # 예: 'THIS CONTRACT AGREEMENT (the "Contract Agreement") is made...'
            #     → Bold+긴 줄(>60자)이지만 강력 트리거로 인식해야 함
            _strong_match = any(rx.search(text.strip()) for rx, _, _ in _STRONG_TRIGGERS)
            if is_heading(text, avg_font_size, char_sizes, char_fonts) or _strong_match:
                # ── 안전장치: 이전 content가 하이픈으로 끝나고 현재 줄이
                #    "Clause/Article/Section..." 키워드로 시작하면 content 계속 ──
                _prev_stripped = _last_content_text.rstrip()
                if (_prev_stripped
                        and any(_prev_stripped.endswith(h) for h in _HYPHEN_CHARS)
                        and not _prev_stripped.endswith('--')
                        and re.match(r'^\s*(?:CLAUSE|ARTICLE|SECTION|PART|CHAPTER)\s', text, re.I)
                        and not _strong_match):
                    ensure_current(page_num)
                    content_text = apply_bold_markdown(text, chars)
                    current["content"] += content_text + "\n"
                    current["page_end"] = max(current["page_end"], page_num)
                    _last_content_text = text
                    continue
                # ── 참조 키워드 뒤 번호 보호 ──
                # 이전 content 줄이 "Sub-Clause", "Clause", "Article" 등으로 끝나면
                # 현재 줄의 번호(20.1, 8.9 등)를 새 heading이 아니라 content로 처리.
                # 예: "subject to Sub-Clause\n20.1 [Contractor's Claims] to:"
                if (_prev_stripped
                        and _DANGLING_REF_RE.search(_prev_stripped)
                        and not _strong_match):
                    ensure_current(page_num)
                    content_text = apply_bold_markdown(text, chars)
                    current["content"] += content_text + "\n"
                    current["page_end"] = max(current["page_end"], page_num)
                    _last_content_text = text
                    continue
                # ── 조항 번호 계층 레벨 추론 ────────────────────────────────
                # 우선순위: 수치 조항번호 > ARTICLE/CLAUSE/PART 등 > 로마숫자/알파벳 > 기본
                level = 1
                t_stripped = text.strip()
                # 수치 조항 번호: "1 Title" → 1, "1.1 Title" → 2, "1.1.2 Title" → 3
                # r'(\d+\.)+' 는 "1.1 Title"을 "1."만 캡처해 level=1로 오인한다.
                # r'\d+(?:\.\d+)*' 로 전체 번호를 캡처 후 점 개수+1로 정확히 계산한다.
                _num_m = re.match(r'^\s*(\d+(?:\.\d+)*)', t_stripped)
                if _num_m:
                    level = _num_m.group(1).count(".") + 1
                elif re.match(r'^\s*(ARTICLE|CHAPTER|PART)\s+', t_stripped, re.I):
                    level = 1   # 최상위 구조
                elif re.match(r'^\s*(SECTION|CLAUSE)\s+', t_stripped, re.I):
                    level = 2   # 중간 구조
                elif re.match(r'^\s*제\s*\d+\s*[장편]\b', t_stripped):
                    level = 1   # 한국어 장/편
                elif re.match(r'^\s*제\s*\d+\s*절\b', t_stripped):
                    level = 2   # 한국어 절
                elif re.match(r'^\s*제\s*\d+\s*조\b', t_stripped):
                    level = 2   # 한국어 조 (절 아래)
                # document-part 패턴 매칭 heading은 level=1 강제 (new_section() 내부에서도 처리)
                # font_size_ratio / bold_ratio 계산 → _detect_zone_hint 에 전달
                _fsr = 1.0
                if char_sizes and avg_font_size > 0:
                    _fsr = (sum(char_sizes) / len(char_sizes)) / avg_font_size
                _br = (sum(1 for f in char_fonts if f and "bold" in f.lower()) / len(char_fonts)
                       if char_fonts else 0.0)
                new_section(text, level, page_num, font_size_ratio=_fsr, bold_ratio=_br)
                _last_content_text = ""  # heading 후 content 컨텍스트 리셋
            else:
                ensure_current(page_num)
                # 볼드 구간을 **...** 마크다운으로 변환하여 저장
                content_text = apply_bold_markdown(text, chars)
                current["content"] += content_text + "\n"
                current["page_end"] = max(current["page_end"], page_num)
                _last_content_text = text

        for tbl in tables:
            if not tbl:
                continue
            md = table_to_markdown(tbl)
            if md:
                ensure_current(page_num)
                current["content"] += "\n" + md + "\n"
                current["page_end"] = max(current["page_end"], page_num)

    flush()

    # 섹션이 없으면 단순 텍스트 전체를 단일 섹션으로
    if not sections:
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                full_text = "\n".join(p.extract_text() or "" for p in pdf.pages)
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

    # ── Phase 3.5: 짧은 하위 섹션 병합 (M-7, 개선) ───────────────────────────
    # 목적: 극도로 짧은 조각 섹션(번호 레이블 수준)을 이전 섹션에 병합하되,
    #       1.1.1.x 4단계 정의 항목과 (a)(b)(c) 서브아이템은 독립 섹션으로 보존.
    #
    # 변경 이유 (이전: threshold=200, level>=3 무조건 병합):
    #   - FIDIC Definitions 섹션의 1.1.1.1~1.1.1.N 항목이 직전 섹션에 모두 흡수돼
    #     clause_number가 부모 섹션 하나로 뭉쳐지는 문제 발생
    #   - (a)(b)(c) 서브아이템도 동일하게 사라져 별도 조항 분리 불가
    #
    # 개선된 병합 조건:
    #   A. definitions zone 부모 하의 level>=4 (1.1.1.x): 병합 제외 → 독립 섹션 보존
    #   B. (a)(b)(c) 알파벳 괄호 서브아이템: 부모 content에 병합
    #      (단, definitions zone 내부에서는 독립 보존)
    #   C. 진짜 조각 (threshold=50자): level>=3 + 극소 content만 병합

    # (a)(b)(c) 서브아이템 heading 패턴
    _ALPHA_PAREN_HEADING = _re.compile(r'^\s*\([a-z]{1,3}\)\s+\S', _re.IGNORECASE)
    # 수정 1: 3단계 이상 수치 조항 번호 패턴 (예: 1.1.1, 1.1.1.19, 2.3.1.1, 14.6.2.3).
    # {3,} → {2,}: 점 2개 이상 = 3단계 이상(1.1.1, 1.1.1.x 등) 모두 독립 보존.
    # _prev_zone == "definitions" 의존을 제거하고 heading 번호 구조 자체로 판별.
    # NON_PROPAGATING_ZONES 로직이 definitions zone_hint를 contract_body로 덮어쓰더라도
    # 독립 보존 조건이 정확하게 동작한다.
    _DEEP_NUMERIC_PATTERN = _re.compile(r'^\s*\d+(?:\.\d+){2,}\s')

    if len(sections) > 1:
        # 진짜 조각만 병합: 50자 미만 (번호 레이블 수준)으로 threshold 대폭 낮춤
        _SHORT_CONTENT_THRESHOLD = 50
        merged: list[dict] = [sections[0]]
        for _sec in sections[1:]:
            _level = _sec.get("level", 1)
            _content = _sec.get("content", "").strip()
            _heading = _sec.get("heading", "")
            _zone = _sec.get("zone_hint", "contract_body")

            # document-part 패턴 매칭 heading은 병합 대상에서 제외 (경계 마커)
            _is_boundary = _detect_zone_hint_from_patterns(_heading, is_heading_signal=True) is not None

            # 이전 섹션의 zone_hint (부모 컨텍스트 판단용)
            _prev_zone = merged[-1].get("zone_hint", "contract_body") if merged else "contract_body"

            # (a)(b)(c) 서브아이템 여부
            _is_alpha_sub = bool(_ALPHA_PAREN_HEADING.match(_heading)) if _heading else False

            # 수정 1: 4단계 이상 수치 조항 번호를 heading 패턴으로 직접 감지 → 병합 제외.
            # 기존 _is_deep_definitions는 _prev_zone == "definitions"에 의존했으나,
            # NON_PROPAGATING_ZONES가 자식 섹션의 zone_hint를 contract_body로 덮어써
            # 조건이 항상 False가 되는 문제가 있었음. heading 번호 구조 자체로 판별한다.
            _is_deep_numeric = bool(_DEEP_NUMERIC_PATTERN.match(_heading)) if _heading else False

            # 케이스 A: 진짜 짧은 조각 (threshold=50) — 4단계 수치 번호 예외 적용
            _is_trivial_fragment = (
                _level >= 3
                and len(_content) < _SHORT_CONTENT_THRESHOLD
                and not _is_boundary
                and not _is_deep_numeric
                and merged
            )

            # 케이스 B: (a)(b)(c) 서브아이템 → 부모 content에 병합
            # 수정 1: definitions zone 판단도 _is_deep_numeric으로 보완.
            # _prev_zone/zone이 contract_body여도 직전 섹션이 4단계 수치 번호면 독립 보존.
            _prev_heading = merged[-1].get("heading", "") if merged else ""
            _prev_is_deep_numeric = bool(_DEEP_NUMERIC_PATTERN.match(_prev_heading)) if _prev_heading else False
            _is_sub_item = (
                _is_alpha_sub
                and not _is_boundary
                and _prev_zone != "definitions"
                and _zone != "definitions"
                and not _prev_is_deep_numeric
                and merged
            )

            if _is_trivial_fragment or _is_sub_item:
                # 이전 섹션에 heading + content를 이어 붙임
                _prev = merged[-1]
                _combined = ""
                if _heading:
                    _combined += _heading + "\n"
                if _content:
                    _combined += _content + "\n"
                _prev["content"] = _prev.get("content", "") + _combined
                _prev["page_end"] = max(_prev.get("page_end", 1), _sec.get("page_end", 1))
            else:
                merged.append(_sec)
        if len(merged) < len(sections):
            log.info(
                f"짧은 하위 섹션 병합: {len(sections)} → {len(merged)} 섹션 "
                f"(threshold={_SHORT_CONTENT_THRESHOLD}자, (a)(b)(c) 서브아이템 포함, "
                f"3단계 이상 수치 번호 독립 보존)"
            )
        sections = merged

    # ── Phase 3.6: 섹션 내 복수 조항 재분할 ──────────────────────────────────
    _before_split = len(sections)
    sections = _split_multi_clause_sections(sections)
    if len(sections) > _before_split:
        log.info(
            f"복수 조항 재분할 (_split_multi_clause_sections): "
            f"{_before_split} → {len(sections)} 섹션"
        )

    # ── Phase 4: 헤더/푸터 감지 및 제거 ───────────────────────────────────────
    hf_info: HeaderFooterInfo | None = None
    try:
        # all_page_data 에서 PageElement 리스트 구성
        pages_elements: list[list[PageElement]] = []
        for pd_item in all_page_data:
            page_els: list[PageElement] = []
            for el in pd_item.get("hf_elements", []):
                page_els.append(PageElement(
                    text=el["text"],
                    bbox=(el["x0"], el["y0"], el["x1"], el["y1"]),
                    page_number=pd_item["page_num"],
                    font_size=el.get("font_size", 0.0),
                ))
            pages_elements.append(page_els)

        if len(pages_elements) >= 3:
            hf_info = _detect_headers_footers(pages_elements, page_heights)
            # 헤더/푸터 패턴이 감지된 경우에만 섹션 텍스트 정제
            if hf_info.header_patterns or hf_info.footer_patterns:
                # C-2: 헤더/푸터 제거 카운트를 분리하여 추적
                total_removed_header = 0
                total_removed_footer = 0
                for sec in sections:
                    cleaned, rem_h, rem_f = _remove_header_footer_lines(sec.get("content", ""), hf_info)
                    sec["content"] = cleaned
                    total_removed_header += rem_h
                    total_removed_footer += rem_f
                    # heading에도 헤더/푸터 패턴 적용 (헤더 텍스트가 섹션 heading으로 오인된 경우 제거)
                    if sec.get("heading"):
                        cleaned_heading, h_h, h_f = _remove_header_footer_lines(sec["heading"], hf_info)
                        sec["heading"] = cleaned_heading.strip()
                        total_removed_header += h_h
                        total_removed_footer += h_f
                hf_info.removed_header_count = total_removed_header
                hf_info.removed_footer_count = total_removed_footer
                log.info(
                    f"헤더/푸터 제거: header_patterns={len(hf_info.header_patterns)}, "
                    f"footer_patterns={len(hf_info.footer_patterns)}, "
                    f"removed_header={total_removed_header}, removed_footer={total_removed_footer}"
                )
    except Exception as e:
        log.warning(f"헤더/푸터 감지 실패 (무시됨): {e}")
        hf_info = None

    # ── Phase 5: 조각 heading 병합 ────────────────────────────────────────────
    # "1.1" / "Definitions" 처럼 번호와 제목이 별도 줄로 추출되어 각각 heading-only
    # 섹션이 된 경우, 이를 "1.1 Definitions" 단일 섹션으로 병합한다.
    sections = _merge_fragmented_headings(sections)

    # ── Phase 5.1 보완: compound heading 분리 ──────────────────────────────────
    # _merge_fragmented_headings 이후에도 "6. COMMENCEMENT 6.1 Effectiveness..."
    # 처럼 부모+자식이 한 heading에 남는 경우를 분리
    sections = _split_compound_headings(sections)

    # ── Phase 5.5: content 줄바꿈 병합 (line unwrapping) ──────────────────────
    # PDF의 물리적 줄바꿈이 그대로 \n으로 보존되어 "fourteen\n(14)\ncalendar days"
    # 처럼 한 문장이 여러 줄로 분리되는 문제를 수정한다.
    # 규칙: 이전 줄이 문장 중간(소문자/쉼표/전치사 등으로 끝남)이고,
    #       다음 줄이 소문자나 괄호 숫자 등으로 시작하면 공백으로 병합.
    # 보존: (a)/(i)/(1) 등 리스트 마커 줄, 빈 줄(\n\n 문단 경계), 표(|)
    for sec in sections:
        sec["content"] = _unwrap_content_lines(sec.get("content", ""))

    log.info(f"pdfplumber 파싱 완료: {len(sections)} sections, {total_pages} pages (workers={len(chunks)})")
    return sections, total_pages, hf_info


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
        hf_info: HeaderFooterInfo | None = None

        if ext == ".pdf":
            # pdfplumber 우선 시도 (래스터라이즈 없음, bad_alloc 없음, 표 구조 보존)
            # Docling 로드 없이 먼저 시도 → 성공하면 Docling 초기화 시간 완전 절감
            sections, total_pages, hf_info = await asyncio.to_thread(_parse_pdf_native, data, filename)
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
            # DOCX도 PDF와 동일하게 조각 heading 병합 적용
            sections = _merge_fragmented_headings(sections)
            sections = _split_compound_headings(sections)

        # ── 스캔 PDF 감지 — 섹션이 없거나 텍스트 밀도가 매우 낮을 때 ────────────
        if not sections and ext == ".pdf":
            # 전체 페이지에서 추출된 단어 수 합산 (pdfplumber 직접 확인)
            _total_words = 0
            _checked_pages = 0
            try:
                import pdfplumber as _ppb
                with _ppb.open(io.BytesIO(data)) as _pdf_scan:
                    _checked_pages = len(_pdf_scan.pages)
                    for _pg in _pdf_scan.pages[:min(10, _checked_pages)]:
                        _txt = _pg.extract_text() or ""
                        _total_words += len(_txt.split())
            except Exception:
                pass
            _avg_words = (_total_words / _checked_pages) if _checked_pages > 0 else 0
            if _avg_words < 10:
                _scan_msg = (
                    "이 PDF는 텍스트 레이어가 없는 스캔 문서로 보입니다. "
                    "텍스트 추출이 불가능합니다. OCR 처리 후 다시 업로드하세요."
                )
                log.warning(_scan_msg)
                warnings.append(_scan_msg)
                return JSONResponse(
                    status_code=422,
                    content={
                        "sections": [],
                        "total_pages": total_pages,
                        "warnings": warnings,
                        "document_parts": [],
                        "toc_entries": [],
                        "sub_documents": [],
                        "scan_detected": True,
                    },
                )

        # ── Bug E 수정: 섹션 page_num을 page_start의 alias로 채워 backward compatibility 유지
        for _sec in sections:
            _sec["page_num"] = _sec.get("page_start") or _sec.get("page_num")

        # ── document_parts 감지 (P1-3: 1B) ─────────────────────────────────
        document_parts = _detect_document_boundaries(sections)

        # ── TOC 감지 및 파싱 (Phase 2A/2B/2C) ─────────────────────────────
        toc_entries: list[dict] = []
        try:
            toc_indices = _detect_toc_pages(sections)
            if toc_indices:
                toc_entries = _parse_toc_entries(toc_indices, sections, total_pages=total_pages)
                document_parts = _validate_structure_against_toc(document_parts, toc_entries, warnings, sections=sections)
                log.info(f"TOC 감지: {len(toc_indices)} 섹션, {len(toc_entries)} 엔트리")
                # TOC 섹션의 zone_hint를 "toc"로 명시 마킹
                # — sectionsToClauses()가 섹션 단위로 isAnalysisTarget() 체크하므로
                #   TOC 내용이 contract_body로 오분류되어 조항으로 추출되는 것을 방지
                toc_idx_set = set(toc_indices)
                for _ti in toc_idx_set:
                    if _ti < len(sections):
                        sections[_ti]["zone_hint"] = "toc"
                        sections[_ti]["is_toc"] = True
                log.info(f"TOC 섹션 zone_hint='toc' 마킹 완료: {len(toc_idx_set)}개 섹션")
        except Exception as _toc_e:
            log.warning(f"TOC 파싱 실패 (무시됨): {_toc_e}")
            toc_entries = []

        # ── sub_documents 감지 (Phase 4A) ──────────────────────────────────
        sub_documents: list[dict] = []
        try:
            sub_documents = _detect_sub_documents(sections, document_parts)
            log.info(f"sub_documents: {len(sub_documents)}개")
        except Exception as _sd_e:
            log.warning(f"sub_documents 감지 실패 (무시됨): {_sd_e}")
            sub_documents = []

        log.info(f"Done: {len(sections)} sections, {total_pages} pages, {len(document_parts)} document_parts, {len(toc_entries)} toc_entries, {len(sub_documents)} sub_documents.")

        response_body: dict = {
            "sections": sections,
            "total_pages": total_pages,
            "warnings": warnings,
            "document_parts": document_parts,
            "toc_entries": toc_entries,
            "sub_documents": sub_documents,
        }
        if hf_info is not None:
            response_body["header_footer_info"] = hf_info.to_dict()

        return JSONResponse(response_body)

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
