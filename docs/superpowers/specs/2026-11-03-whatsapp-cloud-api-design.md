# Integração oficial do WhatsApp no Esfera

Data: 2026-11-03. Estado: proposta para aprovação; implementação e ativação pendentes.

## Objetivo e escopo

O usuário escolheu a integração de mensagens pela API oficial, como segunda alternativa à VPN por dispositivo. Acrescentar ao Esfera um canal WhatsApp Cloud API, capaz de representar vários números comerciais por empresa. A primeira validação usa um número de teste da Meta; cadastrar ou migrar os mais de dez números existentes é uma etapa posterior, dependente do onboarding de cada número.

O canal oficial identifica remetentes por `phone_number_id`, não pelo aparelho físico. Não requer troca de IP por quantidade de mensagens nem simulação de dispositivo. Não promete anonimato, aumento de velocidade, entrega garantida ou ausência de restrições.

## Situação encontrada no repositório

- Frontend React/TypeScript com Tauri 2; backend desktop Rust com reqwest, Axum e SQLite.
- `src-tauri/src/commands.rs::start_campaign` exige aparelho online e inicia o fluxo ADB.
- `src-tauri/src/dispatcher.rs` envia mensagens pelos aparelhos. O canal oficial precisará de um executor próprio.
- `src/pages/SettingsTab.tsx` contém a seção Integrações, atualmente voltada a VEXOR/SAIR.
- `src-tauri/src/optout_api.rs` autentica por empresa e confirma descadastro somente após persistência, mas pertence ao desktop.
- `hub-standalone` já hospeda Rust/Axum/SQLite na VPS. Seu esquema e seus métodos não são idênticos aos do desktop; não assumir que já exista sincronização completa de campanhas, mensagens ou descadastros entre ambos.

## Abordagens

1. **Cloud API direta na VPS — recomendação técnica.** Reutiliza Rust e o hub existente, mantém webhook acessível quando o desktop está fechado e evita intermediário adicional. Exige implementar fila, credenciais e acompanhamento de mensagens.
2. **Cloud API diretamente no desktop.** Menos código inicial de ponte, porém a recepção fica dependente do desktop e exige endereço público HTTPS para webhooks.
3. **Provedor oficial intermediário.** Pode fornecer onboarding e caixa de entrada próprios, mas acrescenta contrato, custos e dependência de APIs adicionais.

O usuário escolheu a API oficial; a hospedagem direta na VPS e os detalhes abaixo são propostas técnicas, ainda não aprovadas.

## Entrega proposta

### 1. Configuração e autenticação

Adicionar em Integrações uma área para consultar conexões oficiais e cadastrar seus identificadores: empresa, rótulo escolhido pelo operador, WABA ID e Phone Number ID. Uma empresa pode ter várias conexões. A interface mostra apenas se as credenciais estão configuradas.

Access Token, App Secret e token de verificação do webhook ficam exclusivamente no servidor, provisionados em arquivo de ambiente protegido e fora do Git. O desktop não recebe nem persiste esses segredos. Usar referências de credenciais por conexão e configuração por aplicativo Meta; a primeira entrega não inclui rotação de segredos pela interface.

Todas as chamadas desktop → VPS exigem token de empresa validado pelo servidor. Resolver a empresa pelo token e conferir propriedade da conexão, da campanha e do contato. IDs enviados pelo cliente não concedem acesso. A configuração do novo canal deve exigir HTTPS e não reutilizar o fallback HTTP do hub para transportar credenciais.

### 2. Envio e campanhas

Adicionar seleção explícita de canal à campanha: `adb` para campanhas existentes e `whatsapp_cloud` para novas campanhas oficiais. A campanha oficial seleciona uma conexão comercial, sem exigir aparelho online.

Na primeira entrega, campanhas oficiais enviam somente templates previamente aprovados: nome, idioma e parâmetros tipados. Não converter automaticamente saudação/corpo/despedida, spintax ou reescrita por IA em templates. Texto livre de atendimento e caixa de entrada completa ficam para outra entrega.

