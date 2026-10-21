@echo off
rem ==========================================================================
rem  Deftaudio PicoROM - Korg DDD expansion sound bank encoder (1 to 8 sounds)
rem
rem  Usage:  Deftaudio_PicoROM_Process.bat "folder with WAVs" [expected count]
rem
rem  Converts the WAV files of one folder (in filename order) into
rem  banks\<folder name>.bin, a 32768-byte Korg DDD sound bank.
rem  Exit code: 0 = bank written, 1 = error, 2 = folder has no WAV files.
rem ==========================================================================
setlocal EnableExtensions DisableDelayedExpansion

set "here=%~dp0"
set "meta=%here%tools\meta"
set "sox=%here%tools\sox\sox.exe"
set "soxdither=%here%tools\soxdither\sox.exe"

rem -- Sample rate. 44100 sets the normal pitch near tune 64 on the DDD;
rem -- the original scripts used 25640 (normal pitch near tune 0).
set "rate=44100"

if "%~1"=="" (
    echo Usage: %~nx0 folderpath [count]
    exit /b 1
)

rem -- Resolve the folder to a full path; the bank is named after it.
for %%A in ("%~1\.") do set "folder=%%~fA"
for %%A in ("%folder%") do set "bankname=%%~nxA"
if not exist "%folder%\" (
    echo Critical Error: folder "%folder%" does not exist.
    exit /b 1
)

echo.
echo === %bankname% ===

call :need "%sox%" || exit /b 1
call :need "%soxdither%" || exit /b 1
call :need "%meta%\57.ddd" || exit /b 1
call :need "%meta%\1.ddd" || exit /b 1
call :need "%meta%\4.ddd" || exit /b 1

rem -- Count the WAV files. Hidden files and macOS "._" files are ignored.
set "count=0"
for /f "eol=| delims=" %%F in ('dir /b /a-d-h /on "%folder%\*.wav" 2^>nul') do call :count "%%F"

if %count% EQU 0 (
    echo No WAV files - this bank will be empty.
    exit /b 2
)
if %count% GTR 8 (
    echo Critical Error: %count% WAV files found, a bank holds at most 8.
    exit /b 1
)
if not "%~2"=="" if not "%~2"=="%count%" (
    echo Critical Error: expected %~2 WAV files, found %count%.
    exit /b 1
)
call :need "%meta%\%count%x_1.ddd" || exit /b 1

