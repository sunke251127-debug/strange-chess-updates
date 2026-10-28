@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "启动手机版.cmd" --internet %*
