@echo off
call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 -vcvars_ver=14.40
cd /d U:\dev\OyasumiVR
code .