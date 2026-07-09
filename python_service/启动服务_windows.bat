@echo off
chcp 65001 >nul
setlocal EnableExtensions

title GEO Python Service
cd /d "%~dp0"

set "SERVICE_DIR=%~dp0"
set "PROJECT_ROOT=%SERVICE_DIR%.."
for %%I in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fI"
set "GEO_PROJECT_DIR=%PROJECT_ROOT%"

echo.
echo ========================================
echo GEO Python 服务 Windows 一键启动
echo 服务目录: %SERVICE_DIR%
echo 项目目录: %GEO_PROJECT_DIR%
echo ========================================
echo.

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
  if not defined PY_CMD (
    where python >nul 2>nul
    if not errorlevel 1 set "PY_CMD=python"
  )
)

if not defined PY_CMD goto no_python

echo 使用 Python 命令: %PY_CMD%
%PY_CMD% --version
if errorlevel 1 goto no_python

if not exist "%PROJECT_ROOT%\input.xlsx" (
  echo.
  echo [提醒] 当前没有找到输入文件:
  echo %PROJECT_ROOT%\input.xlsx
  echo 请把 input.xlsx 放到项目根目录。服务仍会启动，方便先检查插件连接。
  echo.
)

if not exist ".venv\Scripts\python.exe" (
  echo 正在创建虚拟环境 .venv ...
  %PY_CMD% -m venv .venv
  if errorlevel 1 goto venv_error
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 goto venv_error

echo 正在安装/检查依赖...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 goto pip_error

echo.
echo [可选提醒] 如果 Windows 没装 Tesseract OCR，OCR 兜底可能不可用；DOM 截图和图片二次拉框仍可运行。
echo.
echo 服务启动中: http://127.0.0.1:8765
echo 请保持这个窗口不要关闭。
echo.
python server.py
goto end

:no_python
echo.
echo [错误] 没有检测到 Python，也无法自动安装。
echo 处理方式：
echo 1. 安装 Python 3.11 或 3.12
echo 2. 安装时勾选 Add Python to PATH
echo 3. 重新双击本 bat
goto end

:venv_error
echo.
echo [错误] 创建或激活虚拟环境失败。
goto end

:pip_error
echo.
echo [错误] 依赖安装失败，请检查网络或 pip 源。
goto end

:end
echo.
pause
