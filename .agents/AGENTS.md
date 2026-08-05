# WORKSPACE RULES — ESFERA V3

## 🚨 REGRA CRÍTICA DE BUILD DO APLICATIVO DESKTOP TAURI

1. **JAMAIS compilar o executável final usando `cargo build` ou `cargo build --release` em `src-tauri`**:
   - `cargo build` compila apenas o backend em Rust sem empacotar o frontend React (`dist/`).
   - O `.exe` resultante falha em runtime com o erro `ERR_CONNECTION_REFUSED` / `localhost se recusou a se conectar` no computador do cliente/gestor.

2. **O ÚNICO comando permitido para gerar o `.exe` / `.msi` de produção autônomo (Standalone) é**:
   ```bash
   npm run tauri build
   ```

3. **Antes de realizar qualquer build do projeto, LEIA obrigatoriamente o arquivo `REGRA.md` na raiz do repositório**.
