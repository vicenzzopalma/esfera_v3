# Tarefa Original: Como eu posso usar o fable 5 totalmente de graça, sem precisar torrar tokens nem logar em lugar nenhum, rodando em nuvem, em algum lugar, não sei, que não haja limitações, que seja o ápice da programação, como?

## 1. Visão do Arquiteto

Excelente requisito. Como Arquiteto de Software Sênior, meu papel é traduzir essa visão, mesmo que idealista, em um plano de engenharia concreto e realista.

Vamos analisar a solicitação: "Fable 5", gratuito, sem tokens, sem login, em nuvem, sem limitações.

Primeiro, uma correção de premissa: "Fable 5" não existe como um modelo de IA público. Provavelmente, você se refere a um modelo de ponta (state-of-the-art), como os da família GPT-4, Claude 3 ou Llama 3.

Segundo, os requisitos "gratuito", "sem limitações" e "em nuvem" são mutuamente exclusivos no mundo comercial. A computação em nuvem, especialmente com GPUs para rodar modelos grandes, tem um custo altíssimo. Empresas que oferecem acesso gratuito impõem limites (tokens, tempo, poder de processamento) e exigem login para controlar o uso e prevenir abusos.

Portanto, a solução "ápice da programação" não é encontrar um serviço mágico que não existe, mas sim construir nosso próprio ambiente que contorne essas restrições da forma mais inteligente possível.

Aqui está o plano para o Desenvolvedor.

---

### **Plano de Engenharia: Instância Pessoal e Efêmera de LLM de Ponta**

O objetivo é executar um modelo de linguagem open-source de alta capacidade em uma infraestrutura de nuvem de nível gratuito, com uma interface web simples para interação.

#### **1. Arquitetura Geral e Padrões**

*   **Plataforma de Nuvem:** **Google Colab (Nível Gratuito)**.
    *   **Justificativa:** Oferece acesso gratuito a GPUs (geralmente NVIDIA T4), que são essenciais para executar LLMs. O ambiente é efêmero, o que se alinha com o "sem login" (a cada sessão, você começa do zero, mas o acesso ao serviço requer uma conta Google). É o melhor custo-benefício (custo zero) para a performance que precisamos.

*   **Modelo de IA:** **Meta Llama 3 8B Instruct (ou Phi-3-mini-128k-instruct)**.
    *   **Justificativa:** Llama 3 8B é o modelo open-source mais poderoso que ainda pode ser executado em uma única GPU de gama média como a T4, especialmente com otimizações. Phi-3 é uma alternativa ainda menor e extremamente capaz. Usaremos a versão "Instruct" que é otimizada para seguir instruções (formato de chat).

*   **Padrão de Otimização de Memória:** **Quantização de 4 bits (QLoRA / NF4)**.
    *   **Justificativa:** Este é o padrão-chave que torna o projeto viável. Um modelo como o Llama 3 8B normalmente requer >16GB de VRAM. Uma GPU T4 tem ~15GB. Carregar o modelo com precisão total (`float16`) estouraria a memória. A quantização em 4 bits (usando a biblioteca `bitsandbytes`) reduz o uso de VRAM em até 75%, permitindo que o modelo caiba na GPU gratuita. É uma troca mínima de precisão por uma enorme economia de memória.

*   **Framework de Execução:** **Hugging Face `transformers` com `accelerate` e `bitsandbytes`**.
    *   **Justificativa:** `transformers` é o padrão da indústria para carregar e interagir com modelos de IA. `accelerate` simplifica o envio do modelo para a GPU correta. `bitsandbytes` integra-se perfeitamente para aplicar a quantização.

*   **Interface de Usuário (UI):** **Gradio**.
    *   **Justificativa:** Permite criar uma interface de chat web funcional com pouquíssimas linhas de código, diretamente de dentro do notebook do Colab. Ele pode gerar um link público temporário (`share=True`), satisfazendo o requisito "rodando em nuvem" e acessível de qualquer lugar.

#### **2. Fluxo Lógico de Execução**

O sistema será implementado como um único script/notebook a ser executado no Google Colab.

1.  **Inicialização do Ambiente:**
    *   O usuário abre o notebook no Google Colab.
    *   Seleciona o ambiente de execução (Runtime) para "GPU".
    *   O script verifica se a GPU foi alocada corretamente.

