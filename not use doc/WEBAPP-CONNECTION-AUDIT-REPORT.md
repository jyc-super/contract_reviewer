# Webapp Connection Audit Report — Contract Risk Review

**Project**: `d:\coding\contract risk`  
**Audit date**: 2025-03-04  
**Remediation applied**: 2025-03-04 (per Section 5 — .env.example, Supabase client comments, SETUP-GUIDE 배포 체크리스트 및 빌드 안내)

**Scope**: Frontend ↔ API, Supabase, Docling, Gemini, env vars, build/test runtime

---

## 1) Connection Map

| Source | Destination | Mechanism / library | Required env / config | Status |
|--------|-------------|---------------------|----------------------|--------|
| App (SSR) | Supabase Admin | `lib/supabase/admin.ts` → `createClient(url, service_role)` | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **Unverified** (no DB at build time) |
| App (SSR) | Supabase Server client | `lib/supabase/server.ts` → `createServerClient` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Unused** (not imported anywhere) |
| Browser | Supabase Browser client | `lib/supabase/client.ts` → `createClient` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Unused** (not imported anywhere) |
| API routes | Supabase Admin | `getAdminSupabaseClientIfAvailable()` | Same as above | **Unverified** |
| API `/api/settings/status` | Docling | `fetch(DOCLING_SERVICE_URL)` GET, 5s timeout | `DOCLING_SERVICE_URL` | **Unverified** (optional; missing → "미설정") |
| API / pipeline | Docling | `lib/document-parser.ts` → `fetch(.../parse)` POST, 300s timeout | `DOCLING_SERVICE_URL` | **Unverified** (optional; fallback to pdf-parse/mammoth) |
| API / analyze | Gemini | `@google/generative-ai` + key from `getStoredGeminiKey()` | `GEMINI_API_KEY` or stored key (DB/file) + `ENCRYPTION_KEY` for storage | **Unverified** (key from UI or env) |
| Settings page | `/api/settings/status` | `fetch("/api/settings/status")` | — | **Verified** (relative URL, same origin) |
| Settings page | `/api/quota` | `fetch("/api/quota")` | — | **Verified** (relative URL) |
| Upload page | `/api/contracts` | `fetch("/api/contracts", { method: "POST", body })` | — | **Verified** (relative URL) |
| Upload page | `/api/contracts/[id]/status` | `fetch(\`/api/contracts/${id}/status\`)` | — | **Verified** (relative URL) |
| Error boundary | `/api/log` | `fetch("/api/log", { method: "POST", body })` | — | **Verified** (relative URL) |
| Auth (API) | Supabase Auth | `getUserIdFromRequest` → `supabase.auth.getUser(token)` | Same as Admin client | **Unverified** (Bearer optional; placeholder UUID if missing) |
| Gemini key storage | Supabase `app_settings` or file | `lib/gemini-key-store.ts` → `.from("app_settings")` or `data/gemini-key.enc` | Admin env for DB; `ENCRYPTION_KEY` for encrypt (optional in dev) | **Unverified** (graceful fallback to file) |

---

## 2) Confirmed Failures

### 2.1 Build: PageNotFoundError for `/_document`

- **Severity**: **High** (production build 불가)
- **Symptom**: `next build` 시 `Cannot find module for page: /_document` 발생 후 종료
- **Evidence**: 빌드 로그  
  `unhandledRejection Error [PageNotFoundError]: Cannot find module for page: /_document` (at `require.js`, `load-components.js`)
- **Affected**: `next build` (배포/CI)
- **Root cause**: 프로젝트는 **App Router 전용**(`app/`만 사용)인데, 이전 빌드 캐시(`.next/server/pages/`)에 Pages Router용 `_document` 참조가 남아 있어, Next가 `pages/_document`를 로드하려다 소스에 없어 실패한 것으로 추정
- **Fix**:  
  1) `rm -rf .next` (또는 Windows: `Remove-Item -Recurse -Force .next`) 후 `npm run build` 재실행  
  2) 소스에 `pages/` 디렉터리가 있다면 제거하거나, App Router만 사용할 경우 `next.config` 등에서 Pages 비활성화 검토

### 2.2 .env.example vs Docling port

- **Severity**: **Low** (문서/설정 불일치)
- **Symptom**: Docling URL 예시 포트가 가이드와 다름
- **Evidence**:  
  - `.env.example`: `# DOCLING_SERVICE_URL=http://localhost:8080`  
  - `docs/SETUP-GUIDE.md` 및 `run.bat`: Docling 포트 **5001** (`-p 5001:5001`)
