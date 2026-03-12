# Supabase Cloud 연결 정보 UI 입력 기능 명세

> 설정 화면에서 Supabase URL과 Service Role Key를 입력·저장할 수 있도록 하는 작업 명세입니다.
> Gemini API Key와 동일한 패턴으로, 환경변수 대신 UI에서 값을 받아 암호화 저장합니다.

---

## 목표

- 사용자가 `.env` 없이 설정(⚙️) 페이지에서 **Supabase Cloud** 연결 정보를 입력하고 저장할 수 있게 한다.
- 저장된 값은 **암호화**되어 로컬 파일에 보관되며, 앱은 env 우선·없으면 해당 파일에서 읽어 Supabase 클라이언트를 생성한다.

---

## 원칙

- **저장 위치**: Supabase 연결 정보는 DB에 저장할 수 없으므로(연결 전) **로컬 파일만** 사용한다. (`data/supabase-config.enc`)
- **암호화**: Gemini API Key와 동일하게 `ENCRYPTION_KEY`(또는 개발용 키)로 AES-256-GCM 암호화 후 저장한다.
- **우선순위**: 런타임에 `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`가 env에 있으면 env 사용, 없으면 UI로 저장한 파일 값을 사용한다.
- **UI/UX**: Gemini API Key 설정과 같은 스타일(입력란, 저장, "설정됨" 표시, "다시 입력" 버튼).

---

## 1. 백엔드: Supabase 설정 저장소

### 1-1. 새 파일 `lib/supabase-config-store.ts`

- **getSupabaseConfig()** (동기)
  - `process.env.NEXT_PUBLIC_SUPABASE_URL`와 `process.env.SUPABASE_SERVICE_ROLE_KEY`가 모두 있으면 `{ url, serviceRoleKey }` 반환.
  - 없으면 `data/supabase-config.enc` 파일이 있는지 확인하고, 있으면 읽어 복호화 후 JSON 파싱해 `{ url, serviceRoleKey }` 반환.
  - 둘 다 없으면 `null` 반환.
- **setSupabaseConfig({ url: string, serviceRoleKey: string })** (동기)
  - `url`, `serviceRoleKey` trim 후 빈 값이면 에러.
  - `lib/gemini-key-store.ts`와 동일한 암호화 방식(또는 공통 암호화 유틸)으로 `JSON.stringify({ url, serviceRoleKey })`를 암호화해 `data/supabase-config.enc`에 저장.
  - `data` 디렉터리가 없으면 생성 후 저장.
- **isSupabaseConfigConfigured()** (동기)
  - env에 두 값이 있으면 `true`.
  - 없으면 `data/supabase-config.enc` 존재 여부로 반환 (복호화 성공 여부까지 검사해도 됨).

암호화 키는 기존 `gemini-key-store`의 `getEncryptionKey` / `encrypt`·`decrypt` 로직을 재사용하거나, 공통 유틸로 분리해 두면 됨.

---

## 2. Supabase Admin 클라이언트 연동

### 2-1. 수정 `lib/supabase/admin.ts`

- 파일 상단에서 `process.env.NEXT_PUBLIC_SUPABASE_URL`와 `process.env.SUPABASE_SERVICE_ROLE_KEY`를 직접 읽지 않는다.
- **createAdminSupabaseClient()** / **getAdminSupabaseClientIfAvailable()** 내부에서:
  - `getSupabaseConfig()`를 호출해 `{ url, serviceRoleKey }` 또는 `null`을 받는다.
  - `null`이면 `getAdminSupabaseClientIfAvailable()`는 `null` 반환, `createAdminSupabaseClient()`는 기존처럼 에러 throw.
  - 값이 있으면 `createClient(url, serviceRoleKey, { auth: { persistSession: false } })`로 클라이언트 생성해 반환.

기존 동작(env만 사용)과의 호환을 위해, env가 있으면 계속 env를 쓰고, env가 없을 때만 파일을 사용하도록 `getSupabaseConfig()`에서 env 우선 처리하면 된다.

---

## 3. API 라우트

### 3-1. 새 파일 `app/api/settings/supabase-config/route.ts`

- **GET**
  - `isSupabaseConfigConfigured()` 결과를 사용해 `{ configured: boolean }`만 반환.
  - URL/키는 응답에 포함하지 않는다.
