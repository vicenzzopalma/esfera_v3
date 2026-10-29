// ============================================================
// Esfera v3 — Configurações
// Configurações: empresa, notificações, ADB, conexão, IA e segurança
// ============================================================

import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import PageHeader from "../components/ui/PageHeader";
import Field, { FormSection } from "../components/ui/Field";
import { api, setAppMode as setTauriAppMode, reloadConfig } from "../tauri";
import type { AppConfig, AiConfig } from "../types";
import { AI_PROVIDERS, getAiProviderInfo } from "../constants/aiProviders";
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
} from "lucide-react";

type SettingsSection = "geral" | "notificacoes" | "adb" | "hub" | "ia" | "integracoes" | "seguranca";

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
  const [hubAddress, setHubAddress] = useState("127.0.0.1:8555");
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
  const [aiProvider, setAiProvider] = useState("openrouter");
  const [aiModel, setAiModel] = useState("openrouter/free");
  const [aiTemperature, setAiTemperature] = useState("0.7");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiEndpoint, setAiEndpoint] = useState("https://openrouter.ai/api/v1/chat/completions");
  const [savedProviderKeys, setSavedProviderKeys] = useState<Record<string, { apiKey: string; endpoint: string; model: string }>>({});
  const [aiStatus, setAiStatus] = useState("");
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; text: string } | null>(null);

  // Load app config
  useEffect(() => {
    let mounted = true;
    api<AppConfig>("get_app_config")
      .then((cfg) => {
        if (!mounted || !cfg) return;
        setHubEnabled(cfg.hub_enabled);
        setHubAddress(cfg.hub_address || "127.0.0.1:8555");
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
      api<AiConfig | null>("get_ai_config", { companyId: selectedCompanyId })
        .then((cfg) => {
          if (!mounted || !cfg) return;
          setAiProvider(cfg.provider || "openrouter");
          setAiModel(cfg.model || "openrouter/free");
          setAiTemperature(String(cfg.temperature ?? 0.7));
          setAiSystemPrompt(cfg.systemPrompt || "");
          setAiApiKey(cfg.apiKey || "");
          setAiEndpoint(cfg.endpoint || "https://openrouter.ai/api/v1/chat/completions");
        })
        .catch(() => {});

      api<Record<string, { apiKey: string; endpoint: string; model: string }>>("get_ai_provider_keys", { companyId: selectedCompanyId })
        .then((keys) => {
          if (mounted && keys) {
            setSavedProviderKeys(keys);
          }
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
          companyId: selectedCompanyId,
          provider: aiProvider,
          model: aiModel,
          temperature: parseFloat(aiTemperature) || 0.7,
          systemPrompt: aiSystemPrompt,
          apiKey: aiApiKey,
          endpoint: aiEndpoint,
        },
      });
      setSavedProviderKeys((prev) => ({
        ...prev,
        [aiProvider]: { apiKey: aiApiKey, endpoint: aiEndpoint, model: aiModel },
      }));
      setAiStatus("Configuração de IA salva com sucesso!");
    } catch (e) {
      setAiStatus(`Falha ao salvar configuração de IA: ${String(e)}`);
    }
  };

  const handleTestAi = async () => {
    if (!selectedCompanyId) return;
    setTestingAi(true);
    setAiTestResult(null);
    try {
      const rewritten = await api<string>("rewrite_message_ai", {
        message: "Olá {nome}! Notamos uma pendência em aberto de R$ 150,00. Pague pelo PIX financeiro@empresa.com ou acesse https://empresa.com/fatura",
        contactName: "Lucas Silva",
        companyId: selectedCompanyId,
        provider: aiProvider,
        model: aiModel,
        prompt: aiSystemPrompt,
        apiKey: aiApiKey,
        endpoint: aiEndpoint,
      });
      setAiTestResult({ success: true, text: rewritten });
    } catch (err) {
      setAiTestResult({ success: false, text: String(err) });
    } finally {
      setTestingAi(false);
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
        actions={
          <Button icon={<Save size={15} />} onClick={handleSaveAll}>
            Salvar alterações
          </Button>
        }
      />

      {hubStatus && <StatusBanner error={hubStatusIsError} message={hubStatus} onClose={() => setHubStatus("")} />}

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
                <FormSection title="Modo de operação" description="Define onde os dados e aparelhos são gerenciados.">
                  <div className="max-w-xl">
                    <Field label="Modo" htmlFor="set-mode">
                      <select id="set-mode" value={appMode} onChange={(e) => setAppMode(e.target.value as "local" | "empresa" | "master")}>
                        <option value="empresa">Empresa (conecta ao hub na nuvem)</option>
                        <option value="local">Local (somente esta máquina)</option>
                        <option value="master">Master (administração remota)</option>
                      </select>
                    </Field>
                  </div>
                </FormSection>

                {(appMode === "empresa" || appMode === "master" || isMasterUser) && (
                  <FormSection title="Hub" description="Endereço e credenciais do servidor central.">
                    <div className="space-y-4 max-w-xl">
                      <Field label="Endereço do hub" htmlFor="set-hub-addr">
                        {!customIpOverride ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-3 py-2">
                            <span className="flex items-center gap-2 font-mono text-[0.8125rem] text-primary">
                              <span className="h-2 w-2 rounded-full bg-emerald-400" />
                              {hubAddress || "127.0.0.1:8555"}
                              <span className="font-sans text-xs text-tertiary">(padrão local)</span>
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
                              placeholder="127.0.0.1:8555"
                              className="flex-1 font-mono"
                            />
                            <Button
                              variant="secondary"
                              type="button"
                              onClick={() => {
                                setHubAddress("127.0.0.1:8555");
                                setCustomIpOverride(false);
                              }}
                            >
                              Restaurar padrão
                            </Button>
                          </div>
                        )}
                      </Field>

                      <ToggleRow label="Conexão contínua" desc="Mantém sinal de vida em tempo real com o servidor central." checked={hubEnabled} onChange={setHubEnabled} />

                      {(appMode === "master" || appMode === "empresa") && (
                        <>
                          <Field
                            label={appMode === "master" ? "Token do hub (master)" : "Token da empresa"}
                            hint={
                              appMode === "master"
                                ? "Deve ser o mesmo token mestre configurado no servidor."
                                : "Sem o token, os celulares remotos não aparecem."
                            }
                            htmlFor="set-hub-token"
                          >
                            <SecretInput id="set-hub-token" value={hubToken} onChange={setHubToken} placeholder="Cole o token" />
                          </Field>

                          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[0.8125rem] font-medium text-primary">Atualizar servidor</p>
                              <p className="text-xs text-tertiary">Envie o executável do hub para atualizar o servidor remoto.</p>
                              {updateVpsMsg && (
                                <p className="mt-1 text-xs text-secondary break-words">{updateVpsMsg}</p>
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
                              {updatingVps ? "Atualizando..." : "Escolher arquivo"}
                            </Button>
                            <input ref={fileInputRef} type="file" accept=".exe" className="hidden" onChange={handleVpsFile} />
                          </div>
                        </>
                      )}
                    </div>
                  </FormSection>
                )}

                <FormSection title="Servidores locais" description="Acesso pela rede interna e conexão de aparelhos remotos.">
                  <div className="max-w-xl divide-y divide-border">
                    {appMode === "empresa" && (
                      <div className="pb-3">
                        <ToggleRow label="Servidor na rede local" desc="Permite que colaboradores na mesma rede acessem o painel pelo navegador." checked={empresaServerEnabled} onChange={setEmpresaServerEnabled} />
                        {empresaServerEnabled && (
                          <div className="mt-2 w-40">
                            <Field label="Porta" htmlFor="set-lan-port">
                              <input id="set-lan-port" type="number" value={empresaServerPort} onChange={(e) => setEmpresaServerPort(parseInt(e.target.value) || 7777)} min={1024} max={65535} className="font-mono" />
                            </Field>
                          </div>
                        )}
                      </div>
                    )}
                    <div className={appMode === "empresa" ? "pt-3" : ""}>
                      <ToggleRow label="Túnel reverso de aparelhos" desc="Recebe os aparelhos atrás de NAT ou 4G para mantê-los acessíveis via ADB." checked={tunnelServerEnabled} onChange={setTunnelServerEnabled} />
                      {tunnelServerEnabled && (
                        <div className="mt-2 w-40">
                          <Field label="Porta do túnel" hint="Aponte os aparelhos para IP:porta desta máquina ao instalar o agente." htmlFor="set-tunnel-port">
                            <input id="set-tunnel-port" type="number" value={tunnelServerPort} onChange={(e) => setTunnelServerPort(parseInt(e.target.value) || 8888)} min={1024} max={65535} className="font-mono" />
                          </Field>
                        </div>
                      )}
                    </div>
                  </div>
                </FormSection>
              </div>
            )}

            {activeSection === "ia" && (
              <FormSection title="Inteligência artificial" description="Provedor usado para reescrever mensagens e variar o texto dos disparos.">
                <div className="space-y-4 max-w-xl">
                  <Field label="Provedor" htmlFor="set-ai-provider">
                    <select
                      id="set-ai-provider"
                      value={aiProvider}
                      onChange={(e) => {
                        const next = e.target.value;
                        setAiProvider(next);
                        const pInfo = getAiProviderInfo(next);
                        if (savedProviderKeys[next]) {
                          setAiEndpoint(savedProviderKeys[next].endpoint || pInfo?.defaultEndpoint || "");
                          setAiModel(savedProviderKeys[next].model || pInfo?.defaultModel || "");
                          setAiApiKey(savedProviderKeys[next].apiKey || "");
                        } else if (pInfo) {
                          setAiEndpoint(pInfo.defaultEndpoint);
                          setAiModel(pInfo.defaultModel);
                          setAiApiKey("");
                        }
                      }}
                    >
                      <optgroup label="Nuvem gratuita">
                        {AI_PROVIDERS.filter((p) => p.category === "cloud_free").map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Local (offline)">
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

                  <Field label="Modelo" htmlFor="set-ai-model">
                    <input
                      id="set-ai-model"
                      type="text"
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      placeholder="openai/gpt-oss-120b"
                      className="font-mono"
                    />
                    {providerInfo && providerInfo.suggestedModels.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {providerInfo.suggestedModels.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setAiModel(m.id)}
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

                  <Field label="Endereço da API" htmlFor="set-ai-endpoint">
                    <input id="set-ai-endpoint" type="text" value={aiEndpoint} onChange={(e) => setAiEndpoint(e.target.value)} placeholder="https://openrouter.ai/api/v1/chat/completions" className="font-mono" />
                  </Field>

                  {aiProvider !== "ollama" && aiProvider !== "lmstudio" && (
                    <Field label="Chave de API" hint={providerInfo?.keyHint} htmlFor="set-ai-key">
                      <SecretInput id="set-ai-key" value={aiApiKey} onChange={setAiApiKey} placeholder={providerInfo?.keyPlaceholder || "sk-..."} />
                    </Field>
                  )}

                  <div className="w-40">
                    <Field label="Criatividade" hint="De 0 (preciso) a 1 (criativo)." htmlFor="set-ai-temp">
                      <input id="set-ai-temp" type="number" step="0.05" min="0" max="1" value={aiTemperature} onChange={(e) => setAiTemperature(e.target.value)} className="font-mono" />
                    </Field>
                  </div>

                  <Field label="Instruções para a IA" hint="Regras de redação aplicadas a todas as mensagens." htmlFor="set-ai-prompt">
                    <textarea id="set-ai-prompt" value={aiSystemPrompt} onChange={(e) => setAiSystemPrompt(e.target.value)} rows={4} placeholder="Você é um assistente especialista em redação de mensagens para WhatsApp. Seja natural, humano e nunca invente informações." className="resize-none" />
                  </Field>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button icon={<Save size={15} />} onClick={handleSaveAi}>
                      Salvar IA
                    </Button>
                    <Button variant="secondary" icon={<Play size={14} />} loading={testingAi} onClick={handleTestAi}>
                      {testingAi ? "Testando..." : "Testar conexão"}
                    </Button>
                  </div>

                  {aiTestResult && (
                    <div
                      className={`rounded-lg border p-3 text-[0.8125rem] space-y-1 ${
                        aiTestResult.success
                          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {aiTestResult.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                        {aiTestResult.success ? "Teste concluído" : "Falha no teste"}
                      </div>
                      <p className="whitespace-pre-wrap text-xs text-secondary">{aiTestResult.text}</p>
                    </div>
                  )}

                  {aiStatus && <StatusBanner error={aiStatusIsError} message={aiStatus} onClose={() => setAiStatus("")} />}

                  <p className="text-xs text-tertiary">
                    O Spintax é resolvido no criador de campanhas. Combine Spintax com um modelo gratuito ou local para variar as mensagens sem custo.
                  </p>
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
function StatusBanner({ error, message, onClose }: { error: boolean; message: string; onClose: () => void }) {
  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[0.8125rem] ${
        error ? "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
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
        {/* Cartão Gemini Web (Login Google) */}
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium text-primary">Gemini Web (Conta Google — Sem Chave de API)</p>
              <p className="text-[0.75rem] text-tertiary">
                Usa o navegador padrão do sistema (Microsoft Edge) com perfil dedicado do Esfera para reescrever mensagens gratuitamente no site do Gemini, logo após o Groq na cadeia de reserva.
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
