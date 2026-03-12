# 환경 변수 및 마이그레이션

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 사용 시 | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 사용 시 | Service Role Key (서버 전용, RLS 우회) |
| `GEMINI_API_KEY` | 조항 분석·PDF 파싱 시 | Gemini API 키. 없으면 분석·PDF 파싱 불가 |

- Supabase 미설정 시: 계약·구역·조항·분석 DB 저장/조회가 되지 않으며, API가 503 또는 빈 데이터를 반환합니다.
- Supabase Cloud 연결 정보는 **설정(⚙️) 페이지**에서 URL과 Service Role Key를 입력해 저장할 수 있으며, 값은 암호화되어 로컬 파일(`data/supabase-config.enc`)에 보관됩니다.
- `GEMINI_API_KEY` 없음: PDF 파싱 및 분석 실행이 불가합니다.

## Supabase 마이그레이션

1. Supabase 대시보드 → SQL Editor에서 순서대로 실행합니다.

2. **스키마 생성**  
   `supabase/migrations/001_init_core_tables.sql` 내용을 실행합니다.  
   (contracts, document_zones, clauses, clause_analyses 4개 테이블 생성)

3. **RLS 정책 적용**  
   `supabase/migrations/002_rls_policies.sql` 내용을 실행합니다.  
   (4테이블 RLS 활성화 및 정책 추가. Service Role 사용 API는 RLS를 우회합니다.)

## Fallback 텍스트 추출 (DOCX)

DOCX 파일은 mammoth으로 텍스트를 추출합니다. PDF는 Gemini API로 직접 파싱합니다.

```bash
npm install mammoth
```

- mammoth 미설치 시: DOCX 업로드 시 전처리 결과가 빈 페이지로 나올 수 있습니다.

## Auth 연동 (선택)

- **POST /api/contracts** 는 `Authorization: Bearer <Supabase access_token>` 이 있으면 해당 JWT로 사용자 식별 후 `contracts.user_id`에 저장합니다.
- 토큰이 없거나 유효하지 않으면 개발용 placeholder `user_id`를 사용합니다.
- 클라이언트에서 Supabase Auth 로그인 후 업로드 시 세션의 `access_token`을 헤더에 넣어 주면 됩니다.
