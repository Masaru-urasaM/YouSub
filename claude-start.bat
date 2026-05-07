@echo off
set PATH=%PATH%;C:\Users\admin\AppData\Roaming\npm
cd /d "%~dp0"
claude --dangerously-skip-permissions
pause