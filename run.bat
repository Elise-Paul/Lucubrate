@echo off
title Lucubrate - AI Systems IDE
echo ============================================================
echo   Launching Lucubrate Desktop Window
echo   Target Host: Configured via config.json / Settings
echo ============================================================
echo.

cd /d "%~dp0"
python main.py
