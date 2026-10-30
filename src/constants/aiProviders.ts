export interface ModelSuggestion {
  id: string;
  name: string;
  tag: string;
}

export interface AiProviderInfo {
  id: string;
  name: string;
  category: "own_server" | "cloud_free" | "local_free" | "paid_custom";
  defaultEndpoint: string;
  defaultModel: string;
  keyPlaceholder: string;
  keyUrl?: string;
  keyHint?: string;
  suggestedModels: ModelSuggestion[];
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: "vps_ia",
    name: "IA própria (VPS, sem limite)",
    category: "own_server",
    defaultEndpoint: "https://187.77.243.224:11435/v1/chat/completions",
    defaultModel: "qwen3:4b-instruct",
    keyPlaceholder: "Token da IA da VPS (preenchido pelo hub)",
    keyHint: "Configurada em Integrações → IA própria (VPS); os PCs recebem pelo hub.",
    suggestedModels: [{ id: "qwen3:4b-instruct", name: "Qwen 3 4B", tag: "Servidor próprio" }],
  },
  {
    id: "openrouter",
    name: "OpenRouter (Modelos 100% Free)",
    category: "cloud_free",
    defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "nvidia/nemotron-3.5-lightning:free",
    keyPlaceholder: "sk-or-v1-...",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "Obtenha grátis em openrouter.ai/keys",
    suggestedModels: [
      { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA Nemotron Lightning", tag: "Grátis · lento" },
      { id: "xingchen-agi/xing4.0-29b-a4b:free", name: "Xing 4.0 29B", tag: "Grátis · lento" },
      { id: "openrouter/free", name: "Free Router (Auto)", tag: "Sempre Ativo" },
      { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.6B", tag: "Ultra Leve" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA Super 120B", tag: "Potente" },
    ],
  },
  {
    id: "groq",
    name: "Groq (grátis, recomendado)",
    category: "cloud_free",
    defaultEndpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "openai/gpt-oss-120b",
    keyPlaceholder: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "Obtenha grátis em console.groq.com/keys",
    suggestedModels: [
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", tag: "Recomendado · ~2s" },
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", tag: "Mais rápido" },
      { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", tag: "Alternativo" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras Cloud (Grátis & LPUs)",
    category: "cloud_free",
    defaultEndpoint: "https://api.cerebras.ai/v1/chat/completions",
    defaultModel: "llama3.1-8b",
    keyPlaceholder: "csk-...",
    keyUrl: "https://cloud.cerebras.ai",
    keyHint: "Obtenha grátis em cloud.cerebras.ai",
    suggestedModels: [
      { id: "llama3.1-8b", name: "Llama 3.1 8B", tag: "LPU Rápido" },
      { id: "llama3.1-70b", name: "Llama 3.1 70B", tag: "LPU Avançado" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama Local (Offline / Zero Custo)",
    category: "local_free",
    defaultEndpoint: "http://localhost:11434",
    defaultModel: "llama3.2:3b",
    keyPlaceholder: "Sem necessidade de chave para Ollama",
    suggestedModels: [
      { id: "llama3.2:3b", name: "Llama 3.2 3B", tag: "Equilibrado (2.5GB)" },
      { id: "llama3.2:1b", name: "Llama 3.2 1B", tag: "Ultra Leve (1.3GB)" },
      { id: "qwen2.5:3b", name: "Qwen 2.5 3B", tag: "Ótimo em Português" },
      { id: "phi3.5:mini", name: "Phi-3.5 Mini", tag: "Microsoft" },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio Local (Offline / Porta 1234)",
    category: "local_free",
    defaultEndpoint: "http://localhost:1234/v1/chat/completions",
    defaultModel: "local-model",
    keyPlaceholder: "Sem necessidade de chave para LM Studio",
    suggestedModels: [
      { id: "local-model", name: "Modelo Ativo no LM Studio", tag: "Local" },
    ],
  },
  {
    id: "custom",
    name: "API Customizada (Compatível com OpenAI)",
    category: "paid_custom",
    defaultEndpoint: "",
    defaultModel: "",
    keyPlaceholder: "Chave do seu provedor compatível",
    suggestedModels: [],
  },
  {
    id: "openai",
    name: "OpenAI ChatGPT (API Paga)",
    category: "paid_custom",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    keyPlaceholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    suggestedModels: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini", tag: "Econômico" },
      { id: "gpt-4o", name: "GPT-4o", tag: "Avançado" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic Claude (API Paga)",
    category: "paid_custom",
    defaultEndpoint: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-3-haiku-20240307",
    keyPlaceholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com",
    suggestedModels: [
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", tag: "Rápido" },
      { id: "claude-3-5-sonnet-20240620", name: "Claude 3.5 Sonnet", tag: "Avançado" },
    ],
  },
];

export function getAiProviderInfo(providerId: string): AiProviderInfo | undefined {
  return AI_PROVIDERS.find((p) => p.id === providerId.toLowerCase());
}

// Persona padrão da empresa. As regras legais (CDC/LGPD) ficam fixas no backend (ai_engine.rs).
export const DEFAULT_WHATSAPP_SYSTEM_PROMPT =
  "Você é um atendente de cobrança e relacionamento de uma empresa brasileira, falando com o próprio cliente pelo WhatsApp. Seja cordial, respeitoso, claro e breve. O objetivo é convidar o cliente a regularizar a pendência pelo canal de negociação, nunca pressionar. Nunca mencione valores. Mantenha datas, links e canais de negociação exatamente como estão.";
