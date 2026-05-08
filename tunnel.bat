@echo off
REM Iron Yard — host on your PC + Cloudflare Quick Tunnel.
REM No Cloudflare account / no domain required. Each run gets a fresh
REM random https://*.trycloudflare.com URL. Share that URL with friends.
REM Free. Closes when you close this window.
REM
REM First-time setup: download cloudflared.exe from
REM   https://github.com/cloudflare/cloudflared/releases (latest, Windows amd64)
REM and put it in this folder OR on your PATH.

setlocal

cd /d "%~dp0"

where cloudflared >nul 2>&1
if errorlevel 1 (
  if not exist cloudflared.exe (
    echo ERROR: cloudflared not found.
    echo Download from https://github.com/cloudflare/cloudflared/releases
    echo and place cloudflared.exe in this folder.
    pause
    exit /b 1
  )
)

echo === Building client ===
call npm --prefix client install --no-audit --no-fund
if errorlevel 1 ( echo client install failed & pause & exit /b 1 )
call npm --prefix client run build
if errorlevel 1 ( echo client build failed & pause & exit /b 1 )

echo === Installing server deps ===
call npm --prefix server install --no-audit --no-fund
if errorlevel 1 ( echo server install failed & pause & exit /b 1 )

echo === Starting server on :8080 ===
start "iron-yard server" /B cmd /c "node server/src/index.js"

REM Give the server a moment to bind.
timeout /t 2 /nobreak >nul

echo === Opening Cloudflare Quick Tunnel ===
echo === Look for the https://*.trycloudflare.com URL below ===
echo.

cloudflared tunnel --url http://localhost:8080 --no-autoupdate

echo.
echo Tunnel closed. Killing server.
taskkill /F /FI "WINDOWTITLE eq iron-yard server*" >nul 2>&1
endlocal
