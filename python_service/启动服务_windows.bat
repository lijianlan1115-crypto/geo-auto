@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

if exist "GEO反馈自动化.exe" (
  start "" "GEO反馈自动化.exe"
  exit /b 0
)

title GEO Python Service
set "SERVICE_DIR=%~dp0"
set "PROJECT_ROOT=%SERVICE_DIR%.."
for %%I in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fI"
set "GEO_PROJECT_DIR=%PROJECT_ROOT%"

set "PY_CMD="
where py >nul 2>nul
if not errorlevel 1 set "PY_CMD=py -3"
if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 set "PY_CMD=python"
)
if not defined PY_CMD (
  echo 未检测到 Python，正在尝试通过 winget 自动安装 Python 3.11...
  where winget >nul 2>nul
  if errorlevel 1 goto no_python
  winget install -e --id Python.Python.3.11 --scope user --accept-package-agreements --accept-source-agreements
  where py >nul 2>nul
  if not errorlevel 1 set "PY_CMD=py -3"
)
if not defined PY_CMD goto no_python

if not exist ".venv\Scripts\python.exe" (
  %PY_CMD% -m venv .venv
  if errorlevel 1 goto venv_error
)
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 goto pip_error

echo 服务启动中: http://127.0.0.1:8765
python server.py
goto end

:no_python
echo [错误] 未找到 Python，也无法通过 winget 自动安装。
goto end
:venv_error
echo [错误] 创建虚拟环境失败。
goto end
:pip_error
echo [错误] 依赖安装失败，请检查网络或 pip 源。
:end
pause
