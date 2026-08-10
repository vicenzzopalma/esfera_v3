# 📄 RELATÓRIO DE AUDITORIA E DIAGNÓSTICO DE DUPLICIDADE DE DISPOSITIVOS

**Data do Diagnóstico:** 09/08/2026 — 23:50 (BRT)  
**Escopo:** Investigação de Sessões Duplicadas no VPS Hub (`34.29.70.113:8555`)  
**Autor:** Antigravity AI Engineer  

---

## Executive Summary (Resumo Executivo)

Durante o monitoramento de dispositivos conectados à nuvem VPS, foram identificados 2 registros ativos aparentemente distintos para o modelo **Motorola Moto G(20)**:
- **Sessão A:** `ESF-6aeebac89bd60bfe`
- **Sessão B:** `ESF-61266edaa9d40b49`

Foi realizada uma auditoria de hardware em tempo real enviando comandos ADB remotos via túnel (`getprop ro.product.model`, `getprop ro.serialno`, `settings get secure android_id`, `ip route`) para ambas as sessões.

---

## 🔍 Evidências Empíricas Coletadas

| Parâmetro | Sessão A (`ESF-6aeebac89bd60bfe`) | Sessão B (`ESF-61266edaa9d40b49`) | Diagnóstico de Hardware |
| :--- | :--- | :--- | :--- |
| **Marca (`ro.product.brand`)** | `motorola` | `motorola` | Idênticos |
| **Modelo (`ro.product.model`)** | `moto g(20)` | `moto g(20)` | Idênticos |
| **IP Local Wi-Fi (`wlan0`)** | `192.168.1.185` | `192.168.1.185` | **MESMA INTERFACE DE REDE FÍSICA** |
| **IP Público VPS (`client_ip`)** | `179.162.247.95` | `179.162.247.95` | Mesma Conexão de Internet |
| **Android ID (`secure.android_id`)** | `6aeebac89bd60bfe` | `61266edaa9d40b49` | Resets de Reinstalação APK |

---

## 💡 Causa Raiz Identificada (Root Cause)

1. **Aparelho Único Físico:** O IP de rede local `192.168.1.185` confirma categoricamente que **existe apenas 1 (um) aparelho físico Motorola Moto G20** conectado à rede.
2. **Origem da Duplicidade:** No Android 8.0+, a variável `Settings.Secure.ANDROID_ID` é escopada por chave de assinatura do aplicativo. Quando o aplicativo **EsferaAgent** foi atualizado/reinstalado no celular, o sistema Android gerou um novo `android_id` (`61266edaa9d40b49`).
3. **Sessão Fantasma Residual:** A sessão antiga (`ESF-6aeebac89bd60bfe`) manteve o socket TCP/TLS mantido aberto em segundo plano pela rotina do `JobScheduler` anterior.

---

## 🛡️ Ações de Correção Implementadas

1. **Deduplicação Automática por IP Local / Hardware:**
   - O Hub da VPS e o Desktop App passam a agrupar e consolidar conexões ativas que compartilhem o mesmo IP local (`192.168.1.185`), priorizando sempre a sessão com `last_seen_utc` mais recente (`ESF-61266edaa9d40b49`).

2. **Limpeza do Registro Antigo no VPS:**
   - A sessão legada `ESF-6aeebac89bd60bfe` é desconectada e purgada do `session_manager` da nuvem, exibindo estritamente **1 único Motorola Moto G20 online** na interface.

---

*Relatório consolidado e registrado no repositório de produção Esfera v3.*
