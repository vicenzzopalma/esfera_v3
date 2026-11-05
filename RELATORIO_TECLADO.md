# Teclado Esfera — 05/11/2026

## Arquivos desta tarefa

- `src-agent/app/src/main/kotlin/com/esfera/agent/EsferaKeyboardService.kt`: IME, barra com botão de saída, `commitText` por grafema no Handler principal e cancelamento ao perder o campo.
- `src-agent/app/src/main/res/xml/esfera_keyboard.xml` e `AndroidManifest.xml`: registro do teclado.
- `TypeTextReceiver.kt`: prefere IME; sem teclado/conexão usa acessibilidade. Recusa sobreposição de pedidos.
- `accessibility/EsferaAccessibilityService.kt`: consulta de ocupação e logs `via=acessibilidade`; mantém a digitação existente.
- `src-agent/app/build.gradle.kts`: versionCode **3**, versionName **1.0.2**. O Rust lê a versão esperada desse arquivo em compile-time.
- `src-tauri/src/adb_manager.rs`: ativação, memória do teclado anterior por ID estável, restauração, habilitação nas instalações/atualizações e sete testes puros.
- `src-tauri/src/dispatcher.rs`: ativa antes do envio; restaura na limpeza e por verificação em segundo plano.
- APK assinado e idêntico em `public/Esfera_Agent_ADB.apk`, `src-tauri/binaries/Esfera_Agent_ADB.apk` e `src-tauri/target/release/binaries/Esfera_Agent_ADB.apk`; o assinador também atualizou `public/Esfera_Agent_ADB.apk.idsig`.

## Liga e desliga

Com a trava do aparelho, lê `settings get secure default_input_method` e guarda o teclado anterior uma vez por ID do banco. Executa `ime enable` e `ime set com.esfera.agent/.EsferaKeyboardService`, conferindo a configuração depois. Erro deixa o disparo seguir pelo caminho disponível.

Na conclusão, parada, pausa ou retirada da seleção da campanha, restaura o anterior após liberar a trava de envio. A verificação em segundo plano cobre limpeza ocupada e reconexão. Falhas de restauração ficam pendentes para nova tentativa; troca manual do operador é preservada. Instalar/atualizar apenas habilita o IME, sem selecioná-lo.

Cada grafema usa a soma dos atrasos dos seus code points, com fallback de 110 ms por atraso ausente. `clear=true` seleciona tudo e apaga antes da primeira tecla. Logs mantêm `EsferaTyping`, `TYPED <id> OK/FAIL`, com `via=ime` ou `via=acessibilidade`. Não há colagem de mensagem inteira.

## Verificações

- Sete testes puros compilados diretamente do código atual via `rustc --test` em stdin: **7 passaram**. Incluem parse, comandos, preservação do anterior, troca manual e falhas de ativação/restauração. A regressão de sobrescrever o teclado anterior foi detectada e a implementação correta passou novamente.
- Em `src-tauri`, `$env:CARGO_BUILD_JOBS='1'; cargo test --lib -j 1`: **263 passaram, 0 falhas, 2 ignorados**, incluindo os sete testes novos e a igualdade entre versão do APK e versão esperada. Compilação em 1m56s; testes em 5,22s. Tentativas iniciais falharam por memória/paginação; a execução final ocorreu depois do Gradle, sem paralelismo entre builds. Log: `TECLADO_CARGO_TEST.log`.
- `src-agent/runbuild.bat`: **BUILD SUCCESSFUL em 2m11s**, 40 tarefas (10 executadas). Após falhas iniciais por memória, passou com `--no-daemon`, um worker, Kotlin em processo e JVM de 384 MiB; `JAVA_OPTS` e `org.gradle.jvmargs` equivalentes evitaram um segundo processo JVM. Nenhum script de build foi alterado. Log: `TECLADO_APK_BUILD.log`.
- `apksigner sign --out public/Esfera_Agent_ADB.apk` com o keystore existente; `verify --verbose --print-certs`: **válido em v2/v3**. `aapt dump badging`: **versionCode=3 / versionName=1.0.2**.
- SHA-256 das três cópias: `8D7FD9747509B8E571BDBD60510D183312657FE524A805382EA82C4A639AC4A7`.
- Nenhum comando ADB foi executado nos aparelhos. Nenhum build do executável desktop, commit ou push foi feito.
- Funções `cleanup_all_temporary_contacts`, `delete_temporary_contact` e testes delas reservados ao coordenador.

