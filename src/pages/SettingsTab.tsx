// ============================================================
// Esfera v3 — Configurações
// Configurações: empresa, notificações, ADB, conexão, IA e segurança
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
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
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
  getAiProviderInfo,
  normalizeAiProviderId,
} from "../constants/aiProviders";
import {
  Save,
  Globe,
  Bell,
  Shield,
  Smartphone,
  Database,
  RefreshCw,
  Wifi,
  Sparkles,
  Cpu,
  CheckCircle2,
  AlertCircle,
  Play,
  Settings,
  Eye,
  EyeOff,
  Plug,
  Copy,
  KeyRound,
  Loader2,
  Info,
} from "lucide-react";

type SettingsSection = "geral" | "notificacoes" | "adb" | "hub" | "ia" | "integracoes" | "seguranca";
type LoadState = "loading" | "ready" | "error";
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

/** Compara dois retratos do formulário campo a campo. */
function sameSnapshot<T extends Record<string, unknown>>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => a[k] === b[k]);
}
// O que get_ai_provider_keys devolve por provedor. A chave vem vazia (mascarada) no backend novo;
// hasApiKey é o indicador pedido ao backend (pedidos-L-SET.md) e é usado quando existir.
type ProviderKeyInfo = { apiKey?: string; endpoint?: string; model?: string; hasApiKey?: boolean };

const DEFAULT_HUB_ADDRESS = "127.0.0.1:8555";
const KNOWN_MODES = ["empresa", "local", "master"] as const;
type KnownMode = (typeof KNOWN_MODES)[number];
const isKnownMode = (m: string): m is KnownMode => (KNOWN_MODES as readonly string[]).includes(m);

// Texto de teste da IA: sem valores (R$ é proibido e o validador recusaria), sem link e sem data.
const AI_TEST_MESSAGE =
  "Olá {nome}, tudo bem? Aqui é da central de atendimento. Temos uma proposta para você regularizar a sua pendência. Responda esta mensagem para conversar com a gente.";
