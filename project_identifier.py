# D:\Novo\Esfera v3\project_identifier.py

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
                return None  # Diretório 'src' existe, mas não contém arquivos .py
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
            return None  # Não atingiu o limiar mínimo de arquivos

        # Heurística: se todos os arquivos encontrados estiverem na raiz,
        # pode ser um conjunto de scripts soltos, não um projeto.
        is_flat_structure = all(f.parent.resolve() == path.resolve() for f in first_n_files)
        if is_flat_structure:
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
