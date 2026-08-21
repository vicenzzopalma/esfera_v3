# DIRETRIZES ARQUITETURAIS: PERSISTÊNCIA TOTAL, AUTO-DESCOBERTA E RESILIÊNCIA DA FROTA (ESFERA V3)

## 1. Visão Geral e Objetivo Crítico
O sistema **NÃO PODE** depender de suposições manuais de IP, portas estáticas ou intervenções humanas caso um celular desligue, descarregue, reinicie ou tenha seu IP alterado pelo roteador (DHCP).

A arquitetura deve ser **100% à prova de falhas** contra:
1. **Reinicialização e Desligamento (Reboot/Power Off)**.
2. **Mudança Dinâmica de IP** (renovação de concessão DHCP ou troca de Access Point).
3. **Fechamento/Reset de Porta ADB** (`adbd` voltando para USB ou caindo após suspensão).

---

## 2. Especificação do APK Companion (Esfera Agent / Android)

O APK instalado em cada aparelho da frota tem papel ativo, autônomo e resiliente:

### 2.1. Funções Mandatórias do APK:
1. **Exibição Clara de Identidade**:
   - Exibir na interface o Hardware ID fixo (`EsferaDeviceId` / Serial de Hardware) e o nome atribuído ao aparelho.
2. **Ativação e Manutenção de Porta ADB**:
   - Garantir a ativação do serviço ADB TCP (`setprop service.adb.tcp.port 5555` / `stop adbd; start adbd` ou via permissão/Shizuku/Device Owner/Root).
   - Reativar automaticamente no boot (`RECEIVE_BOOT_COMPLETED`) e em eventos de rede (`CONNECTIVITY_CHANGE`).
3. **Anúncio Ativo de IP e Porta (Heartbeat / Check-in Reverso)**:
   - O APK deve enviar ativamente um beacon/broadcast (UDP na LAN ou HTTP/WebSocket para o Hub local/VPS):
     ```json
     {
       "esfera_device_id": "ESF-XXXXXXXX",
       "hardware_serial": "XXXXXX",
       "current_ip": "192.168.1.X",
       "adb_port": 5555,
       "battery_level": 85,
       "timestamp": "2026-08-21T19:10:00Z"
     }
     ```
   - Este anúncio deve ocorrer:
     - Imediatamente ao ligar / reiniciar.
     - Sempre que o Wi-Fi for reconectado ou o IP for alterado.
     - Periodicamente como heartbeat (ex: a cada 30 segundos).

---

## 3. Comportamento do Core Desktop / Hub (Tauri / Rust)

1. **Recepção do Check-in Ativo**:
   - O servidor local (`checkin_server` / UDP listener / HTTP endpoint na porta local) recebe o anúncio do APK.
   - Identifica o aparelho pelo **`EsferaDeviceId`**.
   - Atualiza no banco SQLite (`ESF_Device`) o novo `DeviceIp`, `CurrentAdbAddress` e `Status = 'online'` sem interferir no nome soberano do operador.
   - Executa imediatamente `adb connect <NOVO_IP>:<PORTA>`.

2. **Varredura Ativa e Resolução por Hardware ID**:
   - Se o Hub perder contato com um aparelho, a rotina de varredura busca dispositivos na sub-rede, consulta o Hardware ID de cada um e atualiza os ponteiros de IP no banco.
   - Limpeza automática de sockets zumbis (`adb disconnect`) para evitar deadlocks no daemon do Windows.

---

## 4. Regra Soberana e Inegociável de Identidade (Nomes e IDs)

1. **Imutabilidade Absoluta de Nomes**:
   - O nome atribuído pelo operador a um aparelho (`CustomName`) é 100% perpétuo e intocável.
   - Nenhuma rotina de reconexão, script de adoção, troca de IP ou reinicialização pode alterar, resetar ou sobrescrever os nomes da tabela `ESF_DeviceIdentity`.
2. **Âncora por Hardware ID**:
   - O vínculo do sistema é sempre `Hardware ID -> Nome do Operador`. O IP e a porta são meros atributos de transporte temporários.
