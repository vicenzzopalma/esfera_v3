export interface ModelSuggestion {
  id: string;
  name: string;
  tag: string;
}

export interface AiProviderInfo {
  id: string;
  name: string;
  category: "cloud_free" | "local_free" | "paid_custom";
  defaultEndpoint: string;
  defaultModel: string;
  keyPlaceholder: string;
  keyUrl?: string;
  keyHint?: string;
  suggestedModels: ModelSuggestion[];
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: "openrouter",
    name: "OpenRouter (Modelos 100% Free)",
    category: "cloud_free",
    defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "minimax/minimax-m3.1-flash:free",
    keyPlaceholder: "sk-or-v1-...",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "Obtenha grátis em openrouter.ai/keys",
    suggestedModels: [
      { id: "minimax/minimax-m3.1-flash:free", name: "MiniMax M3.1 Flash", tag: "Recomendado · Rápido & BR" },
      { id: "openrouter/free", name: "Free Router (Auto)", tag: "Sempre Ativo" },
      { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.6B", tag: "Ultra Leve" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA Super 120B", tag: "Potente" },
    ],
  },
  {
    id: "groq",
    name: "GroqCloud (Grátis & LPU Ultrarrápida)",
    category: "cloud_free",
    defaultEndpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    keyPlaceholder: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "Obtenha grátis em console.groq.com/keys",
    suggestedModels: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", tag: "Mais Inteligente" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", tag: "Instantâneo" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", tag: "Robusto" },
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

export const DEFAULT_WHATSAPP_SYSTEM_PROMPT =
  "Você é um assistente comercial brasileiro experiente. Redija mensagens diretas, simpáticas e humanizadas para o WhatsApp. " +
  "Mantenha sempre intactos todos os links (http/https), chaves PIX, números de telefone, datas e valores em Reais (R$). " +
  "Nunca adicione introduções ou explicações robóticas como 'Aqui está a mensagem:'. Devolva estritamente a mensagem final.";
