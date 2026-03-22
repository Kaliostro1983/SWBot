@echo off
cd /d "%~dp0"

echo Stopping old auth session...
if exist ".wwebjs_auth" rmdir /s /q ".wwebjs_auth"
if exist ".wwebjs_cache" rmdir /s /q ".wwebjs_cache"

echo Session removed.
pause