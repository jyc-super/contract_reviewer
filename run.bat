@echo off
chcp 65001 >nul
title Contract Risk Review
cd /d "%~dp0"

REM Add Node to PATH if missing
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

REM Firewall rule for Node (optional)
netsh advfirewall firewall show rule name="Node.js" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Setup] Adding Node.js firewall rule...
  netsh advfirewall firewall add rule name="Node.js" dir=in action=allow program="C:\Program Files\nodejs\node.exe" enable=yes >nul 2>&1
  if errorlevel 1 (
    echo [Info] Firewall rule failed. If http://127.0.0.1:3000 does not open, run as Admin or see docs.
  ) else (
    echo [Setup] Firewall rule added.
  )
  echo.
) else (
  echo [Setup] Node.js firewall rule exists.
)

if not exist "node_modules\next" (
  echo Installing dependencies - first run...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

REM ---------- Docker required for Supabase and Docling ----------
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo [WARN] Docker is not running. Supabase and Docling will show as "not configured" until Docker is started.
  echo Start Docker Desktop and run run.bat again to populate .env.local automatically.
  echo.
)

REM ---------- Supabase local (SETUP-GUIDE Step 1-1) ----------
echo.
echo [Local] Checking Supabase...
if not exist "supabase\config.toml" (
  echo [First run] Running: npx supabase init
  call npx supabase init
  if errorlevel 1 (
    echo [Info] supabase init failed. Install CLI: npm install -g supabase
  ) else (
    echo [First run] Supabase init done.
  )
)
echo [Local] Running: npx supabase start
call npx supabase start
if errorlevel 1 (
  echo [Info] supabase start failed or already running. Manual: npx supabase start
) else (
  echo [Local] Supabase started.
)
echo.

REM Ensure .env.local has Supabase/Docling vars so settings page shows "running"
if exist "scripts\ensure-local-env.js" (
  node scripts\ensure-local-env.js
)

REM ---------- Docling (SETUP-GUIDE Step 1-2) ----------
echo [Local] Checking Docling...
where docker >nul 2>&1
if errorlevel 1 (
  echo [Info] Docker not in PATH. Start Docker Desktop and run manually:
  echo   docker run -d --name docling -p 5001:5001 --restart unless-stopped quay.io/docling-project/docling-serve
  echo   or: docker start docling
) else (
  docker ps -a -q --filter name=docling 2>nul | findstr /r "." >nul 2>&1
  if errorlevel 1 (
    echo [First run] Creating and starting Docling container...
    docker run -d --name docling -p 5001:5001 --restart unless-stopped quay.io/docling-project/docling-serve
    if errorlevel 1 (
      echo [Info] docker run failed. Is Docker Desktop running?
    ) else (
      echo [Local] Docling container started. First run may take 5-10 min for model download.
    )
  ) else (
    echo [Local] Starting Docling: docker start docling
    docker start docling >nul 2>&1
    echo [Local] Docling running.
  )
)
echo.

echo Starting dev server... Browser will open shortly.
echo If port 3000 is in use, use the URL shown (e.g. http://127.0.0.1:3001)
echo See docs\TEST_RUNNER_REPORT_TIMEOUT.md if connection fails.
start "" cmd /c "timeout /t 6 /nobreak >nul && start http://127.0.0.1:3000"
npm run dev
if errorlevel 1 (
  echo.
  echo [ERROR] Dev server exited with an error. Check the messages above.
  pause
  exit /b 1
)
