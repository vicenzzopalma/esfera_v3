// ============================================================
// Esfera v3 — Configurações
// Seções: Rede e ritmo, Inteligência artificial, Integrações (VEXOR) e Conexão e servidores.
// Cada seção salva por conta própria e diz para quem vale: este computador ou a empresa.
// Segredos (chaves de IA e tokens) nunca aparecem na tela; campo em branco mantém o salvo.
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Wifi,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useCompanies } from "../hooks/useQueries";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import PageHeader from "../components/ui/PageHeader";
import Field, { FormSection } from "../components/ui/Field";
import Badge from "../components/ui/Badge";
import { confirmDialog } from "../components/ui/Modal";
import { toast } from "../components/ui/ToastContainer";
import { api, setAppMode as setTauriAppMode, reloadConfig } from "../tauri";
import type { AppConfig, AiConfig } from "../types";
import {
  AI_PROVIDERS,
  AI_RESERVE_CHAIN,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
  getAiProviderInfo,
  normalizeAiProviderId,
} from "../constants/aiProviders";

// ---- Seções ----
// Antes havia também Geral, Notificações, Aparelhos e ADB e Segurança e backup: nenhum daqueles
// campos era salvo em lugar nenhum (e Exportar backup/Restaurar padrões não faziam nada).
type SettingsSection = "rede" | "ia" | "integracoes" | "hub";

const SECTIONS: { id: SettingsSection; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "rede", label: "Rede e ritmo", hint: "Limites de envio e freio dos chips", icon: Gauge },
  { id: "ia", label: "Inteligência artificial", hint: "IA principal, reservas e IA própria", icon: Sparkles },
  { id: "integracoes", label: "Integrações", hint: "VEXOR e descadastro (SAIR)", icon: Plug },
  { id: "hub", label: "Conexão e servidores", hint: "Hub, modo e servidores locais", icon: Wifi },
];

const isSection = (value: string | null): value is SettingsSection => SECTIONS.some((s) => s.id === value);

type LoadState = "loading" | "ready" | "error";
// O que get_ai_provider_keys devolve por provedor. A chave vem vazia (mascarada) no backend novo;
// hasApiKey é o indicador pedido ao backend (pedidos-L-SET.md) e é usado quando existir.
type ProviderKeyInfo = { apiKey?: string; endpoint?: string; model?: string; hasApiKey?: boolean };
type HubSnapshot = {
  hubEnabled: boolean;
  hubAddress: string;
  empresaServerEnabled: boolean;
  empresaServerPort: string;
  tunnelServerEnabled: boolean;
  tunnelServerPort: string;
  appMode: string;
};
type AiSnapshot = { provider: string; model: string; temperature: string; systemPrompt: string; endpoint: string };

interface VpsIaStatus {
  configured: boolean;
  endpoint: string;
  model: string;
}

interface VpsIaTestResult {
  text: string;
  elapsedMs: number;
}

interface GeminiWebStatus {
  connected: boolean;
  browserOpen: boolean;
  savedConnected?: boolean;
  detail: string;
}

/** Compara dois retratos do formulário campo a campo. */
function sameSnapshot<T extends Record<string, unknown>>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => a[k] === b[k]);
}

const DEFAULT_HUB_ADDRESS = "127.0.0.1:8555";
const KNOWN_MODES = ["empresa", "local", "master"] as const;
type KnownMode = (typeof KNOWN_MODES)[number];
const isKnownMode = (m: string): m is KnownMode => (KNOWN_MODES as readonly string[]).includes(m);

// Texto de teste da IA: sem valores (R$ é proibido e o validador recusaria), sem link e sem data.
const AI_TEST_MESSAGE =
  "Olá {nome}, tudo bem? Aqui é da central de atendimento. Temos uma proposta para você regularizar a sua pendência. Responda esta mensagem para conversar com a gente.";
const AI_TEST_CONTACT = "Maria";

// Webhook de descadastro (SAIR): o VEXOR chama POST /api/optout/events no Esfera com o token da empresa.
const OPTOUT_BASE_URL = "http://127.0.0.1:8080";

