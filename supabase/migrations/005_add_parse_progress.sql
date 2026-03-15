-- 005_add_parse_progress.sql
-- contracts 테이블에 parse_progress 컬럼 추가
-- 파이프라인 파싱 중 세부 진행률(0–100)을 저장하여 프론트엔드 폴링이
-- "33%에서 멈춤" 문제를 해결합니다.
-- status=parsing 동안 주기적으로 업데이트되며, 완료 시 null로 리셋됩니다.

alter table public.contracts
  add column if not exists parse_progress integer check (parse_progress >= 0 and parse_progress <= 100);

comment on column public.contracts.parse_progress is
  'Parsing pipeline progress (0–100). Updated during status=parsing. Null when not parsing.';