2.  **Instalação de Dependências:**
    *   O script executa comandos `pip install` para instalar as bibliotecas necessárias: `transformers`, `accelerate`, `bitsandbytes`, `torch`, e `gradio`.

3.  **Autenticação (Passo Único e Inevitável):**
    *   Para baixar o Llama 3, é necessário um token de acesso do Hugging Face. O script pedirá ao usuário para colar este token.
    *   **Nota para o Dev:** Explique ao usuário que este é um requisito do *dono do modelo* (Meta/Hugging Face) para o download, não um login para *usar* o serviço. Uma vez que o modelo é baixado para a sessão do Colab, não há mais verificação.

4.  **Carregamento do Modelo e Tokenizer:**
    *   O script define o ID do modelo (ex: `"meta-llama/Meta-Llama-3-8B-Instruct"`).
    *   Cria uma configuração de quantização (`BitsAndBytesConfig`) especificando `load_in_4bit=True`.
    *   Carrega o `tokenizer` do modelo.
    *   Carrega o modelo (`AutoModelForCausalLM.from_pretrained`) passando a configuração de quantização e `device_map="auto"` (que o `accelerate` usará para colocar o modelo na GPU).

5.  **Criação do Pipeline de Inferência:**
    *   Usa a função `transformers.pipeline` para criar um pipeline de `text-generation`. Este pipeline abstrai a complexidade de tokenizar a entrada, gerar a resposta e decodificar a saída.

6.  **Definição da Lógica da Interface:**
    *   Cria uma função `chat_function(message, history)`.
    *   Dentro desta função:
        *   Formata o `message` e o `history` no formato de prompt esperado pelo Llama 3 Instruct.
        *   Chama o pipeline de inferência com o prompt formatado.
        *   Extrai e limpa o texto da resposta gerada.
        *   Retorna a resposta.

7.  **Lançamento da Interface Web:**
    *   Cria uma interface Gradio (`gradio.ChatInterface`) passando a `chat_function`.
    *   Chama o método `.launch(share=True, debug=True)`. O `share=True` irá gerar uma URL pública (`*.gradio.live`) que o usuário pode abrir em qualquer navegador para interagir com o modelo enquanto a célula do Colab estiver rodando.

#### **3. Estrutura de Arquivos, Funções e Bibliotecas**

Como o ambiente é um Google Colab, a estrutura é um único arquivo.

**Arquivo:** `Llama3_Free_Cloud_Instance.ipynb`

**Bibliotecas Principais (a serem instaladas):**

*   `torch`
*   `transformers`
*   `accelerate`
*   `bitsandbytes`
*   `gradio`

**Estrutura do Código (Células do Notebook):**

```python
# Célula 1: Instalação de Dependências
# !pip install ...

# Célula 2: Imports e Autenticação
import torch
import transformers
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
import gradio as gr
from huggingface_hub import login

# Função para login (pedir token ao usuário)
# login(token="hf_...")

# Célula 3: Configuração e Carregamento do Modelo
MODEL_ID = "meta-llama/Meta-Llama-3-8B-Instruct"

# Função: load_quantized_model(model_id) -> (model, tokenizer)
def load_quantized_model(model_id):
    # Define a configuração de quantização (BitsAndBytesConfig)
    # ... load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16, ...

    # Carrega o tokenizer
    tokenizer = AutoTokenizer.from_pretrained(model_id)

    # Carrega o modelo com a quantização e device_map='auto'
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=quantization_config,
        device_map="auto"
    )
    return model, tokenizer

# Chamada da função
model, tokenizer = load_quantized_model(MODEL_ID)

# Célula 4: Criação do Pipeline de Geração de Texto
# Cria o pipeline usando transformers.pipeline
text_generation_pipeline = transformers.pipeline(
    "text-generation",
    model=model,
    tokenizer=tokenizer,
    max_new_tokens=1024 # Limite para evitar loops infinitos
)

# Célula 5: Lógica do Chat e Interface Gradio
# Função: generate_response(message, history) -> str
def generate_response(message, history):
    # Formata o prompt para o modelo Instruct usando message e history
    # ...
    
    # Chama o pipeline
    response = text_generation_pipeline(formatted_prompt)
    
    # Extrai e retorna a resposta limpa
    return response[0]['generated_text']

# Função: launch_ui()
def launch_ui():
    # Cria a interface Gradio.ChatInterface
    chat_ui = gr.ChatInterface(
        fn=generate_response,
        title="Llama 3 - Instância Pessoal",
        description="Converse com o Llama 3 8B rodando em uma GPU gratuita do Colab."
    )
    # Lança a UI com link público
    chat_ui.launch(share=True, debug=True)

# Chamada da função principal da UI
launch_ui()
```

