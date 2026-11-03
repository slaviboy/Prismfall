@echo off
rem Prismfall launcher: serves the production build on http://localhost:4173 and opens it in
rem Chrome (or Edge) app mode with its own profile, so saves stay separate from normal browsing.
rem   Play.cmd            build once if needed, then play
rem   Play.cmd --rebuild  rebuild first (after updating the game)
setlocal
cd /d "%~dp0"
set "URL=http://localhost:4173/"
set "PROFILE=%LOCALAPPDATA%\Prismfall\chrome-profile"

where node >nul 2>nul || (echo Node.js is required: https://nodejs.org/ & goto :fail)

if not exist node_modules\ (
  echo Installing dependencies...
  call npm install || goto :fail
)

if /i "%~1"=="--rebuild" if exist dist\ rmdir /s /q dist
if not exist dist\index.html (
  echo Building Prismfall...
  call npm run build || goto :fail
)

rem Start the server unless one is already answering on the port.
call :ping || start "Prismfall server" /min cmd /c "npx vite preview"
set /a tries=0
:wait
call :ping && goto :open
set /a tries+=1
if %tries% geq 40 (echo The game server did not start on %URL% & goto :fail)
timeout /t 1 /nobreak >nul
goto :wait

:open
set "BROWSER="
for %%B in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%B set "BROWSER=%%~B"
if not defined BROWSER (
  echo Chrome or Edge was not found; opening the default browser instead.
  start "" "%URL%"
  goto :eof
)
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "%BROWSER%" --app=%URL% --user-data-dir="%PROFILE%" --start-maximized --autoplay-policy=no-user-gesture-required
goto :eof

:ping
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%' | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
exit /b %errorlevel%

:fail
echo.
pause
exit /b 1
