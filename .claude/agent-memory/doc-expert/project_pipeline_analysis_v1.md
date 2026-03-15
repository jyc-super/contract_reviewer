---
name: Parse Pipeline Full Analysis v1
description: Complete analysis of Docling sidecar pipeline architecture, quality scores, and Gemini API intervention impact assessment (2026-03-14)
type: project
---

Full pipeline analysis completed on 2026-03-14. Key findings:

**Current Pipeline**: pdfplumber (primary) + Docling TextOnlyPdfPipeline (fallback). ~3,250 lines Python + ~650 lines TypeScript.

**Current Quality Score: 72/100** (weighted average across all document types)
- FIDIC/EPC native PDF: 88-93/100 (optimized domain)
- Non-standard contracts: 55-65/100
- Scanned PDF: 10-15/100 (no OCR)
- Multi-column/complex tables: 45-60/100

**Top 3 Gemini Intervention Points** (cost-effective, Free Tier feasible):
1. Zone Classification (regex→LLM): +16 points, ~$0.0003/doc
2. Structure Recognition (TOC cross-validation): +13 points, ~$0.0002/doc
3. Quality Check Enhancement: +35 reliability points, ~$0.0004/doc

**With Gemini Phase 1**: 72 → 80 (+8), 3 API calls/doc, gemini-2.0-flash Free Tier (500 docs/day free)
**With All Phases**: 72 → 85 (+13), 13-25 API calls/doc, ~$0.008/doc

**Structural Limitations** (not fixable by Gemini):
- Scanned PDF: needs OCR engine (Tesseract/EasyOCR)
- Multi-column reading order: needs layout-aware parser (DocLayNet)
- Image-based tables: needs rasterization pipeline

**Why:** This analysis serves as baseline for any future parsing quality improvement decisions.
**How to apply:** Reference these scores when prioritizing parse improvements. Phase 1 Gemini interventions should be implemented first due to highest ROI.
