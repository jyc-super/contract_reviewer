@echo off
chcp 65001 >nul
title Docling Sidecar
cd /d "%~dp0.."

set "SIDECAR_PORT=8766"

echo [Docling] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
  pause
  exit /b 1
)

set "PORT_PID="
for /f %%P in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %SIDECAR_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1"') do set "PORT_PID=%%P"

if defined PORT_PID (
  set "PORT_CMD="
  for /f "usebackq delims=" %%C in (`powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=%PORT_PID%\"; if($p){$p.CommandLine}"`) do set "PORT_CMD=%%C"

  echo %PORT_CMD% | findstr /I "docling_sidecar.py" >nul
  if not errorlevel 1 (
    echo [Docling] Sidecar already running on port %SIDECAR_PORT% ^(PID %PORT_PID%^). Skipping restart.
    exit /b 0
  )

  echo [ERROR] Port %SIDECAR_PORT% is already used by another process ^(PID %PORT_PID%^).
  echo [ERROR] Command: %PORT_CMD%
  echo [ERROR] Stop that process or change DOCLING_SIDECAR_URL/port before retrying.
  pause
  exit /b 1
)

set "VENV_DIR=%~dp0..\.venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo [Docling] Creating virtual environment at scripts\.venv ...
  python -m venv "%VENV_DIR%"
  if errorlevel 1 (
    echo [ERROR] Failed to create venv.
    pause
    exit /b 1
  )
)

REM Bootstrap pip if missing (venv may have been created without it)
if not exist "%VENV_DIR%\Scripts\pip.exe" (
  echo [Docling] pip not found in venv, bootstrapping...
  "%VENV_DIR%\Scripts\python" -m ensurepip --upgrade
  "%VENV_DIR%\Scripts\python" -m pip install --upgrade pip -q
)

echo [Docling] Installing / checking dependencies...
"%VENV_DIR%\Scripts\python" -m pip install -q -r scripts\requirements-docling.txt
if errorlevel 1 (
  echo [ERROR] pip install failed.
  pause
  exit /b 1
)

set "HF_CACHE=%USERPROFILE%\.cache\huggingface\hub\models--ds4sd--docling-models"
if not exist "%HF_CACHE%" (
  echo [Docling] DocLayNet model cache not found - downloading ~500MB...
  echo [Docling] Progress will be shown below.
  echo.
  "%VENV_DIR%\Scripts\python" -c "from huggingface_hub import snapshot_download; snapshot_download('ds4sd/docling-models')"
  if errorlevel 1 (
    echo [ERROR] Model download failed. Check your network connection.
    pause
    exit /b 1
  )
  echo.
  echo [Docling] Model download complete.
  echo.
)

echo [Docling] Starting sidecar on http://127.0.0.1:%SIDECAR_PORT% ...
echo [Docling] Keep this window open while using the app. Close to stop.
echo.
set "DOCLING_SIDECAR_PORT=%SIDECAR_PORT%"
REM 대용량 PDF OOM 방지: OpenMP 단일 스레드 + 페이지 배치 크기를 코드 기본값(20)으로 고정.
REM 시스템 환경변수에 DOCLING_BATCH_SIZE=50 등이 남아 있을 경우 이 줄이 덮어써 OOM을 방지한다.
REM 배치 크기를 더 낮추려면 아래 값을 10 이하로 변경하되, 섹션 병합 품질이 저하될 수 있음.
set "DOCLING_BATCH_SIZE=20"
set "OMP_NUM_THREADS=1"
set "MKL_NUM_THREADS=1"
"%VENV_DIR%\Scripts\python" -X utf8 scripts\docling_sidecar.py
