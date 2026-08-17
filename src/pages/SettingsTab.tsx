// ============================================================
// Esfera v3 — Settings Tab (UI/UX Refatorado)
// Configurações da Empresa, IA, Dispatch, ADB e Segurança
// Layout com Menu Lateral Interno e Espaçamento Aprimorado
// ============================================================

import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import { api, setAppMode as setTauriAppMode, reloadConfig } from "../tauri";
import type { AppConfig } from "../types";
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
} from "lucide-react";

type SettingsSection = "geral" | "notificacoes" | "adb" | "hub" | "ia" | "seguranca";

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
  const [hubEnabled, setHubEnabled] = useState(true);
  const [hubAddress, setHubAddress] = useState("34.29.70.113:8555");
  const [hubToken, setHubToken] = useState("");
  const [customIpOverride, setCustomIpOverride] = useState(false);
  const [empresaServerEnabled, setEmpresaServerEnabled] = useState(false);
  const [empresaServerPort, setEmpresaServerPort] = useState(7777);
  const [tunnelServerEnabled, setTunnelServerEnabled] = useState(false);
  const [tunnelServerPort, setTunnelServerPort] = useState(8888);
  const [appMode, setAppMode] = useState<"local" | "empresa" | "master">("empresa");
  const [hubStatus, setHubStatus] = useState("");
  // Atualizar VPS (self-update remoto, sem SSH) — master only
  const [updatingVps, setUpdatingVps] = useState(false);
  const [updateVpsMsg, setUpdateVpsMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // IA / LLM local
  const [aiProvider, setAiProvider] = useState("ollama");
  const [aiModel, setAiModel] = useState("llama3");
  const [aiTemperature, setAiTemperature] = useState("0.7");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiEndpoint, setAiEndpoint] = useState("http://localhost:11434/api/generate");
  const [aiStatus, setAiStatus] = useState("");

  // Load app config
  useEffect(() => {
    let mounted = true;
    api<AppConfig>("get_app_config")
      .then((cfg) => {
        if (!mounted || !cfg) return;
        setHubEnabled(cfg.hub_enabled);
        setHubAddress(cfg.hub_address || "34.29.70.113:8555");
        setHubToken(cfg.hub_token || "");
        setEmpresaServerEnabled(cfg.empresa_server_enabled);
        setEmpresaServerPort(cfg.empresa_server_port || 7777);
        setTunnelServerEnabled(cfg.tunnel_server_enabled ?? false);
        setTunnelServerPort(cfg.tunnel_server_port ?? 8888);
        setAppMode(cfg.mode || "empresa");
      })
      .catch((err) => {
        console.error("Erro ao carregar app_config:", err);
      });
    if (selectedCompanyId) {
      api<import("../types").AiConfig | null>("get_ai_config", { company_id: selectedCompanyId })
        .then((cfg) => {
          if (!mounted || !cfg) return;
          setAiProvider(cfg.provider || "ollama");
          setAiModel(cfg.model || "llama3");
          setAiTemperature(String(cfg.temperature ?? 0.7));
          setAiSystemPrompt(cfg.systemPrompt || "");
          setAiApiKey(cfg.apiKey || "");
          setAiEndpoint(cfg.endpoint || "http://localhost:11434/api/generate");
        })
        .catch(() => {});
    }
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  const handleSaveAi = async () => {
    if (!selectedCompanyId) return;
    try {
      await api("save_ai_config", {
        config: {
          company_id: selectedCompanyId,
          provider: aiProvider,
          model: aiModel,
          temperature: parseFloat(aiTemperature) || 0.7,
          system_prompt: aiSystemPrompt,
          api_key: aiApiKey,
          endpoint: aiEndpoint,
        },
      });
      setAiStatus("Configuração de IA salva com sucesso!");
    } catch {
      setAiStatus("Falha ao salvar configuração de IA.");
    }
  };

  const handleSaveAll = async () => {
    try {
      const payload: AppConfig = {
        hub_enabled: hubEnabled,
        hub_address: hubAddress,
        hub_token: hubToken,
        empresa_server_enabled: empresaServerEnabled,
        empresa_server_port: empresaServerPort,
        checkin_server_enabled: true,
        checkin_server_port: 8080,
        tunnel_server_enabled: tunnelServerEnabled,
        tunnel_server_port: tunnelServerPort,
        mode: appMode,
      };
      await api("save_app_config", { config: payload, ...payload });
      setTauriAppMode(appMode);
      reloadConfig();
      setHubStatus("Configurações salvas com sucesso!");
    } catch (err: any) {
      setHubStatus("Erro ao salvar configurações: " + (err?.message || String(err)));
    }
  };

  // Atualizar VPS (self-update remoto do hub-standalone) — master only
  const handleUpdateVpsClick = () => {
    fileInputRef.current?.click();
  };
  const handleVpsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUpdatingVps(true);
    setUpdateVpsMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const res = await api<string>("update_vps_hub", { base64_bin: b64 });
      setUpdateVpsMsg(res || "VPS atualizado.");
    } catch (err: any) {
      setUpdateVpsMsg("Erro: " + (err?.message || err));
    } finally {
      setUpdatingVps(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const menuItems = [
    { id: "geral", label: "Informações Gerais", icon: <Globe size={18} /> },
    { id: "notificacoes", label: "Notificações", icon: <Bell size={18} /> },
    { id: "adb", label: "Rede & ADB", icon: <Smartphone size={18} /> },
    { id: "hub", label: "Conexão Hub Nuvem", icon: <Wifi size={18} /> },
    { id: "ia", label: "IA & Spintax Local", icon: <Sparkles size={18} /> },
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



            {activeSection === "hub" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Wifi size={24} />} color="blue" title="Conexão Hub Nuvem" subtitle="Topologia de rede local e remota" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Modo de Operação</label>
                    <select value={appMode} onChange={(e) => setAppMode(e.target.value as "local" | "empresa" | "master")} className="w-full input-setting">
                      <option value="empresa">Modo Empresa (Conecta ao Hub Nuvem VPS)</option>
                      <option value="local">Modo Standalone (Offline / Local apenas)</option>
                      <option value="master">Modo Master (Controle Administrativo Remoto)</option>
                    </select>
                  </div>

                  {(appMode === "empresa" || appMode === "master" || isMasterUser) && (
                    <div className="space-y-6 pt-4 border-t border-border">
                      <div>
                        <label className="block font-semibold text-secondary mb-2 text-sm">Servidor Hub Nuvem</label>
                        {!customIpOverride ? (
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-emerald-950/40 border border-emerald-500/30 rounded-xl">
                            <div className="flex items-center gap-2.5 text-emerald-300 font-mono text-sm font-bold">
                              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                              {hubAddress || "34.29.70.113:8555"} (VPS Oficial Fixa)
                            </div>
                            <button
                              type="button"
                              onClick={() => setCustomIpOverride(true)}
                              className="text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 px-3 py-1.5 rounded-lg transition-all font-medium cursor-pointer"
                            >
                              ⚠️ Alterar IP (Caso VPS Caia)
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={hubAddress}
                                onChange={(e) => setHubAddress(e.target.value)}
                                placeholder="34.29.70.113:8555"
                                className="flex-1 input-setting font-mono text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  setHubAddress("34.29.70.113:8555");
                                  setCustomIpOverride(false);
                                }}
                                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2.5 rounded-lg border border-slate-700 font-bold"
                              >
                                Restaurar VPS Oficial
                              </button>
                            </div>
                            <p className="text-[11px] text-amber-400 font-medium">
                              ⚠️ Altere este IP apenas se a VPS principal cair e for necessário redirecionar para um IP de contingência.
                            </p>
                          </div>
                        )}
                      </div>
                      <ToggleRow label="Habilitar Conexão Contínua" desc="Manter heartbeat em tempo real com o servidor central" checked={hubEnabled} onChange={setHubEnabled} />

                      {(appMode === "master" || appMode === "empresa") && (
                        <div className="space-y-2 pt-4 border-t border-border">
                          <label className="block font-semibold text-secondary mb-2 text-sm">
                            {appMode === "master" ? "Token do Hub (Master)" : "Token da Empresa (REALESS)"}
                          </label>
                          <input
                            type="password"
                            value={hubToken}
                            onChange={(e) => setHubToken(e.target.value)}
                            placeholder={appMode === "master" ? "root123" : "Ope@2025"}
                            className="w-full input-setting font-mono text-sm"
                          />
                          <p className="text-[11px] text-amber-400 font-medium">
                            {appMode === "master"
                              ? "Alinhe com HUB_MASTER_TOKEN da VPS (padrão: root123)."
                              : "Token da empresa REALESS (Ope@2025). Sem ele, os celulares remotos não aparecem."}
                          </p>
                          <div className="flex items-center gap-3 pt-2">
                            <button
                              type="button"
                              onClick={handleUpdateVpsClick}
                              disabled={updatingVps}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#5E6AD2]/15 border border-[#5E6AD2]/30 text-[12px] text-[#828DF7] hover:bg-[#5E6AD2]/25 transition-colors cursor-pointer disabled:opacity-50"
                              title="Selecione o esfera-hub-standalone.exe para atualizar o VPS remotamente"
                            >
                              <Cpu size={13} className="shrink-0" />
                              {updatingVps ? "Atualizando..." : "Atualizar VPS"}
                            </button>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept=".exe"
                              className="hidden"
                              onChange={handleVpsFile}
                            />
                            {updateVpsMsg && (
                              <span className="text-[11px] text-zinc-400 max-w-[220px] truncate" title={updateVpsMsg}>{updateVpsMsg}</span>
                            )}
                          </div>
                        </div>
                      )}
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

                  <div className="space-y-6 pt-4 border-t border-border">
                    <ToggleRow label="Túnel Inverso de Dispositivos" desc="Recebe daemons dos celulares (aparelhos atrás de NAT/4G) para mantê-los sempre acessíveis via ADB" checked={tunnelServerEnabled} onChange={setTunnelServerEnabled} />
                    {tunnelServerEnabled && (
                      <div className="pl-6 ml-4 border-l-2 border-violet-500/30">
                        <label className="block font-semibold text-secondary mb-2 text-sm">Porta do Túnel (daemons Android)</label>
                        <input type="number" value={tunnelServerPort} onChange={(e) => setTunnelServerPort(parseInt(e.target.value) || 8888)} min={1024} max={65535} className="w-32 input-setting font-mono text-center" />
                        <p className="text-[11px] text-violet-400 font-medium mt-1">
                          Os aparelhos devem apontar para IP:porta desta máquina no instalador do daemon (Instalar Daemon).
                        </p>
                      </div>
                    )}
                  </div>

                  {hubStatus && (
                    <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl text-sm font-medium mt-6">
                      {hubStatus}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSection === "ia" && (
              <div className="space-y-8 animate-fade-in">
                <SectionHeader icon={<Sparkles size={24} />} color="violet" title="IA & Spintax Local" subtitle="Modelos LLM locais (Ollama / Llama.cpp) e personalização de mensagens" />
                <div className="space-y-6 text-sm max-w-2xl">
                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Provedor</label>
                    <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className="w-full input-setting">
                      <option value="ollama">Ollama (Local — recomendado, zero custo)</option>
                      <option value="openai">OpenAI (API paga)</option>
                      <option value="anthropic">Anthropic (API paga)</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Modelo</label>
                    <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="llama3 / qwen2.5:1.5b / llama3.2:3b (Q4_K_M)" className="w-full input-setting font-mono" />
                    <p className="text-[11px] text-tertiary mt-1">Para inferência local, use um GGUF quantizado (ex.: Q4_K_M). Modelos sugeridos: Qwen2.5-1.5B-Instruct, Llama-3.2-3B-Instruct.</p>
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">Endpoint</label>
                    <input type="text" value={aiEndpoint} onChange={(e) => setAiEndpoint(e.target.value)} placeholder="http://localhost:11434/api/generate" className="w-full input-setting font-mono" />
                  </div>

                  <div className="w-48">
                    <label className="block font-semibold text-secondary mb-2 text-sm">Temperatura</label>
                    <input type="number" step="0.1" min="0" max="2" value={aiTemperature} onChange={(e) => setAiTemperature(e.target.value)} className="w-full input-setting font-mono text-center" />
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">System Prompt (opcional)</label>
                    <textarea value={aiSystemPrompt} onChange={(e) => setAiSystemPrompt(e.target.value)} rows={3} placeholder="Você é um assistente especialista em redação de mensagens para WhatsApp." className="w-full input-setting resize-none" />
                  </div>

                  <div>
                    <label className="block font-semibold text-secondary mb-2 text-sm">API Key (somente para OpenAI/Anthropic)</label>
                    <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." className="w-full input-setting font-mono" />
                  </div>

                  <div className="pt-2">
                    <Button icon={<Sparkles size={18} />} onClick={handleSaveAi} className="px-6 py-2.5">Salvar Configuração de IA</Button>
                  </div>

                  {aiStatus && (
                    <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl text-sm font-medium mt-2">
                      {aiStatus}
                    </div>
                  )}
                  <p className="text-[11px] text-tertiary">O Spintax é resolvido automaticamente no criador de campanhas (aba Campanhas → Simular Spintax). Combine Spintax + Ollama local para zero custo de API e conformidade LGPD.</p>
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
