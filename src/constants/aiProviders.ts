// Provedores de IA que a tela oferece. O dono usa só IAs gratuitas: a ordem recomendada é
// Groq (gpt-oss-120b → gpt-oss-20b) → IA própria da VPS → demais. O Gemini Web não é opção
// de provedor principal; ele só entra como reserva quando a conta Google está conectada.

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
    keyPlaceholder: "Token da IA própria (fica no cartão IA própria)",
    keyHint: "Endereço, modelo e token ficam no cartão “IA própria (VPS)” desta seção; os computadores recebem pelo hub.",
    suggestedModels: [{ id: "qwen3:4b-instruct", name: "Qwen 3 4B", tag: "Servidor próprio" }],
  },
  {
    id: "groq",
    name: "Groq (grátis, recomendado)",
    category: "cloud_free",
    defaultEndpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "openai/gpt-oss-120b",
    keyPlaceholder: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "Crie a chave grátis em console.groq.com/keys.",
    suggestedModels: [
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", tag: "Recomendado · ~2 s" },
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", tag: "Mais rápido" },
      { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", tag: "Alternativo" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter (modelos grátis)",
    category: "cloud_free",
    defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "nvidia/nemotron-3.5-lightning:free",
    keyPlaceholder: "sk-or-v1-...",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "Crie a chave grátis em openrouter.ai/keys.",
    suggestedModels: [
      { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA Nemotron Lightning", tag: "Grátis · lento" },
      { id: "xingchen-agi/xing4.0-29b-a4b:free", name: "Xing 4.0 29B", tag: "Grátis · lento" },
      { id: "openrouter/free", name: "Roteador grátis", tag: "Escolhe um modelo livre" },
      { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.6B", tag: "Muito leve" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA Super 120B", tag: "Mais capaz" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras (grátis)",
    category: "cloud_free",
    defaultEndpoint: "https://api.cerebras.ai/v1/chat/completions",
    defaultModel: "llama3.1-8b",
    keyPlaceholder: "csk-...",
    keyUrl: "https://cloud.cerebras.ai",
    keyHint: "Crie a chave grátis em cloud.cerebras.ai.",
    suggestedModels: [
      { id: "llama3.1-8b", name: "Llama 3.1 8B", tag: "Rápido" },
      { id: "llama3.1-70b", name: "Llama 3.1 70B", tag: "Mais capaz" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (neste computador, offline)",
    category: "local_free",
    defaultEndpoint: "http://localhost:11434",
    defaultModel: "llama3.2:3b",
    keyPlaceholder: "O Ollama não usa chave",
    suggestedModels: [
      { id: "llama3.2:3b", name: "Llama 3.2 3B", tag: "Equilibrado · 2,5 GB" },
      { id: "llama3.2:1b", name: "Llama 3.2 1B", tag: "Muito leve · 1,3 GB" },
      { id: "qwen2.5:3b", name: "Qwen 2.5 3B", tag: "Bom em português" },
      { id: "phi3.5:mini", name: "Phi-3.5 Mini", tag: "Microsoft" },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio (neste computador, offline)",
    category: "local_free",
    defaultEndpoint: "http://localhost:1234/v1/chat/completions",
    defaultModel: "local-model",
    keyPlaceholder: "O LM Studio não usa chave",
    suggestedModels: [
      { id: "local-model", name: "Modelo aberto no LM Studio", tag: "Local" },
    ],
  },
  {
    id: "custom",
    name: "Outra API compatível com OpenAI",
    category: "paid_custom",
    defaultEndpoint: "",
    defaultModel: "",
    keyPlaceholder: "Chave do seu provedor",
    suggestedModels: [],
  },
  {
    id: "openai",
    name: "OpenAI ChatGPT (pago)",
    category: "paid_custom",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    keyPlaceholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Serviço pago: cobra por uso.",
    suggestedModels: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini", tag: "Econômico" },
      { id: "gpt-4o", name: "GPT-4o", tag: "Avançado" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic Claude (pago)",
    category: "paid_custom",
    defaultEndpoint: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-3-haiku-20240307",
    keyPlaceholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com",
    keyHint: "Serviço pago: cobra por uso.",
    suggestedModels: [
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", tag: "Rápido" },
      { id: "claude-3-5-sonnet-20240620", name: "Claude 3.5 Sonnet", tag: "Avançado" },
    ],
  },
];

// Nomes antigos gravados no banco que equivalem a um provedor da lista.
const PROVIDER_ALIASES: Record<string, string> = { ollama_local: "ollama", lm_studio: "lmstudio" };

/** Id do provedor como aparece na lista (minúsculo e sem nomes antigos). */
export function normalizeAiProviderId(providerId: string): string {
  const id = providerId.trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

export function getAiProviderInfo(providerId: string): AiProviderInfo | undefined {
  const id = normalizeAiProviderId(providerId);
  return AI_PROVIDERS.find((p) => p.id === id);
}

/** Provedor e modelo usados quando a empresa ainda não salvou nada (igual ao padrão do disparo). */
export const DEFAULT_AI_PROVIDER = "groq";
export const DEFAULT_AI_MODEL = "openai/gpt-oss-120b";

/**
 * Reservas automáticas, na ordem em que o disparo tenta (dispatcher.rs, build_ai_fallback_chain).
 * A IA principal vem sempre antes; cada reserva só entra se tiver chave ou estiver conectada.
 */
export const AI_RESERVE_CHAIN: { provider: string; label: string; detail: string }[] = [
  { provider: "groq", label: "Groq", detail: "modelo salvo (recomendado: GPT-OSS 120B)" },
  { provider: "groq", label: "Groq · GPT-OSS 20B", detail: "mesma chave, outro limite diário" },
  { provider: "vps_ia", label: "IA própria (VPS)", detail: "quando configurada" },
  { provider: "gemini_web", label: "Gemini Web", detail: "só se a conta Google estiver conectada" },
  { provider: "cerebras", label: "Cerebras", detail: "com a chave da Cerebras" },
  { provider: "openrouter", label: "OpenRouter", detail: "com a chave; depois o roteador grátis" },
];

// Persona padrão da empresa. As regras legais (CDC/LGPD) ficam fixas no backend (ai_engine.rs).
export const DEFAULT_WHATSAPP_SYSTEM_PROMPT =
  "Você é um atendente de cobrança e relacionamento de uma empresa brasileira, falando com o próprio cliente pelo WhatsApp. Seja cordial, respeitoso, claro e breve. O objetivo é convidar o cliente a regularizar a pendência pelo canal de negociação, nunca pressionar. Nunca mencione valores. Mantenha datas, links e canais de negociação exatamente como estão.";
