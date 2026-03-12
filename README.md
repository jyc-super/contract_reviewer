# Contract Risk Review

PDF/DOCX 건설·EPC 계약서를 업로드하면 조항 단위로 파싱하고, 리스크 분석과 FIDIC 비교 편차를 제공하는 웹앱입니다.

## 프로젝트 결과 확인 방법 (실제 앱 실행)

이 프로젝트는 **Next.js 앱**입니다. **index.html을 Live Server로 열면 동작하지 않습니다.**

- **실제 앱을 보려면** 터미널에서 다음을 실행한 뒤 브라우저로 **http://localhost:3000** 을 엽니다.
  ```bash
  cd "d:\coding\contract risk"
  npm run dev
  ```
  **또는** 터미널 입력 없이 **프로젝트 폴더에서 `run.bat`을 더블클릭**하면 서버가 자동으로 뜨고 브라우저가 열립니다. (자세한 방안: [docs/INDEX_HTML_RUN_OPTIONS.md](docs/INDEX_HTML_RUN_OPTIONS.md))
- 루트의 **index.html**은 **정적 목업(프로토타입)** 용이며, 업로드·API·DB 등은 Next 서버(`npm run dev`)에서만 동작합니다.
- Live Server로 index.html을 열 때 **ERR_CONNECTION_TIMED_OUT** 이 나오면: Live Server가 사용하는 포트(보통 5500)가 방화벽/다른 프로그램에 막혀 있거나, 서버가 시작되지 않은 경우입니다. **해결**: 위처럼 `npm run dev`로 Next 앱을 띄우고 **http://localhost:3000** 으로 접속하세요.

## 주요 기능

- 계약서 업로드 (PDF/DOCX, 50MB 이하, magic bytes 검증)
- 전처리 파이프라인: 검증 → PDF는 Gemini API 직접 파싱, DOCX는 mammoth 텍스트 추출 → 구역 분류 → 조항 분할 → 품질 검사
- 불확실 구역 사용자 확정 (include/exclude) 후 조항 파싱
- 조항별 리스크 분석 + FIDIC 비교 (Gemini Flash 1회 호출, 쿼터 소진 시 일부 저장)
- 대시보드(계약 목록·통계·쿼터), 계약 상세(조항 목록·분석 패널), 구역 검토 페이지

## 요구 사항

- Node.js 18+
- npm 또는 yarn

## 설치 및 실행

```bash
npm install
cp .env.example .env   # 필요 시 .env 생성 후 변수 설정
npm run dev
```

브라우저에서 **http://localhost:3000** 접속.

### localhost 연결할 수 없음 (ERR_CONNECTION_TIMED_OUT)

`npm run dev` 후 브라우저에서 **localhost 응답하는 데 시간이 너무 오래 걸립니다** / **ERR_CONNECTION_TIMED_OUT** 이 나오면 아래를 순서대로 확인하세요.

1. **터미널에 서버가 떴는지 확인**  
   `npm run dev` 실행 후 터미널에 `▲ Next.js 14.x.x` 와 **`- Local: http://localhost:3000`** (또는 비슷한 문구)가 보여야 합니다. 에러 메시지가 있으면 그 내용을 확인하세요.

2. **주소 입력 방식**  
   주소창에 **`http://localhost:3000`** 또는 **`http://127.0.0.1:3000`** 을 **그대로** 입력해 보세요. `https`나 포트 없이 `localhost`만 쓰면 연결되지 않을 수 있습니다.

3. **다른 포트로 시도**  
   포트 3000이 이미 쓰이고 있으면 Next가 3001 등으로 안내할 수 있습니다. 터미널에 출력된 **실제 URL**(예: `http://localhost:3001`)로 접속하세요.

4. **모든 네트워크에 바인딩 후 접속**  
   개발 서버가 **모든 인터페이스(0.0.0.0)**에서 리스닝하도록 이미 설정되어 있습니다 (`npm run dev` = `next dev -H 0.0.0.0 -p 3000`). 그래서 **http://localhost:3000** 또는 **http://127.0.0.1:3000** 으로 접속해 보세요. (다른 프로젝트에서 HTTP 접속이 잘 되던 환경과 동일한 방식입니다.)

5. **방화벽/백신**  
   Windows 방화벽 또는 백신에서 Node.js(또는 `node.exe`)가 **개인/공용 네트워크** 접속을 허용하는지 확인하고, 필요하면 예외로 추가해 보세요.  
   **해결**: PowerShell(관리자)에서  
   `netsh advfirewall firewall add rule name="Node.js" dir=in action=allow program="C:\Program Files\nodejs\node.exe" enable=yes`  
   또는 Windows 설정 → 방화벽 → 앱 허용 → Node.js 개인/공용 체크.

6. **타임아웃이 나는 경우 (자동 테스트/스크립트)**  
   터미널에 **Ready**가 보이는데 브라우저나 스크립트에서만 연결 타임아웃이 난다면 **Windows 환경 이슈**(방화벽 또는 Cursor 샌드박스)일 수 있습니다.  
   - **우선**: 브라우저에서 **http://localhost:3000** 직접 접속.  
   - **그래도 안 되면**: [docs/TEST_RUNNER_REPORT_TIMEOUT.md](docs/TEST_RUNNER_REPORT_TIMEOUT.md)의 **즉시 실행할 체크리스트**(netstat, curl, 방화벽 임시 해제로 원인 확인) 및 **1·2·3순위 해결법**을 순서대로 진행하세요.

7. **localhost는 열리는데 페이지가 계속 로딩만 될 때 (무한 스피너)**  
   서버는 떴는데 브라우저에서 **로딩만 돌고 화면이 안 나올 때**는 아래를 순서대로 시도하세요.  
   - **127.0.0.1로 접속**: 주소창에 **http://127.0.0.1:3000** 을 입력해 보세요. `localhost`가 IPv6(::1)로 연결되면서 응답이 느리거나 끊기는 경우가 있습니다.  
   - **중복 프로세스 정리**: 포트 3000을 두 개 이상의 프로세스가 쓰면 응답이 꼬일 수 있습니다.  
     - 터미널에서 `netstat -ano | findstr ":3000"` 으로 PID 확인 후, **개발 서버 터미널만 남기고** 나머지 Node 프로세스는 작업 관리자에서 종료하거나  
     - `run.bat`/`npm run dev`를 모두 **닫은 뒤** 한 번만 다시 실행하세요.  
   - **방화벽 한 번 더**: run.bat을 **우클릭 → 관리자 권한으로 실행**해서 Node.js 방화벽 규칙이 추가되도록 한 뒤, 브라우저에서 다시 **http://127.0.0.1:3000** 접속.  
   - **캐시 초기화 후 재시작**: 위로도 해결되지 않으면 `.next` 폴더를 삭제한 뒤 `npm run dev`(또는 run.bat)로 다시 기동해 보세요.

## 환경 변수 및 DB

- **환경 변수**: [docs/ENV_AND_MIGRATIONS.md](docs/ENV_AND_MIGRATIONS.md) 참고  
  - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`  
  - Gemini: `GEMINI_API_KEY` (조항 분석·PDF 파싱)
- **마이그레이션**: Supabase SQL Editor에서 `supabase/migrations/001_init_core_tables.sql` → `002_rls_policies.sql` 순서 실행

## 스펙

- 상세 스펙 및 비과금 원칙: [master.md](master.md)
