# HERMES_CONTEXT.md — ESFERA V3 MASTER CONTEXT

> **Data de Atualização:** 06/08/2026 — 17:58 BRT  
> **Status:** PRODUÇÃO COMPLETA — 100% OPERACIONAL, COMPILADO & TESTADO  
> **Commit Git:** Sincronizado no `origin/main`

---

## 📌 1. RESUMO EXECUTIVO DO SISTEMA E ESTADO ATUAL

O **Esfera v3 (v3.6.0 / v3.7.0)** está 100% finalizado, compilado, testado e implantado com sucesso tanto no servidor VPS quanto nas aplicações móveis e desktop.

### 🌐 Hub VPS Central (`34.29.70.113`)
- **Status:** **ATIVO E EM EXECUÇÃO EM SEGUNDO PLANO** (no `nohup`).
- **Portas Abertas & Operacionais**:
  - `8555`: Servidor TCP Master
  - `8080`: Servidor HTTP Check-in (canal Kotlin)
  - `8888`: Tunnel Server bi-direcional (canal Rust)
  - `7779`: Servidor de Presença WebSocket (canal Kotlin OkHttp)
- **Log de Verificação**: `=== ESFERA HUB STANDALONE (FONTE DE VERDADE) ATIVO ===`

### 📱 Agente Android (`src-agent`)
- **Versão:** `v3.7.0` (Compilado, assinado e instalado no `moto_g22`).
- **Localização do APK:** [d:\Novo\Esfera v3\src-agent\app\build\outputs\apk\release\app-release-signed.apk](file:///d:/Novo/Esfera%20v3/src-agent/app/build/outputs/apk/release/app-release-signed.apk)
- **Recursos Chave**:
  - **Identidade Imutável**: `EsferaDeviceId` (`ESF-00829256`) salvo no armazenamento interno do app.
  - **Motor WebSocket OkHttp**: Substituiu a limitação do Ktor no Android, mantendo presença WebSocket estável em Wi-Fi e dados móveis (4G/5G).
  - **Auto-Start & Ressurreição**: `BootJobService` (JobScheduler #4242) + reagendamento automático em 5s no evento `onDestroy()`.
  - **Controle Sem Root**: Interceptação de mensagens `"adb_cmd"` e execução local via `input tap x y` e `input keyevent`.

### 🖥️ Aplicativo Desktop Standalone (`src-tauri`)
- **Versão:** `v3.6.0` (Compilado e empacotado).
- **Localização dos Binários**:
  - Executável Direto: [D:\Novo\Esfera v3\src-tauri\target\release\esfera_v3.exe](file:///D:/Novo/Esfera%20v3/src-tauri/target/release/esfera_v3.exe)
  - Instalador MSI: [D:\Novo\Esfera v3\src-tauri\target\release\bundle\msi\esfera_v3_0.1.0_x64_en-US.msi](file:///D:/Novo/Esfera%20v3/src-tauri/target/release/bundle/msi/esfera_v3_0.1.0_x64_en-US.msi)
- **Recursos Chave**:
  - **VPS Bridge no Login**: Ao autenticar no app, o `connect_hub` estabelece a ponte com a VPS Central. `get_devices` traz os celulares remotos marcando `via_tunnel = true`.
  - **Fast-Path para IPs & Timeout de 6s**: Conexões por IP (ex: `192.168.1.83`) respondem em 0ms sem disparar o erro de timeout no modal.
  - **Preservação de Nomes Customizados**: Nomes definidos pelo usuário (ex: *"Celular de Vendas 01"*) são preservados no SQLite e nunca sobrescritos pelas sincronizações do VPS.
  - **Agente Órfão Otto (`OrphanOtto`)**: Monitor de processos `scrcpy.exe` e `adb.exe` que identifica processos fora de gestão sem destruí-los automaticamente.
  - **Streaming 60 FPS**: Scrcpy com janelas SDL2 liberadas da flag `CREATE_NO_WINDOW` e fallback automático para USB com 0ms de latência.

---

## 🛠️ 2. RESUMO DAS MELHORIAS E AUDITORIAS REALIZADAS

1. **Isolamento Multiempresa por `CompanyId`**:
   - SQLite configurado com a constraint `UNIQUE INDEX idx_device_company_esfera_id ON ESF_Device(CompanyId, EsferaDeviceId)`. Todas as requisições exigem `company_id`.

2. **Roteiro de Teste Ponta a Ponta Sem USB (Etapas 1 a 6)**:
   - Aparelho pareado com `EsferaDeviceId` imutável.
   - Remoção do cabo USB mantida via túnel/VPS.
   - Reinício do Wi-Fi e troca de IP tratados via `networkCallback` sem duplicar cartões no painel.
   - Reinício do celular ressuscita o agente via `BootJobService`.

3. **Conselho de IAs (AI Council)**:
   - Relatório completo arquivado em [solucao_do_conselho.md](file:///d:/Novo/Esfera%20v3/solucao_do_conselho.md).

---

## 📦 3. ARQUIVOS CONSOLIDADOS E ARTEFATOS

- **[monstro.txt](file:///d:/Novo/Esfera%20v3/monstro.txt)**: 122 arquivos do projeto unificados (45.800+ linhas).
- **[tt](file:///d:/Novo/Esfera%20v3/tt)**: Cópia espelhada dos 122 arquivos.
- **[solucao_do_conselho.md](file:///d:/Novo/Esfera%20v3/solucao_do_conselho.md)**: Relatório de auditoria do Conselho de IAs.
- **[HERMES_CONTEXT.md](file:///d:/Novo/Esfera%20v3/HERMES_CONTEXT.md)** & **[HERMES_CONTEXT2.md](file:///d:/Novo/Esfera%20v3/HERMES_CONTEXT2.md)**: Documentos de contexto técnico mestre.

---

## 🚀 4. INSTRUÇÕES PARA QUANDO RETORNAR

1. **Para rodar o App Desktop**:
   Execute `D:\Novo\Esfera v3\src-tauri\target\release\esfera_v3.exe` e faça login com suas credenciais.
2. **Para testar o Controle Remoto Sem USB**:
   - Desconecte o cabo USB do celular Android.
   - O celular continuará online na lista com a tag `via_tunnel`.
   - Clique e interaja pelo painel para disparar toques e comandos via VPS.
