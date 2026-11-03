@echo off
chcp 65001 >nul
cd /d "%~dp0backend"

set "PY=.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo ============================================================
echo   DanceMate · 舞蹈学习助手
echo   地址：http://127.0.0.1:8000
echo   关闭此窗口即停止服务（电脑重启后需重新双击本文件）
echo ============================================================
echo.

start "" cmd /c "timeout /t 3 >nul && start http://127.0.0.1:8000"
"%PY%" run.py
pause
