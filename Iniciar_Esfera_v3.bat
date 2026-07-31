@echo off
title Esfera v3 — Inicializador Nao-Bloqueante
echo ============================================================
echo   INICIANDO ESFERA HUB V3 (HIGH-PERFORMANCE C++ ENGINE)
echo ============================================================
echo.
cd /d "%~dp0"

echo [1/2] Verificando compilacao e iniciando aplicativo...
start /b npx tauri dev

echo.
echo [SUCESSO] Esfera v3 iniciado! Esta janela pode ser minimizada.
exit
