@echo off
REM ============================================================
REM Esfera v3 - setup_esfera_device.bat
REM Torna o agente "indestrutivel" no celular conectado via USB.
REM
REM Nivel 1 (sem root): Device Owner via dpm set-device-owner.
REM   - App nao desinstalavel, imune a otimizacao de bateria, sobrevive a reboot.
REM Nivel 2 (root): se o aparelho estiver rootado (su/Magisk), move o app para
REM   /system/priv-app -> vira app de sistema (sobrevive a factory reset do user space).
REM
REM PREREQUISITOS:
REM   - Celular com USB debug ativo e autorizado neste PC.
REM   - APP ja instalado (adb install -r app-release-signed.apk).
REM   - Para Device Owner: o app NAO pode ter conta Google sincronizada que
REM     bloqueie; se falhar, faca um factory reset rapido ou remova contas primeiro.
REM ============================================================

setlocal enabledelayedexpansion
set PKG=com.esfera.agent
set RECEIVER=.AdminReceiver
set APK=C:\Users\vicenzzo.palma\Desktop\EsferaAgent\app-release-signed.apk

echo ============================================================
echo  Esfera Agent - Setup de persistencia (Device Owner / System)
echo ============================================================
echo.

REM Verifica device
adb devices | findstr /r "device$" >nul
if errorlevel 1 (
  echo [ERRO] Nenhum celular autorizado encontrado. Plugue via USB e aceite a depuracao.
  pause
  exit /b 1
)

echo [1/4] Garantindo que o app esta instalado...
if exist "%APK%" (
  adb install -r "%APK%"
) else (
  echo [AVISO] APK nao encontrado em %APK%. Se ja esta instalado, ignore.
)

echo [2/4] Aplicando Device Owner (trava o app como dono do aparelho)...
adb shell dpm set-device-owner %PKG%/%RECEIVER%
if errorlevel 1 (
  echo [AVISO] Device Owner falhou. Possiveis causas: conta Google ativa ou ja e profile owner.
  echo         Faca um factory reset e rode este script ANTES de adicionar conta, ou use o caminho root abaixo.
) else (
  echo [OK] Device Owner aplicado. O agente agora e indestrutivel (sem root).
)

echo [3/4] Tentando nivel root (system-app) se o aparelho estiver rootado...
adb shell "su -c 'echo root_ok'" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Aparelho NAO rootado (ou su indisponivel). Device Owner ja basta para o objetivo.
  goto :fim
)

echo [INFO] Root detectado. Instalando como app de sistema (/system/priv-app)...
adb shell su -c "mount -o remount,rw /system"
adb shell su -c "mkdir -p /system/priv-app/EsferaAgent"
adb push "%APK%" /sdcard/esfera_agent_tmp.apk
adb shell su -c "cp /sdcard/esfera_agent_tmp.apk /system/priv-app/EsferaAgent/EsferaAgent.apk"
adb shell su -c "chmod 644 /system/priv-app/EsferaAgent/EsferaAgent.apk"
adb shell su -c "chown root:root /system/priv-app/EsferaAgent/EsferaAgent.apk"
adb shell su -c "rm -f /sdcard/esfera_agent_tmp.apk"
adb shell su -c "mount -o remount,ro /system"
echo [OK] App de sistema instalado. Reinicie o celular para ativar.
adb reboot

:fim
echo.
echo ============================================================
echo  Pronto. Abra o app "Esfera Agent" uma vez para concluir o assistente
echo  (bateria sem restricao + Device Admin) e ele nunca mais para.
echo ============================================================
pause
