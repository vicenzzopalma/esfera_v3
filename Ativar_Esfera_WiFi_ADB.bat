@echo off
chcp 65001 >nul
title Esfera v3 - Ativador Automatico Wi-Fi ADB
color 0A

echo ============================================================
echo         ESFERA V3 — ATIVADOR AUTOMATICO WI-FI ADB
echo ============================================================
echo.
echo 1. Conecte o celular Android via cabo USB ao computador.
echo 2. Certifique-se de que a Depuracao USB esta ativa.
echo.
echo Pressione qualquer tecla para ativar a conexao sem fio...
pause >nul

echo.
echo [1/4] Ativando porta TCP 5555 no celular...
adb tcpip 5555

echo.
echo [2/4] Extraindo endereco IP do celular na rede Wi-Fi...
for /f "tokens=*" %%a in ('adb shell "ip route | grep wlan0 | grep src"' ) do (
    for /f "tokens=9" %%b in ("%%a") do set PHONE_IP=%%b
)

if "%PHONE_IP%"=="" (
    for /f "tokens=*" %%a in ('adb shell getprop dhcp.wlan0.ipaddress') do set PHONE_IP=%%a
)

echo.
if "%PHONE_IP%"=="" (
    echo [X] Nao foi possivel detectar o IP do Wi-Fi automaticamente.
    echo [X] Verifique se o celular esta conectado no Wi-Fi.
    goto FIM
)

echo [3/4] IP do Celular Detectado: %PHONE_IP%
echo [3/4] Conectando via rede sem fio ao Esfera v3...
adb connect %PHONE_IP%:5555

echo.
echo [4/4] Injetando regras de imunidade e persistencia no Android...
adb -s %PHONE_IP%:5555 shell "setprop persist.adb.tcp.port 5555"
adb -s %PHONE_IP%:5555 shell "settings put global wifi_sleep_policy 2"
adb -s %PHONE_IP%:5555 shell "settings put global stay_on_while_plugged_in 7"
adb -s %PHONE_IP%:5555 shell "dumpsys deviceidle disable"

echo.
echo ============================================================
echo [V] SUCESSO! Celular conectado via Wi-Fi no Esfera v3!
echo [V] Voce ja pode REMOVER o cabo USB do computador!
echo ============================================================

:FIM
echo.
pause
