// ============================================================
// Esfera v3 — Settings Tab Completo
// Configurações da Empresa, IA, Dispatch, ADB e Segurança
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import { api } from "../tauri";
import type { AiConfig, AppConfig } from "../types";
import {
  Save,
  Globe,
  Bell,
  Shield,
  Smartphone,
  Database,
  RefreshCw,
  Zap,
  RotateCcw,
  Brain,
  Wifi,
} from "lucide-react";

export default function SettingsTab() {
  const { selectedCompanyId } = useAuth();

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

  // Dispatch
  const [delayMin, setDelayMin] = useState(30);
  const [delayMax, setDelayMax] = useState(90);
  const [humanizeDelay, setHumanizeDelay] = useState(true);
  const [batchSize, setBatchSize] = useState(5);
  const [retryOnFail, setRetryOnFail] = useState(true);
  const [maxRetriesDispatch, setMaxRetriesDispatch] = useState(2);

  // AI
  const [aiProvider, setAiProvider] = useState("ollama_local");
  const [aiEndpoint, setAiEndpoint] = useState("http://localhost:11434");
  const [aiModel, setAiModel] = useState("llama3.2");
  const [aiTemperature, setAiTemperature] = useState(0.7);
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("Você é um assistente de cobrança. Seja profissional e gentil.");
  const [aiTestResult, setAiTestResult] = useState("");

  // Security
  const [autoBackup, setAutoBackup] = useState(false);
  const [logRetention, setLogRetention] = useState("30");
  const [sessionTimeout, setSessionTimeout] = useState("60");

  // Hub config
  const [hubEnabled, setHubEnabled] = useState(false);
  const [hubAddress, setHubAddress] = useState("");
  const [empresaServerEnabled, setEmpresaServerEnabled] = useState(false);
  const [empresaServerPort, setEmpresaServerPort] = useState(7777);
  const [appMode, setAppMode] = useState<"local" | "empresa" | "master">("local");
  const [hubStatus, setHubStatus] = useState("");

  // Load AI config
  useEffect(() => {
    let mounted = true;
    if (!selectedCompanyId) { if (mounted) return; return; }
    api<AiConfig>("get_ai_config", { companyId: selectedCompanyId })
      .then((cfg) => {
        if (!mounted || !cfg) return;
        setAiProvider(cfg.provider || "ollama_local");
        setAiEndpoint(cfg.endpoint || "http://localhost:11434");
        setAiModel(cfg.model || "llama3.2");
        setAiTemperature(cfg.temperature || 0.7);
        setAiApiKey(cfg.apiKey || "");
        setAiSystemPrompt(cfg.systemPrompt || "");
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  // Load app config
  useEffect(() => {
    let mounted = true;
    api<AppConfig>("get_app_config")
      .then((cfg) => {
        if (!mounted || !cfg) return;
        setHubEnabled(cfg.hub_enabled);
        setHubAddress(cfg.hub_address);
        setEmpresaServerEnabled(cfg.empresa_server_enabled);
        setEmpresaServerPort(cfg.empresa_server_port);
        setAppMode(cfg.mode);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  const handleSaveAll = async () => {
    if (!selectedCompanyId) return;
    try {
      await api("save_ai_config", {
        companyId: selectedCompanyId,
        config: {
          provider: aiProvider,
          model: aiModel,
          temperature: aiTemperature,
          systemPrompt: aiSystemPrompt,
          apiKey: aiApiKey,
          endpoint: aiEndpoint,
        },
      });
      await api("save_app_config", {
        hub_enabled: hubEnabled,
        hub_address: hubAddress,
        empresa_server_enabled: empresaServerEnabled,
        empresa_server_port: empresaServerPort,
        mode: appMode,
      });
      setHubStatus("Configurações salvas. Reinicie o app para aplicar alterações de rede.");
    } catch { /* noop */ }
  };

  const handleTestAI = async () => {
    setAiTestResult("Testando...");
    try {
      const result = await api<string>("rewrite_message_ai", {
        message: "Olá {nome}, sua fatura está pendente.",
        contactName: "Maria",
      });
      setAiTestResult(result);
    } catch {
      setAiTestResult("[Mock] Bom dia Maria! Sua fatura está pendente. Att, Equipe REALESS");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Configurações</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Preferências da empresa, IA, dispatch e segurança.
          </p>
        </div>
        <Button icon={<Save size={16} />} onClick={handleSaveAll}>
          Salvar Tudo
        </Button>
      </div>

      {/* === GERAL === */}
      <Card>
        <SectionHeader icon={<Globe size={18} />} color="violet" title="Informações Gerais" subtitle="Identificação da empresa e fuso horário" />
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-secondary mb-1">Nome da Empresa</label>
            <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="w-full input-setting" />
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">Fuso Horário</label>
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full input-setting">
              <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
              <option value="America/Manaus">América/Manaus (GMT-4)</option>
              <option value="America/Fortaleza">América/Fortaleza (GMT-3)</option>
            </select>
          </div>
        </div>
      </Card>

      {/* === NOTIFICAÇÕES === */}
      <Card>
        <SectionHeader icon={<Bell size={18} />} color="blue" title="Notificações & Alertas" subtitle="Alertas em tempo real do sistema" />
        <div className="space-y-3">
          <ToggleRow label="Alertas do Sistema" desc="Avisos quando dispositivo desconectar" checked={notifications} onChange={setNotifications} />
          <ToggleRow label="Alerta de Bateria Baixa" desc="Avisar se bateria < 20%" checked={batteryAlert} onChange={setBatteryAlert} />
          <ToggleRow label="Alerta de Ban Detectado" desc="Notificar quando chip for banido" checked={banAlert} onChange={setBanAlert} />
          <ToggleRow label="Alerta de Disparo" desc="Notificar ao completar lote de envio" checked={dispatchAlert} onChange={setDispatchAlert} />
        </div>
      </Card>

      {/* === ADB & REDE === */}
      <Card>
        <SectionHeader icon={<Smartphone size={18} />} color="emerald" title="Conexão ADB & Redes" subtitle="Parâmetros de comunicação wireless" />
        <div className="space-y-4 text-xs">
          <ToggleRow label="Reconexão Automática" desc="Tentar reconectar aparelhos offline" checked={autoReconnect} onChange={setAutoReconnect} />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-semibold text-secondary mb-1">Intervalo de Ping (seg)</label>
              <input type="number" value={pingInterval} onChange={(e) => setPingInterval(parseInt(e.target.value) || 30)} min={5} max={300} className="w-full input-setting font-mono" />
            </div>
            <div>
              <label className="block font-semibold text-secondary mb-1">Max Tentativas (device)</label>
              <input type="number" value={maxRetries} onChange={(e) => setMaxRetries(parseInt(e.target.value) || 3)} min={1} max={10} className="w-full input-setting font-mono" />
            </div>
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">PIN de Desbloqueio (opcional)</label>
            <input type="password" value={unlockPin} onChange={(e) => setUnlockPin(e.target.value)} placeholder="Ex: 1234" className="w-full input-setting font-mono" />
          </div>
        </div>
      </Card>

      {/* === DISPATCH === */}
      <Card>
        <SectionHeader icon={<Zap size={18} />} color="amber" title="Motor de Disparos" subtitle="Delays, retry e humanização dos envios" />
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-semibold text-secondary mb-1">Delay Mínimo (seg)</label>
              <input type="number" value={delayMin} onChange={(e) => setDelayMin(parseInt(e.target.value) || 30)} min={5} max={300} className="w-full input-setting font-mono" />
            </div>
            <div>
              <label className="block font-semibold text-secondary mb-1">Delay Máximo (seg)</label>
              <input type="number" value={delayMax} onChange={(e) => setDelayMax(parseInt(e.target.value) || 90)} min={10} max={600} className="w-full input-setting font-mono" />
            </div>
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">Tamanho do Lote (contatos por vez)</label>
            <input type="number" value={batchSize} onChange={(e) => setBatchSize(parseInt(e.target.value) || 5)} min={1} max={50} className="w-full input-setting font-mono" />
          </div>
          <ToggleRow label="Humanização de Delay" desc="Usar distribuição Gaussiana ao invés de delay fixo" checked={humanizeDelay} onChange={setHumanizeDelay} />
          <ToggleRow label="Retry em Falha" desc="Tentar novamente contato que falhou" checked={retryOnFail} onChange={setRetryOnFail} />
          {retryOnFail && (
            <div className="pl-4 border-l-2 border-amber-500/30">
              <label className="block font-semibold text-secondary mb-1">Máximo de Retries por Contato</label>
              <input type="number" value={maxRetriesDispatch} onChange={(e) => setMaxRetriesDispatch(parseInt(e.target.value) || 2)} min={1} max={5} className="w-32 input-setting font-mono" />
            </div>
          )}
        </div>
      </Card>

      {/* === IA === */}
      <Card>
        <SectionHeader icon={<Brain size={18} />} color="violet" title="Configuração de IA" subtitle="Provedor, modelo e parâmetros de geração" />
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-secondary mb-1">Provedor</label>
            <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className="w-full input-setting">
              <option value="ollama_local">Ollama Local</option>
              <option value="ollama_cloud">Ollama Cloud</option>
              <option value="openai">OpenAI (GPT)</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">Endpoint</label>
            <input type="text" value={aiEndpoint} onChange={(e) => setAiEndpoint(e.target.value)} className="w-full input-setting font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-semibold text-secondary mb-1">Modelo</label>
              <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="w-full input-setting font-mono" />
            </div>
            <div>
              <label className="block font-semibold text-secondary mb-1">Temperatura ({aiTemperature})</label>
              <input type="range" min="0" max="1" step="0.1" value={aiTemperature} onChange={(e) => setAiTemperature(parseFloat(e.target.value))} className="w-full mt-2 accent-violet-500" />
            </div>
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">API Key (opcional para local)</label>
            <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." className="w-full input-setting font-mono" />
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">System Prompt</label>
            <textarea value={aiSystemPrompt} onChange={(e) => setAiSystemPrompt(e.target.value)} rows={3} className="w-full input-setting resize-none" />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={handleTestAI}>
              Testar IA
            </Button>
            {aiTestResult && (
              <div className="flex-1 p-2.5 rounded-xl bg-violet-600/10 border border-violet-500/20 text-violet-200 text-xs font-mono">
                {aiTestResult}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* === HUB / DISTRIBUÍDO === */}
      <Card>
        <SectionHeader icon={<Wifi size={18} />} color="blue" title="Conexão Distribuída (Hub)" subtitle="Conecte esta instância ao Hub central ou sirva na LAN" />
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-secondary mb-1">Modo de Operação</label>
            <select value={appMode} onChange={(e) => setAppMode(e.target.value as "local" | "empresa" | "master")} className="w-full input-setting">
              <option value="local">Local (standalone, sem Hub)</option>
              <option value="empresa">Empresa (conecta ao Hub + serve LAN)</option>
              <option value="master">Master (controle remoto via Hub)</option>
            </select>
          </div>
          {appMode !== "local" && (
            <>
              <div>
                <label className="block font-semibold text-secondary mb-1">Endereço do Hub (IP:Porta)</label>
                <input type="text" value={hubAddress} onChange={(e) => setHubAddress(e.target.value)} placeholder="192.168.1.100:8888" className="w-full input-setting font-mono" />
              </div>
              <ToggleRow label="Habilitar Conexão com Hub" desc="Mantém conexão persistente com o servidor central" checked={hubEnabled} onChange={setHubEnabled} />
            </>
          )}
          {appMode === "empresa" && (
            <>
              <ToggleRow label="Servidor LAN (Empresa Server)" desc="Aceita conexões de Gestores/Colaboradores na rede local" checked={empresaServerEnabled} onChange={setEmpresaServerEnabled} />
              {empresaServerEnabled && (
                <div>
                  <label className="block font-semibold text-secondary mb-1">Porta do Servidor LAN</label>
                  <input type="number" value={empresaServerPort} onChange={(e) => setEmpresaServerPort(parseInt(e.target.value) || 7777)} min={1024} max={65535} className="w-32 input-setting font-mono" />
                </div>
              )}
            </>
          )}
          {hubStatus && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">{hubStatus}</p>
          )}
        </div>
      </Card>

      {/* === SEGURANÇA === */}
      <Card>
        <SectionHeader icon={<Shield size={18} />} color="amber" title="Segurança & Retenção" subtitle="Backup, retenção de logs e sessão" />
        <div className="space-y-4 text-xs">
          <ToggleRow label="Backup Automático Diário" desc="Snapshot local de campanhas e contatos" checked={autoBackup} onChange={setAutoBackup} />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-semibold text-secondary mb-1">Retenção de Logs</label>
              <select value={logRetention} onChange={(e) => setLogRetention(e.target.value)} className="w-full input-setting">
                <option value="7">7 dias</option>
                <option value="15">15 dias</option>
                <option value="30">30 dias (Recomendado)</option>
                <option value="60">60 dias</option>
                <option value="90">90 dias</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-secondary mb-1">Timeout de Sessão (min)</label>
              <input type="number" value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)} min={15} max={480} className="w-full input-setting font-mono" />
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button variant="secondary" size="sm" icon={<Database size={14} />}>
              Exportar Snapshot
            </Button>
            <Button variant="danger" size="sm" icon={<RefreshCw size={14} />}>
              Restaurar Padrão
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---- Reusable Components ----
function SectionHeader({
  icon,
  color,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  subtitle: string;
}) {
  const colorMap: Record<string, string> = {
    violet: "bg-violet-600/20 border-violet-500/30 text-violet-400",
    blue: "bg-blue-600/20 border-blue-500/30 text-blue-400",
    emerald: "bg-emerald-600/20 border-emerald-500/30 text-emerald-400",
    amber: "bg-amber-600/20 border-amber-500/30 text-amber-400",
    red: "bg-red-600/20 border-red-500/30 text-red-400",
  };
  return (
    <div className="flex items-center gap-3 mb-5 border-b border-border pb-4">
      <div className={`flex items-center justify-center w-9 h-9 rounded-xl border ${colorMap[color] || colorMap.violet}`}>
        {icon}
      </div>
      <div>
        <h3 className="font-bold text-sm text-primary">{title}</h3>
        <p className="text-xs text-tertiary">{subtitle}</p>
      </div>
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
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-xs font-semibold text-primary">{label}</p>
        <p className="text-[11px] text-tertiary">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
