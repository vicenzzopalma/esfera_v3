# Build e Injeção do Agente Android (Esfera Agent) — Ambiente Windows sem Admin

Passo-a-passo validado em 2026-08-03 numa máquina Windows onde o usuário **não tem privilégios de administrador** e o `winget install` de MSI (Temurin) falha com código 1602 (UAC). Tudo foi instalado via download de ZIP + extração em `D:\Programs` (sem tocar em `C:\Program Files`).

## 1. Pré-requisitos (baixados de ZIP, extraídos em D:\Programs)

- **JDK 17 (Temurin)**: `https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20%2B8/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20_8.zip` → extrair para `D:\Programs\jdk17`.
- **Android cmdline-tools**: `https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip` → extrair para `D:\Programs\android-sdk\cmdline-tools\latest` (o zip vem com uma pasta `cmdline-tools`; mover o conteúdo para `latest\`).
- **Gradle 8.9**: `https://services.gradle.org/distributions/gradle-8.9-bin.zip` → extrair para `D:\Programs\gradle-8.9`.

> O projeto `src-agent` **não tem** `gradlew`. Usa-se o Gradle binário direto. AGP 8.1.4 + Kotlin 1.9.10 + compileSdk 34 são compatíveis com Gradle 8.9.

## 2. Instalar platform-34 + build-tools (o `cmd.exe //c` NÃO funciona sob MSYS)

No MSYS/bash do Hermes, `cmd.exe //c "..."` abre o prompt interativo e **ignora** o comando. Por isso o `sdkmanager.bat` nunca rodou via `cmd`. Solução: invocar o `SdkManagerCli` **diretamente via java.exe**, com `cwd` em `lib/` e caminhos **Windows** (não Unix `/d/...`):

```bat
rem Criar licenças (hashes conhecidos) antes de instalar:
mkdir D:\Programs\android-sdk\licenses
echo 24333f8a63b6825ea9c5514f83c2829b004d1fee > D:\Programs\android-sdk\licenses\android-sdk-license
echo 84831b9409646a918e30573bab4c9c91346d8abd > D:\Programs\android-sdk\licenses\android-sdk-preview-license
```

```bash
cd /d/Programs/android-sdk/cmdline-tools/latest/lib
/d/Programs/jdk17/bin/java.exe \
  -Dcom.android.sdklib.toolsdir="D:/Programs/android-sdk/cmdline-tools/latest" \
  -classpath "sdkmanager-classpath.jar" \
  com.android.sdklib.tool.sdkmanager.SdkManagerCli \
  --sdk_root="D:/Programs/android-sdk" \
  "platforms;android-34" "build-tools;34.0.0"
```

## 3. Compilar e assinar o APK

```bash
cd /d/Novo/Esfera\ v3/src-agent
export JAVA_HOME="D:/Programs/jdk17"
export ANDROID_HOME="D:/Programs/android-sdk"
export ANDROID_SDK_ROOT="D:/Programs/android-sdk"
export PATH="/d/Programs/jdk17/bin:/d/Programs/gradle-8.9/bin:$PATH"
/d/Programs/gradle-8.9/bin/gradle.bat assembleRelease --no-daemon
```

> O `build.gradle.kts` original tinha `isMinifyEnabled = true`, que quebrava o release com R8 (`Missing class org.slf4j.impl.StaticLoggerBinder`, dependência transitiva do Ktor). Foi alterado para `isMinifyEnabled = false` (APK de agente MDM interno — aceitável).

APK gerado em `src-agent/app/build/outputs/apk/release/app-release-unsigned.apk`.

Assinar (keytool/apksigner precisam de `JAVA_HOME` em caminho **Windows**):

```bash
export JAVA_HOME="D:\\Programs\\jdk17"
/d/Programs/jdk17/bin/keytool.exe -genkey -v \
  -keystore "D:\Programs\esfera-debug.keystore" -alias esfera \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass esfera123 -keypass esfera123 \
  -dname "CN=Esfera,OU=Dev,O=Esfera,L=SP,ST=SP,C=BR"

APK="D:\Novo\Esfera v3\public\Esfera_Agent_ADB.apk"
KS="D:\Programs\esfera-debug.keystore"
"D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat" sign \
  --ks "$KS" --ks-key-alias esfera --ks-pass pass:esfera123 \
  --key-pass pass:esfera123 --out "$APK" "$APK"
"D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat" verify "$APK"
```

> IMPORTANTE: sempre usar caminhos `D:\...` (Windows) ao chamar `.bat` do Android SDK / keytool / apksigner. Caminhos `/d/...` (Unix) são convertidos errado pelo CMD.

## 4. Injetar nos dispositivos

O backend já faz o deploy automaticamente: `provision_device` → `install_agent_apk` faz `adb push` + `pm install -r -g` + start do service + keepalive + immunity. Ele procura o APK em:

- `public/Esfera_Agent_ADB.apk` (prioridade)
- `src-tauri/binaries/`, `src-tauri/`, `resources/`, etc. (fallback — ver `find_agent_apk_path` em `adb_manager.rs`)

Basta copiar o APK assinado para `public/Esfera_Agent_ADB.apk` (já feito) e acionar o provisionamento pela UI (DevicesTab) ou comando Tauri `provision_device`.

## 5. Verificação final (tudo compila junto)

- Backend: `cd src-tauri && cargo build` → `Finished dev profile`.
- Frontend: `cd .. && npm run build` → 1877 módulos, OK.
- Agente: APK em `public/Esfera_Agent_ADB.apk`, `apksigner verify` OK.
