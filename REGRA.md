# 🚨 REGRAS OBRIGATÓRIAS DE BUILD DO APLICATIVO DESKTOP (ESFERA V3)

> **ATENÇÃO PARA TODAS AS IAs / AGENTES (Hermes, Antigravity, Subagentes)**:
> Esta regra DEVE ser lida e seguida rigorosamente **ANTES DE QUALQUER COMPILAÇÃO OU GERAÇÃO DE EXECUTÁVEL `.exe`**.

---

## ⛔ PROIBIÇÃO CRÍTICA: NUNCA USAR `cargo build` PARA ENTREGAR O `.EXE` FINAL

1. **O Erro do `cargo build`**:
   - Executar `cargo build` ou `cargo build --release` dentro da pasta `src-tauri` compila **apenas o backend em Rust**.
   - **NÃO empacota o frontend React/HTML/CSS**.
   - O `.exe` resultante fica em modo dev/debug incompleto e tenta abrir `http://localhost:1420` (ou `http://localhost:5173`), causando o erro de tela preta **`ERR_CONNECTION_REFUSED` / `localhost se recusou a se conectar`** no computador do cliente/gestor.

---

## ✅ REGRA OBRIGATÓRIA: O ÚNICO COMANDO VÁLIDO DE BUILD É `npm run tauri build`

Para compilar e entregar qualquer versão funcional e autônoma do aplicativo Desktop (`.exe` ou `.msi`):

1. **Comando Exclusivo**:
   ```bash
   npm run tauri build
   ```

2. **O que este comando faz automaticamente**:
   - Executa `npm run build` (compila o TypeScript e o Vite React para a pasta `dist/`).
   - Empacota os arquivos estáticos do frontend dentro do executável nativo do Rust.
   - Gera o `.exe` standalone completo e o instalador `.msi`.

3. **Caminho dos Artefatos Finais**:
   - `.exe` Standalone: `src-tauri/target/release/esfera_v3.exe`
   - Instalador `.msi`: `src-tauri/target/release/bundle/msi/esfera_v3_0.1.0_x64_en-US.msi`

---

## 🤖 REGRA OBRIGATÓRIA: BUILD DO AGENTE ANDROID (src-agent) SEM ADMIN

O agente Kotlin (`src-agent`) NÃO deve assumir Android SDK/JDK/GRADLE no PATH do sistema
(ambiente sem admin: toolchains vivem em `D:\Programs` via ZIP, nunca `C:\Program Files`).

1. **Toolchain (já provisionado em `D:\Programs`)**:
   - JDK 17: `D:\Programs\jdk17flat\bin\java.exe` (pasta original renomeada p/ tirar o `+` do path)
   - Android SDK: `D:\Programs\android-sdk` (cmdline-tools em `cmdline-tools\latest`)
   - Gradle 8.9: `D:\Programs\gradle-8.9\bin\gradle.bat`
   - Keystore de assinatura: `D:\Programs\esfera-debug.keystore` (alias `esfera`, senha `esfera123`)

2. **Como buildar o APK (cmd.exe /c com .bat no CWD do projeto)**:
   - Criar `src-agent\runbuild.bat`:
     ```
     @echo off
     set JAVA_HOME=D:\Programs\jdk17flat
     set ANDROID_HOME=D:\Programs\android-sdk
     set PATH=D:\Programs\jdk17flat\bin;%PATH%
     D:\Programs\gradle-8.9\bin\gradle.bat --no-daemon assembleRelease
     ```
   - Rodar: `cd /d/Novo/Esfera v3/src-agent && cmd.exe /c runbuild.bat`
     (NUNCA passar o path do .bat como argumento absoluto pro `cmd.exe /c` — o git-bash
     corrompe `D:\x` em `D:x`; use CWD + nome relativo.)

3. **Assinar o APK (obrigatório — assembleRelease gera UNSIGNED)**:
   - `src-agent\app\build\outputs\apk\release\runsign.bat`:
     ```
     @echo off
     set JAVA_HOME=D:\Programs\jdk17flat
     set PATH=D:\Programs\jdk17flat\bin;%PATH%
     D:\Programs\android-sdk\build-tools\34.0.0\apksigner.bat sign --ks D:\Programs\esfera-debug.keystore --ks-key-alias esfera --ks-pass pass:esfera123 --key-pass pass:esfera123 --out app-release-signed.apk app-release-unsigned.apk
     ```
   - Rodar no CWD `app\build\outputs\apk\release`: `cmd.exe /c runsign.bat`
   - APK final: `app-release-signed.apk` (instalar via `adb install -r` com path Windows `D:\...`).

4. **Auto-start do agente (sem root)**:
   - `BootReceiver` sozinho é bloqueado por fabricantes (Moto/Android 12+).
   - `BootJobService` (JobScheduler `setPersisted(true)`) é a forma oficial que sobrevive a reboot.
   - NUNCA tente rootar/exploit de celular para auto-start — use JobScheduler.

---

## 📌 CHECKLIST PRÉ-BUILD DE TODAS AS IAs

- [ ] Leu este arquivo (`REGRA.md`)?
- [ ] O comando disparado é `npm run tauri build` (desktop) / `cmd.exe /c runbuild.bat` (agent)?
- [ ] O `.exe` resultante foi gerado após a inclusão da pasta `dist/` do React?
- [ ] O APK foi assinado com `runsign.bat` (não entregue unsigned)?
- [ ] **JAMAIS** informe ao usuário que o `.exe` gerado via `cargo build` está pronto para teste.
- [ ] **JAMAIS** assuma Android SDK/JDK/GRADLE no PATH — use `D:\Programs`.
