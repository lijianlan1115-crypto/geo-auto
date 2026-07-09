@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
set "GEO_PROJECT_DIR=%~dp0"

echo.
echo ========================================
echo GEO Windows 免 Python 打包工具
echo ========================================
echo.
echo 说明：
echo 1. 这个脚本在一台有 Python 的 Windows 电脑上运行。
echo 2. 运行后会生成 dist\geo-python-service\geo-python-service.exe
echo 3. 把 dist\geo-python-service 整个文件夹发给别人，对方不用安装 Python。
echo 4. Chrome 插件仍需要在 Chrome 扩展页加载 chrome_extension 文件夹。
echo.

set "PY_CMD="
where py >nul 2>nul
if not errorlevel 1 set "PY_CMD=py -3"
if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 set "PY_CMD=python"
)
if not defined PY_CMD (
  echo [错误] 没有 Python，无法打包。请先安装 Python 3.11 或 3.12。
  pause
  exit /b 1
)

if not exist "python_service\.venv\Scripts\python.exe" (
  echo 正在创建虚拟环境...
  %PY_CMD% -m venv python_service\.venv
  if errorlevel 1 goto error
)

call "python_service\.venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r python_service\requirements.txt
python -m pip install pyinstaller
if errorlevel 1 goto error

rmdir /s /q build 2>nul
rmdir /s /q dist\geo-python-service 2>nul

python -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --name geo-python-service ^
  --distpath dist ^
  --workpath build ^
  --add-data "python_service;python_service" ^
  python_service\server.py
if errorlevel 1 goto error

copy "start_windows_exe.bat" "dist\geo-python-service\start_windows_exe.bat" >nul
xcopy "chrome_extension" "dist\geo-python-service\chrome_extension" /E /I /Y >nul
copy "WINDOWS_DEPLOY.md" "dist\geo-python-service\WINDOWS_DEPLOY.md" >nul

echo.
echo ✅ 打包完成：
echo %CD%\dist\geo-python-service
echo.
echo 发给别人时，把 geo-python-service 整个文件夹压缩发送。
pause
exit /b 0

:error
echo.
echo [错误] 打包失败。
pause
exit /b 1
