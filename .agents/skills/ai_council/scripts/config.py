# config.py
import os
from dotenv import load_dotenv

# Carrega variáveis do arquivo .env para o ambiente
load_dotenv()

# --- Configurações da API (Vertex AI) ---
PROJECT_ID = os.getenv("GCP_PROJECT_ID")
LOCATION = os.getenv("GCP_LOCATION")

# --- Configurações do Modelo ---
MODEL_NAME = "gemini-1.5-pro-001" # Nome de modelo válido para Vertex AI
DEFAULT_TEMPERATURE = 0.2

# --- Configurações da Orquestração ---
MAX_ITERATIONS = 3
OUTPUT_FILENAME = "solucao_do_conselho.md"
