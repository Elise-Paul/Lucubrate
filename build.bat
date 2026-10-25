@echo off
setlocal
cd /d "%~dp0"

echo =======================================================
echo   Lucubrate IDE - Standalone Executable Builder
echo =======================================================

echo [1/4] Closing any running Lucubrate instances...
taskkill /F /T /IM Lucubrate.exe >nul 2>&1
python -c "import psutil, time; [p.kill() for p in psutil.process_iter() if p.name().lower() in ('lucubrate.exe', 'sparkcode.exe')]; time.sleep(1)" >nul 2>&1

echo [2/4] Compiling Lucubrate.exe via PyInstaller spec...
python -m PyInstaller --noconfirm Lucubrate.spec
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PyInstaller compilation failed!
    exit /b %ERRORLEVEL%
)

echo [3/4] Syncing config.json into dist\Lucubrate\...
if exist config.json (
    if not exist dist\Lucubrate mkdir dist\Lucubrate
    copy /y config.json dist\Lucubrate\config.json >nul
)

echo [4/4] Syncing latest static assets...
xcopy /s /e /y static dist\Lucubrate\_internal\static >nul

echo.
echo =======================================================
echo   BUILD COMPLETE
echo   Output: dist\Lucubrate\Lucubrate.exe
echo =======================================================
endlocal
