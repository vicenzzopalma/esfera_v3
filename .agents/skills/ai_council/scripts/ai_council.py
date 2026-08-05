import os
import sys
import json

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("ERRO: A nova biblioteca 'google-genai' não está instalada.")
    print("Instale rodando: pip install google-genai")
    sys.exit(1)

# ==========================================
# CONFIGURAÇÃO DA API (NOUS PORTAL / VERTEX AI)
# ==========================================

AUTH_FILE = os.path.expanduser(r"~\AppData\Local\hermes\auth.json")
nous_token = None
nous_base_url = "https://inference-api.nousresearch.com/v1"

if os.path.exists(AUTH_FILE):
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            auth_data = json.load(f)
            nous_info = auth_data.get("providers", {}).get("nous", {})
            nous_token = nous_info.get("access_token")
            nous_base_url = nous_info.get("inference_base_url", nous_base_url)
    except Exception:
        pass

use_openai = False
client = None

if nous_token:
    print("🔄 Autenticando via Nous Portal (AI Gateway)...")
    from openai import OpenAI
    client = OpenAI(base_url=nous_base_url, api_key=nous_token)
    MODEL_NAME = "tencent/hy3:free"
    use_openai = True
else:
    print("🔄 Autenticando no Google Cloud Vertex AI...")
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(
            vertexai=True, 
            project="project-8fa27d2f-29ba-4213-973", 
            location="us-central1"
        )
        MODEL_NAME = "gemini-2.5-pro"
    except Exception:
        from openai import OpenAI
        client = OpenAI()
        MODEL_NAME = "gpt-4o"
        use_openai = True

def call_agent(role_system_prompt, user_message, json_response=False):
    """Função genérica para invocar um agente do conselho."""
    if use_openai:
        messages = [
            {"role": "system", "content": role_system_prompt},
            {"role": "user", "content": user_message}
        ]
        kwargs = {
            "model": MODEL_NAME,
            "messages": messages,
            "temperature": 0.2
        }
        if json_response:
            kwargs["response_format"] = {"type": "json_object"}
        response = client.chat.completions.create(**kwargs)
        return response.choices[0].message.content
    else:
        config_args = {
            "temperature": 0.2,
            "system_instruction": role_system_prompt
        }
        if json_response:
            config_args["response_mime_type"] = "application/json"

        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=user_message,
            config=types.GenerateContentConfig(**config_args)
        )
        return response.text

# ==========================================
# DEFINIÇÃO DOS PAPÉIS (SYSTEM PROMPTS)
# ==========================================

ARCHITECT_PROMPT = """Você é um Arquiteto de Software Sênior.
Sua função é receber um requisito do usuário e planejar a estrutura do código.
Você não deve escrever o código final. Você deve definir:
1. A arquitetura geral e padrões a serem usados (ex: patterns, zero-copy, FFI).
2. O fluxo lógico de execução.
3. Estrutura de arquivos, funções e bibliotecas necessárias.
Seja direto e claro. Crie um mapa perfeito para que o Desenvolvedor só precise implementar o código."""

DEVELOPER_PROMPT = """Você é um Desenvolvedor C++/Python de Elite.
Sua missão é escrever o código baseado nas diretrizes do Arquiteto e no feedback do Revisor (se houver).
Regras:
1. Escreva código limpo, de altíssima performance, seguindo as diretrizes de arquitetura propostas.
2. Retorne PRIMORDIALMENTE código (com breves comentários). 
3. Se o Revisor enviou críticas, resolva o problema apontado na nova versão."""

REVIEWER_PROMPT = """Você é um Code Reviewer Sênior e QA extremamente rigoroso.
Você receberá o Design do Arquiteto e o Código feito pelo Desenvolvedor.
Sua missão é validar:
1. O código atende ao Design original?
2. Existem bugs, memory leaks, problemas de concorrência ou ineficiências (ex: loops mal otimizados, deadlocks)?
3. O código compila logicamente e segue as melhores práticas?

Você DEVE retornar sua análise EXATAMENTE como um objeto JSON válido, com duas chaves:
{
  "approved": boolean,  // true se estiver perfeito e pronto para produção, false se precisar refatorar.
  "feedback": "string"  // explicação detalhada do motivo da aprovação ou reprovação, apontando as linhas com problema.
}"""

