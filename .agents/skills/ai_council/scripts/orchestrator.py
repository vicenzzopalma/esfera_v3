# orchestrator.py
import logging
from typing import Dict
from vertexai.generative_models import GenerativeModel
import config
from llm_client import call_llm
from utils import parse_reviewer_json

class CouncilOrchestrator:
    """
    Orquestra o fluxo de trabalho entre os agentes de IA (Arquiteto, Desenvolvedor, Revisor)
    para gerar e validar código com base em uma tarefa do usuário.
    """
    def __init__(self, model: GenerativeModel, prompts: Dict[str, str]):
        self.model = model
        self.prompts = prompts
        # Corrigido: A configuração do logging foi removida daqui.

    def run(self, task_description: str):
        """
        Executa o ciclo completo do Conselho de IAs.
        """
        logging.info("="*60)
        logging.info("🚀 INICIANDO O CONSELHO DE IAs")
        logging.info("="*60)
        logging.info(f"Tarefa: {task_description}\n")

        design = self._call_architect(task_description)
        if "ERRO_API" in design:
            logging.critical("Falha na fase do Arquiteto. Abortando.")
            return

        developer_history = [
            {'role': 'user', 'parts': [f"Tarefa Original: {task_description}\n\nPlano Arquitetural:\n{design}"]}
        ]
        current_code = ""
        final_iteration = config.MAX_ITERATIONS

        for iteration in range(1, config.MAX_ITERATIONS + 1):
            current_code = self._call_developer(developer_history, iteration)
            if "ERRO_API" in current_code:
                logging.error("Falha na fase do Desenvolvedor. Tentando novamente se possível.")
                continue

            review = self._call_reviewer(design, current_code)
            
            if review.get("approved"):
                logging.info(f"✅ [REVIEWER] APROVADO! (Iteração {iteration})\nFeedback: {review['feedback']}")
                final_iteration = iteration
                break
            else:
                logging.warning(f"❌ [REVIEWER] REPROVADO. (Iteração {iteration})\nCrítica: {review['feedback']}")
                
                developer_history.append({'role': 'model', 'parts': [current_code]})
                developer_history.append({'role': 'user', 'parts': [f"FEEDBACK DO REVIEWER:\n{review['feedback']}\n\nVocê precisa reescrever o código consertando os pontos acima."]})

                if iteration == config.MAX_ITERATIONS:
                    logging.warning("\n⚠️ [SISTEMA] Limite máximo de iterações atingido! O código não foi aprovado.")

        self._save_results(task_description, design, current_code, final_iteration)

    def _call_architect(self, task: str) -> str:
        logging.info("🏛️  [ARCHITECT] Planejando a solução...")
        history = [{'role': 'user', 'parts': [f"Requisito do Usuário:\n{task}"]}]
        design = call_llm(self.model, self.prompts['architect'], history)
        logging.info(" blueprint  DESIGN FINALIZADO. Passando para o Desenvolvedor...")
        return design

    def _call_developer(self, history: list, iteration: int) -> str:
        logging.info(f"\n💻 [DEVELOPER] Codificando (Iteração {iteration}/{config.MAX_ITERATIONS})...")
        code = call_llm(self.model, self.prompts['developer'], history)
        logging.info("✔️ Código gerado. Enviando para QA/Review...")
        return code

    def _call_reviewer(self, design: str, code: str) -> dict:
        logging.info("🔍 [REVIEWER] Analisando o código...")
        prompt = f"--- PLANO ARQUITETURAL ---\n{design}\n\n--- CÓDIGO SUBMETIDO ---\n{code}"
        history = [{'role': 'user', 'parts': [prompt]}]
        
        raw_response = call_llm(self.model, self.prompts['reviewer'], history, json_response=True)
        
        if "ERRO_API" in raw_response:
            return {"approved": False, "feedback": "Falha ao contatar o Revisor via API."}
            
        return parse_reviewer_json(raw_response)

    def _save_results(self, task: str, design: str, code: str, iteration: int):
        logging.info("\n" + "="*60)
        logging.info("🏆 CONSELHO FINALIZADO")
        logging.info("="*60)
        
        try:
            with open(config.OUTPUT_FILENAME, "w", encoding="utf-8") as f:
                f.write(f"# Tarefa Original: {task}\n\n")
                f.write(f"## 1. Visão do Arquiteto\n\n```markdown\n{design}\n```\n\n")
                f.write(f"## 2. Código Final (Iteração {iteration})\n\n")
                lang = "python" if "def " in code or "import " in code else "cpp" if "#include" in code else ""
                f.write(f"```{lang}\n{code}\n```\n")
            logging.info(f"✅ Arquivo de resultado gerado: '{config.OUTPUT_FILENAME}'")
        except IOError as e:
            logging.error(f"Falha ao salvar o arquivo de resultado: {e}")