/** Texto legível de um erro do backend (string), de um Error ou de um objeto com message. */
function errText(e: unknown): string {
  if (typeof e === "string") return e.trim() || "Erro desconhecido.";
  if (e instanceof Error) return e.message.trim() || "Erro desconhecido.";
  if (e && typeof e === "object") {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return String(e);
}

/** Porta TCP válida para servidor local (1024 a 65535) ou null. */
function parsePort(value: string): number | null {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** Número decimal digitado com vírgula ou ponto (NaN se vazio ou inválido). */
function parseDecimal(value: string): number {
  return value.trim() === "" ? NaN : Number(value.trim().replace(",", "."));
}

/** Segundos com uma casa, no formato brasileiro (ex.: "2,4"). */
function formatSeconds(ms: number): string {
  return (ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ---- Testes que a tela pode abandonar ----
// "Parar" ou o tempo limite liberam a tela na hora. O backend não é cancelado: a resposta
// que chegar depois é descartada. Ao sair da tela, a espera termina como parada.
type RunOutcome<T> =
  | { kind: "ok"; value: T; ms: number }
  | { kind: "error"; message: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "stopped" };

function useTimedRun() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const current = useRef<{ id: number; stop: () => void } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => current.current?.stop(), []);

  const run = useCallback(<T,>(task: () => Promise<T>, limitSeconds: number): Promise<RunOutcome<T>> => {
    current.current?.stop();
    const id = ++seq.current;
    setRunning(true);
    const started = performance.now();
    return new Promise<RunOutcome<T>>((resolve) => {
      let timer = 0;
      let settled = false;
      const finish = (outcome: RunOutcome<T>) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (current.current?.id === id) {
          current.current = null;
          setRunning(false);
        }
        resolve(outcome);
      };
      current.current = { id, stop: () => finish({ kind: "stopped" }) };
      timer = window.setTimeout(() => finish({ kind: "timeout", seconds: limitSeconds }), limitSeconds * 1000);
      task().then(
        (value) => finish({ kind: "ok", value, ms: performance.now() - started }),
        (e) => finish({ kind: "error", message: errText(e) }),
      );
    });
  }, []);

  const stop = useCallback(() => current.current?.stop(), []);
  return { running, elapsed, run, stop };
}

type TestResultData = { tone: "success" | "error" | "neutral"; title: string; text: string };

/** Resultado de um teste a partir do desfecho; `ok` monta o texto de sucesso. */
function outcomeToResult<T>(outcome: RunOutcome<T>, ok: (value: T, ms: number) => TestResultData, timeoutHint: string): TestResultData {
  switch (outcome.kind) {
    case "ok":
      return ok(outcome.value, outcome.ms);
    case "error":
      return { tone: "error", title: "Falha no teste", text: outcome.message };
    case "timeout":
      return { tone: "error", title: "Tempo esgotado", text: `Sem resposta em ${outcome.seconds} s. ${timeoutHint}` };
    case "stopped":
      return { tone: "neutral", title: "Teste interrompido", text: "Se a resposta chegar depois, ela é descartada." };
  }
}

/** Lê o arquivo como base64 sem estourar a pilha (o spread em String.fromCharCode quebra em arquivos grandes). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export default function SettingsTab() {
  const { selectedCompanyId, user, hubConnected } = useAuth();
  const isMasterUser = user?.role === "master";
  const canManage = isMasterUser || user?.role === "gestor";
  const companiesQuery = useCompanies();
  const companyName = companiesQuery.data?.find((c) => c.id === selectedCompanyId)?.name;
  const companyLabel = companyName ? `“${companyName}”` : "selecionada";

  // Seção ativa fica na URL (?secao=ia): sobrevive a recarregar e permite link direto.
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get("secao");
  const activeSection: SettingsSection = isSection(sectionParam) ? sectionParam : "rede";
  const goToSection = (id: SettingsSection) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("secao", id);
        return next;
      },
      { replace: true },
    );
  };

  // Hub config
  const [hubEnabled, setHubEnabled] = useState(false);
  const [hubAddress, setHubAddress] = useState(DEFAULT_HUB_ADDRESS);
  // Token digitado agora. O salvo nunca aparece inteiro na tela; em branco = manter o atual.
  const [hubToken, setHubToken] = useState("");
  // Backend antigo ainda devolve o token: fica só na memória para não ser apagado ao salvar.
  const loadedHubToken = useRef("");
  const [customIpOverride, setCustomIpOverride] = useState(false);
  const [empresaServerEnabled, setEmpresaServerEnabled] = useState(false);
  const [empresaServerPort, setEmpresaServerPort] = useState("7777");
  const [tunnelServerEnabled, setTunnelServerEnabled] = useState(false);
  const [tunnelServerPort, setTunnelServerPort] = useState("8888");
  // Pode vir "standalone" (padrão de instalação nova): o valor é mantido até o operador trocar.
  const [appMode, setAppMode] = useState<string>("empresa");
  const [appConfigLoad, setAppConfigLoad] = useState<LoadState>("loading");
  const [appConfigError, setAppConfigError] = useState("");
  const [appConfigReload, setAppConfigReload] = useState(0);
  const [savingHub, setSavingHub] = useState(false);
  const [hubStatus, setHubStatus] = useState("");
  // Atualizar VPS (self-update remoto, sem SSH) — master only
  const [updatingVps, setUpdatingVps] = useState(false);
  const [updateVpsMsg, setUpdateVpsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // IA / LLM
  const [aiProvider, setAiProvider] = useState(DEFAULT_AI_PROVIDER);
  const [aiModel, setAiModel] = useState(DEFAULT_AI_MODEL);
  const [aiTemperature, setAiTemperature] = useState("0.7");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  // Chave digitada agora; a salva não aparece. Em branco = manter a chave salva do provedor.
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiEndpoint, setAiEndpoint] = useState(getAiProviderInfo(DEFAULT_AI_PROVIDER)?.defaultEndpoint ?? "");
  const [savedProviderKeys, setSavedProviderKeys] = useState<Record<string, ProviderKeyInfo>>({});
  // Chaves que o backend antigo ainda devolve: nunca vão para a tela, só voltam ao salvar sem chave nova.
  const loadedKeys = useRef<Record<string, string>>({});
  const [aiLoad, setAiLoad] = useState<LoadState>("loading");
  const [aiLoadError, setAiLoadError] = useState("");
  const [aiReload, setAiReload] = useState(0);
  const [savingAi, setSavingAi] = useState(false);
  const [aiStatus, setAiStatus] = useState("");
  const aiRun = useTimedRun();
  const [aiTestResult, setAiTestResult] = useState<TestResultData | null>(null);

  // Último estado salvo (ou carregado): base de "Alterações não salvas" e do Desfazer.
  const [hubSaved, setHubSaved] = useState<HubSnapshot | null>(null);
  const [aiSaved, setAiSaved] = useState<AiSnapshot | null>(null);

  // Situação das reservas para a lista da cadeia (os cartões IA própria e Gemini informam).
  const [vpsInfo, setVpsInfo] = useState<VpsIaStatus | null>(null);
  const [geminiConnected, setGeminiConnected] = useState<boolean | null>(null);

  // Põe um retrato no formulário e o guarda como "salvo" (carregar, salvar e Desfazer usam).
  const applyHubSnapshot = (s: HubSnapshot) => {
    setHubEnabled(s.hubEnabled);
    setHubAddress(s.hubAddress);
    setEmpresaServerEnabled(s.empresaServerEnabled);
    setEmpresaServerPort(s.empresaServerPort);
    setTunnelServerEnabled(s.tunnelServerEnabled);
    setTunnelServerPort(s.tunnelServerPort);
    setAppMode(s.appMode);
    setHubToken("");
    setCustomIpOverride(false);
    setHubSaved(s);
  };
  const applyAiSnapshot = (s: AiSnapshot) => {
    setAiProvider(s.provider);
    setAiModel(s.model);
    setAiTemperature(s.temperature);
    setAiSystemPrompt(s.systemPrompt);
    setAiEndpoint(s.endpoint);
    setAiApiKey("");
    setAiSaved(s);
  };

  // Configuração da instalação (hub, servidores, modo). Sem ela carregada, Salvar fica bloqueado:
  // salvar os valores de exemplo por cima da configuração real desligaria o hub ou os servidores.
  useEffect(() => {
    let mounted = true;
    setAppConfigLoad("loading");
    setAppConfigError("");
    api<AppConfig>("get_app_config")
      .then((cfg) => {
        if (!mounted) return;
        if (!cfg) throw new Error("A configuração veio vazia.");
        loadedHubToken.current = cfg.hub_token || "";
        applyHubSnapshot({
          hubEnabled: Boolean(cfg.hub_enabled),
          hubAddress: cfg.hub_address || DEFAULT_HUB_ADDRESS,
          empresaServerEnabled: Boolean(cfg.empresa_server_enabled),
          empresaServerPort: String(cfg.empresa_server_port || 7777),
          tunnelServerEnabled: cfg.tunnel_server_enabled ?? false,
          tunnelServerPort: String(cfg.tunnel_server_port || 8888),
          appMode: cfg.mode || "empresa",
        });
        setAppConfigLoad("ready");
      })
      .catch((err) => {
        if (!mounted) return;
        setAppConfigError(errText(err));
        setAppConfigLoad("error");
      });
    return () => { mounted = false; };
  }, [appConfigReload]);

  // IA da empresa selecionada. Ao trocar de empresa tudo volta ao padrão antes de carregar:
  // antes, sem configuração na empresa nova, a tela mantinha (e salvaria) a IA da anterior.
  useEffect(() => {
    if (!selectedCompanyId) return;
    let mounted = true;
    setAiLoad("loading");
    setAiLoadError("");
    setAiStatus("");
    setAiTestResult(null);
    setAiApiKey("");
    loadedKeys.current = {};
    Promise.all([
      api<AiConfig | null>("get_ai_config", { companyId: selectedCompanyId }),
      api<Record<string, ProviderKeyInfo> | null>("get_ai_provider_keys", { companyId: selectedCompanyId }).catch(() => null),
    ])
      .then(([cfg, keys]) => {
        if (!mounted) return;
        const memo: Record<string, string> = {};
        const visible: Record<string, ProviderKeyInfo> = {};
        for (const [rawId, info] of Object.entries(keys ?? {})) {
          const id = normalizeAiProviderId(rawId);
          if (info?.apiKey) memo[id] = info.apiKey;
          visible[id] = {
            endpoint: info?.endpoint || "",
            model: info?.model || "",
            hasApiKey: info?.hasApiKey ?? (info?.apiKey ? true : undefined),
          };
        }
        const provider = normalizeAiProviderId(cfg?.provider || DEFAULT_AI_PROVIDER);
        if (cfg?.apiKey) {
          memo[provider] = cfg.apiKey;
          visible[provider] = { ...visible[provider], hasApiKey: true };
        }
        loadedKeys.current = memo;
        setSavedProviderKeys(visible);
        const info = getAiProviderInfo(provider);
        applyAiSnapshot({
          provider,
          model: cfg?.model || info?.defaultModel || DEFAULT_AI_MODEL,
          temperature: String(cfg?.temperature ?? 0.7),
          systemPrompt: cfg?.systemPrompt || "",
          endpoint: cfg?.endpoint || info?.defaultEndpoint || "",
        });
        // IA própria como principal: endereço e modelo valem os do cartão IA própria (o hub atualiza
        // só o cartão). Se a principal gravada estiver diferente, aparece "Alterações não salvas".
        const vps = provider === "vps_ia" ? visible.vps_ia : undefined;
        if (vps && (vps.endpoint || vps.model)) {
          if (vps.endpoint) setAiEndpoint(vps.endpoint);
          if (vps.model) setAiModel(vps.model);
        }
        setAiLoad("ready");
      })
      .catch((e) => {
        if (!mounted) return;
        setAiLoadError(errText(e));
        setAiLoad("error");
      });
    return () => { mounted = false; };
  }, [selectedCompanyId, aiReload]);

  const changeAiProvider = (next: string) => {
    const pInfo = getAiProviderInfo(next);
    const saved = savedProviderKeys[next];
    setAiProvider(next);
    setAiApiKey("");
    setAiTestResult(null);
    setAiEndpoint(saved?.endpoint || pInfo?.defaultEndpoint || "");
    setAiModel(saved?.model || pInfo?.defaultModel || "");
  };

  // Validação do formulário de IA: devolve o erro de cada campo (vazio = ok).
  const aiTemperatureValue = parseDecimal(aiTemperature);
  const aiTemperatureError =
    !Number.isFinite(aiTemperatureValue) || aiTemperatureValue < 0 || aiTemperatureValue > 1 ? "Use um número de 0 a 1 (ex.: 0,7)." : "";
  // IA própria como principal: endereço e modelo são sempre os do cartão IA própria (quando ele já
  // carregou); assim não há dois lugares para editar o mesmo valor.
  const vpsCard = aiProvider === "vps_ia" && vpsInfo?.configured ? vpsInfo : null;
  const aiEndpointTrim = vpsCard ? vpsCard.endpoint : aiEndpoint.trim();
  const aiModelTrim = vpsCard ? vpsCard.model : aiModel.trim();
  const aiEndpointError =
    aiProvider === "vps_ia"
      ? ""
      : aiProvider === "custom" && !aiEndpointTrim
      ? "Informe o endereço da API."
      : aiEndpointTrim && !/^https?:\/\/\S+$/i.test(aiEndpointTrim)
      ? "O endereço deve começar com http:// ou https://."
      : "";
  const aiModelError = !aiModelTrim && !getAiProviderInfo(aiProvider)?.defaultModel ? "Informe o modelo." : "";

  // Chave que vai para o backend: a digitada agora ou, em branco, a já salva (o backend novo
  // devolve vazio e preserva a salva; o antigo precisava receber a mesma chave de volta).
  const aiKeyToSend = () => aiApiKey.trim() || loadedKeys.current[aiProvider] || "";

  const handleSaveAi = async () => {
    if (!selectedCompanyId || aiLoad !== "ready") return;
    const problem =
      aiTemperatureError ||
      aiEndpointError ||
      aiModelError ||
      (aiProvider === "vps_ia" && vpsInfo && !vpsInfo.configured
        ? "configure a IA própria no cartão abaixo antes de escolhê-la como principal."
        : "");
    if (problem) {
      setAiStatus(`Falha ao salvar: ${problem}`);
      return;
    }
    const info = getAiProviderInfo(aiProvider);
    const provider = aiProvider;
    const model = aiModelTrim || info?.defaultModel || "";
    const endpoint = aiEndpointTrim || info?.defaultEndpoint || "";
    const typedKey = aiApiKey.trim();
    setSavingAi(true);
    setAiStatus("");
    try {
      await api("save_ai_config", {
        config: {
          companyId: selectedCompanyId,
          provider,
          model,
          temperature: aiTemperatureValue,
          systemPrompt: aiSystemPrompt,
          apiKey: aiKeyToSend(),
          endpoint,
        },
      });
      if (typedKey) loadedKeys.current[provider] = typedKey;
      setSavedProviderKeys((prev) => ({
        ...prev,
        [provider]: { endpoint, model, hasApiKey: typedKey ? true : prev[provider]?.hasApiKey },
      }));
      applyAiSnapshot({ provider, model, temperature: aiTemperature.trim(), systemPrompt: aiSystemPrompt, endpoint });
      setAiStatus("Configuração de IA salva.");
      toast.success("Configuração de IA salva");
    } catch (e) {
      setAiStatus(`Falha ao salvar a configuração de IA: ${errText(e)}`);
    } finally {
      setSavingAi(false);
    }
  };

  // Tempo limite do teste: a IA própria tem fila e 90 s de HTTP; local pode estar carregando o modelo.
  const aiTestLimit = aiProvider === "vps_ia" ? 150 : aiProvider === "ollama" || aiProvider === "lmstudio" ? 120 : 45;

  const handleTestAi = async () => {
    if (!selectedCompanyId) return;
    setAiTestResult(null);
    const outcome = await aiRun.run(
      () =>
        api<string>("rewrite_message_ai", {
          message: AI_TEST_MESSAGE,
          contactName: AI_TEST_CONTACT,
          companyId: selectedCompanyId,
          provider: aiProvider,
          model: aiModelTrim,
          prompt: aiSystemPrompt,
          apiKey: aiKeyToSend(),
          endpoint: aiEndpointTrim,
        }),
      aiTestLimit,
    );
    setAiTestResult(
      outcomeToResult(
        outcome,
        (text, ms) => ({ tone: "success", title: `Resposta em ${formatSeconds(ms)} s`, text }),
        "Confira o endereço, a chave e a internet e tente de novo.",
      ),
    );
  };

  const aiDirty =
    aiLoad === "ready" &&
    aiSaved !== null &&
    (aiApiKey.trim() !== "" ||
      !sameSnapshot(
        { provider: aiProvider, model: aiModelTrim, temperature: aiTemperature.trim(), systemPrompt: aiSystemPrompt, endpoint: aiEndpointTrim },
        aiSaved,
      ));

  // O cartão IA própria carregou, salvou ou removeu. Se a IA própria é a principal gravada,
  // a principal passa a usar o endereço e o modelo novos (senão o disparo seguiria nos antigos).
  const aiSavedRef = useRef(aiSaved);
  const aiProviderRef = useRef(aiProvider);
  useEffect(() => {
    aiSavedRef.current = aiSaved;
    aiProviderRef.current = aiProvider;
  });
  const handleVpsChange = useCallback(
    async (status: VpsIaStatus, how: "load" | "save" | "remove") => {
      setVpsInfo(status);
      setSavedProviderKeys((prev) => ({
        ...prev,
        vps_ia: { endpoint: status.endpoint, model: status.model, hasApiKey: status.configured },
      }));
      if (how !== "save" || !status.configured) return;
      if (aiProviderRef.current === "vps_ia") {
        setAiEndpoint(status.endpoint);
        setAiModel(status.model);
      }
      const saved = aiSavedRef.current;
      if (!selectedCompanyId || !saved || saved.provider !== "vps_ia") return;
      if (saved.endpoint === status.endpoint && saved.model === status.model) return;
      const temperature = parseDecimal(saved.temperature);
      try {
        await api("save_ai_config", {
          config: {
            companyId: selectedCompanyId,
            provider: "vps_ia",
            model: status.model,
            temperature: Number.isFinite(temperature) ? temperature : 0.7,
            systemPrompt: saved.systemPrompt,
            apiKey: loadedKeys.current.vps_ia || "",
            endpoint: status.endpoint,
          },
        });
        setAiSaved({ ...saved, endpoint: status.endpoint, model: status.model });
        toast.success("IA principal atualizada", "A IA própria é a principal e já usa o endereço e o modelo novos.");
      } catch (e) {
        toast.error("A IA principal não foi atualizada", `Clique em Salvar IA para usar o endereço novo. ${errText(e)}`);
      }
    },
    [selectedCompanyId],
  );

  // Validação da conexão: endereço host:porta e portas dos servidores ligados.
  const hubAddressTrim = hubAddress.trim();
  const hubAddressError =
    hubAddressTrim && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(hubAddressTrim) ? "Use o formato IP:porta (ex.: 187.77.243.224:8555)." : "";
  const lanPortError = empresaServerEnabled && parsePort(empresaServerPort) === null ? "Use uma porta de 1024 a 65535." : "";
  const tunnelPortError = tunnelServerEnabled && parsePort(tunnelServerPort) === null ? "Use uma porta de 1024 a 65535." : "";

  const handleSaveAll = async () => {
    if (appConfigLoad !== "ready") return;
    const problem = hubAddressError || lanPortError || tunnelPortError;
    if (problem) {
      setHubStatus(`Erro ao salvar a conexão: ${problem}`);
      return;
    }
    const address = hubAddressTrim || DEFAULT_HUB_ADDRESS;
    const typedToken = hubToken.trim();
    setSavingHub(true);
    setHubStatus("");
    try {
      const payload: AppConfig = {
        hub_enabled: hubEnabled,
        hub_address: address,
        // Em branco: o backend novo mantém o token salvo; o antigo recebe de volta o que mandou.
        hub_token: typedToken || loadedHubToken.current,
        empresa_server_enabled: empresaServerEnabled,
        empresa_server_port: parsePort(empresaServerPort) ?? 7777,
        checkin_server_enabled: true,
        checkin_server_port: 8080,
        tunnel_server_enabled: tunnelServerEnabled,
        tunnel_server_port: parsePort(tunnelServerPort) ?? 8888,
        mode: appMode as AppConfig["mode"],
      };
      await api("save_app_config", { config: payload });
      if (typedToken) loadedHubToken.current = typedToken;
      applyHubSnapshot({
        hubEnabled,
        hubAddress: address,
        empresaServerEnabled,
        empresaServerPort: String(payload.empresa_server_port),
        tunnelServerEnabled,
        tunnelServerPort: String(payload.tunnel_server_port),
        appMode,
      });
      setTauriAppMode(isKnownMode(appMode) ? appMode : "local");
      reloadConfig();
      setHubStatus("Conexão salva. Hub e servidores locais passam a usar a configuração nova quando o Esfera for reaberto.");
      toast.success("Conexão salva");
    } catch (err) {
      setHubStatus("Erro ao salvar a conexão: " + errText(err));
    } finally {
      setSavingHub(false);
    }
  };

  const hubDirty =
    appConfigLoad === "ready" &&
    hubSaved !== null &&
    (hubToken.trim() !== "" ||
      !sameSnapshot(
        {
          hubEnabled,
          hubAddress: hubAddressTrim || DEFAULT_HUB_ADDRESS,
          empresaServerEnabled,
          empresaServerPort: empresaServerPort.trim(),
          tunnelServerEnabled,
          tunnelServerPort: tunnelServerPort.trim(),
          appMode,
        },
        hubSaved,
      ));

  // Atualizar VPS (self-update remoto do hub-standalone) — master only
  const handleUpdateVpsClick = () => {
    fileInputRef.current?.click();
  };
  const handleVpsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // permite escolher o mesmo arquivo de novo
    if (!file) return;
    if (!/\.exe$/i.test(file.name) || file.size === 0) {
      setUpdateVpsMsg({ ok: false, text: "Escolha o arquivo esfera-hub-standalone.exe." });
      return;
    }
    const sizeMb = (file.size / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    const confirmed = await confirmDialog({
      title: "Atualizar o servidor do hub?",
      message: `O arquivo ${file.name} (${sizeMb} MB) será enviado e o hub reinicia com a nova versão. Os aparelhos remotos ficam alguns segundos sem conexão.`,
      confirmLabel: "Enviar e atualizar",
      danger: true,
    });
    if (!confirmed) return;
    setUpdatingVps(true);
    setUpdateVpsMsg(null);
    try {
      const b64 = await fileToBase64(file);
      // Tauri 2 espera os argumentos em camelCase: base64Bin (base64_bin não chegava ao comando).
      const res = await api<string>("update_vps_hub", { base64Bin: b64 });
      setUpdateVpsMsg({ ok: true, text: res || "Servidor atualizado." });
    } catch (err) {
      setUpdateVpsMsg({ ok: false, text: "Erro ao atualizar: " + errText(err) });
    } finally {
      setUpdatingVps(false);
    }
  };

  const hubStatusIsError = hubStatus.startsWith("Erro");
  const aiStatusIsError = aiStatus.startsWith("Falha");
  const providerInfo = getAiProviderInfo(aiProvider);
  const keyState = savedProviderKeys[aiProvider]?.hasApiKey;
  const hubUsesCloud = hubSaved?.appMode === "empresa" || hubSaved?.appMode === "master";
  const sectionDirty: Partial<Record<SettingsSection, boolean>> = { ia: aiDirty, hub: hubDirty };

  return (
    <div className="space-y-6 animate-fade-in max-w-6xl mx-auto">
      <PageHeader
        title="Configurações"
        description="Ritmo da rede, inteligência artificial, integrações e conexão. Cada seção diz se vale para este computador ou para a empresa."
        icon={<Settings size={18} />}
      />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav aria-label="Seções de configurações" className="w-full md:w-60 shrink-0 flex md:flex-col gap-1 overflow-x-auto pb-1 md:pb-0">
          {SECTIONS.map(({ id, label, hint, icon: Icon }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => goToSection(id)}
                aria-current={active ? "page" : undefined}
                className={`flex shrink-0 items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors cursor-pointer ${
                  active ? "bg-secondary text-primary" : "text-secondary hover:bg-secondary hover:text-primary"
                }`}
              >
                <Icon size={16} className={`mt-0.5 shrink-0 ${active ? "text-[var(--color-accent-light)]" : "text-tertiary"}`} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-[0.8125rem] font-medium">
                    {label}
                    {sectionDirty[id] && (
                      <>
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning)]" />
                        <span className="sr-only">(alterações não salvas)</span>
                      </>
                    )}
                  </span>
                  <span className="hidden text-xs leading-snug text-tertiary md:block">{hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 w-full min-w-0">
          <Card padding="lg">
            {activeSection === "rede" && <NetworkSettings canEdit={canManage} />}

            {activeSection === "ia" && (
              <div className="space-y-8">
                <FormSection
                  title="IA principal"
                  description={`Primeira IA usada para reescrever as mensagens e variar o texto dos disparos. Vale para a empresa ${companyLabel}.`}
                >
                  <div className="space-y-4 max-w-xl">
                    <LoadGate state={aiLoad} error={aiLoadError} what="a configuração de IA" onRetry={() => setAiReload((n) => n + 1)} />
                    {aiLoad === "ready" && (
                      <>
                        <Field label="Provedor" htmlFor="set-ai-provider">
                          <select id="set-ai-provider" value={aiProvider} onChange={(e) => changeAiProvider(e.target.value)}>
                            {!providerInfo && <option value={aiProvider}>{`Atual: ${aiProvider}`}</option>}
                            <optgroup label="Servidor próprio">
                              {AI_PROVIDERS.filter((p) => p.category === "own_server").map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Nuvem gratuita">
                              {AI_PROVIDERS.filter((p) => p.category === "cloud_free").map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Neste computador (offline)">
                              {AI_PROVIDERS.filter((p) => p.category === "local_free").map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Pagos e personalizados">
                              {AI_PROVIDERS.filter((p) => p.category === "paid_custom").map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </optgroup>
                          </select>
                        </Field>

                        {aiProvider !== "vps_ia" && (
                          <Field label="Modelo" htmlFor="set-ai-model" error={aiModelError || undefined}>
                            <input
                              id="set-ai-model"
                              type="text"
                              value={aiModel}
                              onChange={(e) => setAiModel(e.target.value)}
                              placeholder={providerInfo?.defaultModel || DEFAULT_AI_MODEL}
                              spellCheck={false}
                              className="font-mono"
                            />
                            {providerInfo && providerInfo.suggestedModels.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {providerInfo.suggestedModels.map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => setAiModel(m.id)}
                                    aria-pressed={aiModel === m.id}
                                    className={`rounded-md border px-2 py-1 text-xs transition-colors cursor-pointer ${
                                      aiModel === m.id
                                        ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)] text-primary"
                                        : "border-border text-secondary hover:border-border-strong hover:text-primary"
                                    }`}
                                  >
                                    {m.name} <span className="text-tertiary">({m.tag})</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </Field>
                        )}

                        {aiProvider === "vps_ia" ? (
                          <div className="rounded-lg border border-border bg-secondary px-3 py-2.5 text-[0.8125rem] text-secondary">
                            <p className="font-medium text-primary">Endereço, modelo e token vêm do cartão “IA própria (VPS)”, logo abaixo</p>
                            <p className="mt-0.5 break-all font-mono text-xs">{aiEndpointTrim || "Endereço ainda não configurado"}</p>
                            <p className="break-all font-mono text-xs">{aiModelTrim || "Modelo ainda não configurado"}</p>
                            {vpsInfo && !vpsInfo.configured ? (
                              <p className="mt-1 text-xs text-[var(--color-warning)]">A IA própria ainda não está configurada: preencha o cartão abaixo antes de salvar.</p>
                            ) : (
                              aiSaved?.provider === "vps_ia" &&
                              (aiSaved.endpoint !== aiEndpointTrim || aiSaved.model !== aiModelTrim) && (
                                <p className="mt-1 text-xs text-[var(--color-warning)]">
                                  A IA principal gravada usa outro endereço ou modelo. Clique em Salvar IA para usar os do cartão.
                                </p>
                              )
                            )}
                          </div>
                        ) : (
                          <>
                            <Field
                              label="Endereço da API"
                              htmlFor="set-ai-endpoint"
                              error={aiEndpointError || undefined}
                              aside={
                                providerInfo?.defaultEndpoint && aiEndpointTrim !== providerInfo.defaultEndpoint ? (
                                  <button
                                    type="button"
                                    onClick={() => setAiEndpoint(providerInfo.defaultEndpoint)}
                                    className="cursor-pointer underline hover:text-primary"
                                  >
                                    Usar o padrão
                                  </button>
                                ) : undefined
                              }
                            >
                              <input
                                id="set-ai-endpoint"
                                type="text"
                                value={aiEndpoint}
                                onChange={(e) => setAiEndpoint(e.target.value)}
                                placeholder={providerInfo?.defaultEndpoint || "https://…/v1/chat/completions"}
                                spellCheck={false}
                                className="font-mono"
                              />
                            </Field>

                            {aiProvider !== "ollama" && aiProvider !== "lmstudio" && (
                              <Field
                                label="Chave de API"
                                hint={`${providerInfo?.keyHint ? `${providerInfo.keyHint} ` : ""}Por segurança a chave salva não aparece aqui; deixe em branco para manter a atual e cole outra só para trocar.`}
                                htmlFor="set-ai-key"
                                aside={
                                  keyState === true ? (
                                    <Badge variant="success">Chave salva</Badge>
                                  ) : keyState === false ? (
                                    <Badge variant="neutral">Sem chave salva</Badge>
                                  ) : undefined
                                }
                              >
                                <SecretInput
                                  id="set-ai-key"
                                  value={aiApiKey}
                                  onChange={setAiApiKey}
                                  placeholder={`Em branco = manter a chave salva (${providerInfo?.keyPlaceholder || "sk-..."})`}
                                />
                              </Field>
                            )}
                          </>
                        )}

                        <div className="w-48">
                          <Field label="Criatividade" hint="De 0 (preciso) a 1 (criativo)." htmlFor="set-ai-temp" error={aiTemperatureError || undefined}>
                            <input
                              id="set-ai-temp"
                              type="number"
                              inputMode="decimal"
                              step="0.05"
                              min="0"
                              max="1"
                              value={aiTemperature}
                              onChange={(e) => setAiTemperature(e.target.value)}
                              className="font-mono"
                            />
                          </Field>
                        </div>

                        <Field
                          label="Instruções para a IA"
                          hint="Opcional: tom e cuidados da empresa. As regras legais e a proibição de valores valem sempre, mesmo em branco."
                          htmlFor="set-ai-prompt"
                          aside={
                            aiSystemPrompt.trim() !== DEFAULT_WHATSAPP_SYSTEM_PROMPT ? (
                              <button
                                type="button"
                                onClick={() => setAiSystemPrompt(DEFAULT_WHATSAPP_SYSTEM_PROMPT)}
                                className="cursor-pointer underline hover:text-primary"
                              >
                                Usar o texto padrão
                              </button>
                            ) : undefined
                          }
                        >
                          <textarea
                            id="set-ai-prompt"
                            value={aiSystemPrompt}
                            onChange={(e) => setAiSystemPrompt(e.target.value)}
                            rows={4}
                            placeholder="Ex.: seja cordial e breve, convide o cliente a negociar pelo canal oficial, nunca pressione."
                            className="resize-y"
                          />
                        </Field>

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <Button icon={<Save size={15} />} onClick={handleSaveAi} loading={savingAi} disabled={aiRun.running}>
                            Salvar IA
                          </Button>
                          <Button variant="secondary" icon={<Play size={14} />} loading={aiRun.running} disabled={savingAi} onClick={handleTestAi}>
                            {aiRun.running ? `Testando… ${aiRun.elapsed} s` : "Testar"}
                          </Button>
                          {aiRun.running && (
                            <Button variant="ghost" onClick={aiRun.stop}>
                              Parar
                            </Button>
                          )}
                          {aiDirty && !savingAi && <UnsavedNote onUndo={() => aiSaved && applyAiSnapshot(aiSaved)} />}
                        </div>

                        {aiTestResult && <TestResult result={aiTestResult} />}

                        {aiStatus && <StatusBanner error={aiStatusIsError} message={aiStatus} onClose={() => setAiStatus("")} />}

                        <p className="text-xs text-tertiary">
                          O teste usa os dados da tela, mesmo sem salvar, e um texto de exemplo para “{AI_TEST_CONTACT}”, sem valores e sem link.
                          Desiste sozinho depois de {aiTestLimit} s.
                        </p>
                      </>
                    )}
                  </div>
                </FormSection>

                {aiLoad === "ready" && (
                  <AiReserveChain
                    primary={aiSaved?.provider ?? aiProvider}
                    keys={savedProviderKeys}
                    vpsConfigured={vpsInfo ? vpsInfo.configured : null}
                    geminiConnected={geminiConnected}
                  />
                )}

                {canManage && selectedCompanyId !== null && (
                  <VpsIaCard companyId={selectedCompanyId} primaryIsVps={aiSaved?.provider === "vps_ia"} onChange={handleVpsChange} />
                )}

                {selectedCompanyId !== null && <GeminiWebCard companyId={selectedCompanyId} onConnectedChange={setGeminiConnected} />}
              </div>
            )}

            {activeSection === "integracoes" &&
              (selectedCompanyId !== null ? (
                <IntegrationsSection
                  companyId={selectedCompanyId}
                  isMaster={isMasterUser}
                  canManage={canManage}
                  onGoToConnection={() => goToSection("hub")}
                />
              ) : (
                <p className="text-[0.8125rem] text-secondary">Escolha uma empresa no topo para configurar as integrações.</p>
              ))}

            {activeSection === "hub" && (
              <div className="space-y-8">
                <LoadGate
                  state={appConfigLoad}
                  error={appConfigError}
                  what="a configuração de conexão"
                  onRetry={() => setAppConfigReload((n) => n + 1)}
                />
                {appConfigLoad === "ready" && (
                  <>
                    <FormSection title="Modo de operação" description="Define onde os dados e aparelhos são gerenciados. Vale para este computador.">
                      <div className="max-w-xl">
                        <Field label="Modo" htmlFor="set-mode">
                          <select id="set-mode" value={appMode} onChange={(e) => setAppMode(e.target.value)}>
                            {!isKnownMode(appMode) && (
                              <option value={appMode}>
                                {appMode === "standalone" ? "Autônomo (padrão de instalação nova)" : `Atual: ${appMode}`}
                              </option>
                            )}
                            <option value="empresa">Empresa (conecta ao hub na nuvem)</option>
                            <option value="local">Local (somente esta máquina)</option>
                            <option value="master">Master (administração remota)</option>
                          </select>
                        </Field>
                      </div>
                    </FormSection>

                    <FormSection title="Hub" description="Servidor central que liga os computadores e os aparelhos remotos.">
                      <div className="space-y-4 max-w-xl">
                        <Field
                          label="Endereço do hub"
                          htmlFor="set-hub-addr"
                          error={hubAddressError || undefined}
                          aside={
                            hubConnected ? (
                              <Badge variant="success" dot>
                                Conectado
                              </Badge>
                            ) : (
                              // Sem hub no modo Local/Autônomo é o esperado: aviso só nos modos que usam o hub.
                              <Badge variant={hubUsesCloud ? "warning" : "neutral"} dot>
                                Sem conexão
                              </Badge>
                            )
                          }
                        >
                          {!customIpOverride ? (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-3 py-2">
                              <span className="flex min-w-0 items-center gap-2 font-mono text-[0.8125rem] text-primary">
                                <span className="truncate">{hubAddressTrim || DEFAULT_HUB_ADDRESS}</span>
                                {(hubAddressTrim || DEFAULT_HUB_ADDRESS) === DEFAULT_HUB_ADDRESS && (
                                  <span className="font-sans text-xs text-tertiary">(padrão local)</span>
                                )}
                              </span>
                              <Button variant="ghost" size="sm" type="button" onClick={() => setCustomIpOverride(true)}>
                                Alterar
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <input
                                id="set-hub-addr"
                                type="text"
                                value={hubAddress}
                                onChange={(e) => setHubAddress(e.target.value)}
                                placeholder={DEFAULT_HUB_ADDRESS}
                                spellCheck={false}
                                className="flex-1 font-mono"
                              />
                              <Button
                                variant="secondary"
                                type="button"
                                onClick={() => {
                                  setHubAddress(DEFAULT_HUB_ADDRESS);
                                  setCustomIpOverride(false);
                                }}
                              >
                                Restaurar padrão
                              </Button>
                            </div>
                          )}
                        </Field>
                        <p className="-mt-2 text-xs text-tertiary">“Conectado” é a conexão aberta no login; um endereço novo vale ao reabrir o Esfera.</p>

                        <ToggleRow
                          label="Conexão contínua"
                          desc="Mantém o sinal de vida com o servidor central em tempo real."
                          checked={hubEnabled}
                          onChange={setHubEnabled}
                        />
                        {appMode === "local" && hubEnabled && (
                          <p className="text-xs text-[var(--color-warning)]">
                            No modo Local a conexão contínua continua ligada. Desligue-a se esta máquina não deve usar o hub.
                          </p>
                        )}

                        {(appMode === "master" || appMode === "empresa") && (
                          <Field
                            label={appMode === "master" ? "Token do hub (master)" : "Token da empresa"}
                            hint={`${
                              appMode === "master"
                                ? "Deve ser o mesmo token mestre configurado no servidor."
                                : "Sem o token, os celulares remotos não aparecem."
                            } Por segurança o token salvo não aparece aqui; deixe em branco para manter o atual.`}
                            htmlFor="set-hub-token"
                          >
                            <SecretInput
                              id="set-hub-token"
                              value={hubToken}
                              onChange={setHubToken}
                              placeholder="Em branco = manter o token salvo"
                            />
                          </Field>
                        )}

                        {isMasterUser && (appMode === "master" || appMode === "empresa") && (
                          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[0.8125rem] font-medium text-primary">Atualizar servidor do hub</p>
                              <p className="text-xs text-tertiary">Envie o esfera-hub-standalone.exe para atualizar o servidor remoto. Só o master vê esta opção.</p>
                              {updateVpsMsg && (
                                <p
                                  role={updateVpsMsg.ok ? "status" : "alert"}
                                  className={`mt-1 break-words text-xs ${updateVpsMsg.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}
                                >
                                  {updateVpsMsg.text}
                                </p>
                              )}
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              type="button"
                              icon={<Cpu size={13} />}
                              loading={updatingVps}
                              onClick={handleUpdateVpsClick}
                              title="Selecione o esfera-hub-standalone.exe para atualizar o servidor remotamente"
                            >
                              {updatingVps ? "Enviando…" : "Escolher arquivo"}
                            </Button>
                            <input ref={fileInputRef} type="file" accept=".exe" className="hidden" onChange={handleVpsFile} />
                          </div>
                        )}
                      </div>
                    </FormSection>

                    <FormSection title="Servidores locais" description="Ligam ou desligam quando o Esfera for reaberto.">
                      <div className="max-w-xl divide-y divide-border">
                        <div className="pb-3">
                          <ToggleRow
                            label="Painel na rede local"
                            desc="Colaboradores na mesma rede abrem o painel pelo navegador. Qualquer computador dessa rede alcança a porta: ligue só em rede confiável."
                            checked={empresaServerEnabled}
                            onChange={setEmpresaServerEnabled}
                          />
                          {empresaServerEnabled && (
                            <div className="mt-2 w-40">
                              <Field label="Porta" htmlFor="set-lan-port" error={lanPortError || undefined}>
                                <input
                                  id="set-lan-port"
                                  type="number"
                                  inputMode="numeric"
                                  value={empresaServerPort}
                                  onChange={(e) => setEmpresaServerPort(e.target.value)}
                                  min={1024}
                                  max={65535}
                                  className="font-mono"
                                />
                              </Field>
                            </div>
                          )}
                        </div>
                        <div className="pt-3">
                          <ToggleRow
                            label="Aparelhos fora da rede (túnel)"
                            desc="Mantém conectados, pelo túnel do agente, os aparelhos que estão no 4G ou em outra rede."
                            checked={tunnelServerEnabled}
                            onChange={setTunnelServerEnabled}
                          />
                          {tunnelServerEnabled && (
                            <div className="mt-2 w-40">
                              <Field
                                label="Porta do túnel"
                                hint="Ao instalar o agente, aponte o aparelho para o IP desta máquina e esta porta."
                                htmlFor="set-tunnel-port"
                                error={tunnelPortError || undefined}
                              >
                                <input
                                  id="set-tunnel-port"
                                  type="number"
                                  inputMode="numeric"
                                  value={tunnelServerPort}
                                  onChange={(e) => setTunnelServerPort(e.target.value)}
                                  min={1024}
                                  max={65535}
                                  className="font-mono"
                                />
                              </Field>
                            </div>
                          )}
                        </div>
                      </div>
                    </FormSection>

                    <div className="space-y-3 border-t border-border pt-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button icon={<Save size={15} />} onClick={handleSaveAll} loading={savingHub}>
                          Salvar conexão
                        </Button>
                        {hubDirty && !savingHub && <UnsavedNote onUndo={() => hubSaved && applyHubSnapshot(hubSaved)} />}
                      </div>
                      <p className="text-xs text-tertiary">
                        Vale para este computador. Hub e servidores locais usam a configuração nova quando o Esfera for reaberto.
                      </p>
                      {hubStatus && <StatusBanner error={hubStatusIsError} message={hubStatus} onClose={() => setHubStatus("")} />}
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- Componentes locais ----
// Carregando / erro com "Tentar de novo". Pronto = não mostra nada (o formulário aparece).
function LoadGate({ state, error, what, onRetry }: { state: LoadState; error: string; what: string; onRetry: () => void }) {
  if (state === "ready") return null;
  if (state === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 text-[0.8125rem] text-secondary">
        <Loader2 size={14} className="animate-spin" />
        Carregando {what}…
      </p>
    );
  }
  return <ErrorBox text={`Não foi possível carregar ${what}: ${error}`} onRetry={onRetry} />;
}

// Caixa de erro com botão de nova tentativa.
function ErrorBox({ text, onRetry, retrying = false }: { text: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-[0.8125rem] text-red-700 dark:text-red-400"
    >
      <span className="flex min-w-0 items-start gap-2">
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
        <span className="break-words">{text}</span>
      </span>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry} loading={retrying}>
        Tentar de novo
      </Button>
    </div>
  );
}

// Resultado de teste (IA principal, IA própria, Gemini): sucesso, falha ou interrompido.
function TestResult({ result }: { result: TestResultData }) {
  const tone =
    result.tone === "success"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : result.tone === "error"
      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
      : "border-border bg-secondary text-secondary";
  const Icon = result.tone === "success" ? CheckCircle2 : result.tone === "error" ? AlertCircle : Info;
  return (
    <div role={result.tone === "error" ? "alert" : "status"} className={`space-y-1 rounded-lg border p-3 text-[0.8125rem] ${tone}`}>
      <div className="flex items-center gap-2 font-medium">
        <Icon size={15} className="shrink-0" />
        {result.title}
      </div>
      {result.text && (
        <p className={`whitespace-pre-wrap break-words text-xs ${result.tone === "success" ? "text-primary" : "text-secondary"}`}>{result.text}</p>
      )}
    </div>
  );
}

// Aviso ao lado do Salvar quando o formulário difere do que está gravado.
function UnsavedNote({ onUndo }: { onUndo: () => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="warning" dot>
        Alterações não salvas
      </Badge>
      <button type="button" onClick={onUndo} className="cursor-pointer text-xs text-secondary underline hover:text-primary">
        Desfazer
      </button>
    </span>
  );
}

// Retorno curto de uma ação (salvar, testar): verde quando deu certo, vermelho quando falhou.
function InlineMessage({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return (
    <p
      role={message.ok ? "status" : "alert"}
      className={`whitespace-pre-wrap break-words text-[0.8125rem] ${message.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}
    >
      {message.text}
    </p>
  );
}

function StatusBanner({ error, message, onClose }: { error: boolean; message: string; onClose: () => void }) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[0.8125rem] ${
        error ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        {error ? <AlertCircle size={15} className="shrink-0" /> : <CheckCircle2 size={15} className="shrink-0" />}
        <span className="break-words">{message}</span>
      </span>
      <button type="button" onClick={onClose} aria-label="Fechar aviso" className="shrink-0 text-xs underline cursor-pointer">
        Fechar
      </button>
    </div>
  );
}

// Campo de segredo para DIGITAR um valor novo: mascarado por padrão, com botão para conferir o
// que foi digitado. O valor já salvo nunca vem para cá.
function SecretInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex items-center">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        className="w-full font-mono pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar o que foi digitado" : "Mostrar o que foi digitado"}
        className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:text-primary cursor-pointer"
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-tertiary leading-snug">{desc}</p>
      </div>
      <div className="shrink-0">
        <Toggle checked={checked} onChange={onChange} size="sm" ariaLabel={label} />
      </div>
    </div>
  );
}

// ---------- Inteligência artificial: reservas, IA própria e Gemini Web ----------

// Ordem das reservas (fixa no disparo) com o que se sabe de cada uma.
function AiReserveChain({
  primary,
  keys,
  vpsConfigured,
  geminiConnected,
}: {
  primary: string;
  keys: Record<string, ProviderKeyInfo>;
  vpsConfigured: boolean | null;
  geminiConnected: boolean | null;
}) {
  const primaryId = normalizeAiProviderId(primary);
  const primaryName = getAiProviderInfo(primaryId)?.name ?? primary;
  const stateOf = (provider: string): ReactNode => {
    if (provider === "vps_ia") {
      if (vpsConfigured === null) return null;
      return vpsConfigured ? <Badge variant="success">Configurada</Badge> : <Badge variant="neutral">Não configurada</Badge>;
    }
    if (provider === "gemini_web") {
      if (geminiConnected === null) return null;
      return geminiConnected ? <Badge variant="success">Conectado</Badge> : <Badge variant="neutral">Não conectado</Badge>;
    }
    const has = keys[provider]?.hasApiKey;
    if (has === undefined) return null;
    return has ? <Badge variant="success">Chave salva</Badge> : <Badge variant="neutral">Sem chave</Badge>;
  };
  return (
    <FormSection title="Reservas automáticas" description="Se a IA principal falhar ou esgotar o limite grátis, o disparo tenta as reservas nesta ordem.">
      <div className="max-w-xl space-y-2">
        <ol className="divide-y divide-border rounded-lg border border-border">
          <li className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="w-5 shrink-0 text-center text-xs text-tertiary">1</span>
              <span className="truncate text-[0.8125rem] font-medium text-primary">{primaryName}</span>
            </span>
            <Badge variant="purple">Principal</Badge>
          </li>
          {AI_RESERVE_CHAIN.map((step, i) => {
            // O Groq 20B continua como reserva mesmo quando o Groq é o principal (outro limite diário).
            const isPrimary = step.provider === primaryId && !step.alsoWhenPrimary;
            return (
              <li key={step.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${isPrimary ? "opacity-60" : ""}`}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="w-5 shrink-0 text-center text-xs text-tertiary">{i + 2}</span>
                  <span className="min-w-0">
                    <span className="block text-[0.8125rem] text-primary">{step.label}</span>
                    <span className="block text-xs text-tertiary">{isPrimary ? "já é a principal" : step.detail}</span>
                  </span>
                </span>
                {!isPrimary && stateOf(step.provider)}
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-tertiary">
          Para salvar a chave de uma reserva sem trocar a principal: escolha o provedor acima, cole a chave e clique em Salvar IA;
          depois volte à principal e salve de novo.
        </p>
        <p className="text-xs text-tertiary">Se nenhuma responder a tempo, o envio usa o texto da campanha (com Spintax, se estiver ligado).</p>
      </div>
    </FormSection>
  );
}

// IA própria (Ollama na VPS, com token): endereço, modelo e token por empresa. O hub também
// distribui esta configuração para os computadores.
function VpsIaCard({
  companyId,
  primaryIsVps,
  onChange,
}: {
  companyId: number;
  primaryIsVps: boolean;
  onChange: (status: VpsIaStatus, how: "load" | "save" | "remove") => void;
}) {
  const [status, setStatus] = useState<VpsIaStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "remove">("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useTimedRun();
  const [testResult, setTestResult] = useState<TestResultData | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    let active = true;
    setStatus(null);
    setLoadError("");
    setEndpoint("");
    setModel("");
    setToken("");
    setMessage(null);
    setTestResult(null);
    api<VpsIaStatus>("vps_ia_status", { companyId })
      .then((s) => {
        if (!active) return;
        setStatus(s);
        setEndpoint(s.endpoint);
        setModel(s.model);
        onChangeRef.current(s, "load");
      })
      .catch((e) => {
        if (active) setLoadError(errText(e));
      });
    return () => { active = false; };
  }, [companyId, reload]);

  const defaults = getAiProviderInfo("vps_ia");
  const endpointTrim = endpoint.trim();
  const endpointError = endpointTrim && !/^https?:\/\/\S+$/i.test(endpointTrim) ? "O endereço deve começar com http:// ou https://." : "";
  const canSave =
    busy === "" && !run.running && status !== null && !!endpointTrim && !!model.trim() && !endpointError && (status.configured || !!token.trim());

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const s = await api<VpsIaStatus>("vps_ia_save", { companyId, endpoint: endpointTrim, model: model.trim(), apiToken: token.trim() });
      setStatus(s);
      setEndpoint(s.endpoint);
      setModel(s.model);
      setToken("");
      setMessage({ ok: true, text: "IA própria salva." });
      toast.success("IA própria salva");
      onChangeRef.current(s, "save");
    } catch (e) {
      setMessage({ ok: false, text: errText(e) });
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setMessage(null);
    setTestResult(null);
    const outcome = await run.run(() => api<VpsIaTestResult>("vps_ia_test", { companyId }), 150);
    setTestResult(
      outcomeToResult(
        outcome,
        (r) => ({ tone: "success", title: `Resposta em ${formatSeconds(r.elapsedMs)} s`, text: r.text }),
        "A IA própria pode estar ocupada ou fora do ar; tente de novo em instantes.",
      ),
    );
  };

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: "Remover a IA própria desta empresa?",
      message: primaryIsVps
        ? "Ela sai da cadeia de reserva, mas continua como IA principal com o endereço já gravado nela. Para deixar de usá-la, escolha outra IA principal e salve."
        : "Ela sai da cadeia de reserva. Para usar de novo, salve o endereço, o modelo e o token outra vez.",
      confirmLabel: "Remover",
      danger: true,
    });
    if (!confirmed) return;
    setBusy("remove");
    setMessage(null);
    setTestResult(null);
    try {
      await api<void>("vps_ia_remove", { companyId });
      const s: VpsIaStatus = { configured: false, endpoint: "", model: "" };
      setStatus(s);
      setEndpoint("");
      setModel("");
      setToken("");
      setMessage({ ok: true, text: "IA própria removida desta empresa." });
      onChangeRef.current(s, "remove");
    } catch (e) {
      setMessage({ ok: false, text: errText(e) });
    } finally {
      setBusy("");
    }
  };

  return (
    <FormSection
      title="IA própria (VPS)"
      description="Servidor de IA da empresa, sem limite diário. Entra logo depois do Groq na cadeia de reserva. Os computadores recebem esta configuração pelo hub."
    >
      <div className="max-w-xl space-y-4 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-tertiary">O token salvo não aparece aqui.</p>
          {status === null ? (
            loadError ? (
              <Badge variant="danger">Não foi possível verificar</Badge>
            ) : (
              <Badge variant="neutral">Verificando…</Badge>
            )
          ) : status.configured ? (
            <Badge variant="success" dot>
              Configurada
            </Badge>
          ) : (
            <Badge variant="neutral">Não configurada</Badge>
          )}
        </div>
        {loadError && <ErrorBox text={`Não foi possível ler a IA própria: ${loadError}`} onRetry={() => setReload((n) => n + 1)} />}
        <Field
          label="Endereço"
          htmlFor="ia-vps-endpoint"
          error={endpointError || undefined}
          aside={
            !endpointTrim && defaults ? (
              <button
                type="button"
                onClick={() => {
                  setEndpoint(defaults.defaultEndpoint);
                  if (!model.trim()) setModel(defaults.defaultModel);
                }}
                className="cursor-pointer underline hover:text-primary"
              >
                Usar o padrão
              </button>
            ) : undefined
          }
        >
          <input
            id="ia-vps-endpoint"
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={defaults?.defaultEndpoint}
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field label="Modelo" htmlFor="ia-vps-model">
          <input
            id="ia-vps-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={defaults?.defaultModel}
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field
          label="Token"
          htmlFor="ia-vps-token"
          hint={status?.configured ? "Deixe em branco para manter o token salvo." : "Obrigatório na primeira vez."}
        >
          <SecretInput
            id="ia-vps-token"
            value={token}
            onChange={setToken}
            placeholder={status?.configured ? "Em branco = manter o token salvo" : "Cole o token"}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Save size={15} />} onClick={save} loading={busy === "save"} disabled={!canSave}>
            Salvar IA própria
          </Button>
          <Button
            variant="secondary"
            icon={<Play size={14} />}
            onClick={test}
            loading={run.running}
            disabled={busy !== "" || !status?.configured}
          >
            {run.running ? `Testando… ${run.elapsed} s` : "Testar IA própria"}
          </Button>
          {run.running && (
            <Button variant="ghost" onClick={run.stop}>
              Parar
            </Button>
          )}
          <Button
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={remove}
            loading={busy === "remove"}
            disabled={busy !== "" || run.running || !status?.configured}
          >
            Remover
          </Button>
        </div>
        {status?.configured && <p className="text-xs text-tertiary">O teste usa a configuração salva e desiste sozinho depois de 150 s.</p>}
        <InlineMessage message={message} />
        {testResult && <TestResult result={testResult} />}
      </div>
    </FormSection>
  );
}

// Gemini Web: reserva grátis pelo login da conta Google no Edge (perfil só do Esfera).
// Nunca é a IA principal. A consulta de status abre conexão com o navegador: a cada 30 s,
// só com a tela visível e sem outra ação em andamento.
function GeminiWebCard({ companyId, onConnectedChange }: { companyId: number; onConnectedChange: (connected: boolean | null) => void }) {
  const [status, setStatus] = useState<GeminiWebStatus | null>(null);
  const [busy, setBusy] = useState<"" | "login" | "logout" | "refresh">("");
  const [error, setError] = useState("");
  const run = useTimedRun();
  const [testResult, setTestResult] = useState<TestResultData | null>(null);
  const busyRef = useRef(false);
  const companyRef = useRef(companyId);
  const onChangeRef = useRef(onConnectedChange);
  useEffect(() => {
    onChangeRef.current = onConnectedChange;
  });

  // Respostas atrasadas de outra empresa (troca rápida) são ignoradas.
  const applyStatus = useCallback((s: GeminiWebStatus, forCompany: number) => {
    if (companyRef.current !== forCompany) return;
    setStatus(s);
    onChangeRef.current(Boolean(s.connected || s.savedConnected));
  }, []);

  const readStatus = useCallback(async (forCompany: number): Promise<GeminiWebStatus> => {
    try {
      return await api<GeminiWebStatus>("gemini_web_status", { companyId: forCompany });
    } catch (e) {
      return { connected: false, browserOpen: false, detail: errText(e) };
    }
  }, []);

  useEffect(() => {
    companyRef.current = companyId;
    let alive = true;
    setStatus(null);
    setError("");
    setTestResult(null);
    onChangeRef.current(null);
    const load = async () => {
      const s = await readStatus(companyId);
      if (alive) applyStatus(s, companyId);
    };
    void load();
    const tick = () => {
      if (document.hidden || busyRef.current) return;
      void load();
    };
    const timer = window.setInterval(tick, 30000);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId, readStatus, applyStatus]);

  const withBusy = async (kind: "login" | "logout" | "refresh", action: () => Promise<void>) => {
    busyRef.current = true;
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errText(e));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const login = () =>
    withBusy("login", async () => {
      setTestResult(null);
      applyStatus(await api<GeminiWebStatus>("gemini_web_login", { companyId }), companyId);
    });
  const refresh = () => withBusy("refresh", async () => applyStatus(await readStatus(companyId), companyId));
  const logout = () =>
    withBusy("logout", async () => {
      setTestResult(null);
      await api<void>("gemini_web_logout", { companyId });
      applyStatus(await readStatus(companyId), companyId);
    });

  const test = async () => {
    setError("");
    setTestResult(null);
    busyRef.current = true;
    const outcome = await run.run(() => api<string>("gemini_web_test", { companyId }), 120);
    busyRef.current = false;
    setTestResult(
      outcomeToResult(
        outcome,
        (text, ms) => ({ tone: "success", title: `Resposta em ${formatSeconds(ms)} s`, text }),
        "Confira se o Edge abriu o Gemini com a conta conectada.",
      ),
    );
    if (outcome.kind === "ok") applyStatus(await readStatus(companyId), companyId);
  };

  const connected = Boolean(status?.connected || status?.savedConnected);
  const locked = busy !== "" || run.running;

  return (
    <FormSection
      title="Gemini Web (reserva opcional)"
      description="Grátis, pelo login da conta Google no Microsoft Edge, com um perfil só do Esfera. Entra na cadeia depois do Groq e da IA própria; nunca é a IA principal."
    >
      <div className="max-w-xl space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-[0.8125rem] text-secondary">{status ? status.detail || "Sem detalhes." : "Verificando a conexão…"}</p>
          {status === null ? (
            <Badge variant="neutral">Verificando…</Badge>
          ) : connected ? (
            <Badge variant="success" dot>
              Conectado
            </Badge>
          ) : (
            <Badge variant="warning" dot>
              Não conectado
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<Globe size={15} />} onClick={login} loading={busy === "login"} disabled={locked}>
            {connected ? "Abrir o Gemini" : "Entrar com Google"}
          </Button>
          <Button variant="secondary" icon={<Play size={14} />} onClick={test} loading={run.running} disabled={busy !== ""}>
            {run.running ? `Testando… ${run.elapsed} s` : "Testar"}
          </Button>
          {run.running && (
            <Button variant="ghost" onClick={run.stop}>
              Parar
            </Button>
          )}
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={refresh} loading={busy === "refresh"} disabled={locked}>
            Atualizar status
          </Button>
          {(connected || status?.browserOpen) && (
            <Button variant="ghost" onClick={logout} loading={busy === "logout"} disabled={locked}>
              Desconectar conta Google
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-[0.8125rem] text-[var(--color-danger)]">
            {error}
          </p>
        )}
        {testResult && <TestResult result={testResult} />}
      </div>
    </FormSection>
  );
}

// ---------- Integrações (VEXOR) ----------
// Dois sentidos: o Esfera envia ao VEXOR as respostas dos aparelhos (token do VEXOR) e o VEXOR
// registra descadastros no Esfera (token da integração, gerado pelo master).
function IntegrationsSection({
  companyId,
  isMaster,
  canManage,
  onGoToConnection,
}: {
  companyId: number;
  isMaster: boolean;
  canManage: boolean;
  onGoToConnection: () => void;
}) {
  // Recebimento de descadastros: só interessa saber se a porta 8080 responde (o status exige
  // token; com no-cors qualquer resposta HTTP conta como "no ar").
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch(`${OPTOUT_BASE_URL}/api/optout/status`, { mode: "no-cors" })
        .then(() => alive && setOnline(true))
        .catch(() => alive && setOnline(false));
    void check();
    const timer = window.setInterval(() => {
      if (!document.hidden) void check();
    }, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Token do VEXOR (vale para este computador).
  const [vexorConfigured, setVexorConfigured] = useState<boolean | null>(null);
  const [vexorLoadError, setVexorLoadError] = useState("");
  const [vexorReload, setVexorReload] = useState(0);
  const [vexorToken, setVexorToken] = useState("");
  const [vexorBusy, setVexorBusy] = useState<"" | "save" | "test">("");
  const [vexorResult, setVexorResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    setVexorConfigured(null);
    setVexorLoadError("");
    setVexorToken("");
    setVexorResult(null);
    api<boolean>("get_vexor_token_status", { companyId })
      .then((v) => {
        if (active) setVexorConfigured(v);
      })
      .catch((e) => {
        if (active) setVexorLoadError(errText(e));
      });
    return () => { active = false; };
  }, [companyId, canManage, vexorReload]);

  const saveVexor = async () => {
    setVexorBusy("save");
    setVexorResult(null);
    try {
      await api("save_vexor_token", { companyId, vexorToken: vexorToken.trim() });
      setVexorToken("");
      setVexorConfigured(await api<boolean>("get_vexor_token_status", { companyId }));
      setVexorResult({ ok: true, text: "Token do VEXOR salvo." });
      toast.success("Token do VEXOR salvo");
    } catch (e) {
      setVexorResult({ ok: false, text: errText(e) });
    } finally {
      setVexorBusy("");
    }
  };
  const testVexor = async () => {
    setVexorBusy("test");
    setVexorResult(null);
    try {
      setVexorResult({ ok: true, text: await api<string>("test_vexor_token", { companyId }) });
    } catch (e) {
      setVexorResult({ ok: false, text: errText(e) });
    } finally {
      setVexorBusy("");
    }
  };

  // Token da integração (master): aparece uma vez só; trocar de empresa o esconde.
  const [orgId, setOrgId] = useState("org-local");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    setToken("");
    setError("");
  }, [companyId]);

  const envLine = token
    ? `ESFERA_OPTOUT_LINKS_JSON=${JSON.stringify({ [orgId.trim() || "org-local"]: { baseUrl: OPTOUT_BASE_URL, companyId, token } })}`
    : "";

  const generate = async () => {
    const confirmed = await confirmDialog({
      title: token ? "Gerar outro token da integração?" : "Gerar o token da integração?",
      message:
        "Um token novo invalida o anterior na hora: o VEXOR para de registrar descadastros neste computador até receber o novo.",
      confirmLabel: "Gerar token",
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      setToken(await api<string>("generate_company_token", { companyId }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };

  return (
    <div className="space-y-8">
      <FormSection title="Recebimento de descadastros (SAIR)" description="O VEXOR avisa o Esfera quando um cliente pede para sair; o número entra no descadastro na hora.">
        <div className="max-w-2xl space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium text-primary">Endereço que o VEXOR chama</p>
              <p className="break-all font-mono text-[0.75rem] text-tertiary">POST {OPTOUT_BASE_URL}/api/optout/events</p>
            </div>
            {online === null ? (
              <Badge variant="neutral">Verificando…</Badge>
            ) : online ? (
              <Badge variant="success" dot>
                No ar
              </Badge>
            ) : (
              <Badge variant="danger" dot>
                Fora do ar
              </Badge>
            )}
          </div>
          {online === false && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[0.75rem] text-[var(--color-danger)]">
                A porta 8080 não respondeu. Salve a seção Conexão e servidores e reabra o Esfera para ligar o recebimento.
              </p>
              <Button variant="secondary" size="sm" onClick={onGoToConnection}>
                Abrir Conexão e servidores
              </Button>
            </div>
          )}
        </div>
      </FormSection>

      {canManage && (
        <FormSection
          title="Token do VEXOR"
          description="Usado para enviar ao VEXOR as respostas recebidas nos aparelhos. Use o mesmo token da integração SAIR configurada no VEXOR. Vale para este computador."
        >
          <div className="max-w-2xl space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-tertiary">O token salvo não aparece aqui.</p>
              {vexorConfigured === null ? (
                vexorLoadError ? (
                  <Badge variant="danger">Não foi possível verificar</Badge>
                ) : (
                  <Badge variant="neutral">Verificando…</Badge>
                )
              ) : vexorConfigured ? (
                <Badge variant="success" dot>
                  Configurado
                </Badge>
              ) : (
                <Badge variant="neutral">Não configurado</Badge>
              )}
            </div>
            {vexorLoadError && <ErrorBox text={`Não foi possível ler o token do VEXOR: ${vexorLoadError}`} onRetry={() => setVexorReload((n) => n + 1)} />}
            <Field label="Token do VEXOR" htmlFor="int-vexor-token" hint={vexorConfigured ? "Cole um token novo só para trocar o atual." : undefined}>
              <SecretInput
                id="int-vexor-token"
                value={vexorToken}
                onChange={setVexorToken}
                placeholder={vexorConfigured ? "Em branco = manter o token salvo" : "Cole o token"}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button icon={<Save size={15} />} onClick={saveVexor} loading={vexorBusy === "save"} disabled={vexorBusy !== "" || !vexorToken.trim()}>
                Salvar token do VEXOR
              </Button>
              <Button
                variant="secondary"
                icon={<Play size={14} />}
                onClick={testVexor}
                loading={vexorBusy === "test"}
                disabled={vexorBusy !== "" || !vexorConfigured}
              >
                Testar VEXOR
              </Button>
            </div>
            <InlineMessage message={vexorResult} />
          </div>
        </FormSection>
      )}

      <FormSection
        title="Token da integração"
        description="O VEXOR usa este token para registrar descadastros neste computador. Vale para a empresa selecionada."
      >
        {!isMaster ? (
          <p className="text-[0.8125rem] text-secondary">Só o usuário Master gera o token da integração.</p>
        ) : (
          <div className="max-w-2xl space-y-4">
            <Field label="Organização no VEXOR" htmlFor="int-org" hint="ID da organização do VEXOR que recebe o SAIR (no ambiente local: org-local).">
              <input id="int-org" type="text" value={orgId} onChange={(e) => setOrgId(e.target.value)} spellCheck={false} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button icon={<KeyRound size={15} />} onClick={generate} loading={busy}>
                {token ? "Gerar outro token" : "Gerar token"}
              </Button>
              <p className="text-[0.75rem] text-tertiary">Gerar de novo invalida o token anterior (o VEXOR precisa do novo).</p>
            </div>
            {error && (
              <p role="alert" className="text-[0.75rem] text-[var(--color-danger)]">
                {error}
              </p>
            )}
            {token && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-[0.75rem] text-amber-700 dark:text-amber-300">
                  O token aparece só agora. Copie a linha abaixo para o arquivo .env do VEXOR e reinicie o VEXOR.
                </p>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-secondary px-2.5 py-2 font-mono text-[0.75rem] text-primary">{envLine}</code>
                  <Button variant="secondary" icon={<Copy size={14} />} onClick={() => copy("env", envLine)}>
                    {copied === "env" ? "Copiado" : "Copiar"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <button type="button" onClick={() => copy("token", token)} className="text-[0.75rem] text-secondary underline cursor-pointer hover:text-primary">
                    {copied === "token" ? "Token copiado" : "Copiar só o token"}
                  </button>
                  <button type="button" onClick={() => setToken("")} className="text-[0.75rem] text-secondary underline cursor-pointer hover:text-primary">
                    Ocultar o token
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </FormSection>
    </div>
  );
}

// ---------- Rede e ritmo ----------
type NetworkChipState = "normal" | "reduzido" | "pausado" | "indisponivel";
type NetworkChip = { chipId: number; deviceId: number; deviceName: string; replyRate: number | null; sample: number; state: NetworkChipState; reason: string };
// attempts* = o que o teto conta (tentativas, inclusive falhas; cada parte extra soma uma); sent* = só enviadas.
type NetworkStatus = { hourly: number; daily: number; sentLastHour: number; sentToday: number; attemptsLastHour: number; attemptsToday: number; waitSeconds: number; chips: NetworkChip[] };
const CHIP_STATE_LABEL: Record<NetworkChipState, string> = { normal: "Normal", reduzido: "Reduzido", pausado: "Pausado", indisponivel: "Indisponível" };
const CHIP_STATE_BADGE: Record<NetworkChipState, "success" | "warning" | "danger" | "neutral"> = {
  normal: "success",
  reduzido: "warning",
  pausado: "danger",
  indisponivel: "neutral",
};
const DEFAULT_LIMITS = { hourly: 40, daily: 200 };

// Taxa de resposta do chip com a amostra (vazio enquanto não há taxa).
function chipRateText(c: NetworkChip): string {
  return c.replyRate === null ? "" : `${c.replyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% de resposta em ${c.sample} envios`;
}

function NetworkSettings({ canEdit }: { canEdit: boolean }) {
  // Limites gravados. Sem eles carregados, Salvar gravaria números de exemplo por cima.
  const [hourly, setHourly] = useState("");
  const [daily, setDaily] = useState("");
  const [savedLimits, setSavedLimits] = useState<{ hourly: number; daily: number } | null>(null);
  const [limitsLoad, setLimitsLoad] = useState<LoadState>("loading");
  const [limitsError, setLimitsError] = useState("");
  const [limitsReload, setLimitsReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Situação da rede. O erro da consulta fica separado e some na próxima consulta que der certo.
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLimitsLoad("loading");
    setLimitsError("");
    api<{ hourly: number; daily: number }>("get_network_limits")
      .then((v) => {
        if (!active) return;
        setHourly(String(v.hourly));
        setDaily(String(v.daily));
        setSavedLimits({ hourly: v.hourly, daily: v.daily });
        setLimitsLoad("ready");
      })
      .catch((e) => {
        if (!active) return;
        setLimitsError(errText(e));
        setLimitsLoad("error");
      });
    return () => { active = false; };
  }, [limitsReload]);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const v = await api<NetworkStatus>("get_network_status");
      if (!mounted.current) return;
      setStatus(v);
      setStatusError("");
      setUpdatedAt(new Date());
    } catch (e) {
      if (mounted.current) setStatusError(errText(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const h = Number(hourly);
  const d = Number(daily);
  const hourlyError = hourly.trim() === "" || !Number.isSafeInteger(h) || h < 1 ? "Use um número inteiro maior que zero." : "";
  const dailyError =
    daily.trim() === "" || !Number.isSafeInteger(d) || d < 1
      ? "Use um número inteiro maior que zero."
      : !hourlyError && d < h
      ? "Precisa ser igual ou maior que o limite por hora."
      : "";
  const limitsDirty = savedLimits !== null && (hourly.trim() !== String(savedLimits.hourly) || daily.trim() !== String(savedLimits.daily));

  const save = async () => {
    if (limitsLoad !== "ready" || !canEdit) return;
    const problem = hourlyError || dailyError;
    if (problem) {
      setMessage({ ok: false, text: `Não foi possível salvar: ${problem}` });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api("set_network_limits", { hourly: h, daily: d });
      setSavedLimits({ hourly: h, daily: d });
      setHourly(String(h));
      setDaily(String(d));
      setMessage({ ok: true, text: "Limites da rede salvos." });
      toast.success("Limites da rede salvos");
      void refreshStatus();
    } catch (e) {
      setMessage({ ok: false, text: `Erro ao salvar limites: ${errText(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const chipsPerDevice = new Map<number, number>();
  for (const c of status?.chips ?? []) chipsPerDevice.set(c.deviceId, (chipsPerDevice.get(c.deviceId) ?? 0) + 1);

  return (
    <div className="space-y-8">
      <FormSection
        title="Rede e ritmo"
        description="Teto de tentativas somado de todos os aparelhos deste computador, de todas as empresas. Cada parte da mensagem conta como uma tentativa, mesmo quando o envio falha."
      >
        <div className="max-w-xl space-y-3">
          {status === null && !statusError && (
            <p role="status" className="flex items-center gap-2 text-[0.8125rem] text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Consultando a rede…
            </p>
          )}
          {statusError && <ErrorBox text={`Não foi possível consultar a rede: ${statusError}`} onRetry={() => void refreshStatus()} retrying={refreshing} />}
          {status && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {status.waitSeconds > 0 ? (
                  <Badge variant="warning" dot>
                    Teto atingido · volta a enviar em até {Math.ceil(status.waitSeconds / 60)} min
                  </Badge>
                ) : (
                  <Badge variant="success" dot>
                    Rede disponível para enviar
                  </Badge>
                )}
                <span className="flex items-center gap-2">
                  {updatedAt && (
                    <span className="text-xs text-tertiary">
                      Atualizado às {updatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => void refreshStatus()} loading={refreshing}>
                    Atualizar
                  </Button>
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <UsageMeter label="Na última hora" attempts={status.attemptsLastHour} limit={status.hourly} sent={status.sentLastHour} />
                <UsageMeter label="Hoje" attempts={status.attemptsToday} limit={status.daily} sent={status.sentToday} />
              </div>
            </>
          )}
          <p className="text-xs text-tertiary">
            Janela de envio (horário deste computador): segunda a sexta, das 8h às 20h; sábado, das 8h às 14h; domingo, sem envios.
            A situação de agora aparece na barra inferior.
          </p>
        </div>
      </FormSection>

      <FormSection title="Limites" description="Valem para este computador inteiro. Só master ou gestor altera.">
        <div className="max-w-xl space-y-4">
          {limitsLoad === "loading" && (
            <p role="status" className="flex items-center gap-2 text-[0.8125rem] text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Carregando os limites…
            </p>
          )}
          {limitsLoad === "error" && <ErrorBox text={`Não foi possível carregar os limites: ${limitsError}`} onRetry={() => setLimitsReload((n) => n + 1)} />}
          {limitsLoad === "ready" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Tentativas por hora" hint={`Padrão: ${DEFAULT_LIMITS.hourly}.`} htmlFor="network-hour" error={hourlyError || undefined}>
                  <input
                    id="network-hour"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={hourly}
                    disabled={!canEdit}
                    onChange={(e) => setHourly(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="Tentativas por dia"
                  hint={`Padrão: ${DEFAULT_LIMITS.daily}. Igual ou maior que por hora.`}
                  htmlFor="network-day"
                  error={dailyError || undefined}
                >
                  <input
                    id="network-day"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={daily}
                    disabled={!canEdit}
                    onChange={(e) => setDaily(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Save size={15} />} onClick={save} loading={saving} disabled={!canEdit}>
                  Salvar limites
                </Button>
                {limitsDirty && !saving && savedLimits && (
                  <UnsavedNote
                    onUndo={() => {
                      setHourly(String(savedLimits.hourly));
                      setDaily(String(savedLimits.daily));
                    }}
                  />
                )}
              </div>
              <InlineMessage message={message} />
            </>
          )}
        </div>
      </FormSection>

      <FormSection
        title="Freio por resposta"
        description="O Esfera acompanha quantos clientes respondem em cada chip. Com poucas respostas, primeiro reduz o ritmo; se continuar baixo, pausa o chip por 24 h para proteger o número."
      >
        <div className="max-w-xl">
          {status === null ? (
            statusError ? (
              <p className="text-[0.8125rem] text-tertiary">Sem dados enquanto a consulta da rede falhar.</p>
            ) : (
              <p className="text-[0.8125rem] text-tertiary">Consultando os chips…</p>
            )
          ) : status.chips.length === 0 ? (
            <p className="text-[0.8125rem] text-tertiary">Nenhum chip cadastrado nos aparelhos.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {status.chips.map((c) => {
                const rate = chipRateText(c);
                return (
                  <li key={c.chipId} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[0.8125rem] font-medium text-primary">
                        {c.deviceName || `Aparelho ${c.deviceId}`}
                        {(chipsPerDevice.get(c.deviceId) ?? 0) > 1 && <span className="ml-1.5 text-xs font-normal text-tertiary">chip {c.chipId}</span>}
                      </p>
                      {rate && <p className="text-xs text-secondary">{rate}</p>}
                      {c.reason && <p className="text-xs text-tertiary">{c.reason}</p>}
                    </div>
                    <Badge variant={CHIP_STATE_BADGE[c.state] ?? "neutral"} dot>
                      {CHIP_STATE_LABEL[c.state] ?? c.state}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </FormSection>
    </div>
  );
}

// Uso do teto: número, enviadas e uma barra fina. A cor da barra diz o nível (accent; aviso a
// partir de 80%; perigo no teto) e o texto diz o mesmo, para não depender só da cor.
function UsageMeter({ label, attempts, limit, sent }: { label: string; attempts: number; limit: number; sent: number }) {
  const ratio = limit > 0 ? attempts / limit : 0;
  const level = ratio >= 1 ? "full" : ratio >= 0.8 ? "high" : "ok";
  const fill = level === "full" ? "bg-[var(--color-danger)]" : level === "high" ? "bg-[var(--color-warning)]" : "bg-[var(--color-accent)]";
  const track = level === "full" ? "bg-red-500/15" : level === "high" ? "bg-amber-500/15" : "bg-[var(--color-accent-glow)]";
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <p className="text-xs text-tertiary">{label}</p>
      <p className="text-[0.8125rem] text-secondary">
        <span className="text-lg font-semibold text-primary">{attempts}</span> de {limit} tentativas
      </p>
      <div
        role="meter"
        aria-label={`${label}: ${attempts} de ${limit} tentativas`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(attempts, limit)}
        className={`h-1.5 w-full overflow-hidden rounded-full ${track}`}
      >
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
      </div>
      <p className="text-xs text-tertiary">
        {sent} enviadas{level === "full" ? " · teto atingido" : level === "high" ? " · perto do teto" : ""}
      </p>
    </div>
  );
}
