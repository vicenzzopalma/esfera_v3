# D:\Novo\Esfera v3\runners\pylint_runner.py

from pathlib import Path
from typing import Dict, Any
from .base_runner import BaseRunner

class PylintRunner(BaseRunner):
    """
    Executa o Pylint em um projeto Python e extrai a pontuação global
    usando o formato de saída JSON, de forma robusta.
    """

    def run(self, project_path: Path) -> Dict[str, Any]:
        """
        Executa o Pylint e retorna um dicionário com a pontuação e status.
        """
        target = str(project_path.resolve())

        # Comando para executar o Pylint com saída JSON para stdout.
        command = ["pylint", "--output-format=json", target]

        # Executa o comando usando o método seguro da classe base
        raw_output = self._run_subprocess(command)

        # Parseia a saída JSON usando o método robusto da classe base
        parsed_data = self._parse_json(raw_output)

        # Verifica se a execução ou o parsing falhou (retornou um dict de erro)
        if isinstance(parsed_data, dict) and parsed_data.get("success") is False:
            return {"score": 0.0, "success": False, "error": parsed_data.get("error")}

        # Extrai a pontuação global do relatório JSON de forma segura
        try:
            if isinstance(parsed_data, dict) and "global_note" in parsed_data:
                score = float(parsed_data["global_note"])
                return {"score": score, "success": True, "error": None}
            elif isinstance(parsed_data, list):
                # O Pylint em JSON às vezes retorna uma lista de mensagens de erro
                return {"score": 10.0, "issues_count": len(parsed_data), "success": True, "error": None}
            else:
                return {"score": 0.0, "success": False, "error": "formato_json_inesperado"}
        except (KeyError, TypeError, ValueError):
            return {"score": 0.0, "success": False, "error": "formato_json_inesperado"}
