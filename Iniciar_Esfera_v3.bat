@echo off
title Esfera v3 — Inicializador Nao-Bloqueante
echo ============================================================
echo   INICIANDO ESFERA HUB V3 (HIGH-PERFORMANCE C++ ENGINE)
echo ============================================================
echo.
cd /d "%~dp0"

if exist "%~dp0src-tauri\target\release\esfera_v3.exe" (
    echo [1/2] Executavel de Release encontrado! Iniciando Esfera v3...
    start "" "%~dp0src-tauri\target\release\esfera_v3.exe"
    echo.
    echo [SUCESSO] Esfera v3 iniciado!
    timeout /t 2 >nul
    exit
)

echo [1/2] Iniciando em Modo Desenvolvedor (Dev)...
start "Esfera v3 Server" cmd /k "cd /d %~dp0 && npx tauri dev"

echo.
echo [SUCESSO] Esfera v3 iniciado em processo independente!
timeout /t 3 >nul
exit