Desktop envia ao servidor um snapshot versionado da campanha oficial e seus destinatários. O servidor valida e persiste esse snapshot antes de confirmar o início. A VPS é a autoridade de execução e resultados desse canal; consultar os resultados por polling autenticado no desktop. Alterar ou pausar uma campanha exige comando persistido no servidor; antes de cada envio o executor consulta a pausa. Requisição já entregue à Meta pode concluir após a pausa.

Persistir consentimento e sua origem por destinatário. Não considerar importação de lista como evidência de consentimento. Consultar descadastro central antes de cada envio. O início sincroniza a supressão local com a central, por união, sem apagar registros. Indisponibilidade da sincronização bloqueia o início de campanha oficial.

Decisão técnica para a primeira entrega: importar destinatários oficiais com campos obrigatórios `phone`, `consent_at` (data/hora com fuso), `consent_source` e `consent_reference` (referência verificável ao registro de autorização). Mostrar esses campos na prévia e rejeitar linhas incompletas ou datas futuras. A importação registra a declaração/evidência informada, sem afirmar validação automática de sua autenticidade. Não preencher esses campos automaticamente nem reaproveitar listas antigas como consentidas.

Descadastros recebidos no desktop durante a execução — manuais, VEXOR ou importação do agente — entram em outbox local durável na mesma transação da supressão. Um sincronizador publica pendências continuamente na VPS. Para a primeira entrega, uma campanha oficial tem um desktop controlador autenticado: renovação de lease de sincronização a cada 5 segundos, somente após publicar todas as supressões locais pendentes; validade de 15 segundos. VPS pausa novas tentativas ao expirar o lease. Ao receber SAIR central, a VPS suprime imediatamente; desktop importa e aplica no fluxo local. Falha de rede não permite propagação instantânea: a janela residual é de até 15 segundos, além de requisições já em voo. Interface deve informar essa limitação e a pausa por perda de sincronização. Produção com múltiplos desktops exige registrar todos os produtores de supressão e acompanhar seus leases; fica fora do piloto inicial.

O executor usa `POST https://graph.facebook.com/{version}/{phone_number_id}/messages`. Versão Graph explícita e configurável no servidor; selecionar versão suportada durante a implementação, sem inferir da versão do aplicativo.

Uma resposta de aceite com ID da Meta significa `accepted`, não `delivered`. Persistir o ID para acompanhar os estados posteriores. Não usar o executor ADB como fallback de uma campanha oficial.

### 3. Webhooks e descadastro

Expor um caminho por aplicativo Meta, por exemplo `/webhooks/whatsapp/{appAlias}`, atrás do HTTPS público. O alias seleciona a configuração de assinatura, sem expor o App Secret.

- GET: validar `hub.mode` e `hub.verify_token`; devolver `hub.challenge` em texto quando válidos.
- POST: validar HMAC-SHA256 dos bytes originais contra `X-Hub-Signature-256`, usando comparação constante, antes de confiar no conteúdo.
- Conferir WABA/Phone Number ID contra conexões cadastradas naquele aplicativo. Nunca escolher a empresa por um campo arbitrário fornecido no payload.
- Persistir eventos antes do HTTP 200; processamento idempotente, com limite de corpo e recuperação após reinício. Falha de armazenamento retorna erro recuperável, sem confirmar recebimento.
- Deduplicar mensagens por conexão + ID da Meta; estados por conexão + ID da mensagem + estado + timestamp. Guardar eventos fora de ordem sem regredir `read` para `sent`.
- Receber respostas de texto e botão para detectar SAIR e persistir a supressão central imediatamente. Antes do próximo envio o executor consulta essa supressão. O desktop importa o registro e aplica ao mecanismo local existente; definir testes que comprovem que uma falha de sincronização não libera envios oficiais.

### 4. Persistência e retentativas

Criar tabelas aditivas no hub para conexões, snapshots de campanhas oficiais, destinatários/consentimento, outbox, eventos webhook e supressão central. Todas incluem escopo de empresa; usar chaves e índices que impeçam referências cruzadas. Correspondência local/remota por UUID estável, sem supor igualdade de IDs inteiros nos dois bancos.

Outbox: `queued`, `sending`, `accepted`, `delivered`, `read`, `failed`, `unknown` e `cancelled`. Reserva transacional de trabalho, prazo de posse e número limitado de tentativas. Separar estado de execução de estado de entrega para representar timeout e webhooks tardios.

