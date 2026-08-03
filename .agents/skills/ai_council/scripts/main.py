# main.py
import sys
import os
import logging
import config

# Importações corrigidas para Vertex AI
from google.cloud import aiplatform
from vertexai.generative_models import GenerativeModel

from orchestrator import CouncilOrchestrator

def load_prompts() -> dict:
    """Carrega os system prompts do diretório 'prompts'."""
    prompts = {}
    try:
        for role in ["architect", "developer", "reviewer"]:
            path = os.path.join("prompts", f"{role}.md")
            with open(path, "r", encoding="utf-8") as f:
                prompts[role] = f.read()
        return prompts
    except FileNotFoundError as e:
        logging.critical(f"Erro: Arquivo de prompt não encontrado: {e}. Verifique o diretório 'prompts'.")
        sys.exit(1)

def main():
    """Ponto de entrada principal da aplicação."""
    # Corrigido: Configuração de logging feita aqui, uma única vez.
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s', datefmt='%H:%M:%S')

    # Validação da configuração do Vertex AI
    if not config.PROJECT_ID or not config.LOCATION:
        logging.error("ERRO: As variáveis de ambiente GCP_PROJECT_ID e GCP_LOCATION devem ser definidas no arquivo .env.")
        logging.error("Certifique-se também de estar autenticado via `gcloud auth application-default login`.")
        sys.exit(1)

    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    else:
        print("Digite/Cole o prompt para o conselho (pressione Enter, digite 'EOF' em uma linha vazia própria e envie, ou pressione Ctrl+Z no Windows + Enter):")
        lines = []
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                if line.strip() == "EOF":
                    break
                lines.append(line)
        except KeyboardInterrupt:
            pass
        task = "".join(lines)
        
    if task.strip():
        try:
            # Corrigido: Inicialização da API e do modelo feita explicitamente aqui.
            logging.info(f"Inicializando Vertex AI para o projeto '{config.PROJECT_ID}' na localização '{config.LOCATION}'...")
            aiplatform.init(project=config.PROJECT_ID, location=config.LOCATION)
            
            model = GenerativeModel(config.MODEL_NAME)
            prompts = load_prompts()
            
            # O modelo configurado é injetado no orquestrador.
            orchestrator = CouncilOrchestrator(model, prompts)
            orchestrator.run(task)
            
        except Exception as e:
            logging.critical(f"\nOcorreu um erro inesperado durante a execução: {e}")
            sys.exit(1)
    else:
        print("Operação cancelada.")

if __name__ == "__main__":
    main()
