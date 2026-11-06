# Relatório — Nova Aba "Atendimento pelo Celular" (`/atendimento-celular`)

## 1. Arquivos criados e alterados
- **Criado:** `src-tauri/src/atendimento_celular.rs`
  - Comandos Tauri IPC (acesso restrito a `master` e `gestor`):
    - `get_atendimento_celular_status`: detecta se `bot.ponte_adb` já está rodando (processo separado), resolve o serial ativo e o nome soberano do aparelho no Esfera, lê `%LOCALAPPDATA%\pafixa_ponte_adb.log`, calcula o resumo de hoje e retorna as últimas 30 linhas do log.
    - `get_atendimento_celular_log`: leitura leve do resumo do dia e das últimas linhas do log.
    - `save_atendimento_celular_config`: salva a configuração em `%APPDATA%\esfera_v3\atendimento_celular.json` (`robotDir`, `pythonPath`, `serial`).
    - `start_atendimento_celular`: verifica antes se já existe processo `python`/`pythonw` com `bot.ponte_adb` na linha de comando (evita duplicidade); se não houver, inicia `python -m bot.ponte_adb` em `E:\PAFIXA-ATENDIMENTO` com `PYTHONIOENCODING=utf-8`, `PONTE_SERIAL`, `PONTE_ADB` (usando o `adb.exe` empacotado do Esfera), `CREATE_NO_WINDOW` e redirecionamento para `%LOCALAPPDATA%\pafixa_ponte_adb.out.txt` / `.err.txt`.
    - `stop_atendimento_celular`: desligamento seguro — aguarda até 60 s por uma linha nova no log terminando em `ENVIADA`, `CANCELADA (...)`, `adiada 30 min` ou `na fila` antes de encerrar o processo Python; caso o tempo esgote, encerra o processo e devolve aviso para exibição na tela.
  - Testes unitários (`atendimento_celular::tests`) cobrindo parsing do log, resumo diário, alerta de inatividade (> 10 min), detecção de linha segura de parada, montagem do comando/ambiente, filtragem de processos e preservação do nome soberano do aparelho.
- **Criado:** `src/pages/AtendimentoCelularTab.tsx`
  - Lista de aparelhos conectados no ADB (nome do aparelho no Esfera + serial), botão grande de Ligar / Desligar com estado atual (ligado/desligado, desde quando, aparelho), resumo de hoje (enviadas, canceladas, recebidas, última atividade e alerta se ligado sem linha nova há > 10 min), últimas 30 linhas do log atualizando a cada 5 s e formulário de configuração (`E:\PAFIXA-ATENDIMENTO` e caminho do Python como padrão).
- **Alterado:** `src-tauri/src/lib.rs`
  - Registro mínimo do módulo `pub mod atendimento_celular;` e dos 5 comandos no `tauri::generate_handler![]`.
- **Alterado:** `src/App.tsx`
  - Rota `/atendimento-celular` protegida por `CompanyGate` e `RoleGate` (`["master", "gestor"]`).
- **Alterado:** `src/components/Sidebar.tsx`
  - Item "Atendimento pelo Celular" no grupo "Operações" (visível para `master` e `gestor`).
- **Alterado:** `src/components/Header.tsx`
  - Título/subtítulo da rota `/atendimento-celular` em `PAGE_TITLES` e inclusão em `COMPANY_PAGES`.

## 2. Como testar
1. **Verificação estática e testes unitários (já executados e aprovados):**
   - Na raiz (`D:\Novo\Esfera v3`): `npx tsc --noEmit` (0 erros).
   - Em `src-tauri`: `$env:CARGO_BUILD_JOBS="1"; cargo test --lib -j 1 atendimento_celular` (7 testes passando + 1 ignorado que só consulta processos; nenhum toca na ponte).
   - Revisão (06/11): se a consulta de processos falhar, a aba avisa e Ligar fica bloqueado (antes isso contava como "desligado" e abria uma 2ª ponte); ligar/desligar não rodam ao mesmo tempo; a ponte sai do Job do Esfera e ganha grupo de processos próprio; ao ligar, confere por 5 s se a ponte não fechou e mostra o erro do .err.txt; ao desligar, lê o log a cada 300 ms, mata lançador + python real com /T (leva junto adb e o túnel ssh) e confirma que morreram; PowerShell no máximo a cada 15 s durante a atualização da tela.
2. **No aplicativo Esfera v3:**
   - Entrar com usuário `master` ou `gestor`, selecionar uma empresa e abrir a aba **Atendimento pelo Celular** no menu lateral.
   - Caso a ponte já esteja rodando em segundo plano no Windows, a tela reconhece automaticamente o estado **ATENDIMENTO LIGADO**, mostra o PID, horário de início, aparelho (`ZT322LCLQ6`), contadores de hoje e as últimas 30 linhas do log atualizando a cada 5 s.

## 3. O que falta
- Apenas gerar o instalador de produção (`npm run tauri build`) quando você decidir compilar o aplicativo.
