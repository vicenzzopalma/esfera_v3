param(
    [ValidateSet("release", "debug")]
    [string]$Configuration = "release"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir = Join-Path $ProjectRoot "src-agent"
$OutputDir = Join-Path (Join-Path $ProjectRoot "src-tauri") "binaries"

Write-Host "=== Esfera Agent APK Build ===" -ForegroundColor Cyan
Write-Host "Configuration: $Configuration" -ForegroundColor Cyan

# Check prerequisites
$javaVersion = java -version 2>&1
if (-not $?) {
    Write-Error "JDK 17+ nao encontrado. Instale o JDK 17+ e adicione ao PATH."
    exit 1
}
Write-Host "Java encontrado" -ForegroundColor Green

if (-not (Test-Path "$env:ANDROID_HOME\platforms")) {
    Write-Error "Android SDK nao encontrado (ANDROID_HOME=$env:ANDROID_HOME)"
    exit 1
}
Write-Host "Android SDK encontrado em $env:ANDROID_HOME" -ForegroundColor Green

# Build
Set-Location -LiteralPath $AgentDir
Write-Host "Executando Gradle build..." -ForegroundColor Yellow

if ($Configuration -eq "release") {
    & "$AgentDir\gradlew.bat" assembleRelease
} else {
    & "$AgentDir\gradlew.bat" assembleDebug
}

if (-not $?) {
    Write-Error "Falha no build do APK"
    exit 1
}

# Copy APK to binaries
if ($Configuration -eq "release") {
    $apkSource = Join-Path $AgentDir "app" "build" "outputs" "apk" "release" "app-release.apk"
} else {
    $apkSource = Join-Path $AgentDir "app" "build" "outputs" "apk" "debug" "app-debug.apk"
}

if (-not (Test-Path $apkSource)) {
    Write-Error "APK nao encontrado em $apkSource"
    exit 1
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$apkDest = Join-Path $OutputDir "Esfera_Agent_ADB.apk"
Copy-Item -LiteralPath $apkSource -Destination $apkDest -Force

Write-Host "APK copiado para: $apkDest" -ForegroundColor Green
Write-Host "Build concluido com sucesso!" -ForegroundColor Cyan
Set-Location -LiteralPath $ProjectRoot