- **Affected files**: `.env.example`
- **Root cause**: 예시 포트를 8080으로 적어두어, 실제 사용(5001)과 drift 발생
- **Fix**: `.env.example`을 `DOCLING_SERVICE_URL=http://localhost:5001` 로 수정

---

## 3) Likely Risks and Weak Links

### 3.1 NEXT_PUBLIC_SUPABASE_ANON_KEY not in .env.example

- **Severity**: **Medium** (Supabase 브라우저/서버 클라이언트 사용 시)
- **Why it may fail**: `lib/supabase/server.ts`와 `lib/supabase/client.ts`는 `NEXT_PUBLIC_SUPABASE_ANON_KEY`를 사용하는데, 현재 앱에서는 **어디에서도 import되지 않음**. 나중에 Auth UI나 브라우저용 Supabase를 켜면, `.env.example`에 없어 개발자가 변수를 빠뜨리고 런타임 에러 가능
- **Evidence**:  
  - `lib/supabase/client.ts`: `SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!`  
  - `lib/supabase/server.ts`: 동일  
  - `.env.example`: `NEXT_PUBLIC_SUPABASE_ANON_KEY` 없음
- **What to verify**: Auth/브라우저 Supabase 사용 계획이 있으면 `.env.example`과 로컬 env에 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 추가; 없으면 해당 클라이언트 파일 제거 또는 “미사용” 주석으로 명시

### 3.2 createServerSupabaseClient / createBrowserSupabaseClient 미사용

- **Severity**: **Low** (데드 코드 / 혼란)
- **Why it may fail**: 두 함수는 정의만 되어 있고 호출처가 없음. 향후 사용 시 `ANON_KEY` 필수인데 문서에 없으면 설정 누락 가능
- **Evidence**: `createServerSupabaseClient`, `createBrowserSupabaseClient` 검색 시 정의 파일만 나옴
- **What to verify**: Auth 또는 브라우저 Supabase 사용 시 `.env.example` 및 SETUP-GUIDE에 anon key 명시; 미사용이면 제거하거나 “reserved for future auth” 등으로 표시

### 3.3 ENCRYPTION_KEY in production

- **Severity**: **High** (배포 시)
- **Why it may fail**: `lib/gemini-key-store.ts`: `NODE_ENV === "production"`이면 `ENCRYPTION_KEY`가 32자 미만이면 throw. 배포 시 `.env`에 `ENCRYPTION_KEY`를 넣지 않거나 짧게 넣으면 앱이 기동 실패
- **Evidence**:  
  - `getEncryptionKey()`: `if (process.env.NODE_ENV === "production") { throw new Error("ENCRYPTION_KEY가 설정되어 있지 않거나 32자 이상이어야 합니다."); }`  
  - `.env.example`: `ENCRYPTION_KEY` 주석 처리됨
- **What to verify**: 배포 체크리스트에 “production에서는 `ENCRYPTION_KEY` 32자 이상 필수” 명시; 배포 전에 해당 env 검증 스크립트 또는 앱 부트 시 검사 권장

### 3.4 Docling URL without trailing slash

- **Severity**: **Low**
- **Why it may fail**: `document-parser.ts`와 `api/settings/status/route.ts`는 `replace(/\/$/, "")`로 끝 슬래시 제거 후 사용. 잘못된 URL 형식이 들어오면 이슈 가능성은 낮지만, 문서에 “trailing slash 없이 설정” 권장 명시 시 안전
- **Evidence**: `DOCLING_SERVICE_URL.replace(/\/$/, "")` 사용
- **What to verify**: SETUP-GUIDE에 `http://localhost:5001` (끝에 `/` 없음) 예시 유지

### 3.5 Supabase local URL vs .env.example

- **Severity**: **Low**
- **Why it may fail**: `.env.example`은 `https://your-project.supabase.co` 형태. 로컬은 `http://localhost:54321` (SETUP-GUIDE). 새 개발자가 example만 복사하면 로컬 Supabase에 연결되지 않음
- **Evidence**: SETUP-GUIDE 1-1에서 로컬 API URL `http://localhost:54321` 명시
- **What to verify**: `.env.example`에 주석으로 “로컬: http://localhost:54321 (npx supabase start 후 .env.local 참고)” 추가 권장

---

## 4) Environment Variable Audit

### 4.1 Declared in .env.example vs used in code

