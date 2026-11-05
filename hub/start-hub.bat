@echo off
REM ==========================================================================
REM  Desk Hub - run the assistant on THIS machine and let other devices drive it.
REM  Use it on an idle PC (or a VM). Keep the window open, or install the
REM  service / use the Docker recipe in hub\ for something permanent.
REM ==========================================================================
setlocal
cd /d "%~dp0.."

REM Listen on the network, not just loopback. The server refuses 0.0.0.0
REM unless this flag is set, on purpose.
set "HOST=0.0.0.0"
set "ASSIST_ALLOW_REMOTE=1"
if not defined PORT set "PORT=4390"

REM Optional: point the browser tools at a specific Chrome/Edge.
REM if not defined CHROME_PATH set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"

echo.
echo   Desk Hub starting on port %PORT% ...
echo   First run will print a LAN URL and an 8-digit pairing code.
echo   Open http://127.0.0.1:%PORT%/ on this machine, or pair from another device.
echo   If other devices cannot connect, allow node.exe through Windows Firewall
echo   for the Private network (or run: netsh advfirewall firewall add rule ...).
echo.

node src\server.mjs
endlocal
