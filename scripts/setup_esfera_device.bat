@echo off
REM ============================================================
REM  setup_esfera_device.bat  —  Rotina CRONICA de setup de celular
REM  Aplica TUDO de uma vez num celular plugado (USB ou TCP):
REM   1. Imunidade de segundo plano (Doze/bateria nao mata o agente)
REM   2. Semeia a chave ADB do PC (/data/misc/adb/adb_keys) -> sem popup
REM   3. captive_portal_mode 0 (WiFi nao cai "sem internet")
REM   4. Sobe o agente Esfera em foreground-service
REM  Uso: setup_esfera_device.bat <serial_ou_ip:porta>
REM  Ex:  setup_esfera_device.bat 4200da8501667545
REM        setup_esfera_device.bat 192.168.1.83:5555
REM ============================================================
setlocal
if "%1"=="" (
  echo Uso: %~nx0 ^<serial^|ip:porta^>
  exit /b 1
)
set SERIAL=%1
set ADB=D:\Programs\android-sdk\platform-tools\adb.exe
set PKG=com.esfera.agent

echo [1/4] Imunidade de segundo plano...
%ADB% -s %SERIAL% shell "dumpsys deviceidle whitelist +%PKG%; cmd appops set %PKG% RUN_IN_BACKGROUND allow; cmd appops set %PKG% RUN_ANY_IN_BACKGROUND allow 2>/dev/null; settings put global wifi_sleep_policy 2; settings put global stay_on_while_plugged_in 7; device_config put activity_manager max_phantom_processes 2147483647"

echo [2/4] Semeia chave ADB (sem popup futuro)...
set KEY=%USERPROFILE%\.android\adbkey.pub
if exist "%KEY%" (
  for /f "usebackq delims=" %%K in ("%KEY%") do set PUB=%%K
  %ADB% -s %SERIAL% shell "mkdir -p /data/misc/adb 2>/dev/null; (cat /data/misc/adb/adb_keys 2>/dev/null | grep -qF '%PUB%' || echo %PUB% >> /data/misc/adb/adb_keys); chmod 640 /data/misc/adb/adb_keys; restorecon /data/misc/adb/adb_keys 2>/dev/null"
) else (
  echo   AVISO: %KEY% nao encontrado (rode 'adb keygen' antes)
)

echo [3/4] captive_portal_mode 0 (WiFi nao cai)...
%ADB% -s %SERIAL% shell "settings put global captive_portal_mode 0; settings put global captive_portal_detection_enabled 0"

echo [4/4] Sobe o agente...
%ADB% -s %SERIAL% shell "am start -n %PKG%/.MainActivity"
%ADB% -s %SERIAL% shell "am start-foreground-service %PKG%/.EsferaAgentService"

echo.
echo PRONTO. Celular %SERIAL% imune + agente ativo + chave semeada.
echo (Se pediu autorizacao na tela do celular, toque PERMITIR uma vez.)
endlocal
