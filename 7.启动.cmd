@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 goto try_py
python "%~dp07.news-server.py"
goto finished
:try_py
where py >nul 2>nul
if errorlevel 1 goto missing
py -3 "%~dp07.news-server.py"
goto finished
:missing
echo Python 3.8+ is required. Install Python and run this launcher again.
pause
exit /b 1
:finished
if errorlevel 1 pause
