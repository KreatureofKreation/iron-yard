@echo off
REM Dev mode: ws server :8080 + vite dev :5173 in two windows. Hot-reload client.
setlocal
cd /d "%~dp0"

if not exist "server\node_modules" call npm --prefix server install
if not exist "client\node_modules" call npm --prefix client install

if "%BOT_COUNT%"=="" set BOT_COUNT=1
if "%PORT%"=="" set PORT=8080

echo Starting server on :%PORT% with %BOT_COUNT% bot(s)...
start "iron-yard server" cmd /k "set PORT=%PORT% && set BOT_COUNT=%BOT_COUNT% && npm --prefix server run dev"

echo Starting vite dev on :5173...
start "iron-yard client" cmd /k "npm --prefix client run dev"

echo.
echo Open http://localhost:5173 (auto-detects ws on :%PORT%)
echo Close both windows to stop.
endlocal
