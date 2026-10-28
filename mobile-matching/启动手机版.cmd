@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更高版本，再重新打开此文件。
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  call npm ci --omit=dev --ignore-scripts
  if errorlevel 1 (
    echo 依赖准备失败，请联网后重试。
    pause
    exit /b 1
  )
)
node scripts\start.cjs %*
if errorlevel 1 pause
