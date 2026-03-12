@echo on
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"

REM === Check 1: Node.js ===
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found
  exit /b 1
) else (
  node --version
  echo [OK] Node.js found
)

REM === Check 2: node_modules ===
if not exist "node_modules\next" (
  echo [NEED] node_modules missing - npm install required
) else (
  echo [OK] node_modules\next exists
)

REM === Check 3: Docker ===
docker info 1>nul 2>nul
if not errorlevel 1 (
  echo [OK] Docker running
) else (
  echo [WARN] Docker not running
)

REM === Check 4: Docling sidecar health ===
curl -s --max-time 2 http://127.0.0.1:8765/health
if not errorlevel 1 (
  echo [OK] Docling sidecar is up
) else (
  echo [WARN] Docling sidecar not responding on 8765
)

REM === Check 5: Python ===
python --version 2>&1
if errorlevel 1 (
  echo [WARN] Python not found
) else (
  echo [OK] Python found
)

REM === Check 6: ensure-local-env.js ===
if exist "scripts\ensure-local-env.js" (
  node scripts\ensure-local-env.js
  echo [ensure-local-env exit: %ERRORLEVEL%]
) else (
  echo [WARN] scripts\ensure-local-env.js not found
)

REM === Check 7: npm run dev (non-blocking, 5s then kill) ===
echo [Testing npm run dev for 5 seconds...]
start "" /wait /b cmd /c "timeout /t 5 /nobreak >nul"

echo [DONE] Diagnostics complete
exit /b 0
