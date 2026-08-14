# WORKSPACE RULES — ESFERA V3

## 🚨 REGRA CRÍTICA DE BUILD DO APLICATIVO DESKTOP TAURI

1. **JAMAIS compilar o executável final usando `cargo build` ou `cargo build --release` em `src-tauri`**:
   - `cargo build` compila apenas o backend em Rust sem empacotar o frontend React (`dist/`).
   - O `.exe` resultante falha em runtime com o erro `ERR_CONNECTION_REFUSED` / `localhost se recusou a se conectar` no computador do cliente/gestor.

2. **O ÚNICO comando permitido para gerar o `.exe` / `.msi` de produção autônomo (Standalone) é**:
   ```bash
   npm run tauri build
   ```

3. **Compilação sob Demanda**:
   - Apenas compilar quando o usuário solicitar explicitamente ("compile", "faça o build", etc.). Ao fazer alterações sem solicitação de build, sempre concluir com `"não compilado"`.

---

## 🔒 REGRA CRÍTICA DE IMUTABILIDADE ABSOLUTA DE NOMES E IDENTIDADE DE DISPOSITIVOS

1. **PROIBIÇÃO TOTAL DE RENOMEAÇÃO AUTOMÁTICA OU EM LOTE**:
   - O nome dado pelo operador a um aparelho é **SOBERANO e IMUTÁVEL**.
   - **JAMAIS** executar scripts, comandos ou rotinas automáticas de renomeação em lote ("Aparelho 1, 2, 3..."), resets de banco de dados ou reatribuição de nomes de dispositivos existentes.
   - A tabela `ESF_DeviceIdentity` (local e na VPS) é a **âncora definitiva** de hardware: uma vez salvo, o nome pertence exclusivamente ao operador.

2. **COMPORTAMENTO OBRIGATÓRIO DO SISTEMA (ESCALA DE 100+ DISPOSITIVOS)**:
   - Rotinas de reconexão ADB, auto-recovery, descoberta de rede ou sincronização com a VPS devem **APENAS LER E PRESERVAR** o nome existente vinculado ao `EsferaDeviceId`.
   - A alteração de nome só pode ocorrer por clique e confirmação manual do usuário no modal de configurações.
