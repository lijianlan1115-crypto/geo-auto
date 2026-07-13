@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [GEO] 打包需要在这台电脑先安装 Python 3.10 或更高版本。
  echo [GEO] 普通使用者不需要 Python，只需要拿到 GEO反馈自动化.exe。
  pause
  exit /b 1
)

python -c "import tkinter" >nul 2>nul
if errorlevel 1 (
  echo [GEO] 当前 Python 缺少 tkinter 图形组件。
  echo [GEO] 请使用 python.org 官方 Windows 安装包，并勾选 Tcl/Tk and IDLE 后重新打包。
  pause
  exit /b 1
)

if not exist .venv (
  echo [GEO] 创建打包虚拟环境...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -r requirements-build.txt

echo [GEO] 正在生成 Windows 图形化客户端...
python -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --hidden-import sqlite3 ^
  --hidden-import _sqlite3 ^
  --name "GEO反馈自动化" ^
  --distpath . ^
  --workpath build ^
  --specpath build ^
  desktop_app.py

if errorlevel 1 (
  echo [GEO] 打包失败，请查看上方错误。
  pause
  exit /b 1
)

echo.
echo [GEO] 已生成：%cd%\GEO反馈自动化.exe
echo [GEO] 客户双击 GEO反馈自动化.exe 即可，电脑不需要安装 Python。
pause
