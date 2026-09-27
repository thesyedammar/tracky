@echo off
rem Tracky helper — double-click me instead of typing a command.
rem Needs Node 22+ installed (node --version to check).
cd /d "%~dp0"
echo Starting the Tracky helper... leave this window open while you browse.
node server\server.mjs
echo.
echo The helper stopped. Press any key to close.
pause >nul
