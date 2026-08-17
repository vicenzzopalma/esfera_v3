@echo off
:: =====================================================================
:: SCRIPT DE REMOÇÃO FORÇADA E LIMPEZA - CXLOGON / NSSM (JAHASTECH)
:: COM AUTO-ELEVAÇÃO PARA ADMINISTRADOR AUTOMÁTICA
:: =====================================================================

:: Verifica se o script está rodando como Administrador
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :admin_execution
) else (
    echo =======================================================
    echo  Detectado usuario comum. Solicitando permissao Admin...
    echo =======================================================
    :: Invoca o UAC e reexecuta este mesmo script como Administrador
    powershell -Command "Start-Process -FilePath '%~dpnx0' -Verb RunAs"
    exit /b
)

:admin_execution
cls
echo =====================================================================
:: Muda o diretório atual para a pasta onde o script está localizado
cd /d "%~dp0"
title REMOVEDOR CXLOGON - ADMINISTRADOR

echo =====================================================================
echo                 REMOVENDO CXLOGON / NSSM - JAHASTECH
echo =====================================================================
echo.

echo [1/6] Parando o servico CxLogon...
sc stop CxLogon
timeout /t 2 /nobreak >nul

echo [2/6] Encerrando processos remanescentes (cxlogon.exe / nssm.exe)...
taskkill /F /IM cxlogon.exe /T
taskkill /F /IM nssm.exe /T
timeout /t 2 /nobreak >nul

echo [3/6] Removendo definicao do servico do Windows...
sc delete CxLogon
timeout /t 1 /nobreak >nul

echo [4/6] Limpando pastas e arquivos de instalacao...
if exist "C:\Program Files (x86)\Jahastech" (
    echo Removendo "C:\Program Files (x86)\Jahastech"...
    rd /s /q "C:\Program Files (x86)\Jahastech"
)
if exist "C:\ProgramData\Jahastech" (
    echo Removendo "C:\ProgramData\Jahastech"...
    rd /s /q "C:\ProgramData\Jahastech"
)
if exist "%LOCALAPPDATA%\Jahastech" (
    echo Removendo "%LOCALAPPDATA%\Jahastech"...
    rd /s /q "%LOCALAPPDATA%\Jahastech"
)

echo [5/6] Removendo chaves de registro associadas...
reg delete "HKLM\SYSTEM\CurrentControlSet\Services\CxLogon" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Jahastech" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\WOW6432Node\Jahastech" /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Jahastech" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CxLogon" /f >nul 2>&1

echo [6/6] Confirmando se os processos sumiram da memoria...
tasklist | findstr /I "cxlogon.exe nssm.exe" >nul
if %errorlevel% == 0 (
    echo [AVISO] Alguns processos ainda estao ativos. Recomendamos reiniciar o PC!
) else (
    echo [SUCESSO] Processos removidos da memoria com exito!
)

echo.
echo =====================================================================
echo                CONCLUIDO! CxLogon foi removido.
echo =====================================================================
echo.
echo Pressione qualquer tecla para fechar...
pause >nul
exit
