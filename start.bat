@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"
title Ghazal for Gen Z

echo ===================================================
echo             Ghazal for Gen Z Launcher
echo ===================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not found in PATH.
    echo Please install Node.js [v18 or higher recommended] from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. Check npm
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not installed or not found in PATH.
    echo.
    pause
    exit /b 1
)

:: 3. Check node_modules
if not exist "node_modules\" (
    echo [INFO] Dependencies not found. Installing packages with npm install...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed. Please check your internet connection or npm setup.
        echo.
        pause
        exit /b %ERRORLEVEL%
    )
    echo [INFO] Dependencies installed successfully.
    echo.
)

:: 4. Determine Mode (dev / prod / build / help)
set "MODE=%~1"
if /i "%MODE%"=="prod" goto start_prod
if /i "%MODE%"=="production" goto start_prod
if /i "%MODE%"=="build" goto run_build
if /i "%MODE%"=="help" goto show_help
if /i "%MODE%"=="--help" goto show_help
if /i "%MODE%"=="-h" goto show_help
if /i "%MODE%"=="/?" goto show_help
goto start_dev

:show_help
echo Usage:
echo   start.bat         - Start in development mode (hot reload enabled)
echo   start.bat prod    - Start in production mode (fast and optimized)
echo   start.bat build   - Build the production bundle
echo   start.bat help    - Show this help message
echo.
pause
exit /b 0

:start_dev
echo [INFO] Starting development server (npm run dev)...
echo [INFO] Opening http://localhost:3000 in your browser...
echo.
echo Tip: Run "start.bat prod" if you prefer running the production build.
echo Press Ctrl+C in this window to stop the server.
echo ---------------------------------------------------
echo.

:: Launch browser in background after short delay
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3000"

call npm run dev
goto server_ended

:start_prod
if not exist ".next\" (
    echo [INFO] Production build not found. Running npm run build first...
    call npm run build
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Build failed. Cannot start production server.
        pause
        exit /b %ERRORLEVEL%
    )
)
echo [INFO] Starting production server (npm run start)...
echo [INFO] Opening http://localhost:3000 in your browser...
echo.
echo Press Ctrl+C in this window to stop the server.
echo ---------------------------------------------------
echo.

:: Launch browser in background after short delay
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:3000"

call npm run start
goto server_ended

:run_build
echo [INFO] Building production bundle (npm run build)...
call npm run build
if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] Build completed successfully.
) else (
    echo.
    echo [ERROR] Build failed.
)
pause
exit /b %ERRORLEVEL%

:server_ended
if %ERRORLEVEL% neq 0 (
    echo.
    echo [NOTICE] Server stopped with error code %ERRORLEVEL%.
    pause
)
