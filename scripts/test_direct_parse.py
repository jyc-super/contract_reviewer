"""
Direct docling parse test - no sidecar HTTP, tests docling directly.
Tests do_table_structure=False fix for OOM.
"""
import sys, time, io, logging, os

os.environ.setdefault("HF_HUB_OFFLINE", "0")

# suppress noisy C++ warnings
import warnings
warnings.filterwarnings("ignore")

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.base_models import InputFormat
from docling_core.types.io import DocumentStream

logging.basicConfig(level=logging.CRITICAL)

print("Creating converter (table_structure=False)...", flush=True)
pipeline_options = PdfPipelineOptions()
pipeline_options.do_ocr = False
pipeline_options.do_table_structure = False  # avoid OOM

converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
)
print("Converter ready.", flush=True)

pdf_path = os.path.join(os.path.dirname(__file__), "..", "QNLP.ITB.P2 EPC Contract.pdf")
with open(pdf_path, "rb") as f:
    data = f.read()
print(f"PDF: {len(data):,} bytes", flush=True)

stream = DocumentStream(name="contract.pdf", stream=io.BytesIO(data))
t0 = time.time()
print("Converting...", flush=True)
result = converter.convert(stream)
doc = result.document
elapsed = time.time() - t0
print(f"Done in {elapsed:.1f}s", flush=True)

try:
    pages = doc.num_pages()
    print(f"Pages: {pages}", flush=True)
except Exception as e:
    print(f"num_pages err: {e}", flush=True)

try:
    md = doc.export_to_markdown()
    print(f"Markdown: {len(md)} chars", flush=True)
    # Show first 1200 chars
    sample = md[:1200].replace("\n", " | ")
    print(f"Sample: {sample}", flush=True)
except Exception as e:
    print(f"markdown err: {e}", flush=True)

# Build sections like the sidecar does
print("\n--- Sections ---", flush=True)
try:
    SectionHeaderItem = TextItem = None
    for mod_path in [
        "docling_core.transforms.chunker.hierarchical_chunker",
        "docling.datamodel.document",
        "docling_core.types.doc.document",
    ]:
        try:
            import importlib
            mod = importlib.import_module(mod_path)
            SectionHeaderItem = SectionHeaderItem or getattr(mod, "SectionHeaderItem", None)
            TextItem = TextItem or getattr(mod, "TextItem", None)
        except Exception:
            pass

    sections = []
    current = None
    for item, level in doc.iterate_items():
        cls_name = type(item).__name__
        if cls_name == "SectionHeaderItem" or (SectionHeaderItem and isinstance(item, SectionHeaderItem)):
            if current and current.get("heading") or (current and current.get("content", "").strip()):
                sections.append(current)
            current = {"heading": getattr(item, "text", "").strip(), "level": level}
        elif cls_name in ("TextItem", "ListItem") or (TextItem and isinstance(item, TextItem)):
            if current is None:
                current = {"heading": "", "level": 1, "content": ""}
            current.setdefault("content", "")
            current["content"] += getattr(item, "text", "").strip() + "\n"
    if current:
        sections.append(current)

    print(f"Total sections found: {len(sections)}", flush=True)
    for i, s in enumerate(sections[:10]):
        print(f"  [{i}] L{s.get('level',1)} {repr(s.get('heading','')[:60])}", flush=True)
except Exception as e:
    print(f"iterate_items err: {e}", flush=True)

print("DONE", flush=True)
