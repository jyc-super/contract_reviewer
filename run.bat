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
if not exist "node_modules\next" (
  echo [Setup] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
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

  REM [OPT] Supabase가 이미 실행 중이면 npx supabase start를 완전히 건너뜀.
  REM  npx + CLI 초기화 + Docker 컨테이너 상태 확인 비용(30~120초) 절감.
  REM  curl --max-time 3 으로 최대 3초 내 응답 없으면 미실행으로 판단.
  echo [Local] Checking if Supabase is already running...
  curl -s --max-time 3 http://127.0.0.1:54321/health >nul 2>&1
  if not errorlevel 1 (
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
if "%DOCLING_AUTO_START%"=="false" goto :docling_manual
echo [Docling] Auto-start enabled — instrumentation.ts will start sidecar during npm run dev.
goto :docling_done

:docling_manual
REM ── Manual / legacy mode: start sidecar before npm run dev ────────────────
set "DOCLING_REQUIRED=true"
set "DOCLING_READY=0"
set "DOCLING_MODE=none"
set "WAIT_SECONDS=15"

REM 이미 실행 중인 컨테이너 확인 (docker inspect → 파일 경유로 안정적 파싱)
docker inspect contract-risk-docling --format "{{.State.Health.Status}}" > "%TEMP%\docling_health.txt" 2>nul
findstr /b /c:"healthy" "%TEMP%\docling_health.txt" >nul 2>&1
if not errorlevel 1 set "DOCLING_READY=1"
type "%TEMP%\docling_health.txt" >> "%RUNLOG%" 2>nul
echo [Docling] DOCLING_READY=%DOCLING_READY% (initial) >> "%RUNLOG%"
if "%DOCLING_READY%"=="1" (
  echo [Docling] Sidecar already running ^(docker healthy^)
  set "DOCLING_MODE=existing"
  goto :docling_ready_check
)

if "%DOCKER_OK%"=="1" goto :docling_docker_manual
goto :docling_python_manual

:docling_docker_manual
echo [Docling] Docker available - checking for pre-built image...
docker image inspect contract-risk-docling:local >nul 2>&1
if errorlevel 1 (
  echo [Docling] Image not found - skipping Docker build, using Python venv instead.
  goto :docling_python_manual
)
docker compose -f docker-compose.docling.yml up -d
if errorlevel 1 (
  echo [Docling] Docker compose up failed - falling back to Python venv.
  goto :docling_python_manual
)
echo [Docling] Container started. Waiting for health...
set "DOCLING_MODE=docker"
set "WAIT_SECONDS=180"
goto :docling_wait_loop_manual

:docling_python_manual
python --version >nul 2>&1
if not errorlevel 1 goto :docling_python_start_manual
echo [Docling] Neither Docker nor Python found.
echo [Docling] Upload unavailable. Install Docker Desktop or Python 3.10+.
goto :docling_ready_check

:docling_python_start_manual
echo [Docling] Starting Python venv sidecar in background (manual mode)...
start "Docling Sidecar" /min cmd /c "set DOCLING_PRELOAD_MODEL=false && scripts\start_sidecar.bat"
set "DOCLING_MODE=python"
set "WAIT_SECONDS=60"
echo [Docling] lazy import 모드 — 서버 기동만 확인합니다 (최대 60초).

set "WAIT_COUNT=0"
:docling_wait_loop_manual
set /a "WAIT_COUNT+=1"
if %WAIT_COUNT% GTR %WAIT_SECONDS% goto :docling_ready_check

if "%DOCLING_MODE%"=="docker" (
  docker inspect contract-risk-docling --format "{{.State.Health.Status}}" > "%TEMP%\docling_health.txt" 2>nul
  findstr /b /c:"healthy" "%TEMP%\docling_health.txt" >nul 2>&1
  if not errorlevel 1 set "DOCLING_READY=1"
)
if "%DOCLING_MODE%"=="python" (
  curl -s --max-time 3 http://127.0.0.1:8766/health > "%TEMP%\docling_health.txt" 2>nul
  findstr /C:"\"status\": \"ok\"" "%TEMP%\docling_health.txt" >nul 2>&1
  if not errorlevel 1 set "DOCLING_READY=1"
)

if "%DOCLING_READY%"=="1" goto :docling_ready_check
set /a "MOD=WAIT_COUNT %% 10"
if "%MOD%"=="0" echo [Docling] 서버 기동 대기 중... %WAIT_COUNT%/%WAIT_SECONDS%초 경과
timeout /t 1 /nobreak >nul
goto :docling_wait_loop_manual

:docling_ready_check
echo [Docling] At docling_ready: DOCLING_READY=%DOCLING_READY% MODE=%DOCLING_MODE% >> "%RUNLOG%"
if not "%DOCLING_READY%"=="1" goto :docling_unavailable_manual
echo [Docling] Ready (mode: %DOCLING_MODE%) - upload parser is available.
goto :docling_done

:docling_unavailable_manual
echo.
echo [ERROR] Docling 사이드카 기동 실패 - %WAIT_SECONDS%초 내에 /health 응답 없음
if "%DOCLING_MODE%"=="docker" echo [ERROR] 로그 확인: docker logs contract-risk-docling
if not "%DOCLING_MODE%"=="docker" (
  echo [ERROR] scripts\start_sidecar.bat 를 별도 창에서 직접 실행하여 오류를 확인하세요.
  echo [ERROR] Python/venv 문제라면: .venv\Scripts\pip install -r scripts\requirements-docling.txt
)
echo [ERROR] 문제 해결 후 run.bat을 다시 실행하세요.
echo.
pause
exit /b 1

:docling_done
echo/

REM ── 포트 3000 점유 프로세스 정리 ────────────────────────────────────────────
REM [OPT] PowerShell 대신 순수 CMD(netstat + for + taskkill)로 처리.
REM  PowerShell.exe 프로세스 초기화 hang(10~30초) 완전 제거.
REM  netstat -ano 는 즉시 응답하며, findstr로 LISTENING 상태만 필터링.
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /C:" LISTENING" ^| findstr "\:3000 "') do (
  echo [Next] Killing process on port 3000 (PID: %%P)
  taskkill /PID %%P /F >nul 2>&1
)

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
