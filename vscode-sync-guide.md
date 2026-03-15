# VS Code 개발 환경 동기화 가이드

회사와 집의 VS Code 환경을 동일하게 맞추는 방법 (외부 업로드 제한 환경 기준)

---

## 방법 1: USB/이메일로 설정 파일 복사

회사에서 설정 파일을 USB에 담아 집으로 가져오기.

**복사할 파일 위치 (Windows):**
```
%APPDATA%\Code\User\settings.json
%APPDATA%\Code\User\keybindings.json
%APPDATA%\Code\User\snippets\
```

**확장 목록 추출:**
```bash
code --list-extensions > extensions.txt
```
집에서 `extensions.txt`를 보고 수동 설치:
```bash
cat extensions.txt | xargs -I {} code --install-extension {}
```

---

## 방법 2: VS Code Settings Sync (Microsoft 계정)

회사 보안 정책이 GitHub은 막아도 Microsoft 계정은 허용하는 경우가 많습니다.

> **사전 확인:** 회사 PC에서 브라우저로 `https://login.live.com` 접근이 되는지 먼저 확인하세요.
> 차단되어 있으면 이 방법을 사용할 수 없습니다.

---

### Step 1: 동기화할 항목 설정 (선택 사항)

기본값으로 모두 동기화되지만, 일부만 선택하려면:

1. `Ctrl+Shift+P` → **"Settings Sync: Configure..."** 입력
2. 동기화할 항목 체크/해제:
   - ☑ **Settings** — settings.json
   - ☑ **Keyboard Shortcuts** — 키바인딩 (플랫폼별 분리 가능)
   - ☑ **Extensions** — 설치된 확장 목록
   - ☑ **UI State** — 패널 레이아웃, 탭 상태
   - ☑ **Snippets** — 코드 스니펫
   - ☑ **Tasks** — tasks.json
   - ☑ **Profiles** — 프로필 설정

---

### Step 2: 회사 PC에서 Settings Sync 켜기

1. `Ctrl+Shift+P` → **"Settings Sync: Turn On"** 입력
2. 동기화 항목 확인 화면에서 **"Sign in & Turn On"** 클릭
3. 계정 선택 팝업에서 **"Sign in with Microsoft Account"** 선택
   - (GitHub 계정 아님 — 회사에서 GitHub이 차단된 경우 대비)
4. 브라우저가 열리면 Microsoft 계정(`@outlook.com`, `@hotmail.com`, 또는 회사 M365 계정)으로 로그인
5. VS Code로 돌아오면 자동으로 업로드 시작
6. 좌측 하단 계정 아이콘에 **"Settings Sync is On"** 표시되면 완료

---

### Step 3: 집 PC에서 연결하기

1. 집 PC VS Code에서 동일하게 `Ctrl+Shift+P` → **"Settings Sync: Turn On"**
2. 같은 Microsoft 계정으로 로그인
3. 충돌 해결 화면이 나타나면:
   - **"Replace Local"** — 클라우드(회사) 설정으로 집 PC를 완전히 덮어씀 ← 권장
   - **"Merge"** — 양쪽 설정을 병합 (충돌 항목은 수동 해결 필요)
4. 확장 프로그램은 자동으로 다운로드 및 설치됨 (수 분 소요)

---

### Step 4: 이후 관리

- 설정 변경 시 **자동으로 클라우드에 업로드** → 다른 PC에서도 자동 반영
- 강제 동기화: `Ctrl+Shift+P` → **"Settings Sync: Sync Now"**
- 동기화 로그 확인: `Ctrl+Shift+P` → **"Settings Sync: Show Log"**
- 동기화 끄기: `Ctrl+Shift+P` → **"Settings Sync: Turn Off"**

---

### 문제 해결

| 증상 | 해결 방법 |
|------|-----------|
| 로그인 창이 안 열림 | 브라우저에서 `login.live.com` 직접 접속 시도 |
| 확장이 집에서 설치 안 됨 | Extensions 패널 → 클라우드 아이콘 클릭하여 수동 설치 |
| 설정이 덮어씌워짐 | "Settings Sync: Show Conflicts"로 충돌 항목 확인 |
| 회사/집 키바인딩 따로 관리 | Configure에서 "Keyboard Shortcuts for each platform" 체크 |

---

## 방법 3: 사내 내부망 저장소 활용

사내 내부 Git 서버(GitLab, Bitbucket 등)나 NAS/공유 드라이브가 있다면 설정 파일을 거기에 올리고, 집에서는 USB로 받아오는 방식.

---

## 방법 비교

| 상황 | 추천 방법 |
|------|-----------|
| 설정이 자주 바뀜 | Microsoft 계정 Settings Sync 시도 |
| 설정이 거의 고정됨 | USB로 한 번만 복사 |
| 사내 내부망 Git 있음 | 내부 저장소에 dotfiles 관리 |
