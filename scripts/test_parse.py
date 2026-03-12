"""Direct docling parse test for QNLP.ITB.P2 EPC Contract.pdf"""
import sys, time, io, logging, os

os.environ.setdefault("HF_HUB_OFFLINE", "0")
logging.basicConfig(level=logging.ERROR)

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.base_models import InputFormat
from docling_core.types.io import DocumentStream

pipeline_options = PdfPipelineOptions()
pipeline_options.do_ocr = False
pipeline_options.do_table_structure = False  # no table OOM

converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
)
print("Converter ready", flush=True)

pdf_path = os.path.join(os.path.dirname(__file__), "..", "QNLP.ITB.P2 EPC Contract.pdf")
with open(pdf_path, "rb") as f:
    data = f.read()
print(f"PDF loaded: {len(data):,} bytes", flush=True)

stream = DocumentStream(name="contract.pdf", stream=io.BytesIO(data))
t0 = time.time()
try:
    result = converter.convert(stream)
    doc = result.document
    elapsed = time.time() - t0
    print(f"Convert done in {elapsed:.1f}s", flush=True)
except Exception as e:
    print(f"Convert FAILED: {type(e).__name__}: {e}", flush=True)
    sys.exit(1)

try:
    print(f"Pages: {doc.num_pages()}", flush=True)
except Exception as e:
    print(f"num_pages error: {e}", flush=True)

try:
    md = doc.export_to_markdown()
    print(f"Markdown: {len(md)} chars", flush=True)
    print("--- Sample ---", flush=True)
    print(md[:1000], flush=True)
except Exception as e:
    print(f"markdown error: {e}", flush=True)
