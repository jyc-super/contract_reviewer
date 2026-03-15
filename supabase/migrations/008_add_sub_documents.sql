-- Migration 008: add sub_documents JSONB column to contracts table
-- Applied as part of Phase 4A multi-document boundary detection.
-- sub_documents stores the array of sub-document boundaries detected by
-- _detect_sub_documents() in the Docling sidecar.
--
-- Schema:
--   sub_documents JSONB  -- nullable; array of { title, page_start, page_end, document_parts }

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS sub_documents JSONB;
