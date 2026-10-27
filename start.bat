@echo off
setlocal
cd /d "%~dp0"

rem Si ya hay algo escuchando en el 4520, no levantamos un segundo server.
netstat -ano | findstr /c:":4520 " | findstr /i "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo El grabador ya estaba corriendo.
  start "" "http://localhost:4520"
  exit /b 0
)

echo Levantando el grabador de reuniones...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err.log'"

rem Esperamos a que el puerto responda antes de abrir el navegador
set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
set /a tries+=1
netstat -ano | findstr /c:":4520 " | findstr /i "LISTENING" >nul 2>&1
if %errorlevel%==0 goto ready
if %tries% geq 20 (
  echo No arranco. Revisa server.err.log
  pause
  exit /b 1
)
goto wait

:ready
start "" "http://localhost:4520"
echo Listo: http://localhost:4520