# ==========================================
# MOTOR DE ORQUESTRAÇÃO
# ==========================================

def run_ai_council(task_description, max_iterations=3):
    print("="*60)
    print("🚀 INICIANDO O CONSELHO DE IAs")
    print("="*60)
    print(f"Tarefa: {task_description}\n")
    
    # 1. Fase do Arquiteto
    print("🧠 [ARCHITECT] Planejando a solução...")
    design = call_agent(ARCHITECT_PROMPT, f"Requisito do Usuário:\n{task_description}")
    
    print("-" * 40)
    print("📄 DESIGN FINALIZADO. Passando para o Desenvolvedor...")
    print("-" * 40)
    
    # 2. Loop de Desenvolvimento e Revisão
    developer_context = f"Tarefa Original: {task_description}\n\nPlano Arquitetural:\n{design}"
    current_code = ""
    
    for iteration in range(1, max_iterations + 1):
        print(f"\n💻 [DEVELOPER] Codificando (Iteração {iteration}/{max_iterations})...")
        prompt_dev = developer_context
        
        if iteration > 1:
            prompt_dev += "\n\nATENÇÃO: Sua última versão foi reprovada. Corrija baseando-se no feedback do Revisor."
            
        current_code = call_agent(DEVELOPER_PROMPT, prompt_dev)
        print("✔️ Código gerado. Enviando para QA/Review...")
        
        # Chama o Revisor
        print(f"🔍 [REVIEWER] Analisando o código...")
        prompt_reviewer = f"--- PLANO ARQUITETURAL ---\n{design}\n\n--- CÓDIGO SUBMETIDO ---\n{current_code}"
        
        reviewer_response_raw = call_agent(REVIEWER_PROMPT, prompt_reviewer, json_response=True)
        
        try:
            # Tenta decodificar o JSON rigoroso que o Revisor foi instruído a gerar
            review_data = json.loads(reviewer_response_raw)
            approved = review_data.get("approved", False)
            feedback = review_data.get("feedback", "Feedback não reconhecido.")
        except Exception as e:
            print("⚠️ [SISTEMA] Falha ao processar o JSON do Revisor. Reprovando por segurança.")
            approved = False
            feedback = f"Sua resposta não foi um JSON válido (Erro: {e}). O output recebido foi: {reviewer_response_raw}"
            
        if approved:
            print(f"✅ [REVIEWER] APROVADO!\nFeedback: {feedback}")
            break
        else:
            print(f"❌ [REVIEWER] REPROVADO.\nCrítica: {feedback}")
            
            # Retroalimenta o histórico do Developer com o erro para que ele corrija
            developer_context += f"\n\n--- TENTATIVA {iteration} ---\nCódigo enviado:\n{current_code}\n\nFEEDBACK DO REVIEWER:\n{feedback}\n\nVocê precisa reescrever o código consertando os pontos acima."
            
            if iteration == max_iterations:
                print("\n⚠️ [SISTEMA] Limite máximo de iterações atingido! O código não foi aprovado pelo Revisor, mas será retornado no estado atual.")

    print("\n" + "="*60)
    print("🏆 CONSELHO FINALIZADO")
    print("="*60)
    
    # Salvar resultado localmente
    output_file = "solucao_do_conselho.md"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(f"# Tarefa Original: {task_description}\n\n")
        f.write(f"## 1. Visão do Arquiteto\n\n{design}\n\n")
        f.write(f"## 2. Código Final (Iteração {iteration})\n\n```\n{current_code}\n```")
    
    print(f"✅ Arquivo gerado: '{output_file}' (Veja o código final aqui!)")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        # Use o primeiro argumento como nome do arquivo de prompt se possível, ou string.
        arg = " ".join(sys.argv[1:])
        if os.path.exists(arg):
            with open(arg, "r", encoding="utf-8") as f:
                task = f.read()
        else:
            task = arg
    else:
        print("Digite/Cole o prompt para o conselho (pressione Enter, digite 'EOF' em uma linha vazia própria e envie, ou pressione Ctrl+Z no Windows + Enter):")
        lines = []
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                # Critério de parada amigável para colagem de texto em terminal
                if line.strip() == "EOF":
                    break
                lines.append(line)
        except KeyboardInterrupt:
            pass
        task = "".join(lines)
        
    if task.strip():
        run_ai_council(task)
    else:
        print("Operação cancelada.")
