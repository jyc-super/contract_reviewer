# VS Code Remote Tunnels 상세 가이드

원격 PC의 파일에 직접 접속하여 작업하는 방법.
파일 업로드 없이 Microsoft 릴레이 서버(HTTPS)를 통해 연결한다.

---

## 0. 사전 요구사항

### 서버 PC (집 PC)

- **VS Code** 설치 (최신 버전 권장)
- **인터넷 연결** (HTTPS 443 아웃바운드)
- `code` 명령이 터미널에서 실행 가능해야 함

#### `code` 명령이 안 되는 경우

```
VS Code 실행 → Ctrl+Shift+P → "Shell Command: Install 'code' command in PATH" 선택
```

설치 후 터미널을 새로 열고 확인:

```bash
code --version
# 예: 1.96.0 / abc123... / x64
```

### 클라이언트 PC (사내 PC)

- **브라우저만 있으면 됨** (VS Code 설치 불필요)
- 또는 VS Code가 설치되어 있다면 `Remote - Tunnels` 확장 사용 가능
- `*.tunnels.api.visualstudio.com`, `*.devtunnels.ms` 도메인 접근 필요

### 계정

- **Microsoft 계정** 또는 **GitHub 계정** 1개 필요
- 서버/클라이언트 양쪽에서 **동일한 계정**으로 로그인해야 함

---

## 1. 서버 PC 설정 (집 PC)

### Step 1: 터널 생성 및 인증

터미널(PowerShell 또는 CMD)을 열고:

```bash
code tunnel
```

실행하면 다음 과정이 진행된다:

```
*
* Visual Studio Code Server
*
* By using the software, you agree to
* the Visual Studio Code Server License Terms (https://aka.ms/vscode-server-license)
*

? How would you like to log in to Visual Studio Code?
> Microsoft Account
  GitHub Account
```

1. **로그인 방식 선택** — Microsoft 또는 GitHub
2. **디바이스 코드 인증** — 화면에 표시된 코드를 브라우저에서 입력
   ```
   To grant access to the server, please log into
   https://github.com/login/device
   and use code XXXX-XXXX
   ```
3. 브라우저에서 해당 URL 접속 → 코드 입력 → 승인
4. **터널 이름 지정**
   ```
   ? What would you like to call this machine?
   > home-pc
   ```

완료되면 다음과 같은 메시지가 표시된다:

```
Open this link in your browser https://vscode.dev/tunnel/home-pc
```

### Step 2: 터널 상태 확인

터널이 활성화되면 터미널에 연결 로그가 표시된다:

```
[2026-03-13 10:00:00] info Creating tunnel with the name: home-pc
[2026-03-13 10:00:01] info Connected to server
[2026-03-13 10:00:01] info Open this link in your browser https://vscode.dev/tunnel/home-pc
```

이 터미널 창을 **닫지 않아야** 터널이 유지된다.

### Step 3: Windows 서비스로 등록 (권장)

터미널을 계속 열어둘 수 없다면 서비스로 등록한다:

```bash
# 먼저 기존 터널 중지 (실행 중이라면 Ctrl+C)

# 서비스 설치 (관리자 권한 불필요)
code tunnel service install
```

서비스 등록 시에도 인증 과정(디바이스 코드)이 한 번 필요하다.

#### 서비스 등록 후 동작

- PC 부팅 시 자동으로 터널이 시작됨
- Windows 로그인하지 않아도 동작
- VS Code를 열지 않아도 동작
- 백그라운드에서 상시 실행

#### 서비스 관리 명령어

```bash
# 서비스 상태 확인
code tunnel service log

# 서비스 제거
code tunnel service uninstall

# 서비스 재시작 (문제 발생 시)
code tunnel service uninstall
code tunnel service install
```

### `code tunnel` vs `code tunnel service install` 비교

| 항목 | `code tunnel` | `code tunnel service install` |
|---|---|---|
| 실행 방식 | 터미널에서 수동 실행 | Windows 서비스로 자동 실행 |
| PC 재부팅 후 | 다시 실행해야 함 | 자동 시작 |
| 터미널 창 | 열어둬야 함 | 불필요 |
| Windows 로그인 | 필요 | 불필요 |
| 용도 | 일시적 사용, 테스트 | 상시 운영 |
| 제거 | Ctrl+C로 종료 | `code tunnel service uninstall` |

---

## 2. 클라이언트 PC 접속 (사내 PC)

### 방법 1: 브라우저 접속 (VS Code 설치 불필요)

