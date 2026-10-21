@echo off
rem ==========================================================================
rem  Deftaudio PicoROM - builds PicoROM.BIN from [WAV_IN]\Bank1 ... Bank8
rem  Each BankN folder may hold 1 to 8 WAV files (taken in filename order).
rem  Empty or missing bank folders, and banks that fail, become empty banks.
rem ==========================================================================
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "errors=0"
set "empty=0"

if exist temp rmdir /s /q temp
if exist banks rmdir /s /q banks
mkdir banks

if not exist "tools\meta\empty.bin" (
    echo Critical Error: tools\meta\empty.bin cannot be found. Do not alter the "tools" folder.
    pause
    exit /b 1
)

echo Building banks from the [WAV_IN] folder...
for /l %%b in (1,1,8) do call :bank %%b

echo.
echo ======================================================================
if %empty% GTR 0 echo %empty% bank(s) had no WAV files and were left empty.
if %errors% EQU 0 echo All banks converted without errors.
if %errors% GTR 0 echo %errors% bank(s) FAILED and were replaced with empty data - see the messages above.
echo ======================================================================

rem -- The PicoROM address lines are wired in reverse: image order is 1,5,3,7,2,6,4,8.
copy /b banks\Bank1.bin + banks\Bank5.bin + banks\Bank3.bin + banks\Bank7.bin + banks\Bank2.bin + banks\Bank6.bin + banks\Bank4.bin + banks\Bank8.bin PicoROM.BIN >nul
set "size=0"
for %%S in (PicoROM.BIN) do set "size=%%~zS"
if not "%size%"=="262144" (
    echo Critical Error: PicoROM.BIN is %size% bytes instead of 262144. Not programming.
    pause
    exit /b 1
)
echo.
echo PicoROM.BIN generated - 262144 bytes. Use it for programming PicoROM.
echo.

set "answer="
set /p "answer=Do you want to program it now? (Y/N): "
if /i not "%answer%"=="Y" (
    echo Skipping programming.
    goto :done
)
if not exist "picorom-x86_64-pc-windows-msvc.exe" (
    echo Critical Error: picorom-x86_64-pc-windows-msvc.exe cannot be found.
    goto :done
)
echo Running the PicoROM tool, using "PicoROM" as the device name...
picorom-x86_64-pc-windows-msvc.exe upload -s PicoROM PicoROM.BIN 2mbit
if errorlevel 1 (
    echo PicoROM programming FAILED. Check that the device is connected and named "PicoROM".
) else (
    echo PicoROM programmed.
)

:done
echo.
echo Done.
pause
exit /b 0


rem --------------------------------------------------------------------------
:bank
set "bin=banks\Bank%1.bin"
if not exist "[WAV_IN]\Bank%1\" (
    echo.
    echo === Bank%1 ===
    echo Folder [WAV_IN]\Bank%1 does not exist - this bank will be empty.
    set /a empty+=1
    copy /b tools\meta\empty.bin "%bin%" >nul
    goto :eof
)
call Deftaudio_PicoROM_Process.bat "[WAV_IN]\Bank%1"
if errorlevel 2 (
    set /a empty+=1
    copy /b tools\meta\empty.bin "%bin%" >nul
    goto :eof
)
if errorlevel 1 (
    set /a errors+=1
    copy /b tools\meta\empty.bin "%bin%" >nul
    goto :eof
)
goto :eof
