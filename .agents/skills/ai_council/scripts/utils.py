# utils.py
import json
import re
import logging

def parse_reviewer_json(raw_text: str) -> dict:
    """
    Analisa a resposta do revisor, limpando-a de blocos de código markdown
    antes de tentar decodificar o JSON. É robusto a textos extras.
    """
    try:
        # Regex para encontrar um bloco JSON, mesmo com texto antes/depois.
        match = re.search(r"```json\s*([\s\S]+?)\s*```", raw_text, re.DOTALL)
        if match:
            json_str = match.group(1)
        else:
            # Se não houver markdown, tenta encontrar um JSON aninhado em chaves.
            brace_match = re.search(r"{\s*[\s\S]+?\s*}", raw_text, re.DOTALL)
            if brace_match:
                json_str = brace_match.group(0)
            else:
                json_str = raw_text

        data = json.loads(json_str)
        
        if 'approved' not in data or 'feedback' not in data:
             raise ValueError("JSON não contém as chaves 'approved' e 'feedback'.")

        return data

    except (json.JSONDecodeError, ValueError) as e:
        logging.error(f"Falha ao processar JSON do Revisor: {e}")
        return {
            "approved": False,
            "feedback": f"Sua resposta não foi um JSON válido ou completo. Erro: {e}. Resposta recebida:\n---\n{raw_text}\n---"
        }
