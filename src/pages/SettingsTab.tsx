// ============================================================
// Esfera v3 — Settings Tab (UI/UX Refatorado)
// Configurações da Empresa, IA, Dispatch, ADB e Segurança
// Layout com Menu Lateral Interno e Espaçamento Aprimorado
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

type SettingsSection = "geral" | "notificacoes" | "adb" | "dispatch" | "ia" | "hub" | "seguranca";

export default function SettingsTab() {
  const { selectedCompanyId } = useAuth();
  
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
      setHubStatus("Configurações salvas. Reinicie o app para aplicar alterações.");
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

  const menuItems = [
    { id: "geral", label: "Informações Gerais", icon: <Globe size={18} /> },
    { id: "notificacoes", label: "Notificações", icon: <Bell size={18} /> },
    { id: "adb", label: "Rede & ADB", icon: <Smartphone size={18} /> },
    { id: "dispatch", label: "Motor de Disparos", icon: <Zap size={18} /> },
    { id: "ia", label: "Inteligência Artificial", icon: <Brain size={18} /> },
    { id: "hub", label: "Conexão Hub", icon: <Wifi size={18} /> },
    { id: "seguranca", label: "Segurança", icon: <Shield size={18} /> },
  ] as const;

  return (
    <div className="flex flex-col h-full space-y-6 animate-fade-in max-w-6xl mx-auto">
      {/* Header Superior */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-primary tracking-tight">Configurações do Sistema</h2>
          <p className="text-sm text-tertiary mt-1">
            Personalize preferências, parâmetros de envio, IA e segurança.
          </p>
        </div>
        <Button icon={<Save size={18} />} onClick={handleSaveAll} className="px-6 py-2.5">
          Salvar Alterações
        </Button>
      </div>

      <div className="flex flex-col md:flex-row gap-8 items-start">
        {/* Menu Lateral Esquerdo */}
        <aside className="w-full md:w-64 shrink-0 glass-panel p-4 rounded-2xl flex flex-col gap-1">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id as SettingsSection)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                activeSection === item.id
                  ? "bg-violet-600/20 text-violet-400 border border-violet-500/30"
                  : "text-tertiary hover:bg-white/5 hover:text-primary"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </aside>

        {/* Área de Conteúdo (Direita) */}
        <main className="flex-1 w-full">
          <Card className="p-8">
            {activeSection === "geral" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Globe size={24} />} color="violet" title="Informações Gerais" subtitle="Identificação da empresa e fuso horário" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Nome da Empresa</label>
                    <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="w-full input-setting" />
                  </div>
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Fuso Horário</label>
                    <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full input-setting">
                      <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
                      <option value="America/Manaus">América/Manaus (GMT-4)</option>
                      <option value="America/Fortaleza">América/Fortaleza (GMT-3)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeSection === "notificacoes" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Bell size={24} />} color="blue" title="Notificações & Alertas" subtitle="Alertas visuais e sonoros do sistema" />
                <div className="space-y-6 max-w-2xl">
                  <ToggleRow label="Alertas do Sistema" desc="Receber avisos quando dispositivos desconectarem ou apresentarem falhas" checked={notifications} onChange={setNotifications} />
                  <ToggleRow label="Alerta de Bateria Baixa" desc="Notificar visualmente caso a bateria do celular fique abaixo de 20%" checked={batteryAlert} onChange={setBatteryAlert} />
                  <ToggleRow label="Alerta de Ban Detectado" desc="Sinalizar imediatamente quando a operadora banir o chip" checked={banAlert} onChange={setBanAlert} />
                  <ToggleRow label="Alerta de Conclusão de Disparo" desc="Avisar assim que a fila de envios de uma campanha for zerada" checked={dispatchAlert} onChange={setDispatchAlert} />
                </div>
              </div>
            )}

            {activeSection === "adb" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Smartphone size={24} />} color="emerald" title="Conexão ADB & Redes" subtitle="Parâmetros de comunicação wireless com celulares" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <ToggleRow label="Reconexão Automática" desc="O servidor tentará reconectar aparelhos caídos em segundo plano" checked={autoReconnect} onChange={setAutoReconnect} />
                  
                  <div className="flex gap-8">
                    <div className="w-40">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Intervalo Ping (s)</label>
                      <input type="number" value={pingInterval} onChange={(e) => setPingInterval(parseInt(e.target.value) || 30)} min={5} max={300} className="w-full input-setting font-mono text-lg text-center" />
                    </div>
                    <div className="w-40">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Max Tentativas</label>
                      <input type="number" value={maxRetries} onChange={(e) => setMaxRetries(parseInt(e.target.value) || 3)} min={1} max={10} className="w-full input-setting font-mono text-lg text-center" />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">PIN de Desbloqueio (opcional)</label>
                    <input type="password" value={unlockPin} onChange={(e) => setUnlockPin(e.target.value)} placeholder="Ex: 1234" className="w-48 input-setting font-mono text-lg tracking-widest" />
                  </div>
                </div>
              </div>
            )}

            {activeSection === "dispatch" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Zap size={24} />} color="amber" title="Motor de Disparos" subtitle="Regras, delays e humanização dos envios" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <div className="flex gap-8 p-4 bg-amber-500/5 rounded-xl border border-amber-500/10">
                    <div className="flex-1">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Delay Mínimo (segundos)</label>
                      <input type="number" value={delayMin} onChange={(e) => setDelayMin(parseInt(e.target.value) || 30)} min={5} max={300} className="w-32 input-setting font-mono text-center text-lg" />
                    </div>
                    <div className="flex-1">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Delay Máximo (segundos)</label>
                      <input type="number" value={delayMax} onChange={(e) => setDelayMax(parseInt(e.target.value) || 90)} min={10} max={600} className="w-32 input-setting font-mono text-center text-lg" />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Contatos por Lote (Batch Size)</label>
                    <input type="number" value={batchSize} onChange={(e) => setBatchSize(parseInt(e.target.value) || 5)} min={1} max={50} className="w-32 input-setting font-mono text-center text-lg" />
                  </div>

                  <div className="pt-4 space-y-6 border-t border-border">
                    <ToggleRow label="Humanização de Delay" desc="Usar distribuição Gaussiana em vez de atrasos lineares para evitar bloqueios" checked={humanizeDelay} onChange={setHumanizeDelay} />
                    <ToggleRow label="Retry Automático em Falha" desc="Se o ADB falhar no toque da tela, tentar o mesmo contato novamente" checked={retryOnFail} onChange={setRetryOnFail} />
                    
                    {retryOnFail && (
                      <div className="pl-6 ml-4 border-l-2 border-amber-500/30">
                        <label className="block font-semibold text-secondary mb-2 text-sm">Máximo de Retries por Contato</label>
                        <input type="number" value={maxRetriesDispatch} onChange={(e) => setMaxRetriesDispatch(parseInt(e.target.value) || 2)} min={1} max={5} className="w-24 input-setting font-mono text-center" />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSection === "ia" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Brain size={24} />} color="violet" title="Inteligência Artificial" subtitle="Modelos, prompts e personalização do LLM" />
                <div className="space-y-6 text-sm max-w-3xl">
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Provedor de LLM</label>
                    <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className="w-64 input-setting">
                      <option value="ollama_local">Ollama Local (Offline)</option>
                      <option value="ollama_cloud">Ollama Servidor Nuvem</option>
                      <option value="openai">OpenAI (ChatGPT)</option>
                      <option value="anthropic">Anthropic (Claude)</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Endpoint URL</label>
                    <input type="text" value={aiEndpoint} onChange={(e) => setAiEndpoint(e.target.value)} className="w-full input-setting font-mono" />
                  </div>

                  <div className="flex flex-col sm:flex-row gap-6">
                    <div className="flex-1">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Modelo Desejado</label>
                      <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="llama3.2" className="w-full input-setting font-mono" />
                    </div>
                    <div className="w-48 shrink-0">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Temperatura ({aiTemperature})</label>
                      <input type="range" min="0" max="1" step="0.1" value={aiTemperature} onChange={(e) => setAiTemperature(parseFloat(e.target.value))} className="w-full mt-3 accent-violet-500 cursor-pointer" />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">API Key (Token de Autorização)</label>
                    <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." className="w-full input-setting font-mono tracking-widest" />
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">System Prompt Base</label>
                    <textarea value={aiSystemPrompt} onChange={(e) => setAiSystemPrompt(e.target.value)} rows={5} className="w-full input-setting resize-none leading-relaxed" />
                  </div>

                  <div className="flex items-center gap-4 pt-4 border-t border-border">
                    <Button size="md" variant="secondary" icon={<RotateCcw size={16} />} onClick={handleTestAI}>
                      Testar Comunicação IA
                    </Button>
                    {aiTestResult && (
                      <div className="flex-1 p-3 rounded-xl bg-violet-600/10 border border-violet-500/20 text-violet-200 text-sm font-mono break-words leading-relaxed">
                        {aiTestResult}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSection === "hub" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Wifi size={24} />} color="blue" title="Conexão Hub & Cluster" subtitle="Topologia de rede local e remota" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Modo de Operação</label>
                    <select value={appMode} onChange={(e) => setAppMode(e.target.value as "local" | "empresa" | "master")} className="w-full input-setting">
                      <option value="local">Modo Standalone (Offline / Local apenas)</option>
                      <option value="empresa">Modo Empresa (Conecta ao Hub + LAN)</option>
                      <option value="master">Modo Master (Controle Administrativo Remoto)</option>
                    </select>
                  </div>

                  {appMode !== "local" && (
                    <div className="space-y-6 pt-4 border-t border-border">
                      <div>
                        <label className="block font-semibold text-secondary mb-2 text-sm">Endereço do Servidor Hub (IP:Porta)</label>
                        <input type="text" value={hubAddress} onChange={(e) => setHubAddress(e.target.value)} placeholder="192.168.1.100:8888" className="w-full max-w-sm input-setting font-mono" />
                      </div>
                      <ToggleRow label="Habilitar Conexão Contínua" desc="Manter heartbeat em tempo real com o servidor central" checked={hubEnabled} onChange={setHubEnabled} />
                    </div>
                  )}

                  {appMode === "empresa" && (
                    <div className="space-y-6 pt-4 border-t border-border">
                      <ToggleRow label="Ativar Servidor LAN Interno" desc="Permite que colaboradores na rede Wi-Fi local acessem o painel via navegador web" checked={empresaServerEnabled} onChange={setEmpresaServerEnabled} />
                      {empresaServerEnabled && (
                        <div className="pl-6 ml-4 border-l-2 border-blue-500/30">
                          <label className="block font-semibold text-secondary mb-2 text-sm">Porta de Acesso (Servidor Web)</label>
                          <input type="number" value={empresaServerPort} onChange={(e) => setEmpresaServerPort(parseInt(e.target.value) || 7777)} min={1024} max={65535} className="w-32 input-setting font-mono text-center" />
                        </div>
                      )}
                    </div>
                  )}

                  {hubStatus && (
                    <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl text-sm font-medium mt-6">
                      {hubStatus}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSection === "seguranca" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Shield size={24} />} color="emerald" title="Segurança & Backup" subtitle="Proteção de dados e retenção de registros" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <ToggleRow label="Backup Automático Diário" desc="Salvar cópia de segurança (snapshot) local do banco de dados todo fim de dia" checked={autoBackup} onChange={setAutoBackup} />
                  
                  <div className="flex gap-8">
                    <div className="w-48">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Retenção de Logs (Dias)</label>
                      <select value={logRetention} onChange={(e) => setLogRetention(e.target.value)} className="w-full input-setting">
                        <option value="7">7 dias (Mais Leve)</option>
                        <option value="15">15 dias</option>
                        <option value="30">30 dias (Padrão)</option>
                        <option value="90">90 dias</option>
                      </select>
                    </div>
                    <div className="w-48">
                      <label className="block font-semibold text-secondary mb-2 text-sm">Timeout de Sessão (min)</label>
                      <input type="number" value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)} min={15} max={480} className="w-full input-setting text-center font-mono" />
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pt-6 mt-4 border-t border-border">
                    <Button variant="secondary" size="md" icon={<Database size={16} />}>
                      Exportar Backup Agora
                    </Button>
                    <Button variant="danger" size="md" icon={<RefreshCw size={16} />}>
                      Restaurar de Padrão
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </main>
      </div>
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
    <div className="flex items-center gap-4 mb-2 pb-4">
      <div className={`flex items-center justify-center w-12 h-12 rounded-xl border ${colorMap[color] || colorMap.violet}`}>
        {icon}
      </div>
      <div>
        <h3 className="text-xl font-bold text-primary">{title}</h3>
        <p className="text-sm text-tertiary mt-0.5">{subtitle}</p>
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
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] -mx-4 px-4 rounded-xl transition-colors">
      <div className="pr-6">
        <p className="text-base font-semibold text-primary mb-1">{label}</p>
        <p className="text-sm text-tertiary leading-snug">{desc}</p>
      </div>
      <div className="shrink-0 scale-110">
        <Toggle checked={checked} onChange={onChange} />
      </div>
    </div>
  );
}
