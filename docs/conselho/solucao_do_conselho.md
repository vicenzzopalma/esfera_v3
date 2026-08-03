# Tarefa Original: Com base nas reprovações anteriores do Conselho de IAs para o projeto em D:\Novo\Esfera, analise os seguintes problemas que foram encontrados e reprovados: 1) Parsing frágil do stderr no pylint_runner.py para extrair pontuação; 2) Uso ineficiente de list(path.glob()) que carrega tudo em memória no project_identifier.py; 3) Falta de tratamento robusto para JSON malformado nos runners; 4) Regressão lógica na detecção de projetos Python com estrutura src/; 5) Fallback identificava projetos apenas por presença de .py (falsos positivos). Proponha soluções concretas e implementáveis para cada um desses problemas.

## 1. Visão do Arquiteto

Entendido. A seguir, o plano de ação para corrigir as fragilidades e ineficiências apontadas pelo Conselho. O foco será em robustez, eficiência e manutenibilidade.

### 1. Arquitetura Geral e Padrões

Para resolver os problemas de forma coesa, adotaremos os seguintes princípios e padrões:

1.  **Robust Data Interchange:** Substituiremos o parsing de saídas de texto (stdout/stderr) por formatos de intercâmbio de dados estruturados, como JSON, sempre que a ferramenta externa permitir. Isso elimina a fragilidade do parsing manual.
2.  **Lazy Evaluation & Iterators:** Para operações de I/O em arquivos, utilizaremos iteradores e geradores em vez de carregar coleções inteiras de dados em memória. Isso resolve gargalos de memória e melhora a performance em projetos grandes.
3.  **Strategy Pattern para Detecção:** A lógica de identificação de projetos será refatorada para usar o *Strategy Pattern*. Cada método de detecção (ex: `src/` layout, `pyproject.toml`, fallback) será uma "estratégia" separada e intercambiável. Isso torna o sistema mais modular, testável e fácil de estender ou reordenar.
4.  **Error Handling Centralizado:** Implementaremos um tratamento de exceções consistente, especialmente para parsing de dados (JSON) e comunicação com processos externos, utilizando blocos `try-except` específicos e logging detalhado.

### 2. Fluxo Lógico e Plano de Ação por Problema

#### Problema 1: Parsing frágil do `pylint_runner.py`

*   **Diagnóstico:** O script depende da estrutura de texto do `stderr` do Pylint, que pode mudar entre versões ou configurações.
*   **Solução Proposta:** Modificar a chamada ao Pylint para que ele gere um relatório em formato JSON, que é estável e fácil de parsear.
*   **Fluxo de Execução:**
    1.  O `pylint_runner.py` invocará o Pylint com o argumento `--output-format=json`.
    2.  A saída JSON será capturada do `stdout` (não `stderr`).
    3.  O script usará a biblioteca `json` para carregar a string de saída em um dicionário Python.
    4.  A pontuação será extraída de forma segura acessando a chave correspondente no dicionário (ex: `report['global_note']`).
    5.  A chamada será encapsulada em um `try-except` para tratar possíveis erros na execução do subprocesso ou no parsing do JSON (conforme Problema 3).

---

#### Problema 2: Uso ineficiente de `list(path.glob())`

*   **Diagnóstico:** `list()` força a avaliação imediata de todo o gerador retornado por `glob()`, consumindo memória proporcional ao número de arquivos no projeto.
*   **Solução Proposta:** Processar o gerador de arquivos diretamente, sem convertê-lo para uma lista.
*   **Fluxo de Execução:**
    1.  Localize a linha `files = list(path.glob('**/*.py'))` em `project_identifier.py`.
    2.  Altere para `file_generator = path.glob('**/*.py')`.
    3.  Modifique o código subsequente que consome a variável `files` para iterar diretamente sobre `file_generator`.
    4.  Se for necessário contar os arquivos, use um contador dentro do loop em vez de `len(files)`. Ex: `file_count = sum(1 for _ in path.glob('**/*.py'))`.

---

#### Problema 3: Falta de tratamento para JSON malformado

*   **Diagnóstico:** Uma falha na comunicação ou um output corrompido da ferramenta externa pode gerar uma string que não é um JSON válido, quebrando o runner com uma exceção `json.JSONDecodeError`.
*   **Solução Proposta:** Envolver todas as chamadas `json.loads()` em um bloco `try-except` robusto.
*   **Fluxo de Execução:**
    1.  Em todos os runners (`pylint_runner.py` e outros), localize as chamadas `json.loads(output)`.
    2.  Encapsule a chamada da seguinte forma:
        ```python
        try:
            data = json.loads(output)
        except json.JSONDecodeError as e:
            # Logar o erro e a string malformada para depuração
            log.error(f"Falha ao parsear JSON: {e}")
            log.debug(f"Output recebido: {output[:500]}") # Limita o tamanho do log
            # Retornar um estado de falha ou um objeto vazio padronizado
            return {"error": "JSON malformado", "success": False}
        ```

---

