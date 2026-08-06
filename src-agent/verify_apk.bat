@echo off
set JAVA_HOME=D:\Programs\jdk17flat
set PATH=D:\Programs\jdk17flat\bin;%PATH%
cd /d D:\Novo\Esfera^ v3\src-agent\app\build\outputs\apk\release
D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat verify --verbose app-release-signed.apk
echo VERIFY_EXIT=%ERRORLEVEL%
