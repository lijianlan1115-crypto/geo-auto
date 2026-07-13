@echo off
setlocal
cd /d "%~dp0"

if exist "GEO反馈自动化.exe" (
  start "" "GEO反馈自动化.exe"
  exit /b 0
)

if exist "geo-python-service.exe" (
  echo [GEO] 正在启动旧版免 Python 本地服务...
  "geo-python-service.exe"
  pause
  exit /b %errorlevel%
)

where python >nul 2>nul
if errorlevel 1 (
  echo [GEO] 未找到 Python，也没有 GEO反馈自动化.exe。
  echo [GEO] 请使用已经打包好的 Windows 图形化版本，或在有 Python 的电脑上运行 build_windows_exe.bat 生成 exe。
  pause
  exit /b 1
)

echo [GEO] 未发现 exe，使用 Python 开发模式启动...
if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install -r requirements.txt
python server.py
pause