#### Problema 4 & 5: Regressão lógica (`src/`) e Fallback fraco (`.py`)

*   **Diagnóstico:** A lógica de detecção é provavelmente uma série de `if/elif/else`, tornando-a frágil e difícil de manter. O fallback é muito permissivo.
*   **Solução Proposta:** Implementar o **Strategy Pattern**. Criar uma hierarquia de estratégias de detecção, da mais confiável para a menos confiável.
*   **Fluxo de Execução:**
    1.  O `ProjectIdentifier` principal receberá uma lista ordenada de estratégias de detecção.
    2.  Ele iterará sobre as estratégias, chamando um método `detect(path)` em cada uma.
    3.  A primeira estratégia que retornar um resultado positivo (identificando o projeto) encerra o processo e seu resultado é utilizado.
    4.  A estratégia de fallback (baseada em arquivos `.py`) será a última da lista e terá sua lógica aprimorada.
        *   **Lógica Aprimorada do Fallback:** Em vez de `any(.py)`, a estratégia deve exigir um limiar mínimo (ex: > 3 arquivos `.py`) E/OU verificar se os arquivos não estão todos no diretório raiz (indicando um projeto mais estruturado vs. scripts soltos).

### 3. Estrutura de Arquivos, Funções e Bibliotecas

**Bibliotecas Principais:** `pathlib`, `subprocess`, `json`, `typing` (para interfaces/protocols).

---

**`project_identifier.py`**

```python
# D:\Novo\Esfera\project_identifier.py

from pathlib import Path
from typing import Protocol, List, Optional

class DetectionStrategy(Protocol):
    """Interface para todas as estratégias de detecção."""
    def detect(self, path: Path) -> Optional[str]:
        """Se o projeto for detectado, retorna o tipo (ex: 'PYTHON'). Senão, None."""
        ...

class PyProjectTomlStrategy(DetectionStrategy):
    def detect(self, path: Path) -> Optional[str]:
        # Lógica: procurar por 'pyproject.toml' com [tool.poetry] ou [project]
        ...

class SrcLayoutStrategy(DetectionStrategy):
    def detect(self, path: Path) -> Optional[str]:
        # Lógica: procurar por 'src/<project_name>' e arquivos .py dentro
        ...

class PythonHeuristicStrategy(DetectionStrategy):
    """Fallback aprimorado."""
    def detect(self, path: Path) -> Optional[str]:
        # Lógica: contar arquivos .py (usando gerador, não list)
        # Se count > THRESHOLD (ex: 3), retorna 'PYTHON'
        ...

class ProjectIdentifier:
    def __init__(self):
        self.strategies: List[DetectionStrategy] = [
            PyProjectTomlStrategy(),
            SrcLayoutStrategy(),
            # Outras estratégias de alta confiança aqui...
            PythonHeuristicStrategy(), # Fallback por último
        ]

    def identify(self, project_path: Path) -> Optional[str]:
        # Iterar sobre self.strategies e chamar detect()
        # Retornar o primeiro resultado não-nulo
        ...

# O código que usa list(path.glob()) será refatorado para usar geradores
# dentro das estratégias.
```

---

**`runners/base_runner.py`** (Pode ser um novo arquivo para centralizar lógica)

```python
# D:\Novo\Esfera\runners\base_runner.py

import json
import logging

class BaseRunner:
    def _run_subprocess(self, command: list) -> str:
        # Lógica de chamada ao subprocess.run, capturando stdout
        ...

    def _parse_json(self, json_string: str) -> dict:
        # Implementar o bloco try-except robusto para json.JSONDecodeError
        # conforme descrito no Problema 3.
        ...
```

---

**`runners/pylint_runner.py`**

```python
# D:\Novo\Esfera\runners\pylint_runner.py

from .base_runner import BaseRunner

class PylintRunner(BaseRunner):
    def run(self, project_path: str) -> dict:
        # Construir o comando com '--output-format=json'
        command = ["pylint", "--output-format=json", project_path]
        
        # Chamar o subprocesso
        output = self._run_subprocess(command)
        
        # Parsear a saída usando o método robusto da classe base
        parsed_data = self._parse_json(output)
        
        # Extrair a pontuação e outras métricas do 'parsed_data'
        # e retornar o resultado final.
        ...
```

Este plano fornece um caminho claro para o desenvolvedor. Ele aborda cada problema com uma solução técnica específica, integrada a uma arquitetura mais ampla e robusta.

## 2. Código Final (Iteração 1)

```
Aqui está o código, implementado de acordo com as diretrizes do Arquiteto para resolver os problemas apontados.

### **`D:\Novo\Esfera\runners\base_runner.py`**
Este é um novo arquivo base para centralizar a lógica de execução de subprocessos e parsing de JSON, garantindo robustez e reuso.

```python
# D:\Novo\Esfera\runners\base_runner.py

import json
import logging
import subprocess
from typing import Dict, List, Any

