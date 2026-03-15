-- Migration 006: Add document_parts, header_footer_info, toc_entries to contracts
-- These columns store structured document analysis results from the Docling sidecar
-- that were previously computed but never persisted to the database.
--
-- document_parts: logical sections of the document (e.g. Cover, TOC, GC, Appendices)
-- header_footer_info: detected repeating headers/footers and their patterns
-- toc_entries: parsed table of contents entries (added now for Phase 2 readiness)

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS document_parts    JSONB,
  ADD COLUMN IF NOT EXISTS header_footer_info JSONB,
  ADD COLUMN IF NOT EXISTS toc_entries       JSONB;
