@echo off
REM Fog chess launcher for Windows: runs the bundled JAS server (vendor\jas)
REM on this repo's apps\ folder, on its own port so it can sit beside an
REM everyday JAS on 4500.
setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

if not exist "%DIR%\vendor\jas\jas.cmd" goto submodules
if not exist "%DIR%\vendor\obscuro-chess\vendor\obscuro\package.json" goto submodules
goto run

:submodules
echo fog-chess: submodules missing, running git submodule update --init --recursive
git -C "%DIR%" submodule update --init --recursive || exit /b 1

:run
set "JAS_APPS=%DIR%\apps"
if not defined PORT set "PORT=4510"
echo Fog chess: http://localhost:%PORT%/fog-chess
call "%DIR%\vendor\jas\jas.cmd" %*