# Configuração do logger para depuração de problemas nos runners
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
            # Executa o comando, capturando stdout/stderr e decodificando como UTF-8.
            # check=True lança CalledProcessError se o processo retornar um código de erro.
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
            log.debug(f"Stderr: {e.stderr.strip()}")
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
            log.debug(f"Output recebido (primeiros 500 chars): {json_string[:500]}")
            return {"error": "malformed_json", "success": False}
```

### **`D:\Novo\Esfera\runners\pylint_runner.py`**
Refatorado para herdar de `BaseRunner` e usar o formato de saída JSON do Pylint, eliminando o parsing frágil de `stderr`.

```python
# D:\Novo\Esfera\runners\pylint_runner.py

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
        if parsed_data.get("success") is False:
            return {"score": 0.0, "success": False, "error": parsed_data.get("error")}

        # Extrai a pontuação global do relatório JSON de forma segura
        try:
            score = float(parsed_data["global_note"])
            return {"score": score, "success": True, "error": None}
        except (KeyError, TypeError, ValueError):
            # Trata o caso onde o JSON é válido, mas não contém a chave/formato esperado
            return {"score": 0.0, "success": False, "error": "formato_json_inesperado"}
```

### **`D:\Novo\Esfera\project_identifier.py`**
Completamente refatorado para usar o *Strategy Pattern*, com estratégias de detecção modulares e eficientes, e um fallback aprimorado.

```python
# D:\Novo\Esfera\project_identifier.py

import itertools
from pathlib import Path
from typing import Protocol, List, Optional, Generator

# --- Interface (Protocolo) para as Estratégias ---

class DetectionStrategy(Protocol):
    """
    Define a interface para uma estratégia de detecção de tipo de projeto.
    """
    def detect(self, path: Path) -> Optional[str]:
        """
        Tenta detectar o tipo de projeto. Retorna o tipo (ex: 'PYTHON') ou None.
        """
        ...

# --- Estratégias de Detecção Concretas ---

class PyProjectTomlStrategy:
    """Detecta projetos Python baseados na presença de `pyproject.toml`."""
    def detect(self, path: Path) -> Optional[str]:
        pyproject_file = path / "pyproject.toml"
        if pyproject_file.is_file():
            content = pyproject_file.read_text(encoding='utf-8', errors='ignore')
            if "[tool.poetry]" in content or "[project]" in content:
                return "PYTHON"
        return None

class SrcLayoutStrategy:
    """Detecta projetos Python que seguem a estrutura de layout 'src/'."""
    def detect(self, path: Path) -> Optional[str]:
        src_dir = path / "src"
        if src_dir.is_dir():
            # Usa um gerador para verificar eficientemente a existência de qualquer arquivo .py
            try:
                next(src_dir.glob("**/*.py"))
                return "PYTHON"
            except StopIteration:
                return None # Diretório 'src' existe, mas não contém arquivos .py
        return None

class PythonHeuristicStrategy:
    """Estratégia de fallback aprimorada com limiar e análise de estrutura."""
    MIN_PY_FILES_THRESHOLD = 3

    def detect(self, path: Path) -> Optional[str]:
        # Usa um gerador para eficiência de memória, evitando list(path.glob(...))
        py_files_generator: Generator[Path, None, None] = path.glob("**/*.py")

        # Pega os primeiros N+1 arquivos para verificar se o limiar foi atingido
        # `itertools.islice` consome o gerador de forma preguiçosa (lazy)
        first_n_files = list(itertools.islice(py_files_generator, self.MIN_PY_FILES_THRESHOLD))

        if len(first_n_files) < self.MIN_PY_FILES_THRESHOLD:
            return None # Não atingiu o limiar mínimo de arquivos

        # Heurística: se todos os arquivos encontrados estiverem na raiz,
        # pode ser um conjunto de scripts soltos, não um projeto.
        is_flat_structure = all(f.parent.resolve() == path.resolve() for f in first_n_files)
        if is_flat_structure:
            # Para ser considerado um projeto mesmo sendo plano, talvez precise de mais arquivos.
            # Esta lógica pode ser expandida, mas já evita muitos falsos positivos.
            return None

        return "PYTHON"

# --- Orquestrador Principal ---

class ProjectIdentifier:
    """
    Identifica o tipo de um projeto usando uma lista ordenada de estratégias.
    """
    def __init__(self, strategies: Optional[List[DetectionStrategy]] = None):
        """Inicializa com estratégias padrão ordenadas por confiabilidade."""
        self.strategies: List[DetectionStrategy] = strategies or [
            PyProjectTomlStrategy(),
            SrcLayoutStrategy(),
            PythonHeuristicStrategy(),  # Fallback por último
        ]

    def identify(self, project_path_str: str) -> Optional[str]:
        """
        Itera sobre as estratégias e retorna o tipo de projeto na primeira detecção.
        """
        project_path = Path(project_path_str)
        if not project_path.is_dir():
            return None

        for strategy in self.strategies:
            project_type = strategy.detect(project_path)
            if project_type:
                return project_type  # Retorna o primeiro resultado positivo

        return None
```
```