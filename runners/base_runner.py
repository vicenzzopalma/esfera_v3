# D:\Novo\Esfera v3\runners\base_runner.py

import json
import logging
import subprocess
from typing import Dict, List, Any

log = logging.getLogger(__name__)

class BaseRunner:
    """
    Classe base para runners que executam ferramentas externas via subprocesso
    e parseiam a saída JSON. Centraliza o tratamento de erros e a comunicação.
    """

    def _run_subprocess(self, command: List[str]) -> str:
        """
        Executa um comando em um subprocesso e captura seu stdout.
        Retorna uma string JSON de erro padronizada em caso de falha.
        """
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=True,
                encoding='utf-8'
            )
            return result.stdout
        except FileNotFoundError:
            log.error(f"Comando não encontrado: '{command[0]}'. Verifique se está instalado e no PATH.")
            return '{"error": "command_not_found", "success": false}'
        except subprocess.CalledProcessError as e:
            log.error(f"Erro ao executar '{' '.join(command)}'. Código: {e.returncode}")
            log.debug(f"Stderr: {e.stderr.strip() if e.stderr else ''}")
            return '{"error": "execution_failed", "success": false}'
        except Exception as e:
            log.error(f"Erro inesperado ao executar o subprocesso: {e}")
            return '{"error": "unknown_subprocess_error", "success": false}'

    def _parse_json(self, json_string: str) -> Dict[str, Any]:
        """
        Parseia uma string JSON de forma robusta, tratando JSON malformado.
        Retorna um dicionário de erro se o parsing falhar.
        """
        try:
            return json.loads(json_string)
        except json.JSONDecodeError as e:
            log.error(f"Falha ao parsear a saída JSON: {e}")
            log.debug(f"Output recebido (primeiros 500 chars): {json_string[:500] if json_string else ''}")
            return {"error": "malformed_json", "success": False}
