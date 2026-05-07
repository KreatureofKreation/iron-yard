@echo off
REM Iron Yard launcher. Double-click to run.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org and re-run.
  pause
  exit /b 1
)

REM Install deps if missing.
if not exist "server\node_modules" (
  echo Installing server deps...
  call npm --prefix server install || goto :err
)
if not exist "client\node_modules" (
  echo Installing client deps...
  call npm --prefix client install || goto :err
)

REM Build client if dist missing or older than any source file.
if not exist "client\dist\index.html" (
  echo Building client...
  call npm --prefix client run build || goto :err
)

REM Optional: bot count. Override via:  set BOT_COUNT=2 ^&^& start.bat
if "%BOT_COUNT%"=="" set BOT_COUNT=1
if "%PORT%"=="" set PORT=8080

echo.
echo ============================================
echo  Iron Yard
echo  open  http://localhost:%PORT%
echo  bots  %BOT_COUNT%
echo ============================================
echo.

call npm --prefix server start
goto :end

:err
echo.
echo *** error — see output above ***
pause
exit /b 1

:end
endlocal
pause