- **POST**
  - body: `{ url?: string, serviceRoleKey?: string }`.
  - `url`, `serviceRoleKey`가 없거나 trim 후 빈 문자열이면 400 에러.
  - (선택) 해당 url·키로 Supabase 클라이언트를 만들어 `from('contracts').select('id').limit(1)` 등으로 연결 테스트 후, 성공 시에만 저장.
  - `setSupabaseConfig({ url: url.trim(), serviceRoleKey: serviceRoleKey.trim() })` 호출.
  - 저장 성공 시 200 + `{ ok: true }` 또는 메시지 반환.
  - 암호화 키 없음 등으로 저장 실패 시 503/500 및 적절한 에러 메시지 반환 (Gemini 키 API와 유사한 메시지 스타일).

---

## 4. UI 컴포넌트

### 4-1. 새 파일 `components/dashboard/SupabaseConfigSetup.tsx`

- **역할**: 설정 페이지에서 Supabase Cloud URL과 Service Role Key를 입력하고 저장하는 폼.
- **동작**:
  - 마운트 시 `GET /api/settings/supabase-config`로 `configured` 여부 조회.
  - `configured === true`이면 "Supabase 연결 정보가 설정되어 있습니다." + "다시 입력" 버튼 표시. (키는 표시하지 않음.)
  - "다시 입력" 클릭 시 또는 처음부터 미설정이면 입력 폼 표시:
    - **Supabase URL**: `<input type="url">` 또는 `text`, placeholder 예: `https://xxxxx.supabase.co`
    - **Service Role Key**: `<input type="password">`, placeholder 예: `eyJhbGci...` (키 형식 안내)
  - "저장" 버튼 클릭 시 `POST /api/settings/supabase-config`에 `{ url, serviceRoleKey }` 전송.
  - 성공 시 `configured` 상태로 전환하고 폼 숨김. 실패 시 API 에러 메시지를 폼 위/아래에 표시.
- **스타일**: `GeminiKeySetup.tsx`와 동일한 카드/버튼/에러 문구 스타일을 사용해 일관성 유지.
- (선택) 저장 후 설정 페이지 상단 "로컬 서비스 상태"나 상태 요약에서 Supabase가 "연결됨"으로 갱신되도록, 필요 시 부모에서 상태 새로고침 유도.

---

## 5. 설정 페이지 통합

### 5-1. 수정 `app/settings/page.tsx`

- "Gemini API Key" 섹션 위쪽 또는 아래쪽에 **"Supabase Cloud 연결"** 섹션을 추가한다.
- 해당 섹션에 `<SupabaseConfigSetup />`를 렌더링한다.
- 기존 "로컬 서비스 상태"에서 Supabase 상태는 이미 `/api/settings/status`를 사용하므로, `getAdminSupabaseClientIfAvailable()`가 이제 파일에서 읽은 설정도 사용하므로 별도 수정 없이 "연결됨"이 표시될 수 있도록 백엔드만 구현하면 된다.

---

## 6. 확인 사항

- env에 `NEXT_PUBLIC_SUPABASE_URL`와 `SUPABASE_SERVICE_ROLE_KEY`가 있으면 기존과 동일하게 env 우선 사용.
- env가 없고 UI에서만 저장한 경우, `data/supabase-config.enc`만으로 Admin 클라이언트가 생성되고, 설정 탭에서 Supabase "연결됨"으로 표시되는지 확인.
- Service Role Key는 UI/API 응답/로그에 노출되지 않도록 처리되어 있는지 확인.
- `ENCRYPTION_KEY`가 없을 때 동작은 Gemini 키 저장과 동일한 정책(개발용 키 허용 여부, production 에러 메시지)으로 처리.

---

## 7. 문서 갱신 (선택)

- `docs/SETUP-GUIDE.md` 또는 `docs/ENV_AND_MIGRATIONS.md`에 "Supabase Cloud 연결 정보는 설정(⚙️) 페이지에서 URL과 Service Role Key를 입력해 저장할 수 있으며, 값은 암호화되어 로컬 파일에 보관됩니다." 문구를 추가할 수 있다.
- `.env.example`에는 기존처럼 `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 예시를 유지하되, "또는 설정 화면에서 입력" 주석을 추가할 수 있다.
