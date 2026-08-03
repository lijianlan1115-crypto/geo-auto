@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
set "GEO_PROJECT_DIR=%~dp0"

echo.
echo ========================================
echo GEO Python Service EXE 启动
echo ========================================
echo.

if not exist "input.xlsx" (
  echo [提醒] 当前文件夹没有 input.xlsx
  echo 请把 input.xlsx 放到本文件夹后再跑正式任务。
  echo 服务仍会启动，方便先检查插件连接。
  echo.
)

if exist "python_service\GEO反馈自动化.exe" (
  start "" "python_service\GEO反馈自动化.exe"
  exit /b 0
)
if exist "GEO反馈自动化.exe" (
  start "" "GEO反馈自动化.exe"
  exit /b 0
)
if exist "geo-python-service.exe" (
  geo-python-service.exe
  exit /b %errorlevel%
)

echo [错误] 找不到 Windows 客户端程序。
echo 请确认压缩包已经完整解压，不能直接在 ZIP 预览中运行。
pause
exit /b 1
