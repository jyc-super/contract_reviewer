# run.bat 기준 전체 프로젝트 테스트 결과

**실행 일시**: 2026-03-05  
**범위**: run.bat 전제 조건 확인 → 단위 테스트 → 린트 → 프로덕션 빌드

---

## 1. run.bat 전제 조건

| 항목 | 결과 |
|------|------|
| 프로젝트 디렉터리 | `d:\coding\contract risk` |
| Node/npm | 사용 가능 (PATH 인식) |
| 의존성 | `node_modules\next` 존재 시 `npm install` 생략 |

---

## 2. 단위 테스트 (Vitest)

```bash
npm run test
```

| 항목 | 결과 |
|------|------|
| **상태** | ✅ 통과 |
| **파일** | `lib/quota-manager.test.ts` (3 tests) |
| **소요** | 약 21초 |

---

## 3. 린트 (Next.js ESLint)

```bash
npm run lint
```

| 항목 | 결과 |
|------|------|
| **상태** | ⚠️ 대화형 설정 프롬프트 출력 (ESLint 미설정) |
| **비고** | 코드 오류가 아니라 Next.js 기본 ESLint 설정 선택 단계에서 종료. 설정 후 재실행 필요. |

---

## 4. 프로덕션 빌드 (Next.js)

```bash
npm run build
```

### 4.1 1차 실패 — 모듈 경로 오류 (수정 완료)

- **원인**: `app/api/contracts/[id]/zones/` 및 `app/contracts/[id]/zones/` 가 한 단계 더 깊은 폴더인데, 상대 경로가 그에 맞지 않음.
- **수정**:
  - `app/api/contracts/[id]/zones/route.ts`: `../../../../lib` → `../../../../../lib` (supabase/admin, auth/server)
  - `app/contracts/[id]/zones/page.tsx`: `../../../lib` → `../../../../lib`, `../../../components` → `../../../../components`
- **결과**: 해당 Module not found 오류 해소.

### 4.2 2차 실패 — Windows ESM/경로 이슈 (환경) — **해결됨**

- **증상**: `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'` (PostCSS/globals.css 로딩 시).
- **원인**: Windows 절대 경로(`D:\...`)가 ESM 로더에서 file URL로 처리되지 않는 환경 이슈. Next.js 14.2.0 대에서 발생.
- **해결**: Next.js를 **14.2.4**로 업그레이드. (해당 버그는 14.2.4+에서 수정됨.)  
  추가로 빌드 통과를 위해 다음 수정 적용:
  - `lib/embedding.ts`: Gemini `embedContent` 호출 시 `content`에 `role: "user"` 추가.
  - `types/pdf-parse.d.ts`: pdf-parse 모듈 타입 선언 추가.
  - `lib/utils/language.ts`: franc 동적 import 타입 처리 (`default` 유무 모두 대응).
- **결과**: `npm run build` 정상 완료.

---

## 5. 요약

| 단계 | 결과 | 비고 |
|------|------|------|
| run.bat 전제 | ✅ | node, 의존성 확인 가능 |
| `npm run test` | ✅ 통과 | 3 tests |
| `npm run lint` | ⚠️ | ESLint 설정 후 재실행 권장 |
| `npm run build` | ✅ 통과 | Next.js 14.2.4 업그레이드 및 타입 수정 반영 |

**코드 수정 사항**: zones 관련 상대 경로 수정, Next.js 14.2.4로 업그레이드(Windows ESM 경로 이슈 해결), embedding/language/pdf-parse 타입·선언 보완.  
**권장**: 개발 서버는 `run.bat` 실행 후 브라우저에서 **http://127.0.0.1:3000** 접속으로 확인.
