@echo off
rem Kept for compatibility. Encodes a folder that must hold exactly 7 WAV file(s).
rem Deftaudio_PicoROM_Process.bat does the work for any count from 1 to 8.
call "%~dp0Deftaudio_PicoROM_Process.bat" "%~1" 7
exit /b %errorlevel%
