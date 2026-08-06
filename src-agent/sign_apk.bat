@echo off
set JAVA_HOME=D:\Programs\jdk17flat
set PATH=D:\Programs\jdk17flat\bin;%PATH%
cd /d D:\Novo\Esfera^ v3\src-agent\app\build\outputs\apk\release
D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat sign --ks D:\Programs\esfera-debug.keystore --ks-key-alias esfera --ks-pass pass:esfera123 --key-pass pass:esfera123 --out app-release-signed.apk app-release-unsigned.apk
echo SIGN_EXIT=%ERRORLEVEL%
D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat verify app-release-signed.apk
echo VERIFY_EXIT=%ERRORLEVEL%
