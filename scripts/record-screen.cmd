@echo off
rem Records the primary display to reference-capture\<name>-<time>.mp4 (git-ignored).
rem Uses the Desktop Duplication API, so fullscreen games are captured too.
rem   scripts\record-screen.cmd                 60 seconds, named "clip"
rem   scripts\record-screen.cmd quad-clear 45   45 seconds, named "quad-clear"
rem Press q in this window to stop early.
setlocal
cd /d "%~dp0.."
set "NAME=%~1"
if "%NAME%"=="" set "NAME=clip"
set "SECS=%~2"
if "%SECS%"=="" set "SECS=60"
where ffmpeg >nul 2>nul || (echo ffmpeg is required on PATH. & pause & exit /b 1)
if not exist reference-capture mkdir reference-capture
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "OUT=reference-capture\%NAME%-%STAMP%.mp4"
echo Recording %SECS% s of the screen to %OUT%  (press q here to stop early)
ffmpeg -hide_banner -loglevel error -f lavfi -i "ddagrab=framerate=60:draw_mouse=0,hwdownload,format=bgra" -t %SECS% -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p "%OUT%"
echo Saved %OUT%
