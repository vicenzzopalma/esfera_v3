@echo off
set JAVA_HOME=D:\Programs\jdk17flat
set ANDROID_HOME=D:\Programs\android-sdk
set PATH=D:\Programs\jdk17flat\bin;%PATH%
D:\Programs\gradle-8.9\bin\gradle.bat --no-daemon assembleRelease
echo GRADLE_EXIT=%ERRORLEVEL%