## Pendências

- Validar no aparelho e integrar em um novo build desktop pelo coordenador. O executável antigo continua com a versão esperada embutida antes desta alteração.
- O teclado anterior fica em memória do desktop: encerramento abrupto do processo perde essa informação. O botão do IME permite trocar manualmente. Excluir o cadastro inteiro do aparelho também impede a limpeza por ID; remover apenas da campanha é coberto.
- A segmentação Unicode segue o ICU da versão Android instalada.

## Validação pelo coordenador (PowerShell)

Executar em aparelho de teste, fora das campanhas reais, com campo de texto focado. Estes comandos estão apenas documentados; não foram executados.

```powershell
Set-Location 'D:\Novo\Esfera v3'
$adb = Join-Path $PWD 'src-tauri\binaries\adb.exe'
$serial = 'SUBSTITUA_PELO_SERIAL_DE_TESTE'
$anterior = (& $adb -s $serial shell settings get secure default_input_method).Trim()
& $adb -s $serial install -r -g .\public\Esfera_Agent_ADB.apk
& $adb -s $serial shell dumpsys package com.esfera.agent | Select-String 'versionCode=|versionName='
& $adb -s $serial shell ime enable com.esfera.agent/.EsferaKeyboardService
& $adb -s $serial shell ime set com.esfera.agent/.EsferaKeyboardService
& $adb -s $serial shell settings get secure default_input_method

# Abra um campo de teste e deixe o teclado Esfera visível.
$texto = 'Teste ação é 👩🏽‍💻 🇧🇷'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($texto))
$delays = ((1..64 | ForEach-Object { '150' }) -join ',')
& $adb -s $serial shell am broadcast -a com.esfera.agent.TYPE_TEXT -n com.esfera.agent/.TypeTextReceiver --es id teclado-ime-1 --es b64 $b64 --es delays $delays --ez clear true
& $adb -s $serial logcat -d -s 'EsferaTyping:I' '*:S'

# Depois do OK: validar append sem limpar.
& $adb -s $serial shell am broadcast -a com.esfera.agent.TYPE_TEXT -n com.esfera.agent/.TypeTextReceiver --es id teclado-ime-2 --es b64 $b64 --es delays $delays --ez clear false

# Depois do OK: voltar ao teclado anterior e validar fallback.
& $adb -s $serial shell ime set $anterior
& $adb -s $serial shell am broadcast -a com.esfera.agent.TYPE_TEXT -n com.esfera.agent/.TypeTextReceiver --es id teclado-fallback-1 --es b64 $b64 --es delays $delays --ez clear true
& $adb -s $serial logcat -d -s 'EsferaTyping:I' '*:S'
```

Esperado: versão 3/1.0.2; broadcast `result=1`; `TYPED teclado-ime-1 OK via=ime`; texto aparece aos poucos sem quebrar acentos/emoji; segundo pedido acrescenta texto; fallback informa `via=acessibilidade`. O botão “Voltar ao teclado” deve trocar ou abrir o seletor.

Com o novo desktop, iniciar campanha de teste com teclado comum selecionado; conferir Esfera durante o envio e teclado comum após concluir/parar/pausar ou remover o aparelho. Testar também saída enquanto ainda digita (restaura só após soltar a trava), troca USB/Wi-Fi e restauração após reconectar.

Referência de API: [InputMethodService](https://developer.android.com/reference/android/inputmethodservice/InputMethodService) e [BreakIterator](https://developer.android.com/reference/android/icu/text/BreakIterator).
