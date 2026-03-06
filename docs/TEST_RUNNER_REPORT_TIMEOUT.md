# test-runner → project-manager 보고: run.bat 테스트 및 타임아웃 문제

**보고일**: 2026-03-05  
**작성**: test-runner  
**수신**: project-manager (해결 방안 검토 요청)

---

## 1. 테스트 실행 요약

| 단계 | 실행 내용 | 결과 |
|------|-----------|------|
| 1 | run.bat과 동일한 흐름으로 `npm run dev` 실행 (`next dev -H 0.0.0.0 -p 3000`) | ✅ 성공 |
| 2 | 서버 기동 로그 확인 | ✅ `Next.js 14.2.0`, `Local: http://localhost:3000`, `Network: http://0.0.0.0:3000`, **Ready in 8.8s** |
| 3 | HTTP 접속 확인 (`Invoke-WebRequest`로 `http://127.0.0.1:3000`, `http://localhost:3000` 각 5초 타임아웃) | ❌ **타임아웃** (작업 시간이 초과되었습니다) |

---

## 2. 문제 성격

- **이 문제는 프로젝트 아키텍처 문제가 아니라 Windows 로컬 환경에서 Next.js 개발 서버 접속이 안 되는 환경 이슈입니다.**
- 서버는 정상 기동되었는데(Ready in 8.8s) 브라우저/HTTP 요청이 타임아웃되는 상황입니다.
- 보고서의 테스트는 **Cursor 에이전트가 PowerShell에서 Invoke-WebRequest로 수행**한 것이며, **실제 브라우저 접속은 아직 시도하지 않은 상태**입니다.

---

## 3. 가능성 높은 원인과 순서대로 해결법

### 1순위: Windows 방화벽 (가장 흔한 원인)

Next.js를 처음 `npm run dev`로 실행하면 Windows가 **"이 앱의 네트워크 액세스를 허용하시겠습니까?"** 팝업을 띄웁니다. Cursor 터미널에서 실행하면 이 팝업이 뒤에 숨거나 자동 차단될 수 있습니다.

**확인 방법** (PowerShell 관리자 권한):

```powershell
netsh advfirewall firewall show rule name=all dir=in | findstr "node"
```

**해결** (PowerShell 관리자 권한):

```powershell
netsh advfirewall firewall add rule name="Node.js" dir=in action=allow program="C:\Program Files\nodejs\node.exe" enable=yes
```

또는 **Windows 설정 → 방화벽 → 앱 허용**에서 `node.exe`를 찾아 **개인/공용** 둘 다 체크.

### 2순위: IPv6/IPv4 충돌

`-H 0.0.0.0`으로 바인딩하면 IPv4에서만 리스닝하는데, `localhost`가 IPv6(::1)로 해석되면 연결이 안 될 수 있습니다.

**확인**:

```powershell
# hosts 파일 확인 (localhost가 127.0.0.1로 매핑되어 있는지)
type C:\Windows\System32\drivers\etc\hosts

# 포트 리스닝 확인
netstat -ano | findstr ":3000"
```

`netstat`에서 **0.0.0.0:3000 LISTENING**이 보이면 서버는 정상입니다. 이 상태에서 `http://127.0.0.1:3000`이 안 되면 방화벽이 원인일 가능성이 높습니다.

### 3순위: Cursor 에이전트 샌드박스 제한

Cursor 터미널 에이전트가 네트워크 요청을 샌드박스 안에서 실행하는 경우, 로컬 서버 접속이 막힐 수 있습니다. **Cursor 자체의 제한**이므로, **직접 브라우저에서 http://localhost:3000을 여는 것**이 정답입니다.

---

## 4. 즉시 실행할 체크리스트

```powershell
# 1. 서버가 실제로 리스닝 중인지 확인
netstat -ano | findstr ":3000"
# → "0.0.0.0:3000 LISTENING" 이 보이면 서버 정상

# 2. curl로 테스트 (Invoke-WebRequest 대신, Windows 10+ 내장)
curl http://127.0.0.1:3000

# 3. 그래도 안 되면 방화벽 임시 비활성화로 원인 확인 (테스트 후 반드시 다시 활성화)
netsh advfirewall set allprofiles state off
curl http://127.0.0.1:3000
netsh advfirewall set allprofiles state on
```

**3번에서 접속이 되면** → 방화벽이 원인. 위의 `node.exe` 허용 규칙을 추가하면 됩니다.

---

## 4-2. 페이지가 계속 로딩만 될 때 (무한 스피너)

서버는 떠 있고(`netstat`에 `LISTENING`), 브라우저에서 **localhost:3000**을 열면 탭이 계속 돌기만 하고 화면이 안 나오는 경우:

1. **http://127.0.0.1:3000 으로 접속**  
   `localhost`가 IPv6(::1)로 해석되면서 응답이 느리거나 끊길 수 있습니다. 주소창에 **127.0.0.1**을 직접 입력해 보세요.

2. **포트 3000을 쓰는 프로세스가 여러 개인지 확인**  
   `netstat -ano | findstr ":3000"` 에서 **LISTENING**인 행이 두 개 이상이면, 개발 서버를 **한 번만** 띄우고 나머지 Node 프로세스는 종료한 뒤 다시 접속하세요.  
   (예: 터미널에서 run.bat/npm run dev 창을 모두 닫고, 한 개만 다시 실행)

3. **방화벽 규칙 확인**  
   run.bat을 **관리자 권한으로 한 번 실행**해 Node.js 방화벽 규칙이 추가되도록 한 뒤, 브라우저에서 **http://127.0.0.1:3000** 다시 시도.

4. **캐시 초기화**  
   프로젝트 폴더에서 `.next` 폴더를 삭제한 뒤 `npm run dev`(또는 run.bat)로 서버를 다시 기동하고, **http://127.0.0.1:3000** 으로 접속.

---

## 5. 결론

- **서버 자체는 정상**이며, 접속 문제는 **Windows 방화벽** 또는 **Cursor 에이전트의 네트워크 제한**일 가능성이 높습니다.
- **우선 브라우저에서 직접 http://localhost:3000 을 열어보세요.** Cursor에서만 타임아웃이 나고 브라우저에서는 열리는 경우가 많습니다.
- 브라우저에서도 안 되면 위의 **방화벽 체크리스트**를 순서대로 진행하세요.
- **프로젝트 코드나 설정 문제가 아니라 OS 환경 문제**이므로, 한 번 해결하면 이후에는 재발하지 않습니다.

---

## 6. project-manager 조치 사항 (문서 반영)

- **README.md**: localhost 타임아웃 시 권장 검증 절차 및 본 보고서 링크 추가.
- **검증 방법**: 자동 HTTP가 타임아웃되는 환경에서는 "run.bat 실행 → Ready 확인 → 브라우저에서 http://localhost:3000 접속"을 공식 검증 절차로 명시.
- **방화벽 예외**: GUI(Windows 설정 → 앱 허용 → Node.js 개인/공용 체크) 또는 PowerShell 관리자: `netsh advfirewall firewall add rule name="Node.js" dir=in action=allow program="C:\Program Files\nodejs\node.exe" enable=yes`
- **RUN_BAT_VERIFICATION.md**: 권장 검증 절차 및 본 보고서 링크 추가.
