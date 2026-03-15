-- Migration 010: clauses 테이블에 content_format 컬럼 추가
--
-- 목적: 파싱 파이프라인이 pdfplumber에서 볼드 텍스트를 **...** 마크다운 span으로
--       변환하여 저장하므로, 각 조항의 텍스트 포맷을 명시적으로 기록한다.
--
-- content_format 값:
--   'plain'    — 일반 텍스트 (마크다운 없음). 기본값.
--   'markdown' — 인라인 마크다운 포함 (현재: **bold** span).
--
-- 기존 rows는 DEFAULT 'plain'으로 채워진다.

ALTER TABLE clauses
  ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'plain';

-- 향후 유효하지 않은 값이 삽입되는 것을 방지하는 CHECK 제약
ALTER TABLE clauses
  ADD CONSTRAINT clauses_content_format_check
    CHECK (content_format IN ('plain', 'markdown'));

COMMENT ON COLUMN clauses.content_format IS
  'Text format of the clause body: ''plain'' = no markup, ''markdown'' = inline markdown (e.g. **bold** spans).';
