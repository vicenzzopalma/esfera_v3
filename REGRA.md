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

## 📌 CHECKLIST PRÉ-BUILD DE TODAS AS IAs

- [ ] Leu este arquivo (`REGRA.md`)?
- [ ] O comando disparado é `npm run tauri build`?
- [ ] O `.exe` resultante foi gerado após a inclusão da pasta `dist/` do React?
- [ ] **JAMAIS** informe ao usuário que o `.exe` gerado via `cargo build` está pronto para teste.