rem -- Samples per sound for 1..8 sounds. Every sound is padded with silence
rem -- or cut to exactly this length, so the header addresses always match
rem -- (SoX's fade already pads to its stop position; pad/trim makes it explicit).
for /f "tokens=%count%" %%L in ("32460 16230 10820 8115 6492 5410 4637 4000") do set "len=%%L"
echo %count% sound(s), %len% samples each at %rate% Hz.

set "work=%here%temp\%bankname%"
if exist "%work%" rmdir /s /q "%work%"
mkdir "%work%"
if not exist "%here%banks" mkdir "%here%banks"
set "out=%here%banks\%bankname%.bin"
if exist "%out%" del "%out%"

rem -- Convert each WAV. Temporary files are numbered, so names that are the
rem -- same in their first 8 characters can no longer overwrite each other.
set "idx=0"
set "failed="
for /f "eol=| delims=" %%F in ('dir /b /a-d-h /on "%folder%\*.wav" 2^>nul') do call :convert "%%F"
if defined failed goto :fail
if not "%idx%"=="%count%" (
    echo Critical Error: converted %idx% of %count% files.
    goto :fail
)

rem -- Header: <N>x_1.ddd name1 <N>x_2.ddd name2 ... name<N> <N>x_<N+1>.ddd
copy /b "%meta%\%count%x_1.ddd" "%out%" >nul
for /l %%i in (1,1,%count%) do call :header %%i
if defined failed goto :fail

rem -- Sample data. 8 sounds: 57 bytes of silence after each, 4 at the end.
rem -- 7 sounds: 1 byte at the end. 1..6 sounds fill the bank exactly.
for /l %%i in (1,1,%count%) do call :data %%i
if "%count%"=="8" call :append "%meta%\4.ddd"
if "%count%"=="7" call :append "%meta%\1.ddd"
if defined failed goto :fail

set "size=0"
for %%S in ("%out%") do set "size=%%~zS"
if not "%size%"=="32768" (
    echo Critical Error: bank is %size% bytes instead of 32768.
    goto :fail
)
echo Success: banks\%bankname%.bin written - 32768 bytes.
rmdir /s /q "%work%" 2>nul
rmdir "%here%temp" 2>nul
exit /b 0

:fail
if exist "%out%" del "%out%"
rmdir /s /q "%work%" 2>nul
rmdir "%here%temp" 2>nul
exit /b 1


rem --------------------------------------------------------------------------
:count
set "nm=%~1"
if "%nm:~0,2%"=="._" goto :eof
set /a count+=1
goto :eof

:convert
set "nm=%~1"
if "%nm:~0,2%"=="._" goto :eof
if defined failed goto :eof
set /a idx+=1
set "DDD_NAME=%~n1"
set "DDD_OUT=%work%\%idx%.nam"
echo   %idx%. "%~1"
rem -- Normalize, resample, mono, trim leading silence (below 0.2 percent),
rem -- fade, then pad/cut to exactly %len% samples.
"%sox%" -V1 -D --norm=-0.3 "%folder%\%~1" "%work%\%idx%.wav" rate %rate% channels 1 silence 1 1 0.20%% fade p 2s %len%s 50s pad 0 %len%s trim 0 %len%s
if errorlevel 1 (
    echo   Critical Error: SoX could not convert this file.
    set "failed=1"
    goto :eof
)
rem -- Dither to 8-bit unsigned raw PCM.
"%soxdither%" -V1 "%work%\%idx%.wav" --bits 8 --encoding unsigned-integer "%work%\%idx%.raw" dither -r
if errorlevel 1 (
    echo   Critical Error: SoX could not convert this file to 8-bit.
    set "failed=1"
    goto :eof
)
rem -- Sound name: first 8 characters of the file name, non-ASCII characters
rem -- replaced by "_", padded with spaces to exactly 8 bytes.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$n = $env:DDD_NAME -replace '[^\x20-\x7E]', '_'; if ($n.Length -gt 8) { $n = $n.Substring(0, 8) }; [IO.File]::WriteAllBytes($env:DDD_OUT, [Text.Encoding]::ASCII.GetBytes($n.PadRight(8)))" >nul 2>nul
set "namesize=0"
if exist "%DDD_OUT%" for %%S in ("%DDD_OUT%") do set "namesize=%%~zS"
if "%namesize%"=="8" goto :eof
rem -- Without PowerShell: the first 8 characters, written by cmd itself.
set "short=%DDD_NAME%        "
set "short=%short:~0,8%"
<nul set /p "=%short%" >"%DDD_OUT%"
for %%S in ("%DDD_OUT%") do set "namesize=%%~zS"
if "%namesize%"=="8" goto :eof
rem -- Last resort (e.g. a name starting with a space): a generic name.
<nul set /p "=SOUND %idx% " >"%DDD_OUT%"
goto :eof

:header
set /a next=%1+1
call :append "%work%\%1.nam"
call :append "%meta%\%count%x_%next%.ddd"
goto :eof

:data
call :append "%work%\%1.raw"
if "%count%"=="8" call :append "%meta%\57.ddd"
goto :eof

:need
if exist "%~1" exit /b 0
echo Critical Error: "%~1" cannot be found. Do not alter the "tools" folder.
exit /b 1

:append
if not exist "%~1" (
    echo Critical Error: missing "%~1".
    set "failed=1"
    goto :eof
)
copy /b "%out%" + "%~1" "%out%.part" >nul
move /y "%out%.part" "%out%" >nul
goto :eof
