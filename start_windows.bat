@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
set "GEO_PROJECT_DIR=%~dp0"

echo.
echo ========================================
echo GEO 自动化 Windows 一键启动
echo ========================================
echo.

if not exist "python_service\启动服务_windows.bat" (
  echo [错误] 找不到 python_service\启动服务_windows.bat
  echo 请确认整个项目文件夹已完整复制到 Windows。
  pause
  exit /b 1
)

call "python_service\启动服务_windows.bat"
