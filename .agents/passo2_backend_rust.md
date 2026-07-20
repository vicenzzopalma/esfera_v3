# Planejamento Esfera v3 — Passo 2: Back-end (Rust)

Este documento contém o contexto do que foi feito no front-end e os passos exatos para a próxima fase (Back-end), focado 100% no motor em Rust.

## 📌 Contexto Atual (Front-end Concluído)
- **Tecnologias:** Tauri v2, React, TailwindCSS v4, TypeScript.
- **Estado Visual:** Toda a UI está pronta e navegável (Login, Empresas, Dispositivos, Campanhas, Automações, Logs, Config).
- **Controle de Acesso:** Implementado mock para Master, Gestor e Colaborador.
- **Dados:** Atualmente, a interface consome dados de teste de `src/mock-data.ts`.
- **A Ponte IPC:** A interface está isolada e pronta para chamar as funções Rust usando `invoke()`.

## 🚀 Próximos Passos (Para a IA no próximo chat)
Quando abrir o próximo chat para iniciar o back-end, peça para a IA focar exclusivamente na pasta `src-tauri/` e ignorar o front-end. 

Aqui estão as tarefas estruturadas para o back-end:

### 1. Configuração do Banco de Dados (SQLite)
- Adicionar dependências no `Cargo.toml` (`rusqlite` ou `sqlx`, `serde`, `serde_json`).
- Criar a estrutura do banco de dados local para substituir as entidades do `mock-data.ts`:
  - `users`, `companies`, `devices`, `campaigns`, `automations`, `contacts`, `logs`.
- Criar funções de inicialização (`create_tables`) executadas no setup do Tauri.

### 2. Integração com ADB (Android Debug Bridge)
- Criar `src-tauri/src/adb_manager.rs`.
- Implementar chamadas para o binário do ADB (usando `std::process::Command` ou similar) para:
  - Listar dispositivos conectados e status da bateria.
  - Conectar/Desconectar dispositivos via IP/Porta.
  - Enviar eventos de toque/texto para disparos.

### 3. Criar os Comandos IPC (Tauri Commands)
- Criar `src-tauri/src/comandos.rs`.
- Implementar as funções com `#[tauri::command]` que o front-end irá chamar. Exemplos necessários:
  - `login(username, password) -> Result<User, String>`
  - `get_companies() -> Result<Vec<Company>, String>`
  - `get_devices(company_id) -> Result<Vec<Device>, String>`
  - `connect_device(ip, port) -> Result<String, String>`
  - `create_campaign(data) -> Result<(), String>`
- Registrar todos os comandos no `main.rs` (em `tauri::Builder::default().invoke_handler(...)`).

### 4. Motor de Disparos (Threads Assíncronas)
- Criar lógica para gerenciar as campanhas em background sem travar a interface.
- Implementar um "Worker" em Rust que:
  - Lê a fila de contatos pendentes do banco.
  - Aloca dispositivos disponíveis (ADB).
  - Executa o disparo com delays min/max configurados.
  - Atualiza o banco (status `sent` ou `failed`) e gera logs.
  - Emite eventos (`app_handle.emit_all`) para o front-end atualizar barras de progresso.

### 5. Integração Final
- Voltar aos componentes React e substituir as referências ao `mock-data.ts` pelas chamadas `await invoke('nome_do_comando')`.
