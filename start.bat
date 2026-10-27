@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"
set "ROOT=%CD%"
set "GHAZAL_ROOT=%CD%"
title Ghazal launcher

if not defined PORT set "PORT=3000"
set "MODE=%~1"
if not defined MODE set "MODE=dev"

echo ===================================================
echo             Ghazal Launcher
echo ===================================================
echo.

:: 1. Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    echo         Install Node.js 20.9 or newer from https://nodejs.org/ and try again.
    goto fail
)

:: 2. npm
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH.
    goto fail
)

:: 3. PowerShell (used to detect a server already holding the port)
where powershell >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Windows PowerShell was not found in PATH.
    goto fail
)

:: 4. Dependencies
if not exist "node_modules\next\package.json" (
    echo [INFO] Dependencies missing. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your network connection, then retry.
        goto fail
    )
    echo [INFO] Dependencies installed.
    echo.
)

:: 5. Mode
if /i "%MODE%"=="dev" goto start_dev
if /i "%MODE%"=="prod" goto start_prod
if /i "%MODE%"=="production" goto start_prod
if /i "%MODE%"=="build" goto run_build
if /i "%MODE%"=="clean" goto run_clean
if /i "%MODE%"=="stop" goto run_stop
if /i "%MODE%"=="help" goto show_help
if /i "%MODE%"=="--help" goto show_help
if /i "%MODE%"=="-h" goto show_help
if /i "%MODE%"=="/?" goto show_help
echo [WARN] Unknown mode "%MODE%". Falling back to dev.
goto start_dev


:show_help
echo Usage:
echo   start.bat           Start the dev server (hot reload)
echo   start.bat prod      Build if needed, then start the production server
echo   start.bat build     Build the production bundle only
echo   start.bat stop      Stop Node servers started from this folder
echo   start.bat clean     Delete .next caches and start from scratch next time
echo   start.bat help      Show this help
echo.
echo Options:
echo   set PORT=3100 ^&^& start.bat    Use a different port (default 3000)
echo   set GHAZAL_NO_BROWSER=1 ^&^& start.bat    Do not open a browser
echo.
echo If the page says "missing required error components", run:
echo   start.bat stop
echo   start.bat
goto done


:: ---------------------------------------------------------------
:: dev
:: ---------------------------------------------------------------
:start_dev
call :prepare_port
if errorlevel 1 goto fail

:: Never run a second dev server: two servers sharing .next is what
:: produces "missing required error components, refreshing...".
if defined PORT_PID if /i "%PORT_IMAGE%"=="node.exe" (
    echo [INFO] A Node server is already listening on port %PORT% ^(PID %PORT_PID%^).
    echo [INFO] Not starting a second copy - that is what corrupts the .next cache.
    echo [INFO] Opening http://localhost:%PORT%
    echo [INFO] To replace it, run "start.bat stop" first.
    if not defined GHAZAL_NO_BROWSER start "" "http://localhost:%PORT%"
    goto done
)

call :ensure_dev_cache
if errorlevel 1 goto fail

echo [INFO] Starting dev server on http://localhost:%PORT%
echo [INFO] Press Ctrl+C in this window to stop the server.
echo ---------------------------------------------------
echo.

if not defined GHAZAL_NO_BROWSER start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%PORT%"

call npm run dev -- -p %PORT%
goto server_ended


:: ---------------------------------------------------------------
:: prod
:: ---------------------------------------------------------------
:start_prod
call :prepare_port
if errorlevel 1 goto fail

if defined PORT_PID if /i "%PORT_IMAGE%"=="node.exe" (
    echo [INFO] A Node server is already listening on port %PORT% ^(PID %PORT_PID%^).
    echo [INFO] Opening http://localhost:%PORT%
    echo [INFO] To replace it, run "start.bat stop" first.
    if not defined GHAZAL_NO_BROWSER start "" "http://localhost:%PORT%"
    goto done
)

:: A dev .next has no BUILD_ID; "next start" would fail on it. A build that
:: predates the current sources would serve stale code, so rebuild as well.
call :needs_build
if defined NEEDS_BUILD (
    echo [INFO] Production build is missing or older than the sources.
    echo [INFO] Running npm run build first...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed. Production server not started.
        goto fail
    )
)

echo [INFO] Starting production server on http://localhost:%PORT%
echo [INFO] Press Ctrl+C in this window to stop the server.
echo ---------------------------------------------------
echo.

if not defined GHAZAL_NO_BROWSER start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"

call npm run start -- -p %PORT%
goto server_ended


:: ---------------------------------------------------------------
:: build
:: ---------------------------------------------------------------
:run_build
echo [INFO] Building production bundle ^(npm run build^)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    goto fail
)
echo.
echo [SUCCESS] Build completed. Start it with: start.bat prod
goto done


