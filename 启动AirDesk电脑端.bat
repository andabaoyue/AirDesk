@echo off
cd /d "%~dp0airdesk-desktop-host"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  call npm run dev
)