1. 브라우저에서 접속:
   ```
   https://vscode.dev/tunnel/home-pc
   ```
   (또는 https://vscode.dev 접속 후 수동 연결)

2. 서버 PC와 **동일한 계정**으로 로그인

3. 연결되면 브라우저에서 VS Code 전체 기능 사용 가능:
   - 파일 탐색기 (서버 PC의 파일시스템)
   - 편집기
   - 터미널 (서버 PC에서 실행됨)
   - 확장 프로그램
   - Git

### 방법 2: VS Code 앱에서 접속

사내 PC에 VS Code가 설치되어 있다면 더 나은 경험을 제공한다.

1. **확장 설치**
   - `Ctrl+Shift+X` → **"Remote - Tunnels"** 검색 → 설치
   - (확장 ID: `ms-vscode.remote-server`)

2. **터널 연결**
   - `Ctrl+Shift+P` → **"Remote-Tunnels: Connect to Tunnel"** 선택
   - 계정 로그인 (서버와 동일한 계정)
   - 터널 목록에서 `home-pc` 선택

3. **연결 확인**
   - 좌측 하단에 `><` 아이콘과 함께 **"Tunnel: home-pc"** 표시
   - 터미널을 열면 서버 PC의 셸이 실행됨

### 방법 3: VS Code 앱에서 수동 연결

1. 좌측 하단 `><` 아이콘 클릭
2. **"Connect to Tunnel..."** 선택
3. 터널 이름 입력 또는 목록에서 선택

---

## 3. 실제 작업 흐름

### 특정 폴더 열기

연결 후 서버 PC의 원하는 폴더를 열 수 있다:

- `Ctrl+Shift+P` → **"File: Open Folder"** → 경로 입력
  ```
  예: /d/coding/contract risk
  ```

### 터미널 사용

`Ctrl+`` 로 터미널을 열면 **서버 PC의 셸**이 실행된다:

```bash
# 서버 PC에서 실행되는 명령어
npm run dev
git status
python scripts/docling_sidecar.py
```

### 포트 포워딩

서버 PC에서 실행 중인 로컬 서버(예: localhost:3000)에 접근하려면:

1. 터미널에서 서버 실행 (예: `npm run dev`)
2. VS Code가 자동으로 포트 감지 → **"Open in Browser"** 알림 표시
3. 또는 수동으로:
   - `Ctrl+Shift+P` → **"Forward a Port"**
   - 포트 번호 입력 (예: `3000`)
4. 브라우저에서 포워딩된 URL로 접속 가능

#### 포트 포워딩 패널

- `Ctrl+Shift+P` → **"Ports: Focus on Ports View"**
- 현재 포워딩된 포트 목록 확인/추가/제거 가능

### 확장 프로그램

- 서버 PC에 설치된 확장이 자동으로 사용됨
- 클라이언트에서 새 확장을 설치하면 서버 PC에 설치됨
- UI 전용 확장(테마 등)은 클라이언트에만 설치됨

---

## 4. 트러블슈팅

### 터널이 목록에 안 보일 때

```bash
# 서버 PC에서 터널 상태 확인
code tunnel status

# 터널 이름 변경
code tunnel rename new-name

# 기존 터널 삭제 후 재생성
code tunnel unregister
code tunnel
```

### 연결이 안 될 때

1. **서버 PC 확인**
   - PC가 켜져 있는지 확인
   - 인터넷 연결 확인
   - 서비스 모드: `code tunnel service log`로 로그 확인

2. **클라이언트 PC 확인**
   - 동일한 계정으로 로그인했는지 확인
   - 아래 도메인이 차단되지 않았는지 확인:
     - `*.tunnels.api.visualstudio.com`
     - `*.devtunnels.ms`
     - `login.microsoftonline.com` (MS 계정 사용 시)
     - `github.com` (GitHub 계정 사용 시)

3. **서비스 재시작**
   ```bash
   code tunnel service uninstall
   code tunnel service install
   ```

### 연결이 느릴 때

- Microsoft 릴레이 서버를 경유하므로 직접 연결보다 약간의 지연이 있음
- 대용량 파일 작업 시 체감될 수 있음
- 터미널 출력이 많은 명령(예: `npm install`)은 다소 느릴 수 있음

### 터널 이름 충돌

같은 계정으로 여러 PC에서 같은 이름을 사용하면 충돌한다:

```bash
# 다른 이름으로 변경
code tunnel rename home-pc-2
```

---

## 5. 보안 참고사항

- 모든 통신은 **HTTPS(TLS)** 로 암호화됨
- Microsoft/GitHub 계정 인증 필수 — 계정 없이는 접속 불가
- 서버 PC의 **모든 파일**에 접근 가능하므로 계정 보안에 주의
- 2단계 인증(2FA) 활성화 권장
- 사내 보안 정책에 따라 터널 사용이 제한될 수 있음 — IT 부서 확인 권장

---

## 6. 빠른 참조

```bash
# 터널 시작 (일회성)
code tunnel

# 서비스 등록 (상시 운영)
code tunnel service install

# 서비스 로그 확인
code tunnel service log

# 서비스 제거
code tunnel service uninstall

# 터널 이름 변경
code tunnel rename <new-name>

# 터널 등록 해제
code tunnel unregister

# 터널 상태 확인
code tunnel status
```

### 클라이언트 접속 URL

```
https://vscode.dev/tunnel/<터널이름>
```