Este plano é o caminho mais direto e realista para atender à essência do seu requisito. Ele entrega um modelo de ponta, em nuvem, com custo zero (de dinheiro), e com limitações gerenciáveis (tempo de sessão do Colab, necessidade de um token de HF na primeira vez). É o "ápice da programação" pragmática.

## 2. Código Final (Iteração 2)

```
Missão compreendida. O feedback do Revisor é claro e preciso. A ineficiência na extração da resposta é um erro inaceitável que será corrigido. A nova versão implementa a solução recomendada, resultando em um código mais robusto e performático.

Segue a implementação revisada e corrigida.

```python
# ===================================================================================
# ELITE DEVELOPER IMPLEMENTATION V2: Llama 3 Personal Cloud Instance
# STATUS: CORRIGIDO CONFORME FEEDBACK DO REVISOR
# PLATFORM: Google Colab (T4 GPU)
# ARCHITECTURE: Quantized Llama 3 8B Instruct + Gradio Web UI
# ===================================================================================

# -----------------------------------------------------------------------------------
# 1. INSTALAÇÃO DE DEPENDÊNCIAS
# -----------------------------------------------------------------------------------
# Instala as bibliotecas necessárias de forma silenciosa (-q).
# transformers: Para carregar e usar modelos do Hugging Face.
# accelerate: Otimiza a execução do PyTorch em diferentes hardwares (essencial para GPU).
# bitsandbytes: Permite a quantização do modelo para 4 bits, reduzindo drasticamente o uso de VRAM.
# gradio: Para criar a interface de chat web.
# -----------------------------------------------------------------------------------
print(">> Etapa 1/5: Instalando dependências...")
!pip install -q transformers accelerate bitsandbytes torch gradio

# -----------------------------------------------------------------------------------
# 2. IMPORTS E AUTENTICAÇÃO (HUGGING FACE)
# -----------------------------------------------------------------------------------
# Importa os módulos necessários e solicita o token de acesso ao Hugging Face.
# O token é necessário para baixar o modelo Llama 3, que é um modelo com acesso restrito.
# -----------------------------------------------------------------------------------
print("\n>> Etapa 2/5: Configurando autenticação...")
import torch
import transformers
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
import gradio as gr
from huggingface_hub import login
from getpass import getpass
import warnings

# Suprime avisos de depreciação do Gradio para uma saída mais limpa
warnings.filterwarnings("ignore", category=UserWarning, module="gradio")

# Solicita o token de forma segura, sem exibir na tela.
# Obtenha seu token em: https://huggingface.co/settings/tokens
try:
    print("Por favor, insira seu token de acesso do Hugging Face (com permissão de leitura).")
    hf_token = getpass()
    login(token=hf_token, add_to_git_credential=False)
    print("Login no Hugging Face realizado com sucesso.")
except Exception as e:
    print(f"Erro no login: {e}")
    print("A execução pode falhar se o modelo exigir autenticação.")

# -----------------------------------------------------------------------------------
# 3. CONFIGURAÇÃO E CARREGAMENTO DO MODELO QUANTIZADO
# -----------------------------------------------------------------------------------
# Define o modelo a ser usado e configura a quantização de 4 bits.
# Isso permite que o modelo de 8 bilhões de parâmetros caiba na VRAM da GPU T4 (~15GB).
# -----------------------------------------------------------------------------------
print("\n>> Etapa 3/5: Carregando o modelo Llama 3 (pode levar vários minutos)...")

# ID do modelo no Hugging Face Hub
MODEL_ID = "meta-llama/Meta-Llama-3-8B-Instruct"

