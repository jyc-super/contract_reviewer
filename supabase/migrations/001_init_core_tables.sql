-- 001_init_core_tables.sql
-- 핵심 4개 테이블 (contracts, document_zones, clauses, clause_analyses) 초기 스키마
-- 실제 Supabase 프로젝트에 적용할 때 이 파일을 기반으로 조정할 수 있습니다.

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  status text not null, -- uploading | filtering | parsing | analyzing | ready | partial | error
  page_count integer,
  extraction_method text, -- native / ocr / hybrid
  ocr_confidence numeric,
  source_languages text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_zones (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  page_from integer not null,
  page_to integer not null,
  zone_type text not null, -- cover_page, contract_body, general_conditions, ...
  confidence numeric not null,
  is_analysis_target boolean not null default false,
  user_confirmed boolean,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.clauses (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  zone_id uuid not null references public.document_zones(id) on delete cascade,
  clause_prefix text, -- GC-, PC-, MAIN-
  number text,
  title text,
  text text not null,
  is_auto_split boolean not null default false,
  needs_review boolean not null default false,
  content_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.clause_analyses (
  clause_id uuid primary key references public.clauses(id) on delete cascade,
  risk_level text not null, -- high | medium | low | info
  risk_summary text not null,
  recommendations text not null,
  fidic_comparisons jsonb,
  llm_model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

