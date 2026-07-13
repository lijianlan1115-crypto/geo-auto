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

if not exist "geo-python-service.exe" (
  echo [错误] 找不到 geo-python-service.exe
  pause
  exit /b 1
)

echo 服务启动中: http://127.0.0.1:8765
echo 请保持这个窗口不要关闭。
echo.
geo-python-service.exe
pause
