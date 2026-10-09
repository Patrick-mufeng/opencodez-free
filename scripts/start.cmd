@echo off
REM Start the opencodez-free local server on Windows.
REM Requires Node.js >= 22.18 (native TypeScript support).
setlocal
cd /d "%~dp0.."
node src/index.ts %*