:: ---------------------------------------------------------------
:: clean
:: ---------------------------------------------------------------
:run_clean
echo [INFO] Removing .next caches and TypeScript build info...
call :wipe_next
for /d %%D in (".next.*") do (
    echo [INFO] Removing %%D
    rmdir /s /q "%%D" 2>nul
)
echo [DONE] Next start will compile from scratch.
goto done


:: ---------------------------------------------------------------
:: stop
:: ---------------------------------------------------------------
:run_stop
where powershell >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PowerShell not found, cannot stop servers automatically.
    goto fail
)
echo [INFO] Stopping Node processes started from "%ROOT%"...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = $env:GHAZAL_ROOT; $found = @(); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | ForEach-Object { $found += $_.ProcessId }; $c = @(Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue)[0]; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { $found += $p.Id } }; $found = @($found | Sort-Object -Unique); if ($found.Count -gt 0) { $found | ForEach-Object { Write-Host ('  stopping PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } else { Write-Host '  nothing was running' }"
ping -n 3 127.0.0.1 >nul
call :probe_port
if defined PORT_PID echo [WARN] Port %PORT% is still busy ^(PID %PORT_PID%, %PORT_IMAGE%^).
echo [DONE]
goto done


:: ---------------------------------------------------------------
:: helpers
:: ---------------------------------------------------------------

:: Sets PORT_PID / PORT_IMAGE when something listens on %PORT%.
:probe_port
set "PORT_PID="
set "PORT_IMAGE="
for /f "tokens=1,2" %%A in ('powershell -NoProfile -Command "$c = @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)[0]; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Output ('' + $p.Id + ' ' + $p.ProcessName) } }"') do (
    set "PORT_PID=%%A"
    set "PORT_IMAGE=%%B.exe"
)
exit /b 0

:: Keeps %PORT% if free or already served by Node, otherwise moves to the
:: next free port so the browser URL and the server always agree.
:prepare_port
set /a PORT_TRIES=0
:prepare_port_loop
call :probe_port
if not defined PORT_PID exit /b 0
if /i "%PORT_IMAGE%"=="node.exe" exit /b 0
echo [WARN] Port %PORT% is used by "%PORT_IMAGE%" ^(PID %PORT_PID%^) - not a Node server.
set /a PORT+=1
set /a PORT_TRIES+=1
if %PORT_TRIES% geq 10 (
    echo [ERROR] Ports %PORT% and below all look busy. Pick one yourself, e.g.:
    echo         set PORT=3200 ^&^& start.bat
    exit /b 1
)
goto prepare_port_loop

:: Sets NEEDS_BUILD=1 when sources are newer than the production build.
:needs_build
set "NEEDS_BUILD="
if not exist ".next\BUILD_ID" (
    set "NEEDS_BUILD=1"
    exit /b 0
)
powershell -NoProfile -Command "$build = (Get-Item '.next\BUILD_ID').LastWriteTimeUtc; $paths = @('app','components','lib','data\catalog.json','next.config.js','package.json','tailwind.config.ts','postcss.config.js','tsconfig.json'); $newest = Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property LastWriteTimeUtc -Maximum; if ($newest.Maximum -and $newest.Maximum -gt $build) { exit 1 } else { exit 0 }"
if errorlevel 1 set "NEEDS_BUILD=1"
exit /b 0

:: Removes a .next folder that next dev cannot reuse safely.
:ensure_dev_cache
if not exist ".next" exit /b 0
if exist ".next\BUILD_ID" (
    echo [INFO] .next contains a production build - clearing it for dev mode...
    call :wipe_next
    exit /b 0
)
if exist ".next\server\app" exit /b 0
if exist ".next\server\pages" exit /b 0
if not exist ".next\build-manifest.json" exit /b 0
echo [INFO] .next looks incomplete (left over from a crashed or duplicated server) - clearing it...
call :wipe_next
exit /b 0

:wipe_next
if exist ".next" rmdir /s /q ".next" 2>nul
if exist ".next" (
    echo [WARN] Could not fully delete .next - a Node process may still be using it.
    echo        Run "start.bat stop" and try again.
)
if exist "tsconfig.tsbuildinfo" del /q "tsconfig.tsbuildinfo" 2>nul
exit /b 0

:server_ended
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
    echo [NOTICE] Server exited with code %EXIT_CODE%.
    echo          If the page said "missing required error components", run:
    echo            start.bat stop
    echo            start.bat
    pause
)
exit /b %EXIT_CODE%

:fail
echo.
pause
exit /b 1

:done
if /i not "%MODE%"=="dev" if /i not "%MODE%"=="prod" if /i not "%MODE%"=="production" pause
exit /b 0
