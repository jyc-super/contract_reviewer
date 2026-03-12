# ContractLens 초기 설정 가이드

> **사용자가 직접 입력할 것: Gemini API Key 1개뿐**
>
> 나머지(DB)는 Docker에서 자동 실행됩니다. PDF 파싱은 Gemini API로 처리되므로 Docling/Docker가 필요 없습니다.
> 총 소요 시간: 약 10분 · 비용: 0원 · 인터넷 가입/계정 생성: Gemini만

---

## 전체 구조

```
┌─────────────────────────────────────────┐
│          ContractLens (Next.js)          │
│             localhost:3000               │
└──────┬─────────────────────┬───────────┘
       │                      │
       ▼                      ▼
  ┌──────────┐          ┌──────────┐
  │ Supabase │          │ Gemini   │
  │ (로컬DB) │          │ (AI분석  │
  │ :54321   │          │ +PDF파싱)│
  │ Docker   │          │ 클라우드  │
  └──────────┘          └──────────┘
     자동실행             API Key 1개
```

| 구성 요소 | 위치 | 사용자 조치 |
|-----------|------|------------|
| **Supabase** | 로컬 Docker (localhost:54321) | 없음 — 자동 실행 |
| **Gemini API** | Google 클라우드 | ★ API Key 입력 (1회, 분석·PDF 파싱 모두 사용) |

---

## 사전 요구사항

- **Docker Desktop** — [docker.com/get-started](https://www.docker.com/get-started/)
- **Node.js 18+** — 이미 설치되어 있을 것
- **Google 계정** — Gemini API 키 발급용

---

## Step 1: Docker 서비스 일괄 실행 (5분)

### 1-1. Supabase 로컬 실행

프로젝트 루트 디렉토리에서:

```bash
# Supabase CLI 설치 (최초 1회)
npm install -g supabase

# Supabase 초기화 (최초 1회)
npx supabase init

# 로컬 Supabase 시작
npx supabase start
```

첫 실행 시 Docker 이미지를 다운로드하므로 3~5분 소요됩니다.
완료되면 아래와 같은 출력이 나옵니다:

```
Started supabase local development setup.

         API URL: http://localhost:54321
     GraphQL URL: http://localhost:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
        anon key: eyJhbGciOiJIUzI1NiIs...
service_role key: eyJhbGciOiJIUzI1NiIs...
```

> 이 값들은 로컬 환경에서 항상 동일합니다. `.env.local`에 자동으로 들어갑니다.

### 1-2. 자동 재시작 확인

Docker Desktop 설정:
- **Settings → General → "Start Docker Desktop when you sign in"** 체크

이렇게 하면 컴퓨터 재부팅 후에도:
- Docker Desktop 자동 시작 → Supabase 자동 시작
- 별도 조작 필요 없음

### 1-3. 실행 확인

```bash
# 전체 Docker 컨테이너 상태 확인
docker ps

# Supabase 상태 확인
npx supabase status

# Supabase Studio — 브라우저에서 http://localhost:54323
```

---

## Step 2: 데이터베이스 테이블 생성 (2분)

### 2-1. Supabase Studio 접속

브라우저에서 `http://localhost:54323` 접속

### 2-2. SQL 실행

1. 왼쪽 메뉴 → **SQL Editor**
2. CLAUDE.md의 `## 데이터베이스 스키마` 섹션 SQL 전체를 복사
3. 붙여넣기 → **Run**
4. "Success" 확인

### 2-3. Storage 버킷 생성

1. 왼쪽 메뉴 → **Storage** → **New bucket**
2. 이름: `contracts`, Public: OFF
3. **Create bucket**

---

## Step 3: 환경 변수 설정 (1분)

프로젝트 루트에 `.env.local` 파일:

```bash
# ─── Supabase (로컬 — 값이 항상 동일) ───
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU

# ─── Gemini API (★ 이것만 직접 발급 필요) ───
GEMINI_API_KEY=여기에_본인_키_입력
```

> 💡 Supabase 로컬의 키들은 모든 개발자에게 동일한 테스트용 키입니다.
> 보안 걱정 없이 그대로 사용하세요. 실제 데이터는 로컬에만 존재합니다.

---

## Step 4: Gemini API 키 발급 (2분)

이것이 **유일하게 외부에서 발급받아야 하는 것**입니다.

1. [aistudio.google.com](https://aistudio.google.com) → Google 로그인
2. **Get API Key** → **Create API Key**
3. `AIzaSy...` 형태의 키 복사
4. 두 곳 중 하나에 입력:
   - **방법 A**: `.env.local`의 `GEMINI_API_KEY=` 뒤에 붙여넣기
   - **방법 B**: 앱 실행 후 ⚙️ 설정 탭에서 입력 → 저장

> 신용카드 불필요. 키는 Google이 폐기하지 않는 한 영구적.

---

## Step 5: 앱 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

설정 탭(⚙️)에서 모든 상태가 초록이면 완료:

```
● Supabase    로컬 실행 중
● 문서 파싱  Gemini API (PDF/DOCX)
● Gemini API  연결됨
✓ 모든 서비스 정상
```

---

## 매일 사용할 때

### 아침에 할 일

```
Docker Desktop 시작 (자동 시작 설정 시 불필요)
  → Supabase 자동 시작
  → npm run dev
  → http://localhost:3000 접속
  → 끝
```

### Gemini API 할당량 리셋

매일 17:00 KST (midnight Pacific Time). 별도 조작 불필요.

---

## 문제 해결

### Docker 관련

| 증상 | 해결 |
|------|------|
| `docker ps`에 아무것도 안 보임 | Docker Desktop 실행 확인 |
| Supabase 컨테이너 안 뜸 | `npx supabase start` 재실행 |
| 포트 충돌 | `docker ps`로 충돌 확인 후 해당 컨테이너 정지 |

### Supabase 관련

| 증상 | 해결 |
|------|------|
| "relation does not exist" | SQL Editor에서 스키마 SQL 재실행 |
| Studio 접속 안 됨 | `npx supabase status`로 URL 확인 |
| DB 초기화하고 싶음 | `npx supabase db reset` |

### Gemini 관련

| 증상 | 해결 |
|------|------|
| 401 에러 | API 키 확인/재생성 |
| 429 에러 | 할당량 소진, 17:00 KST 이후 리셋 |
| 앱 설정 탭에서 저장 안 됨 | `.env.local`에 직접 입력 |

---

## 데이터 저장 위치

| 데이터 | 위치 | 백업 방법 |
|--------|------|----------|
| DB (계약서, 분석 결과) | Docker 볼륨 (로컬) | `npx supabase db dump > backup.sql` |
| 업로드된 파일 | Supabase Storage (Docker 볼륨) | 볼륨 백업 |
| Gemini API Key | 로컬 DB 또는 `.env.local` | 파일 백업 |

> ⚠️ `npx supabase stop`은 데이터를 유지합니다.
> `npx supabase stop --no-backup`은 데이터를 삭제합니다. 주의하세요.

---

## 무료 한도 요약

| 구성 요소 | 한도 | 의미 |
|-----------|------|------|
| Supabase 로컬 | 무제한 (내 PC 디스크) | 계약서 무제한 저장 |
| Gemini 3.1 Flash Lite | 500회/일 | PDF 파싱·분석 포함, 계약서 ~5건/일 |
| Gemma 27B/12B | 14,400회/일 | 전처리 무제한급 |
| Gemini Embedding | 1,000회/일 | 벡터 생성 충분 |

**총 비용: 0원. 외부 서버 없음. 모든 데이터 로컬 저장.**