Impedir duplicação local por chave de operação estável. Não afirmar entrega exatamente uma vez: timeout após envio ou queda entre aceite remoto e persistência local gera resultado incerto. Não reenviar automaticamente trabalhos incertos nem simplesmente recuperar todo `sending` como `queued`; reconciliar com webhook quando possível e sinalizar revisão ao operador.

Aplicar limites da Meta por conexão e backoff para erros recuperáveis cujo não aceite seja conhecido. Honrar `Retry-After` quando fornecido. Erros de autenticação, permissão ou template pausam o remetente/campanha com motivo visível. Não redistribuir para outro número para contornar erro.

### 5. Segurança e operação

Timeouts explícitos; destino Graph fixo; sem redirecionamento autenticado para outro host. Logs sem tokens, App Secret, corpo de mensagem ou telefone completo. Segredos isolados por ambiente e acesso restrito ao processo do serviço. Métricas: fila, aceites, entregas, falhas, incertezas e atraso de webhook.

Nenhuma chamada externa de envio durante os testes locais. Ativação usa primeiro destinatário de teste autorizado. Onboarding, templates, elegibilidade e cobrança pertencem à conta Meta; a integração não os cria automaticamente nesta entrega. Não migrar números de produção nem modificar a conta Meta sem instrução específica.

## Pontos de alteração previstos

- `hub-standalone`: módulos de cliente Graph, filas, persistência, endpoints autenticados e webhooks; reqwest em dependências de execução e biblioteca HMAC mantida.
- `src-tauri`: comandos autenticados de configuração pública, criação/controle/consulta de campanhas oficiais e sincronização de supressões; modelos e migrações locais aditivas.
- `src/tauri.ts`, `src/types.ts`, `src/pages/SettingsTab.tsx`, `src/pages/CampaignsTab.tsx`: integração com esses comandos e representação dos estados oficiais.
- Não renomear dispositivos nem alterar sua identidade; não instalar ou modificar aplicativos Android para o canal oficial.

## Critérios de aceitação

1. Empresa A não consulta, inicia ou pausa campanhas/conexões da empresa B.
2. Token ausente ou inválido não autoriza endpoints de controle; assinatura ausente ou inválida não grava eventos webhook.
3. Testes com servidor Graph simulado comprovam formato de template, autorização, timeout, classificação de erros e ausência de retentativa cega.
4. Repetição de comando/evento não duplica trabalho; reinício preserva fila, pausa, consentimento e supressão.
5. Aceite HTTP não aparece como entrega; estados fora de ordem não regridem confirmação de leitura.
6. SAIR cancela trabalhos pendentes; contato sem consentimento não entra na fila. Cobrir descadastro local durante execução, importação de consentimento inválido e perda/expiração de lease de sincronização.
7. Campanha oficial funciona sem ADB e sem aparelho online; nenhuma alteração nos nomes de aparelhos.
8. Segredos não aparecem em respostas IPC/HTTP, Git ou logs.

Testes e verificações estáticas conforme os módulos alterados. Não gerar executável de produção sem pedido explícito: regra de `.agents/AGENTS.md`. Para eventual empacotamento desktop, usar `npm run tauri build`.

## Dados necessários para ativar

Conta/aplicativo Meta com WhatsApp configurado, WABA ID, Phone Number ID de teste, Access Token, App Secret, token de verificação escolhido e domínio HTTPS apontando para a VPS. Segredos devem ser provisionados diretamente no servidor, sem colar no chat ou incluir no documento. A ausência desses dados não impede implementar e testar localmente, mas impede afirmar que a integração está ativa.

## Referências

- Coleção oficial Meta, endpoints e exemplos de mensagens: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
- Verificação de webhook documentada pelo projeto oficial WhatsApp: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/ (SDK arquivado; referência do contrato, não dependência recomendada).
- Documentação Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/overview (acesso automatizado retornou HTTP 429 nesta consulta).

## Decisão pendente

Aprovação do escopo: canal Cloud API direto na VPS, piloto com número de teste e um desktop controlador, campanhas de templates, importação de evidência de consentimento e retorno de estados/SAIR; sem migração automática dos números existentes. Após aprovação, escrever o plano de implementação e executar as alterações.