const AI_TEST_CONTACT = "Maria";

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
  const { selectedCompanyId, user } = useAuth();
  const isMasterUser = user?.role === "master";

  // Controle de Navegação Interna
  const [activeSection, setActiveSection] = useState<SettingsSection>("geral");

  // General
  const [companyName, setCompanyName] = useState("REALESS RM COBRANÇAS");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");

  // Notifications
  const [notifications, setNotifications] = useState(true);
  const [batteryAlert, setBatteryAlert] = useState(true);
  const [banAlert, setBanAlert] = useState(true);
  const [dispatchAlert, setDispatchAlert] = useState(false);

  // ADB
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [pingInterval, setPingInterval] = useState(30);
  const [maxRetries, setMaxRetries] = useState(3);
  const [unlockPin, setUnlockPin] = useState("");

  // Security
  const [autoBackup, setAutoBackup] = useState(false);
  const [logRetention, setLogRetention] = useState("30");
  const [sessionTimeout, setSessionTimeout] = useState("60");

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
        // IA própria: endereço e modelo valem os do cartão IA própria (atualizados também pelo hub).
        const vps = provider === "vps_ia" ? visible.vps_ia : undefined;
        applyAiSnapshot({
          provider,
          model: vps?.model || cfg?.model || info?.defaultModel || DEFAULT_AI_MODEL,
          temperature: String(cfg?.temperature ?? 0.7),
          systemPrompt: cfg?.systemPrompt || "",
          endpoint: vps?.endpoint || cfg?.endpoint || info?.defaultEndpoint || "",
        });
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
  const aiTemperatureValue = Number(aiTemperature.replace(",", "."));
  const aiTemperatureError =
    aiTemperature.trim() === "" || !Number.isFinite(aiTemperatureValue) || aiTemperatureValue < 0 || aiTemperatureValue > 1
      ? "Use um número de 0 a 1 (ex.: 0,7)."
      : "";
  const aiEndpointTrim = aiEndpoint.trim();
  const aiEndpointError =
    aiProvider === "custom" && !aiEndpointTrim
      ? "Informe o endereço da API."
      : aiEndpointTrim && !/^https?:\/\/\S+$/i.test(aiEndpointTrim)
      ? "O endereço deve começar com http:// ou https://."
      : "";
  const aiModelError = !aiModel.trim() && !getAiProviderInfo(aiProvider)?.defaultModel ? "Informe o modelo." : "";

  // Chave que vai para o backend: a digitada agora ou, em branco, a já salva (o backend novo
  // devolve vazio e preserva a salva; o antigo precisava receber a mesma chave de volta).
  const aiKeyToSend = () => aiApiKey.trim() || loadedKeys.current[aiProvider] || "";

  const handleSaveAi = async () => {
    if (!selectedCompanyId || aiLoad !== "ready") return;
    const problem = aiTemperatureError || aiEndpointError || aiModelError;
    if (problem) {
      setAiStatus(`Falha ao salvar: ${problem}`);
      return;
    }
    const info = getAiProviderInfo(aiProvider);
    const provider = aiProvider;
    const model = aiModel.trim() || info?.defaultModel || "";
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
          model: aiModel.trim(),
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
        { provider: aiProvider, model: aiModel.trim(), temperature: aiTemperature.trim(), systemPrompt: aiSystemPrompt, endpoint: aiEndpointTrim },
        aiSaved,
      ));

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


  const menuItems: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: "geral", label: "Geral", icon: <Globe size={16} /> },
    { id: "notificacoes", label: "Notificações", icon: <Bell size={16} /> },
    { id: "adb", label: "Aparelhos e ADB", icon: <Smartphone size={16} /> },
    { id: "hub", label: "Conexão e servidores", icon: <Wifi size={16} /> },
    { id: "ia", label: "Inteligência artificial", icon: <Sparkles size={16} /> },
    { id: "integracoes", label: "Integrações", icon: <Plug size={16} /> },
    { id: "seguranca", label: "Segurança e backup", icon: <Shield size={16} /> },
  ];

  const hubStatusIsError = hubStatus.startsWith("Erro");
  const aiStatusIsError = aiStatus.startsWith("Falha");
  const providerInfo = getAiProviderInfo(aiProvider);

  return (
    <div className="space-y-6 animate-fade-in max-w-6xl mx-auto">
      <PageHeader
        title="Configurações"
        description="Preferências da empresa, conexão, IA e segurança."
        icon={<Settings size={18} />}
      />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav aria-label="Seções de configurações" className="w-full md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto">
          {menuItems.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[0.8125rem] font-medium transition-colors cursor-pointer text-left ${
                  active ? "bg-secondary text-primary" : "text-secondary hover:bg-secondary hover:text-primary"
                }`}
              >
                <span className={active ? "text-[var(--color-accent-light)]" : "text-tertiary"}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>

        <main className="flex-1 w-full min-w-0">
          <Card padding="lg">
            {activeSection === "geral" && (
              <FormSection title="Geral" description="Identificação da empresa e fuso horário.">
                <div className="space-y-4 max-w-xl">
                  <Field label="Nome da empresa" htmlFor="set-company">
                    <input id="set-company" type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                  </Field>
                  <Field label="Fuso horário" htmlFor="set-tz">
                    <select id="set-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                      <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
                      <option value="America/Manaus">América/Manaus (GMT-4)</option>
                      <option value="America/Fortaleza">América/Fortaleza (GMT-3)</option>
                    </select>
                  </Field>
                </div>
              </FormSection>
            )}

            {activeSection === "geral" && <NetworkSettings canEdit={user?.role === "master" || user?.role === "gestor"} />}

            {activeSection === "notificacoes" && (
              <FormSection title="Notificações" description="Escolha quais avisos o sistema deve exibir.">
                <div className="max-w-xl divide-y divide-border">
                  <ToggleRow label="Alertas do sistema" desc="Avisar quando aparelhos desconectarem ou apresentarem falhas." checked={notifications} onChange={setNotifications} />
                  <ToggleRow label="Bateria baixa" desc="Avisar quando a bateria de um aparelho ficar abaixo de 20%." checked={batteryAlert} onChange={setBatteryAlert} />
                  <ToggleRow label="Bloqueio de chip" desc="Avisar assim que um chip for bloqueado pela operadora." checked={banAlert} onChange={setBanAlert} />
                  <ToggleRow label="Disparo concluído" desc="Avisar quando a fila de envios de uma campanha terminar." checked={dispatchAlert} onChange={setDispatchAlert} />
                </div>
              </FormSection>
            )}

            {activeSection === "adb" && (
              <FormSection title="Aparelhos e ADB" description="Como o sistema se comunica com os celulares.">
                <div className="space-y-5 max-w-xl">
                  <ToggleRow label="Reconectar automaticamente" desc="Tenta reconectar aparelhos desconectados em segundo plano." checked={autoReconnect} onChange={setAutoReconnect} />
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Intervalo de verificação (s)" hint="Entre 5 e 300." htmlFor="set-ping">
                      <input id="set-ping" type="number" value={pingInterval} onChange={(e) => setPingInterval(parseInt(e.target.value) || 30)} min={5} max={300} className="font-mono" />
                    </Field>
                    <Field label="Máximo de tentativas" hint="Entre 1 e 10." htmlFor="set-retries">
                      <input id="set-retries" type="number" value={maxRetries} onChange={(e) => setMaxRetries(parseInt(e.target.value) || 3)} min={1} max={10} className="font-mono" />
                    </Field>
                  </div>
                  <Field label="PIN de desbloqueio" hint="Opcional. Usado para desbloquear a tela dos aparelhos." htmlFor="set-pin">
                    <SecretInput id="set-pin" value={unlockPin} onChange={setUnlockPin} placeholder="Ex.: 1234" />
                  </Field>
                </div>
              </FormSection>
            )}

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
                        <Field label="Endereço do hub" htmlFor="set-hub-addr" error={hubAddressError || undefined}>
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

            {activeSection === "ia" && (
              <FormSection title="Inteligência artificial" description="Provedor usado para reescrever mensagens e variar o texto dos disparos.">
                <div className="space-y-4 max-w-xl">
                  <LoadGate
                    state={aiLoad}
                    error={aiLoadError}
                    what="a configuração de IA"
                    onRetry={() => setAiReload((n) => n + 1)}
                  />
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

                      {aiProvider === "vps_ia" ? (
                        <div className="rounded-lg border border-border bg-secondary px-3 py-2.5 text-[0.8125rem] text-secondary">
                          <p className="font-medium text-primary">Endereço e token da IA própria</p>
                          <p className="mt-0.5 break-all font-mono text-xs">{aiEndpointTrim || "Ainda não configurado"}</p>
                          <p className="mt-1 text-xs text-tertiary">{providerInfo?.keyHint}</p>
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
                        <Button variant="secondary" icon={<Play size={14} />} loading={aiRun.running} onClick={handleTestAi}>
                          {aiRun.running ? `Testando… ${aiRun.elapsed} s` : "Testar"}
                        </Button>
                        {aiRun.running && (
                          <Button variant="ghost" onClick={aiRun.stop}>
                            Parar
                          </Button>
                        )}
                        {aiDirty && !savingAi && (
                          <UnsavedNote onUndo={() => aiSaved && applyAiSnapshot(aiSaved)} />
                        )}
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
            )}

            {activeSection === "integracoes" && <IntegrationsSection companyId={selectedCompanyId ?? 1} isMaster={isMasterUser} canManage={isMasterUser || user?.role === "gestor"} />}

            {activeSection === "seguranca" && (
              <FormSection title="Segurança e backup" description="Proteção de dados e retenção de registros.">
                <div className="space-y-5 max-w-xl">
                  <ToggleRow label="Backup diário automático" desc="Salva uma cópia local do banco de dados ao fim de cada dia." checked={autoBackup} onChange={setAutoBackup} />
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Retenção de logs" htmlFor="set-retention">
                      <select id="set-retention" value={logRetention} onChange={(e) => setLogRetention(e.target.value)}>
                        <option value="7">7 dias</option>
                        <option value="15">15 dias</option>
                        <option value="30">30 dias (padrão)</option>
                        <option value="90">90 dias</option>
                      </select>
                    </Field>
                    <Field label="Expiração da sessão (min)" hint="Entre 15 e 480." htmlFor="set-session">
                      <input id="set-session" type="number" value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)} min={15} max={480} className="font-mono" />
                    </Field>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Button variant="secondary" icon={<Database size={15} />}>
                      Exportar backup
                    </Button>
                    <Button variant="danger" icon={<RefreshCw size={15} />}>
                      Restaurar padrões
                    </Button>
                  </div>
                </div>
              </FormSection>
            )}
          </Card>
        </main>
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
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-[0.8125rem] text-red-700 dark:text-red-400"
    >
      <span className="flex min-w-0 items-start gap-2">
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
        <span className="break-words">
          Não foi possível carregar {what}: {error}
        </span>
      </span>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>
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

// Campo de segredo: mascarado por padrão, com botão para mostrar/ocultar.
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
        autoComplete="off"
        className="w-full font-mono pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar valor" : "Mostrar valor"}
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
        <Toggle checked={checked} onChange={onChange} size="sm" />
      </div>
    </div>
  );
}

// ---------- Integrações ----------
// Webhook de descadastro (SAIR): o VEXOR chama POST /api/optout/events no Esfera com o token da empresa.
const OPTOUT_BASE_URL = "http://127.0.0.1:8080";

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

function IntegrationsSection({ companyId, isMaster, canManage }: { companyId: number; isMaster: boolean; canManage: boolean }) {
  const [vexorToken, setVexorToken] = useState("");
  const [vexorConfigured, setVexorConfigured] = useState<boolean | null>(null);
  const [vexorBusy, setVexorBusy] = useState<"" | "save" | "test">("");
  const [vexorResult, setVexorResult] = useState("");
  useEffect(() => {
    let active = true;
    setVexorConfigured(null);
    setVexorToken("");
    setVexorResult("");
    if (canManage) api<boolean>("get_vexor_token_status", { companyId }).then((v) => { if (active) setVexorConfigured(v); }).catch((e) => { if (active) setVexorResult(String(e)); });
    return () => { active = false; };
  }, [companyId, canManage]);
  const saveVexor = async () => {
    setVexorBusy("save"); setVexorResult("");
    try {
      await api("save_vexor_token", { companyId, vexorToken });
      setVexorToken("");
      setVexorConfigured(await api<boolean>("get_vexor_token_status", { companyId }));
      setVexorResult("Token salvo.");
    } catch (e) { setVexorResult(String(e)); } finally { setVexorBusy(""); }
  };
  const testVexor = async () => {
    setVexorBusy("test"); setVexorResult("");
    try { setVexorResult(await api<string>("test_vexor_token", { companyId })); }
    catch (e) { setVexorResult(String(e)); } finally { setVexorBusy(""); }
  };
  const [online, setOnline] = useState<boolean | null>(null);
  const [orgId, setOrgId] = useState("org-local");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  // Estado do cartão Gemini Web (Login Google sem chave de API)
  const [vpsStatus, setVpsStatus] = useState<VpsIaStatus | null>(null);
  const [vpsEndpoint, setVpsEndpoint] = useState("");
  const [vpsModel, setVpsModel] = useState("");
  const [vpsToken, setVpsToken] = useState("");
  const [vpsBusy, setVpsBusy] = useState<"" | "save" | "test" | "remove">("");
  const [vpsResult, setVpsResult] = useState("");
  const [vpsError, setVpsError] = useState("");

  useEffect(() => {
    let active = true;
    setVpsStatus(null); setVpsEndpoint(""); setVpsModel(""); setVpsToken("");
    setVpsResult(""); setVpsError("");
    if (canManage) {
      api<VpsIaStatus>("vps_ia_status", { companyId }).then((status) => {
        if (!active) return;
        setVpsStatus(status); setVpsEndpoint(status.endpoint); setVpsModel(status.model);
      }).catch((e) => { if (active) setVpsError(String(e)); });
    }
    return () => { active = false; };
  }, [companyId, canManage]);

  const saveVps = async () => {
    setVpsBusy("save"); setVpsError(""); setVpsResult("");
    try {
      const status = await api<VpsIaStatus>("vps_ia_save", { companyId, endpoint: vpsEndpoint.trim(), model: vpsModel.trim(), apiToken: vpsToken });
      setVpsStatus(status); setVpsEndpoint(status.endpoint); setVpsModel(status.model); setVpsToken("");
      setVpsResult("Configura\u00e7\u00e3o salva.");
    } catch (e) { setVpsError(String(e)); } finally { setVpsBusy(""); }
  };
  const testVps = async () => {
    setVpsBusy("test"); setVpsError(""); setVpsResult("");
    try {
      const result = await api<VpsIaTestResult>("vps_ia_test", { companyId });
      setVpsResult(`Resposta em ${(result.elapsedMs / 1000).toFixed(1)} s: ${result.text}`);
    } catch (e) { setVpsError(String(e)); } finally { setVpsBusy(""); }
  };
  const removeVps = async () => {
    setVpsBusy("remove"); setVpsError(""); setVpsResult("");
    try {
      await api<void>("vps_ia_remove", { companyId });
      setVpsStatus({ configured: false, endpoint: "", model: "" });
      setVpsEndpoint(""); setVpsModel(""); setVpsToken(""); setVpsResult("Configura\u00e7\u00e3o removida.");
    } catch (e) { setVpsError(String(e)); } finally { setVpsBusy(""); }
  };

  const [geminiStatus, setGeminiStatus] = useState<GeminiWebStatus | null>(null);
  const [geminiBusy, setGeminiBusy] = useState<"" | "login" | "test" | "logout">("");
  const [geminiTestResult, setGeminiTestResult] = useState("");
  const [geminiError, setGeminiError] = useState("");

  const refreshGeminiStatus = async () => {
    try {
      const res = await api<GeminiWebStatus>("gemini_web_status", { companyId });
      setGeminiStatus(res);
    } catch (e) {
      setGeminiStatus({ connected: false, browserOpen: false, detail: String(e) });
    }
  };

  useEffect(() => {
    let alive = true;
    // no-cors: só interessa saber se a porta responde (o status exige token).
    const check = () =>
      fetch(`${OPTOUT_BASE_URL}/api/optout/status`, { mode: "no-cors" })
        .then(() => alive && setOnline(true))
        .catch(() => alive && setOnline(false));
    check();
    refreshGeminiStatus();
    const timer = setInterval(() => {
      check();
      refreshGeminiStatus();
    }, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [companyId]);

  const handleGeminiLogin = async () => {
    setGeminiBusy("login");
    setGeminiError("");
    setGeminiTestResult("");
    try {
      const res = await api<GeminiWebStatus>("gemini_web_login", { companyId });
      setGeminiStatus(res);
    } catch (e) {
      setGeminiError(String(e));
    } finally {
      setGeminiBusy("");
    }
  };

  const handleGeminiTest = async () => {
    setGeminiBusy("test");
    setGeminiError("");
    setGeminiTestResult("");
    try {
      const out = await api<string>("gemini_web_test", { companyId });
      setGeminiTestResult(out);
      await refreshGeminiStatus();
    } catch (e) {
      setGeminiError(String(e));
    } finally {
      setGeminiBusy("");
    }
  };

  const handleGeminiLogout = async () => {
    setGeminiBusy("logout");
    setGeminiError("");
    setGeminiTestResult("");
    try {
      await api<void>("gemini_web_logout", { companyId });
      await refreshGeminiStatus();
    } catch (e) {
      setGeminiError(String(e));
    } finally {
      setGeminiBusy("");
    }
  };

  const envLine = token
    ? `ESFERA_OPTOUT_LINKS_JSON=${JSON.stringify({ [orgId.trim() || "org-local"]: { baseUrl: OPTOUT_BASE_URL, companyId, token } })}`
    : "";

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      setToken(await api<string>("generate_company_token", { companyId }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };

  const isGeminiConnected = Boolean(geminiStatus?.connected || geminiStatus?.savedConnected);

  return (
    <FormSection title="Integrações" description="Conexão com Gemini Web (login Google sem chave de API) e webhook de descadastro (SAIR) do VEXOR.">
      <div className="space-y-5 max-w-2xl">
        {canManage && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">IA pr&#243;pria (VPS)</p>
                <p className="text-[0.75rem] text-tertiary">Configura&#231;&#227;o usada para reescrever mensagens.</p>
              </div>
              <span className="text-[0.75rem] text-secondary" role="status">
                {vpsStatus === null ? (vpsError ? "N\u00e3o foi poss\u00edvel verificar" : "Verificando\u2026") : vpsStatus.configured ? "Configurada" : "N\u00e3o configurada"}
              </span>
            </div>
            <Field label="Endere&#231;o" htmlFor="int-vps-endpoint">
              <input id="int-vps-endpoint" type="url" value={vpsEndpoint} onChange={(e) => setVpsEndpoint(e.target.value)} placeholder="https://187.77.243.224:11435/v1/chat/completions" />
            </Field>
            <Field label="Modelo" htmlFor="int-vps-model">
              <input id="int-vps-model" type="text" value={vpsModel} onChange={(e) => setVpsModel(e.target.value)} placeholder="Nome do modelo" />
            </Field>
            <Field label="Token" htmlFor="int-vps-token" hint={vpsStatus?.configured ? "Deixe em branco para manter o token salvo. O valor salvo n\u00e3o \u00e9 exibido." : "O valor salvo n\u00e3o \u00e9 exibido."}>
              <input id="int-vps-token" type="password" autoComplete="new-password" value={vpsToken} onChange={(e) => setVpsToken(e.target.value)} placeholder="Cole o token" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={saveVps} loading={vpsBusy === "save"} disabled={vpsBusy !== "" || !vpsEndpoint.trim() || !vpsModel.trim() || (!vpsStatus?.configured && !vpsToken.trim())}>Salvar</Button>
              <Button variant="secondary" onClick={testVps} loading={vpsBusy === "test"} disabled={vpsBusy !== "" || !vpsStatus?.configured}>Testar</Button>
              <Button variant="secondary" onClick={removeVps} loading={vpsBusy === "remove"} disabled={vpsBusy !== "" || !vpsStatus?.configured}>Remover</Button>
            </div>
            {vpsError && <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">{vpsError}</p>}
            {vpsResult && <p className="whitespace-pre-wrap text-[0.75rem] text-secondary" role="status">{vpsResult}</p>}
          </div>
        )}
        {/* Cartão Gemini Web (Login Google) */}
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium text-primary">Gemini Web (Conta Google — Sem Chave de API)</p>
              <p className="text-[0.75rem] text-tertiary">
                Reserva opcional e gratuita: usa o Microsoft Edge com um perfil só do Esfera para reescrever no site do Gemini. Entra na cadeia de reserva depois do Groq e da IA própria (VPS); nunca é a IA principal.
              </p>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
                geminiStatus === null
                  ? "bg-secondary text-secondary"
                  : isGeminiConnected
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
            >
              {geminiStatus === null ? (
                "Verificando…"
              ) : isGeminiConnected ? (
                <>
                  <CheckCircle2 size={13} /> Conectado
                </>
              ) : (
                <>
                  <AlertCircle size={13} /> Não conectado
                </>
              )}
            </span>
          </div>

          {geminiStatus?.detail && (
            <p className="text-[0.75rem] text-secondary">{geminiStatus.detail}</p>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <Button
              icon={<Globe size={15} />}
              onClick={handleGeminiLogin}
              loading={geminiBusy === "login"}
              disabled={geminiBusy !== ""}
            >
              Entrar com Google
            </Button>
            <Button
              variant="secondary"
              icon={<Play size={14} />}
              onClick={handleGeminiTest}
              loading={geminiBusy === "test"}
              disabled={geminiBusy !== ""}
            >
              Testar
            </Button>
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} />}
              onClick={refreshGeminiStatus}
              disabled={geminiBusy !== ""}
            >
              Atualizar status
            </Button>
            {(isGeminiConnected || geminiStatus?.browserOpen) && (
              <Button
                variant="secondary"
                onClick={handleGeminiLogout}
                loading={geminiBusy === "logout"}
                disabled={geminiBusy !== ""}
              >
                Sair
              </Button>
            )}
          </div>

          {geminiError && (
            <p className="text-[0.75rem] text-red-600 dark:text-red-400">{geminiError}</p>
          )}

          {geminiTestResult && (
            <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[0.75rem] text-primary">
              <p className="font-medium text-emerald-600 dark:text-emerald-400 mb-1">Resposta de teste do Gemini Web:</p>
              <p className="whitespace-pre-wrap">{geminiTestResult}</p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-medium text-primary">Webhook de descadastro</p>
            <p className="font-mono text-[0.75rem] text-tertiary">POST {OPTOUT_BASE_URL}/api/optout/events</p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
              online === null ? "bg-secondary text-secondary" : online ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400"
            }`}
          >
            {online === null ? "Verificando…" : online ? <><CheckCircle2 size={13} /> Ativo</> : <><AlertCircle size={13} /> Fora do ar</>}
          </span>
        </div>
        {online === false && (
          <p className="text-[0.75rem] text-red-600 dark:text-red-400">
            A porta 8080 não respondeu. Clique em “Salvar alterações” e reabra o Esfera para ligar o webhook.
          </p>
        )}

        {canManage && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-[0.8125rem] font-medium text-primary">Token do VEXOR</p>
            <p className="text-[0.75rem] text-secondary">{vexorConfigured === null ? "Verificando…" : vexorConfigured ? "Token configurado." : "Token não configurado."}</p>
            <Field label="Token do VEXOR" htmlFor="int-vexor-token" hint="Use o mesmo token da integração SAIR configurada no VEXOR. O valor salvo não é exibido.">
              <SecretInput id="int-vexor-token" value={vexorToken} onChange={setVexorToken} placeholder="Cole o token" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={saveVexor} loading={vexorBusy === "save"} disabled={vexorBusy !== "" || !vexorToken.trim()}>Salvar token</Button>
              <Button variant="secondary" onClick={testVexor} loading={vexorBusy === "test"} disabled={vexorBusy !== "" || !vexorConfigured}>Testar</Button>
            </div>
            {vexorResult && <p className="text-[0.75rem] text-secondary" role="status">{vexorResult}</p>}
          </div>
        )}
        {!isMaster ? (
          <p className="text-[0.8125rem] text-secondary">Só o usuário Master gera o token da integração.</p>
        ) : (
          <div className="space-y-4">
            <Field label="Organização no VEXOR" htmlFor="int-org" hint="ID da organização do VEXOR que recebe o SAIR (no ambiente local: org-local).">
              <input id="int-org" type="text" value={orgId} onChange={(e) => setOrgId(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button icon={<KeyRound size={15} />} onClick={generate} loading={busy}>
                {token ? "Gerar outro token" : "Gerar token"}
              </Button>
              <p className="text-[0.75rem] text-tertiary">Gerar de novo invalida o token anterior (o VEXOR precisa do novo).</p>
            </div>
            {error && <p className="text-[0.75rem] text-red-600 dark:text-red-400">{error}</p>}
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
                <button type="button" onClick={() => copy("token", token)} className="text-[0.75rem] text-secondary underline cursor-pointer">
                  {copied === "token" ? "Token copiado" : "Copiar só o token"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </FormSection>
  );
}


type NetworkChipState = "normal" | "reduzido" | "pausado" | "indisponivel";
type NetworkChip = { chipId: number; deviceId: number; deviceName: string; replyRate: number | null; sample: number; state: NetworkChipState; reason: string };
// attempts* = o que o teto conta (tentativas, inclusive falhas; cada parte extra soma uma); sent* = só enviadas.
type NetworkStatus = { hourly: number; daily: number; sentLastHour: number; sentToday: number; attemptsLastHour: number; attemptsToday: number; waitSeconds: number; chips: NetworkChip[] };
const CHIP_STATE_LABEL: Record<NetworkChipState, string> = { normal: "Normal", reduzido: "Reduzido", pausado: "Pausado", indisponivel: "Indisponível" };

// Linha curta do freio por resposta: estado, taxa com a amostra e motivo.
function chipBrakeText(c: NetworkChip): string {
  const rate = c.replyRate === null ? "" : `${c.replyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% de resposta em ${c.sample} envios`;
  return [CHIP_STATE_LABEL[c.state] ?? c.state, rate, c.reason].filter(Boolean).join(" · ");
}

function NetworkSettings({ canEdit }: { canEdit: boolean }) {
  const [hourly, setHourly] = useState("40");
  const [daily, setDaily] = useState("200");
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  // Retorno do Salvar e erro da consulta ficam separados: o erro some na próxima consulta que der certo.
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  // Sem os limites reais carregados, Salvar gravaria os números de exemplo (40/200) por cima.
  const [limitsReady, setLimitsReady] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => api<NetworkStatus>("get_network_status")
      .then(v => { if (active) { setStatus(v); setLoadError(""); } })
      .catch(e => { if (active) setLoadError(`Erro ao consultar a rede: ${String(e)}`); });
    api<{ hourly: number; daily: number }>("get_network_limits")
      .then(v => { if (active) { setHourly(String(v.hourly)); setDaily(String(v.daily)); setLimitsReady(true); } })
      .catch(e => { if (active) setMessage(`Erro ao carregar limites: ${String(e)}`); });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const save = async () => {
    const h = Number(hourly), d = Number(daily);
    if (!Number.isSafeInteger(h) || !Number.isSafeInteger(d) || h < 1 || d < h) { setMessage("Informe números inteiros positivos; o limite diário deve ser maior ou igual ao horário."); return; }
    setSaving(true);
    try {
      await api("set_network_limits", { hourly: h, daily: d });
      setMessage("Limites da rede salvos.");
    } catch (e) {
      setMessage(`Erro ao salvar limites: ${String(e)}`);
    } finally {
      setSaving(false);
    }
    try { setStatus(await api<NetworkStatus>("get_network_status")); setLoadError(""); }
    catch (e) { setLoadError(`Erro ao consultar a rede: ${String(e)}`); }
  };
  return <div className="mt-6 border-t border-border pt-6"><FormSection title="Rede e ritmo" description="Teto de tentativas compartilhado por todos os aparelhos desta instalação. Cada parte da mensagem conta como uma tentativa, mesmo quando o envio falha.">
    <div className="space-y-4 max-w-xl">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tentativas por hora" hint="Padrão: 40." htmlFor="network-hour">
          <input id="network-hour" type="number" min={1} value={hourly} disabled={!canEdit} onChange={e => setHourly(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Tentativas por dia" hint="Padrão: 200. Igual ou maior que por hora." htmlFor="network-day">
          <input id="network-day" type="number" min={1} value={daily} disabled={!canEdit} onChange={e => setDaily(e.target.value)} className="font-mono" />
        </Field>
      </div>
      <Button onClick={save} loading={saving} disabled={!canEdit || !limitsReady}>Salvar limites</Button>
      {message && <p role="status" className="text-sm text-secondary">{message}</p>}
      {loadError && <p role="alert" className="text-sm text-red-500">{loadError}</p>}
      {status && <div className="space-y-1 text-sm text-secondary">
        <p>Tentativas na última hora: <span className="font-mono text-primary">{status.attemptsLastHour}</span> de {status.hourly}. Tentativas hoje: <span className="font-mono text-primary">{status.attemptsToday}</span> de {status.daily}.</p>
        <p>{status.waitSeconds > 0 ? `Teto atingido: a rede volta a enviar em até ${Math.ceil(status.waitSeconds / 60)} min.` : "Rede disponível para enviar."}</p>
      </div>}
      {status && status.chips.length > 0 && <div className="space-y-1">
        <p className="text-[0.8125rem] font-medium text-primary">Freio por resposta</p>
        <ul className="space-y-1 text-sm text-secondary">
          {status.chips.map(c => <li key={c.chipId}><span className="font-medium text-primary">{c.deviceName || `Aparelho ${c.deviceId}`}</span>: {chipBrakeText(c)}</li>)}
        </ul>
      </div>}
    </div>
  </FormSection></div>;
}
