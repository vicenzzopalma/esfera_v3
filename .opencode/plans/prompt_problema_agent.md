# PROBLEMA: Identificação de Dispositivos Android no Esfera v3

## Contexto do Projeto

O Esfera v3 é uma plataforma de gestão de disparos via WhatsApp usando ADB (Android Debug Bridge). 

**Stack:** React 19 + TypeScript + Vite + TailwindCSS v4 + Tauri v2 (Rust backend) + SQLite (rusqlite)

A comunicação com celulares Android é feita exclusivamente via ADB sobre TCP/IP (Wi-Fi). O backend Rust executa comandos como `adb connect <ip>:<porta>`, `adb shell`, `adb install`, etc.

## O Problema

Atualmente cada celular é identificado no sistema pelo seu endereço IP + porta ADB (ex: `192.168.1.185:5555`). Este IP:Porta é usado como:

1. **Primary Key na tabela ESF_Device** (`AdbDeviceId TEXT PRIMARY KEY`)
2. **Chave estrangeira** nas tabelas ESF_DeviceAssignment e ESF_DevicePermissionRequest
3. **Identificador único** em toda a interface do usuário (React)

### Consequências

Quando um celular troca de rede Wi-Fi ou o DHCP renova o IP:

1. O dispositivo "some" do sistema — ninguém consegue mais conectar nele
2. Se reconectar com IP novo, aparece como um dispositivo novo e diferente
3. Todo o histórico é perdido: vínculos com colaboradores, permissões concedidas, campanhas associadas
4. O auto-reconnect tenta reconectar no IP antigo a cada 25s, sempre falhando

### Exemplo Real

- Celular "Aparelho 1" (Xiaomi Redmi Note) está no IP `192.168.1.185:5555`
- Colaborador "João" tem permissão para usar este celular
- O Wi-Fi cai, o celular reconecta e ganha IP `192.168.1.200:5555`
- Agora: "Aparelho 1" aparece como offline, "Aparelho 9" (novo) aparece no IP novo
- João perdeu a permissão, o gestor precisa reconfigurar tudo

## O que existe hoje no projeto

### 1. APK Android primitivo (`Esfera_Agent_ADB.apk`)
Existe um arquivo APK em `public/Esfera_Agent_ADB.apk` (package: `com.mouldybread.adbautoenable`). Ele é um app minimalista que:
- Mostra um botão "Ativar Wi-Fi ADB"
- Não tem identificação própria
- Não se comunica com nenhum servidor
- Não persiste após reboot
- Foi criado por terceiro (mouldybread) e não temos o código-fonte

### 2. Injeção de ID via ADB (já existe no `adb_manager.rs`)
O backend Rust já consegue injetar comandos via ADB no celular:
```rust
// Injeta ID persistente no sistema Android
fn inject_persistent_device_id(serial, persistent_id) {
    adb shell setprop persist.esfera.device_id {id}
    adb shell echo '{id}' > /sdcard/.esfera_device_id
}

// Lê o ID de volta
fn get_persistent_device_id(serial) -> Option<String> {
    adb shell getprop persist.esfera.device_id
    // fallback: cat /sdcard/.esfera_device_id
}

// Injeta imunidade (keepalive ADB, desliga randomização MAC, etc)
fn inject_device_immunity(serial, persistent_id)
```

### 3. Auto-reconnect daemon
Thread que a cada 25s tenta `adb connect <ip>:<porta>` para cada device salvo no banco.

### 4. Tabela ESF_Device atual
```sql
CREATE TABLE ESF_Device (
    AdbDeviceId TEXT PRIMARY KEY,  -- IP:Porta (ex: "192.168.1.185:5555")
    DeviceName TEXT NOT NULL,
    Brand TEXT NOT NULL,
    Model TEXT NOT NULL,
    DeviceIp TEXT NOT NULL,
    DevicePort INTEGER NOT NULL DEFAULT 5555,
    Status TEXT NOT NULL DEFAULT 'offline',
    BatteryLevel INTEGER NOT NULL DEFAULT 0,
    CompanyId INTEGER NOT NULL,
    DeviceNumber INTEGER NOT NULL DEFAULT 1,
    Sector TEXT NOT NULL DEFAULT 'junior'
);
```

### 5. Dispositivos pré-cadastrados
8 celulares reais da empresa já estão no banco:
```
192.168.1.185:5555 → Aparelho 1 (Xiaomi Redmi Note)
192.168.1.35:5555  → Aparelho 2 (Multilaser F Pro 2)
192.168.1.54:5555  → Aparelho 3 (Samsung Galaxy A01)
... etc
```

### 6. Disponibilidade
- Todos os celulares são **propriedade da empresa** (não há restrição de root ou modificação)
- O ADB já está ativo em todos via Wi-Fi
- O Windows tem o `adb` instalado e funciona
- Os celulares podem ter qualquer versão do Android (9 a 14)

## O que o Conselho precisa responder

1. **Qual a melhor estratégia para identificar cada celular de forma única e imutável?** Considere que:
   - O IP muda frequentemente
   - ANDROID_ID, IMEI, MAC Address, serial number — o que funciona em cada versão do Android?
   - Sem acesso root, o que é possível?

2. **Como fazer o celular "se apresentar" ao servidor Esfera sem depender de IP fixo?**
   - Deve ser algo que funciona quando o celular está em qualquer rede
   - O servidor precisa saber o IP atual do celular para poder usar ADB

3. **Precisa de um novo APK Android?** Se sim:
   - O que ele deve fazer?
   - Como ele descobre para qual servidor conectar?
   - Como ele sobrevive a reboot, troca de rede, Doze mode do Android?
   - Quais permissões são necessárias?

4. **Como adaptar o backend Rust e o banco SQLite para suportar essa nova identificação?**
   - A tabela ESF_Device precisa mudar?
   - As tabelas que referenciam o device (assignments, permissions) precisam mudar?
   - Como migrar os 8 devices existentes sem perder dados?

5. **Como adaptar o frontend React?**
   - O que muda na interface do usuário?
   - Como mostrar o status de conexão em tempo real?

6. **Quais os riscos e limitações?**
   - Android pode matar serviços em background (Xiaomi, Samsung, Huawei são agressivos)
   - `setprop` requer ADB shell — funciona sem root?
   - Foreground Service é suficiente para manter a conexão?

## Resultado esperado

O Conselho deve analisar o problema e produzir:
1. **Análise técnica** da viabilidade de cada abordagem
2. **Arquitetura completa** da solução
3. **Código de implementação** tanto do backend (Rust) quanto do app Android (se necessário)
4. **Plano de migração** dos dados existentes
5. **Riscos e mitigação** para cada limitação identificada
