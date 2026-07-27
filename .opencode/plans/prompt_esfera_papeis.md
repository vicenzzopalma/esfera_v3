# PROJETO: Esfera v3 — Sistema de Papéis (Colaborador, Supervisor, Gestor)

## CONTEXTO DO PROJETO

O Esfera v3 é uma plataforma de gestão de disparos via ADB para WhatsApp. Usa:
- **Frontend:** React 19 + TypeScript + Vite + TailwindCSS v4 + React Router v7 + TanStack Query v5 + Lucide Icons
- **Backend:** Tauri v2 (Rust) com SQLite (rusqlite + r2d2 pool)
- **Autenticação:** JWT-like sessions via SHA-256 hash no Rust
- **Estilo:** Tema escuro com glassmorphism, cards arredondados, gradientes violeta/indigo

## ESTRUTURA ATUAL DE ARQUIVOS RELEVANTES

```
D:\Novo\Esfera v3\
├── src\
│   ├── types.ts                    # Interfaces TypeScript
│   ├── App.tsx                     # Rotas protegidas
│   ├── context\AuthContext.tsx     # Auth com roles: master, gestor, colaborador
│   ├── components\Sidebar.tsx      # Nav sidebar com role filtering
│   ├── components\ui\Card.tsx      # Card glassmorphism
│   ├── components\ui\Badge.tsx     # Badge de status
│   ├── components\ui\Button.tsx    # Botão temático
│   ├── components\ui\Modal.tsx     # Modal overlay
│   ├── components\ui\Toggle.tsx    # Switch toggle
│   ├── pages\
│   │   ├── LoginPage.tsx          # Login com dev shortcuts
│   │   ├── DevicesTab.tsx         # ADB device hub (1638 linhas)
│   │   ├── DashboardTab.tsx       # KPIs
│   │   ├── PermissionsTab.tsx     # Permissões granulares
│   │   ├── CompaniesTab.tsx       # CRUD de empresas
│   │   ├── CampaignsTab.tsx       # Campanhas
│   │   ├── AutomationsTab.tsx     # Regras de automação
│   │   ├── LogsTab.tsx            # Log do sistema
│   │   └── SettingsTab.tsx        # Configurações
│   ├── hooks\useQueries.ts        # React Query hooks
│   └── tauri.ts                   # Wrapper IPC api()
├── src-tauri\
│   ├── src\
│   │   ├── lib.rs                 # Entry + generate_handler![]
│   │   ├── commands.rs            # ~1444 linhas de comandos IPC
│   │   ├── db.rs                  # SQLite CRUD completo (1764 linhas)
│   │   └── session.rs            # Auth session management
```

## PAPÉIS ATUAIS NO SISTEMA

type Role = "master" | "gestor" | "colaborador";

## TAREFA: IMPLEMENTAR PAPEL SUPERVISOR + NOVAS TELAS

### 1. Backend (Rust) — Modificações

#### 1.1 Tipos (db.rs)
Adicionar structs:
- DeviceAssignment { user_id, device_id, assigned_at }
- PermissionRequest { id, user_id, device_id, status, requested_at, approved_by, approved_at }

#### 1.2 Novas Tabelas SQL (db.rs — create_tables)
ESF_DeviceAssignment: UserId, DeviceId, AssignedAt (PK: UserId, DeviceId)
ESF_DevicePermissionRequest: RequestId PK, UserId, DeviceId, Status (default 'pending'), RequestedAt, ApprovedBy, ApprovedAt

#### 1.3 Novos Métodos no Database (db.rs)
- get_users(company_id) -> Vec<User>
- get_user_by_id(user_id) -> Option<User>
- create_user(username, password, display_name, role, company_id) -> Result<i32, String>
- update_user(user_id, display_name, role, is_active) -> Result<(), String>
- assign_device_to_user(user_id, device_id) -> Result<(), String>
- remove_device_assignment(user_id, device_id) -> Result<(), String>
- get_user_assigned_devices(user_id) -> Vec<Device>
- request_device_permission(user_id, device_id) -> Result<i32, String>
- get_pending_requests(company_id) -> Vec<PermissionRequest>
- get_user_requests(user_id) -> Vec<PermissionRequest>
- approve_request(request_id, approved_by) -> Result<(), String>
- deny_request(request_id) -> Result<(), String>

#### 1.4 Novos Comandos IPC (commands.rs + lib.rs)
Registrar: get_users, create_user, update_user, assign_device_to_user, remove_device_assignment, get_user_assigned_devices, request_device_permission, get_pending_requests, get_user_requests, approve_request, deny_request

#### 1.5 Seed Data
Adicionar supervisor/sup123 com role supervisor

### 2. Frontend — Types (types.ts)
Role ganha "supervisor"
Novas interfaces: DeviceAssignment, PermissionRequest

### 3. Frontend — Auth (AuthContext.tsx)
Adicionar supervisor/sup123 nos SYSTEM_USERS fallback

### 4. NOVAS PÁGINAS

#### 4.1 UsersTab.tsx — Gerenciamento de Usuários (/users, master/gestor)
Card "Criar Usuário": inputs nome, username, senha + role selector (dropdown: Colaborador/Supervisor/Gestor) + botão criar
Tabela "Usuários": Nome, Username, Papel (badge), Ativo, Ações (editar modal, desativar)
Seção "Vínculos": para cada colaborador, checkboxes de devices + salvar

#### 4.2 MinhasSolicitacoesTab.tsx — Tela do Colaborador (/my-requests, colaborador)
Header + grid "Meus Celulares" (cards de devices vinculados):
- Nome, modelo, status (pulse online/offline), setor
- Botão "Solicitar Permissão" (gradiente violeta)
- Se pendente: desabilitado "Pendente..."
- Se aprovado: "Iniciar Uso"
- Se em uso: "Finalizar Uso"
Timeline "Minhas Solicitações" com status + data
Auto-refresh 7s

#### 4.3 SupervisorTab.tsx — Tela do Supervisor (/supervisor, supervisor/gestor/master)
3 sub-abas:
1. "Monitorar" — grid de devices + badge "Em uso por: Nome", botão espelhar
2. "Solicitações" — tabela de pedidos pendentes com Aprovar/Recusar
3. "Histórico" — log de uso

### 5. Sidebar (Sidebar.tsx)
Grupo "ACESSO":
- Minhas Solicitações (ClipboardList icon, roles: colaborador)
- Usuários (Users icon, roles: master, gestor)
- Supervisão (ShieldAlert icon, roles: supervisor, gestor, master)
Remover colaborador de "Dispositivos ADB"

### 6. App.tsx — Rotas
/my-requests -> MinhasSolicitacoesTab (colaborador)
/supervisor -> SupervisorTab (supervisor/gestor/master)
/users -> UsersTab (master/gestor)
RootRedirect: colaborador -> /my-requests, supervisor -> /supervisor

### 7. ESTILO — Seguir padrão existente
Glassmorphism, gradientes violeta/indigo, rounded-3xl, bg-primary escuro, text-primary/secondary/tertiary
Badge componente com variantes, Button componente, lucide-react icons, animate-fade-in

### 8. REGRAS
1. NÃO alterar master
2. NÃO quebrar telas existentes
3. Usar api() de src/tauri.ts
4. Usar useAuth()
5. Toda pagina: export default function NomeTab()
6. Colaborador so ve devices vinculados
7. Supervisor ve todos devices + solicitacoes se autorizado
8. Role selector obrigatorio na criacao de usuario
