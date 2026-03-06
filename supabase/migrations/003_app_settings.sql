-- 003_app_settings.sql
-- 앱 설정 저장 (Gemini API Key 암호화 저장용)

create table if not exists public.app_settings (
  key text primary key,
  value_encrypted text not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is '앱 설정 키-값 (암호화된 값만 저장)';
comment on column public.app_settings.key is '설정 키 (예: gemini_api_key)';
comment on column public.app_settings.value_encrypted is '암호화된 값 (IV:authTag:ciphertext hex)';
