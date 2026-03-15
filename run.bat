@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Contract Risk Review
cd /d "%~dp0"
set "RUNLOG=%~dp0run.log"
echo [START] %DATE% %TIME% > "%RUNLOG%"

REM If WSL update prompt appears, run: wsl --update

REM Ensure Node.js exists or add default install path.
where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
  ) else (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
  )
)

REM Optional firewall rule for Node.
REM [OPT] netsh 대신 레지스트리 키로 규칙 존재 여부를 확인 — netsh 서비스 초기화 1~3초 절감
reg query "HKLM\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules" /v "Node.js" >nul 2>&1
if not errorlevel 1 (
  echo [Setup] Node firewall rule exists
  goto :firewall_done
)

echo/
echo [Setup] Adding Node.js firewall rule...
netsh advfirewall firewall add rule name="Node.js" dir=in action=allow program="C:\Program Files\nodejs\node.exe" enable=yes >nul 2>&1
if errorlevel 1 (
  echo [Info] Firewall rule add failed. Run this script as Admin if localhost cannot be reached.
) else (
  echo [Setup] Firewall rule added
)
echo/

:firewall_done
REM ── npm install 캐싱 ────────────────────────────────────────────────────────
REM  package-lock.json 수정 시간을 .npm.check에 저장하여 변경 없으면 스킵.
REM  node_modules 자체가 없으면 무조건 설치.
set "NPM_NEED_INSTALL=0"
if not exist "node_modules\next" (
  set "NPM_NEED_INSTALL=1"
) else if not exist ".npm.check" (
  set "NPM_NEED_INSTALL=1"
) else (
  REM package-lock.json 수정 시간과 캐시 비교
  for %%F in (package-lock.json) do set "LOCK_TIME=%%~tF"
  set /p LAST_TIME=<".npm.check"
  if not "!LOCK_TIME!"=="!LAST_TIME!" set "NPM_NEED_INSTALL=1"
)
if "%NPM_NEED_INSTALL%"=="1" (
  echo [Setup] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  for %%F in (package-lock.json) do echo %%~tF> ".npm.check"
) else (
  echo [Setup] npm dependencies up-to-date
)

set "DOCKER_OK=0"
docker info 1>nul 2>nul
if not errorlevel 1 (
  set "DOCKER_OK=1"
  goto :docker_done
)

echo [Docker] Docker not running - attempting to start Docker Desktop...
where "Docker Desktop.exe" >nul 2>&1
if not errorlevel 1 (
  start "" "Docker Desktop.exe"
  goto :docker_start_wait
)
if exist "%PROGRAMFILES%\Docker\Docker\Docker Desktop.exe" (
  start "" "%PROGRAMFILES%\Docker\Docker\Docker Desktop.exe"
  goto :docker_start_wait
)
echo [Docker] Docker Desktop not found. Install from https://docs.docker.com/desktop/
goto :docker_done

:docker_start_wait
echo [Docker] Waiting for Docker to start (up to 60 seconds)...
for /l %%W in (1,1,60) do (
  docker info 1>nul 2>nul
  if not errorlevel 1 (
    set "DOCKER_OK=1"
    echo [Docker] Docker is ready.
    goto :docker_done
  )
  set /a "MOD=%%W %% 10"
  if "!MOD!"=="0" echo [Docker] Still waiting... %%W/60s
  timeout /t 1 /nobreak >nul
)
echo [Docker] Docker did not start in 60 seconds - continuing without Docker.

:docker_done

if "%DOCKER_OK%"=="1" (
  echo/
  echo [Local] Checking Supabase...
  if not exist "supabase\config.toml" (
    echo [First run] npx supabase init
    call npx supabase init
    if errorlevel 1 (
      echo [Info] supabase init failed. You can install CLI with: npm install -g supabase
    ) else (
      echo [First run] Supabase init done
    )
  )

  REM [OPT] 2단계 확인: docker ps(빠름) → curl health(확실) → npx start(최후)
  echo [Local] Checking if Supabase is already running...
  set "SUPA_RUNNING=0"

  REM Step 1: Docker 컨테이너 상태로 빠른 판단
  docker ps --filter "name=supabase_db" --filter "status=running" --format "{{.Names}}" 2>nul | findstr "supabase" >nul 2>&1
  if not errorlevel 1 (
    REM Step 2: 컨테이너 실행 중 → health check로 확인 (2초 타임아웃)
    curl -s --max-time 2 http://127.0.0.1:54321/health >nul 2>&1
    if not errorlevel 1 set "SUPA_RUNNING=1"
  )

  if "!SUPA_RUNNING!"=="1" (
    echo [Local] Supabase already running - skipping start
  ) else (
    echo [Local] npx supabase start
    call npx supabase start
    if errorlevel 1 (
      echo [Info] supabase start failed or already running.
    ) else (
      echo [Local] Supabase started
    )
  )
  echo/
) else (
  echo/
  echo [WARN] Docker is not running. Supabase local is skipped.
  echo [Local] Supabase skipped - Docker not available
  echo/
)

REM Ensure .env.local has required local values.
if exist "scripts\ensure-local-env.js" (
  node scripts\ensure-local-env.js
)

REM ── Docling sidecar ───────────────────────────────────────────────────────
REM
REM  instrumentation.ts (Next.js 14) now handles sidecar auto-start.
REM  When npm run dev starts, instrumentation.ts spawns docling_sidecar.py
REM  via lib/sidecar-manager.ts using the project .venv Python executable.
REM
REM  This block is the FALLBACK for DOCLING_AUTO_START=false or when you
REM  need the sidecar running before npm run dev (e.g. Docker image mode).
REM  In the default auto-start case, jump straight to starting the dev server.
REM
if "%DOCLING_AUTO_START%"=="false" (
  echo [Docling] Auto-start disabled. Ensure sidecar is running: scripts\start_sidecar.bat
  echo [Docling] Upload will fail with DOCLING_UNAVAILABLE if sidecar is not reachable.
) else (
  echo [Docling] Auto-start enabled — instrumentation.ts will start sidecar during npm run dev.
)

:docling_done
echo/

REM ── 포트 3000 점유 프로세스 정리 ────────────────────────────────────────────
REM  Node.js 스크립트로 처리: 정확한 netstat 파싱 + 포트 해제 대기(최대 3초)
node scripts\kill-port.js 3000

echo [Next] Reached dev server start >> "%RUNLOG%"
echo [Next] Starting dev server...
echo [Next] Browser will open shortly.
start "" cmd /c "timeout /t 6 /nobreak >nul && start http://127.0.0.1:3000"
call npm run dev
if errorlevel 1 (
  echo/
  echo [ERROR] Dev server exited with an error.
  pause
  exit /b 1
)

exit /b 0