| Variable | In .env.example | Used in code | Notes |
|----------|-----------------|--------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ `lib/supabase/admin.ts`, server.ts, client.ts | OK |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ admin.ts, auth/server | OK |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ❌ | ✅ server.ts, client.ts (현재 미사용) | **Drift**: 사용처는 있으나 example에 없음 |
| `GEMINI_API_KEY` | ✅ | ✅ gemini-key-store.ts | OK |
| `ENCRYPTION_KEY` | ⚠️ 주석 | ✅ gemini-key-store.ts (배포 시 필수) | Optional 로컬, 필수 배포 |
| `DOCLING_SERVICE_URL` | ⚠️ 주석, 포트 8080 | ✅ document-parser.ts, api/settings/status/route.ts | **Drift**: 포트 5001로 통일 권장 |

### 4.2 Server vs client exposure

- **Server-only (적절)**: `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `GEMINI_API_KEY`, `DOCLING_SERVICE_URL` — 모두 서버 코드에서만 사용됨 ✅  
- **Public (의도적)**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — 브라우저에서 Supabase 클라이언트용. 현재 앱은 Admin만 사용하므로 ANON은 미사용 ✅  
- **오류**: 서버 전용 시크릿이 클라이언트 번들에 노출되는 코드 경로 없음 ✅  

### 4.3 Missing / suspicious

- **Missing in example**: `NEXT_PUBLIC_SUPABASE_ANON_KEY` (미사용이지만 선언해 두면 향후 Auth 도입 시 안전)
- **Suspicious**: 없음. 다만 `ENCRYPTION_KEY`가 production에서 없으면 기동 실패하므로, 배포 문서에 명시 필요

---

## 5) Recommended Remediation Order

1. **Build 수복 (필수)**  
   - `.next` 삭제 후 `npm run build` 재실행.  
   - 실패 시 `pages/` 디렉터리 존재 여부 확인 후, App Router만 사용 시 제거 또는 Next 설정 정리.

2. **문서/설정 정리**  
   - `.env.example`: `DOCLING_SERVICE_URL=http://localhost:5001` 로 수정(주석 해제 또는 예시 통일).  
   - 선택: 로컬 Supabase URL 주석 추가, `NEXT_PUBLIC_SUPABASE_ANON_KEY` 예시 추가(향후 Auth용).

3. **배포 전 필수**  
   - Production 환경에 `ENCRYPTION_KEY` 32자 이상 설정.  
   - Supabase(로컬/원격) URL·키 설정 후 `/api/settings/status` 호출해 Supabase/ Docling/Gemini 상태 확인.

4. **선택: 데드 코드 정리**  
   - `createServerSupabaseClient` / `createBrowserSupabaseClient` 를 당분간 쓰지 않을 경우, 제거하거나 “reserved for future auth” 주석 + `.env.example`에 ANON_KEY 설명 추가.

5. **위험 완화**  
   - Docling/Supabase 미설정 시에도 앱은 동작( fallback 파서, DB 없이 진행 가능). 설정 페이지 경고 문구는 이미 있으므로 유지.

---

## 6) Verification Checklist

- [ ] **Build**: `Remove-Item -Recurse -Force .next` (또는 `rm -rf .next`) 후 `npm run build` 성공
- [ ] **Unit tests**: `npm test` (vitest) — 현재 3 tests passed ✅
- [ ] **Env**: `.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 설정 후 앱 기동
- [ ] **Supabase**: `npx supabase start` 후 동일 URL/키로 설정 → 설정 페이지에서 “Supabase 로컬 DB” 정상 표시
- [ ] **Docling**: `DOCLING_SERVICE_URL=http://localhost:5001` 설정 후 Docker Docling 실행 → 설정 페이지 “Docling” 정상
- [ ] **Gemini**: UI에서 API 키 입력 또는 `GEMINI_API_KEY` 설정 → 설정 페이지 “Gemini” 정상
- [ ] **API reachability**: 브라우저 또는 `curl`로 `GET /api/settings/status`, `GET /api/quota` 200 및 JSON 응답 확인
- [ ] **Production**: 배포 시 `ENCRYPTION_KEY` 32자 이상 설정 후 기동 및 키 저장/불러오기 동작 확인

---

## Test-runner summary (runtime)

- **npm test**: ✅ **Passed** — `lib/quota-manager.test.ts` 3 tests, vitest run 성공  
- **npm run build**: ❌ **Failed** — `PageNotFoundError: Cannot find module for page: /_document` (위 2.1과 동일 원인)  
- **API routes**: 소스 기준 상대 경로 `fetch("/api/...")`만 사용 → same-origin, CORS 이슈 없음. 실제 기동 후 `/api/settings/status`, `/api/quota` 호출로 검증 권장.

---

*Report generated by webapp-connection-auditor style audit + test-runner style build/test run.*