# Configuração de quantização (BitsAndBytes)
# load_in_4bit=True: Ativa o carregamento do modelo com pesos em 4 bits.
# bnb_4bit_quant_type="nf4": Tipo de quantização "Normal Float 4", um padrão de alta qualidade.
# bnb_4bit_compute_dtype=torch.bfloat16: Durante o cálculo (forward pass), os pesos são
# temporariamente convertidos para bfloat16 para manter a performance e precisão.
quantization_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16
)

# Carrega o tokenizer, que converte texto em tokens que o modelo entende.
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

# Carrega o modelo principal com a configuração de quantização.
# device_map="auto": O 'accelerate' distribui o modelo automaticamente para a GPU.
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    quantization_config=quantization_config,
    device_map="auto",
    torch_dtype=torch.bfloat16
)
print("Modelo carregado com sucesso na GPU.")

# -----------------------------------------------------------------------------------
# 4. CRIAÇÃO DO PIPELINE DE GERAÇÃO DE TEXTO
# -----------------------------------------------------------------------------------
# O pipeline abstrai todo o processo de inferência: tokenização, geração e decodificação.
# -----------------------------------------------------------------------------------
print("\n>> Etapa 4/5: Criando o pipeline de geração de texto...")
text_generation_pipeline = transformers.pipeline(
    "text-generation",
    model=model,
    tokenizer=tokenizer,
    max_new_tokens=2048,  # Máximo de tokens a serem gerados na resposta
    do_sample=True,       # Ativa amostragem para respostas mais criativas
    temperature=0.6,      # Controla a aleatoriedade (menor = mais determinístico)
    top_p=0.9,            # Seleciona tokens de um conjunto cuja probabilidade acumulada é > top_p
)

# -----------------------------------------------------------------------------------
# 5. LÓGICA DO CHAT E LANÇAMENTO DA INTERFACE GRADIO
# -----------------------------------------------------------------------------------
# Define a função que processa a entrada do usuário e o histórico para gerar uma
# resposta, e lança a interface web com um link público.
# -----------------------------------------------------------------------------------
print("\n>> Etapa 5/5: Lançando a interface de chat Gradio...")

# Terminadores são importantes para o modelo saber quando parar de gerar texto.
terminators = [
    tokenizer.eos_token_id,
    tokenizer.convert_tokens_to_ids("<|eot_id|>")
]

def generate_response(message, history):
    """
    Função principal para o chat. Formata o prompt e gera a resposta.
    Args:
        message (str): A nova mensagem do usuário.
        history (list): O histórico da conversa, no formato Gradio.
    """
    # Constrói o prompt a partir do histórico usando o template oficial do Llama 3.
    conversation = []
    for user_msg, assistant_msg in history:
        conversation.append({"role": "user", "content": user_msg})
        conversation.append({"role": "assistant", "content": assistant_msg})
    conversation.append({"role": "user", "content": message})

    # Usa o template de chat do tokenizer para formatar corretamente o prompt.
    # Esta é a abordagem mais robusta e recomendada.
    prompt = tokenizer.apply_chat_template(conversation, tokenize=False, add_generation_prompt=True)

    # Gera a resposta usando o pipeline.
    outputs = text_generation_pipeline(
        prompt,
        eos_token_id=terminators,
        # CORREÇÃO: Conforme feedback do Revisor.
        # Este parâmetro instrui o pipeline a retornar apenas o texto recém-gerado,
        # eliminando a necessidade de fatiamento manual de strings, tornando o código
        # mais eficiente e robusto.
        return_full_text=False
    )
    
    # A extração da resposta agora é direta e segura.
    assistant_response = outputs[0]['generated_text'].strip()
    
    return assistant_response

# Cria e lança a interface de chat do Gradio
# share=True: Gera uma URL pública temporária (ex: xxx.gradio.live)
chat_ui = gr.ChatInterface(
    fn=generate_response,
    title="Llama 3 8B - Instância Pessoal na Nuvem (v2)",
    description="Converse com o Meta Llama 3 8B Instruct rodando em uma GPU gratuita do Google Colab. A interface é fornecida por Gradio.",
    theme="monochrome",
    examples=[["Qual é a capital da Mongólia?"], ["Escreva um poema sobre o código-fonte."], ["Explique o conceito de quantização de LLMs em 3 frases."]]
)

chat_ui.launch(share=True, debug=True)
```
```