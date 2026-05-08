@echo off
REM Iron Yard — named Cloudflare Tunnel (stable URL).
REM Prereq: TUNNEL.md "Option B" one-time setup must be done first
REM (cloudflared tunnel login, create iron-yard, route dns, write config.yml).

setlocal
cd /d "%~dp0"

where cloudflared >nul 2>&1
if errorlevel 1 (
  if not exist cloudflared.exe (
    echo ERROR: cloudflared not found. See TUNNEL.md.
    pause & exit /b 1
  )
)

REM Sanity: confirm the iron-yard tunnel exists.
cloudflared tunnel list 2>nul | findstr /C:"iron-yard" >nul
if errorlevel 1 (
  echo ERROR: tunnel "iron-yard" not found. Run the one-time setup in TUNNEL.md:
  echo   cloudflared tunnel login
  echo   cloudflared tunnel create iron-yard
  echo   cloudflared tunnel route dns iron-yard play.yourdomain.com
  echo and create %%USERPROFILE%%\.cloudflared\config.yml
  pause & exit /b 1
)

echo === Building client ===
call npm --prefix client install --no-audit --no-fund
if errorlevel 1 ( echo client install failed & pause & exit /b 1 )
call npm --prefix client run build
if errorlevel 1 ( echo client build failed & pause & exit /b 1 )

echo === Installing server deps ===
call npm --prefix server install --no-audit --no-fund

echo === Starting server on :8080 ===
start "iron-yard server" /B cmd /c "node server/src/index.js"

timeout /t 2 /nobreak >nul

echo === Running named tunnel "iron-yard" ===
echo === Game served at the hostname you configured (see TUNNEL.md) ===
echo.

cloudflared tunnel run iron-yard

echo.
echo Tunnel closed. Killing server.
taskkill /F /FI "WINDOWTITLE eq iron-yard server*" >nul 2>&1
endlocal
