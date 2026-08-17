@echo off
echo ====================================
echo REMOVENDO CxLogon / NSSM - Jahastech
echo ====================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Execute este script como ADMINISTRADOR.
    pause
    exit /b 1
)

echo [1/5] Parando servico CxLogon...
sc stop CxLogon
timeout /t 2 /nobreak >nul

echo [2/5] Matando processos...
taskkill /F /IM cxlogon.exe /T >nul 2>&1
taskkill /F /IM nssm.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul

echo [3/5] Deletando servico do Windows...
sc delete CxLogon
timeout /t 1 /nobreak >nul

echo [4/5] Removendo arquivos de instalacao...
rd /s /q "C:\Program Files (x86)\Jahastech" >nul 2>&1
rd /s /q "C:\ProgramData\Jahastech" >nul 2>&1
del /f /q "%LOCALAPPDATA%\Jahastech\*.*" >nul 2>&1
rd /s /q "%LOCALAPPDATA%\Jahastech" >nul 2>&1

echo [5/5] Removendo entradas de Registro...
reg delete "HKLM\SYSTEM\CurrentControlSet\Services\CxLogon" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Jahastech" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\WOW6432Node\Jahastech" /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Jahastech" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CxLogon" /f >nul 2>&1

echo.
echo ====================================
echo CONCLUIDO. CxLogon removido.
echo Reinicie o computador para limpeza
echo total da memoria e servicos.
echo ====================================
pause
