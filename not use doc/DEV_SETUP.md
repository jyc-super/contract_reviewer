# 개발 환경 설치 가이드

Contract Risk Review 앱을 로컬에서 실행하기 위한 단계입니다.

## 1. 필수 도구

- **Node.js 18 이상**  
  - [nodejs.org](https://nodejs.org/)에서 LTS 버전 설치  
  - 설치 후 터미널에서 `node -v`, `npm -v` 확인

- **npm** (Node 설치 시 포함) 또는 **yarn** / **pnpm**

## 2. 의존성 설치

프로젝트 루트에서:

```bash
cd "d:\coding\contract risk"
npm install
```

- **선택 패키지**(pdf-parse, mammoth, franc): 설치 실패 시에도 앱은 동작합니다.  
  - PDF/DOCX 텍스트 추출: `pdf-parse`, `mammoth`  
  - 언어 감지: `franc`

## 3. 환경 변수

`.env.example`을 복사해 `.env.local` 생성 후 값을 채웁니다.

```bash
cp .env.example .env.local
```

| 변수 | 필수 | 설명 |
|------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 사용 시 | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 사용 시 | Service Role Key (서버 전용) |
| `GEMINI_API_KEY` | 조항 분석 사용 시 | [Google AI Studio](https://aistudio.google.com/)에서 발급 |
| `DOCLING_SERVICE_URL` | Docling 사용 시 | 예: `http://localhost:8080` |

- Supabase 미설정: DB 저장/조회 불가, API가 503 또는 빈 데이터 반환  
- `GEMINI_API_KEY` 미설정: 분석 시 빈 요약/권고가 저장됨

## 4. Supabase DB 설정 (DB 사용 시)

1. [Supabase](https://supabase.com/)에서 프로젝트 생성  
2. 대시보드 → **SQL Editor**에서 아래 순서로 실행:
   - `supabase/migrations/001_init_core_tables.sql`
   - `supabase/migrations/002_rls_policies.sql`
3. **Settings → API**에서 URL과 Service Role Key를 `.env.local`에 입력

## 5. 실행

```bash
npm run dev
```

브라우저에서 **http://localhost:3000** 접속.

### 터미널에서 `npm`을 찾을 수 없을 때

Node.js를 방금 설치했거나 Cursor를 열어 둔 채로 설치했다면, **해당 터미널에는 PATH가 반영되지 않아** `npm`이 인식되지 않을 수 있습니다.

**방법 1 — 현재 터미널에서 PATH만 새로 고치기 (PowerShell)**  
아래 한 줄을 복사해 터미널에 붙여 넣고 Enter 한 뒤, 이어서 `npm run dev`를 실행하세요.

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
```

그 다음:

```powershell
cd "d:\coding\contract risk"
npm run dev
```

**방법 2 — Cursor/터미널 다시 열기**  
Cursor를 완전히 종료했다가 다시 실행하거나, **새 터미널**을 연 뒤 위처럼 `cd` → `npm run dev`를 실행하면 됩니다.

## 6. 기타 명령

| 명령 | 설명 |
|------|------|
| `npm run build` | 프로덕션 빌드 |
| `npm run start` | 빌드 후 프로덕션 서버 실행 |
| `npm test` | 단위 테스트 (Vitest) 실행 |
| `npm run test:watch` | 테스트 감시 모드 |

## 7. Docling (선택)

PDF/DOCX 레이아웃·표 추출을 Docling으로 쓰려면:

- Docling 서비스를 Docker 등으로 띄운 뒤  
- `.env.local`에 `DOCLING_SERVICE_URL=http://localhost:8080` 설정  
- 미설정 시 pdf-parse / mammoth fallback 사용 (해당 패키지 설치 시)

---

상세 환경 변수·마이그레이션: [docs/ENV_AND_MIGRATIONS.md](docs/ENV_AND_MIGRATIONS.md)
