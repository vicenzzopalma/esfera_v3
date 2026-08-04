# Arquiteturas Alternativas (Contexto Futuro)

Este documento guarda opções de arquitetura alternativas para a comunicação entre o servidor (Esfera Hub) e os celulares físicos (Device Farm). Atualmente o sistema utiliza um **Túnel Reverso TCP nativo (Esfera Agent)**, mas as opções abaixo foram consideradas válidas e podem ser exploradas no futuro dependendo da evolução dos requisitos.

## 1. Rede Privada Overlay / VPN Mesh (Tailscale, WireGuard, ZeroTier)
Cria-se uma rede privada virtual em cima da rede Wi-Fi existente, onde cada celular recebe um IP virtual estático e criptografado que nunca muda.

* **Como funciona:** Um cliente VPN leve (como o Tailscale ou WireGuard) roda no celular (ou via perfil de VPN Always-On nativo do Android).
* **Vantagens:** O IP virtual atribuído ao celular dentro da rede Mesh permanece fixo, independentemente da troca de IP físico na LAN/Wi-Fi. O servidor pode continuar usando conexões direcionadas ao IP virtual fixo do celular.
* **Desvantagens:** Ligeiro overhead de CPU para criptografia do tráfego; dependência do subsistema de VPN do Android (que precisa ser travado como Always-On para não ser suspenso). Isso também bloqueia o uso de outras VPNs/Proxies no celular para os processos de automação.

## 2. Arquitetura de Mensageria IoT / MQTT (Pub/Sub Broker)
Utilização de um protocolo de mensageria leve desenvolvido especificamente para dispositivos IoT operando em redes instáveis.

* **Como funciona:** O celular mantém um cliente MQTT conectado a um Broker central (ex: Mosquitto, EMQX). A comunicação é orientada a tópicos (ex: `dispositivos/{hardware_id}/comandos`).
* **Vantagens:** Keep-Alive de baixíssimo consumo de dados e bateria; suporte a mensagens retidas (Retained Messages) e recurso de Last Will and Testament (notifica o servidor instantaneamente se a conexão com o celular for cortada).
* **Desvantagens:** Requer um Broker MQTT como componente intermediário de infraestrutura; não é projetado para transmissão de grandes fluxos de dados brutos (como streaming de tela via scrcpy ou ADB puro).

## 3. Provisionamento Nativo Android Enterprise / DPC (Kiosk / Dedicated Device)
Provisionamento do dispositivo no modo Device Owner desde a formatação inicial do sistema (via QR Code ou NFC Zero-Touch).

* **Como funciona:** O aplicativo de gerenciamento é configurado como o DPC (Device Policy Controller) do sistema. O celular opera como um dispositivo dedicado (Kiosk Mode).
* **Vantagens:** Permissão máxima de gerenciamento sem necessidade de root; o sistema impede permanentemente o encerramento do app; controle nativo de atualizações, travamento de Wi-Fi e políticas de energia.
* **Desvantagens:** Exige a restauração de fábrica (factory reset) do aparelho para realizar o provisionamento inicial como Device Owner, o que adiciona forte atrito operacional no setup da farm de dispositivos físicos.
