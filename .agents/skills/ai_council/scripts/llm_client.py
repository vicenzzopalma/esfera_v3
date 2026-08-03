# llm_client.py
import logging
from typing import List, Dict, Any
from vertexai.generative_models import GenerativeModel, GenerationConfig, Part
import config

def call_llm(
    model: GenerativeModel,
    system_prompt: str,
    history: List[Dict[str, Any]],
    json_response: bool = False
) -> str:
    """
    Função genérica e robusta para invocar o modelo Vertex AI.
    Corrigido para não ter efeitos colaterais na importação e usar o modelo injetado.

    Args:
        model: A instância do GenerativeModel do Vertex AI.
        system_prompt: A instrução de sistema para o modelo.
        history: O histórico da conversa, uma lista de dicionários.
        json_response: Se True, força a saída em JSON.
    """
    # Converte o histórico de dicionário para a lista de objetos Content esperada
    contents = [Part.from_dict(item) for item in history]

    # Configuração de geração, aplicada por chamada
    mime_type = "application/json" if json_response else "text/plain"
    gen_config = GenerationConfig(
        temperature=config.DEFAULT_TEMPERATURE,
        response_mime_type=mime_type
    )

    try:
        # A instrução de sistema é um atributo do modelo no SDK do Vertex
        model.system_instruction = system_prompt
        
        response = model.generate_content(
            contents=contents,
            generation_config=gen_config,
        )
        return response.text
    except Exception as e:
        logging.error(f"Erro na chamada da API do Vertex AI: {e}")
        return f"ERRO_API: {e}"
