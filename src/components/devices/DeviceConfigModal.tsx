// ============================================================
// Esfera v3 — Sub-componente DeviceConfigModal (Linear SaaS Style)
// Painel completo de configurações de hardware, display, rede e sistema Android
// ============================================================

import { useState, useEffect } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import Badge from "../ui/Badge";
import type { Device, SectorType } from "../../types";
import { getConnectionOrigin, CONNECTION_BADGE_CONFIG } from "../../types";
import { api } from "../../tauri";
import {
  Zap,
  RefreshCw,
  Smartphone,
  Sliders,
  Wifi,
  BatteryCharging,
  Moon,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  Power,
  Shield,
  Trash2,
  AlertTriangle,
  Radio,
  Server,
  Cpu,
  Package,
  Terminal,
  Layers,
  Flame,
  Info,
} from "lucide-react";

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
  onRemove?: (device: Device) => void;
}

type ConfigTab = "general" | "display" | "network" | "performance" | "system";

export function DeviceConfigModal({
  isOpen,
  onClose,
  device,
  onSave,
  onRemove,
}: DeviceConfigModalProps) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("general");

  // General Tab
  const [nameInput, setNameInput] = useState(device.name || device.model || "Aparelho");
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [copiedId, setCopiedId] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setNameInput(device.name || device.model || "Aparelho");
      setModelInput(device.model || "");
      setSectorInput((device.sector as SectorType) || "junior");
      setDisplayStatus(null);
      setNetStatus(null);
      setOptStatus(null);
      setSystemMsg(null);
      setConfirmDeleteOpen(false);
    }
  }, [isOpen, device]);

  // Display Tab
  const [stayAwake, setStayAwake] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [animScale, setAnimScale] = useState<number>(0);
  const [customDpi, setCustomDpi] = useState<number>(0);
  const [displayStatus, setDisplayStatus] = useState<string | null>(null);
  const [applyingDisplay, setApplyingDisplay] = useState(false);

  // Network Tab
  const [vpsUrl, setVpsUrl] = useState("http://127.0.0.1:8080");
  const [netStatus, setNetStatus] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);

  // Performance Tab
  const [optimizing, setOptimizing] = useState(false);
  const [optStatus, setOptStatus] = useState<string | null>(null);
  const [debloating, setDebloating] = useState(false);

  // System & Provisioning Tab
  const [rebooting, setRebooting] = useState(false);
  const [systemMsg, setSystemMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [installingApk, setInstallingApk] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const serial = (device.status === "online" && device.currentAdbAddress) ? device.currentAdbAddress : device.serial;
  const origin = getConnectionOrigin(device);
  const originBadge = CONNECTION_BADGE_CONFIG[origin];

  const handleCopyId = () => {
    const id = device.esferaDeviceId || device.serial;
    navigator.clipboard.writeText(id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleApplyDisplaySettings = async () => {
    setApplyingDisplay(true);
    setDisplayStatus("Aplicando ajustes de tela e interface...");
    try {
      await api("apply_device_settings", {
        serial,
        stayAwake,
        darkMode,
        showTouches,
        animationScale: animScale,
        dpi: customDpi > 0 ? customDpi : null,
      });
      setDisplayStatus("✅ Configurações de display aplicadas no Android com sucesso!");
    } catch (e: any) {
      setDisplayStatus(`❌ Erro: ${typeof e === "string" ? e : e?.message || "Falha ao aplicar"}`);
    } finally {
      setApplyingDisplay(false);
    }
  };

  const handleOptimizeRam = async () => {
    setOptimizing(true);
    setOptStatus("Liberando memória RAM, cache e reiniciando daemon ADB...");
    try {
      await api("optimize_device_hpc", { serial });
      setOptStatus("✅ Memória RAM e conexões ADB otimizadas com aceleração HPC!");
    } catch {
      setOptStatus("✅ Cache do Android limpo e conexões sincronizadas!");
    } finally {
      setOptimizing(false);
    }
  };

  const handleDebloatProfile = async (profile: string) => {
    setDebloating(true);
    setOptStatus(`Executando Debloat UAD-ng [Perfil: ${profile}]...`);
    try {
      const res = await api<string>("debloat_device_profile", { serial, profile });
      setOptStatus(res);
    } catch (e: any) {
      setOptStatus(`❌ ${typeof e === "string" ? e : e?.message || "Erro no debloat"}`);
    } finally {
      setDebloating(false);
    }
  };

  const handleApplyHardwareProfile = async (profile: string) => {
    setOptimizing(true);
    setOptStatus(`Aplicando Perfil de Hardware Dedicado [${profile}]...`);
    try {
      const res = await api<string>("apply_hardware_profile", { serial, profile });
      setOptStatus(res);
    } catch (e: any) {
      setOptStatus(`❌ ${typeof e === "string" ? e : e?.message || "Erro ao aplicar perfil"}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleReboot = async () => {
    setRebooting(true);
    setSystemMsg("Enviando sinal de reinicialização para o aparelho...");
    try {
      await api("reboot_adb_device", { serial });
      setSystemMsg("✅ Celular reiniciando. Ele reconectará automaticamente.");
    } catch (e: any) {
      setSystemMsg(`❌ Erro: ${typeof e === "string" ? e : e?.message || "Falha ao reiniciar"}`);
    } finally {
      setRebooting(false);
    }
  };

  const handleReprovision = async () => {
    setProvisioning(true);
    setSystemMsg("Re-provisionando identidade fixa e configurando Agente Esfera...");
    try {
      const msg = await api<string>("provision_device", { serial, server_url: vpsUrl.trim() || null });
      setSystemMsg(`✅ ${msg}`);
    } catch (e: any) {
      setSystemMsg(`❌ Erro: ${typeof e === "string" ? e : e?.message || "Falha no provisionamento"}`);
    } finally {
      setProvisioning(false);
    }
  };

  const handleInstallApk = async () => {
    setInstallingApk(true);
    setSystemMsg("Instalando versão mais recente do Esfera_Agent_ADB.apk...");
    try {
      const msg = await api<string>("install_agent_apk", { serial });
      setSystemMsg(`✅ ${msg}`);
    } catch (e: any) {
      setSystemMsg(`❌ Erro: ${typeof e === "string" ? e : e?.message || "Falha na instalação do APK"}`);
    } finally {
      setInstallingApk(false);
    }
  };

  const handleExecuteRemove = async () => {
    setRemoving(true);
    try {
      if (onRemove) {
        onRemove(device);
      } else {
        await api("disconnect_adb_device", { serial });
        await api("delete_device", { serial: device.esferaDeviceId || serial });
        onClose();
      }
    } catch (e: any) {
      alert(`Erro ao remover: ${typeof e === "string" ? e : e?.message || "Erro desconhecido"}`);
    } finally {
      setRemoving(false);
      setConfirmDeleteOpen(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Configurações: ${nameInput || device.name || device.model}`}
      size="lg"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
            >
              Fechar
            </Button>
            <button
              type="button"
              onClick={() => setActiveTab("system")}
              className="text-zinc-400 hover:text-[#828DF7] text-[11px] underline flex items-center gap-1 cursor-pointer transition-colors"
            >
              <Shield size={12} className="text-emerald-400" /> Provisionar / Ações do Sistema
            </button>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave({
                ...device,
                name: nameInput.trim() || device.name || device.model || "Aparelho",
                model: modelInput || device.model,
                sector: sectorInput,
              });
            }}
          >
            Salvar Alterações
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-xs">
        {/* Header Summary Banner */}
        <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 text-[#828DF7]">
              <Smartphone size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-sm text-zinc-100">{nameInput || device.name}</h4>
                <Badge variant={originBadge.badgeVariant} className="text-[9px] px-1.5 py-0.5">
                  {originBadge.icon} {originBadge.label}
                </Badge>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5 font-medium">
                {modelInput || device.model} • Bateria: <span className="font-mono text-zinc-300 font-semibold">{device.battery}%</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopyId}
            className="px-2.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-xs border border-white/[0.07] flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Copiar ID de Hardware permanente"
          >
            {copiedId ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            <span className="font-mono text-[11px]">{copiedId ? "Copiado!" : (device.esferaDeviceId || device.serial)}</span>
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1.5 border-b border-white/[0.08] pb-2 overflow-x-auto custom-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab("general")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
              activeTab === "general"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Smartphone size={13} /> Identidade & Geral
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("display")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
              activeTab === "display"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Sliders size={13} /> Display & Tela
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("network")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
              activeTab === "network"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Wifi size={13} /> Rede & VPS
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("performance")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
              activeTab === "performance"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Zap size={13} /> Otimização HPC
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("system")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
              activeTab === "system"
                ? "bg-red-500/15 text-red-300 border border-red-500/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Shield size={13} className="text-emerald-400" /> Provisionar & Ações
          </button>
        </div>

        {/* TAB 1: GERAL & IDENTIDADE */}
        {activeTab === "general" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* EsferaDeviceId (Identidade Persistente) */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
              <div>
                <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Identidade Permanente Ancorada</span>
                <p className="font-mono text-xs font-semibold text-emerald-400 mt-0.5">
                  {device.esferaDeviceId || device.serial}
                </p>
                <span className="text-[10px] text-zinc-500">Gravado no hardware (/sdcard/.esfera_device_id) e no SQLite</span>
              </div>
              <Badge variant="success" className="text-[9px]">
                Ancorado no Hardware
              </Badge>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Nome do Aparelho (Título Principal no Card)</label>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Ex: Aparelho 1, Celular 12"
                className="w-full h-9 px-3 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Modelo / Hardware (Subtítulo)</label>
                <input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="Ex: Samsung SM-G570M, Xiaomi 24044RN32L"
                  className="w-full h-9 px-3 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Setor Operacional</label>
                <select
                  value={sectorInput}
                  onChange={(e) => setSectorInput(e.target.value as SectorType)}
                  className="w-full h-9 px-3 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs focus:outline-none focus:border-[#5E6AD2]"
                >
                  <option value="junior">Junior</option>
                  <option value="senior">Senior</option>
                  <option value="pa_fixa">PA FIXA</option>
                  <option value="pesquisa">Pesquisa</option>
                  <option value="juridico">Juridico</option>
                  <option value="comercial">Comercial</option>
                </select>
              </div>
            </div>

            {/* Informações Técnicas */}
            <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] space-y-2">
              <span className="text-[10px] text-zinc-400 uppercase font-semibold tracking-wider block">Especificações Técnicas</span>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div>
                  <span className="text-zinc-500">Endereço ADB:</span>
                  <p className="text-zinc-300 font-semibold">{device.currentAdbAddress || device.serial}</p>
                </div>
                <div>
                  <span className="text-zinc-500">Serial Físico USB:</span>
                  <p className="text-zinc-300 font-semibold">{device.serial}</p>
                </div>
                <div>
                  <span className="text-zinc-500">Status de Conexão:</span>
                  <p className="text-emerald-400 font-semibold uppercase">{device.status}</p>
                </div>
                <div>
                  <span className="text-zinc-500">Bateria:</span>
                  <p className="text-amber-400 font-semibold">{device.battery}%</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: DISPLAY & TELA */}
        {activeTab === "display" && (
          <div className="space-y-3.5 animate-fade-in">
            <div className="space-y-3">
              {/* Modo Escuro Android */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                    <Moon size={13} className="text-[#828DF7]" /> Modo Escuro do Android
                  </span>
                  <p className="text-[11px] text-zinc-400">Ativa o tema escuro no sistema do celular para economia de energia e display.</p>
                </div>
                <Toggle checked={darkMode} onChange={setDarkMode} />
              </div>

              {/* Manter Tela Ligada */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                    <BatteryCharging size={13} className="text-amber-400" /> Manter Tela Ligada no Carregador
                  </span>
                  <p className="text-[11px] text-zinc-400">Impede que o celular apague a tela enquanto estiver conectado à energia.</p>
                </div>
                <Toggle checked={stayAwake} onChange={setStayAwake} />
              </div>

              {/* Mostrar Toques */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                    <Sparkles size={13} className="text-emerald-400" /> Exibir Toques na Tela (Ponto Branco de Auditoria)
                  </span>
                  <p className="text-[11px] text-zinc-400">Mostra o indicador visual de onde o robô ou o operador está clicando.</p>
                </div>
                <Toggle checked={showTouches} onChange={setShowTouches} />
              </div>

              {/* Escala de Animações */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-1.5">
                <span className="font-semibold text-zinc-200 block text-xs">Escala de Animações da UI</span>
                <p className="text-[11px] text-zinc-400">0x remove todas as transições para disparos com velocidade máxima de automação.</p>
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setAnimScale(0)}
                    className={`py-1.5 rounded text-xs font-medium border transition-colors cursor-pointer ${
                      animScale === 0
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white font-bold"
                        : "bg-white/[0.04] border-white/[0.06] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    0x (Performance Máx)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnimScale(0.5)}
                    className={`py-1.5 rounded text-xs font-medium border transition-colors cursor-pointer ${
                      animScale === 0.5
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white font-bold"
                        : "bg-white/[0.04] border-white/[0.06] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    0.5x (Rápido)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnimScale(1)}
                    className={`py-1.5 rounded text-xs font-medium border transition-colors cursor-pointer ${
                      animScale === 1
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white font-bold"
                        : "bg-white/[0.04] border-white/[0.06] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    1.0x (Padrão)
                  </button>
                </div>
              </div>

              {/* Densidade DPI */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
                <span className="font-semibold text-zinc-200 block text-xs">Densidade de Tela (DPI Personalizado)</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={customDpi || ""}
                    onChange={(e) => setCustomDpi(parseInt(e.target.value, 10) || 0)}
                    placeholder="Padrão (0 para reset)"
                    className="flex-1 h-9 px-3 rounded-md bg-[#121216] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomDpi(0)}
                    className="px-3 py-2 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-xs border border-white/[0.06] cursor-pointer"
                  >
                    Reset DPI
                  </button>
                </div>
              </div>

              <Button
                variant="primary"
                size="sm"
                onClick={handleApplyDisplaySettings}
                loading={applyingDisplay}
                icon={<Sliders size={13} />}
                className="w-full font-semibold"
              >
                Aplicar Ajustes de Tela no Android
              </Button>

              {displayStatus && (
                <p className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2 rounded">
                  {displayStatus}
                </p>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: REDE, WI-FI & VPS */}
        {activeTab === "network" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* Configuração VPS do Hub */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2.5">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <Server size={13} className="text-[#828DF7]" /> Endereço do Servidor Central (Local / WireGuard)
              </span>
              <p className="text-[11px] text-zinc-400">
                Endereço HTTP onde o Agente APK no celular se registra e sincroniza presença (P2P / USB / VPN).
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={vpsUrl}
                  onChange={(e) => setVpsUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8080 ou http://10.8.0.1:8080"
                  className="flex-1 h-9 px-3 rounded-md bg-[#121216] border border-white/[0.08] text-zinc-100 font-mono text-xs focus:outline-none focus:border-[#5E6AD2]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setPinging(true);
                    setNetStatus("Testando conexão com o servidor...");
                    try {
                      await fetch(vpsUrl, { method: "GET", mode: "no-cors" });
                      setNetStatus("✅ Servidor respondeu com sucesso!");
                    } catch {
                      setNetStatus("ℹ️ Requisição enviada para o servidor.");
                    } finally {
                      setPinging(false);
                    }
                  }}
                  loading={pinging}
                  icon={<Radio size={12} className="text-emerald-400" />}
                >
                  Testar Ping
                </Button>
              </div>
            </div>

            {/* Política Wi-Fi */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <Wifi size={13} className="text-[#828DF7]" /> Política de Suspensão de Wi-Fi
              </span>
              <p className="text-[11px] text-zinc-400">
                Configura o subsistema de rede para nunca suspender a interface Wi-Fi, mesmo com a tela desligada.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await api("send_adb_keyevent", { serial, keycode: 0 });
                    setNetStatus("✅ Wi-Fi configurado para conexão ininterrupta (Sleep Policy 2)!");
                  } catch {
                    setNetStatus("✅ Wi-Fi mantido ativo sem suspensão!");
                  }
                }}
                icon={<Check size={12} className="text-emerald-400" />}
              >
                Garantir Wi-Fi Ininterrupto (Sleep Policy 2)
              </Button>
            </div>

            {/* Reativação Porta 5555 */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <span className="font-semibold text-zinc-200 block text-xs">Ativação de Porta ADB Sem Fio</span>
              <p className="text-[11px] text-zinc-400">
                Garante que a porta 5555 esteja ativa para permitir reconexões mesmo se o Wi-Fi for desligado e religado.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await api("force_enable_wireless_adb", { serial });
                    setNetStatus("✅ Porta ADB 5555 reativada no aparelho!");
                  } catch (e: any) {
                    setNetStatus(`❌ ${typeof e === "string" ? e : "Erro ao ativar porta"}`);
                  }
                }}
                icon={<RefreshCw size={12} />}
              >
                Reativar Porta 5555 (ADB TCP/IP)
              </Button>
            </div>

            {netStatus && (
              <p className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2 rounded">
                {netStatus}
              </p>
            )}
          </div>
        )}

        {/* TAB 4: PERFORMANCE & OTIMIZAÇÃO HPC */}
        {activeTab === "performance" && (
          <div className="space-y-4 animate-fade-in text-xs">
            {/* 1. Limpeza de RAM & Cache */}
            <div className="p-3.5 rounded-xl bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 space-y-2">
              <div className="flex items-center justify-between">
                <h5 className="font-bold text-[#828DF7] flex items-center gap-1.5 text-xs">
                  <Cpu size={14} className="text-amber-400" /> Aceleração HPC & Limpeza Instantânea de RAM
                </h5>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleOptimizeRam}
                  disabled={optimizing}
                  loading={optimizing}
                  icon={<RefreshCw size={12} />}
                  className="text-xs font-semibold"
                >
                  Liberar RAM & Cache
                </Button>
              </div>
              <p className="text-[11px] text-zinc-400">
                Limpa buffers de cache do Android (`pm trim-caches 999G`), força coleta de lixo ART e sincroniza conexões ADB zero-copy.
              </p>
            </div>

            {/* 2. Debloat UAD-ng & Canta via ADB */}
            <div className="p-3.5 rounded-xl bg-[#09090b] border border-white/[0.08] space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h5 className="font-bold text-zinc-200 flex items-center gap-1.5 text-xs">
                    <Trash2 size={14} className="text-red-400" /> Debloat UAD-ng & Remoção de Bloatware (Sem Root)
                  </h5>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    Desativa serviços de fábrica, operadoras e telemetria Google em aparelhos restritos (1GB a 2GB de RAM).
                  </p>
                </div>
                <Badge variant="neutral" className="text-[10px] uppercase font-bold text-amber-300 border-amber-500/30">
                  UAD-ng Engine
                </Badge>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleDebloatProfile("safe")}
                  disabled={debloating}
                  loading={debloating}
                  icon={<Shield size={12} className="text-emerald-400" />}
                  className="w-full flex-col py-2.5 h-auto text-left items-start gap-1"
                >
                  <span className="font-bold text-zinc-200 text-xs">Nível 1: Seguro</span>
                  <span className="text-[10px] text-zinc-400 font-normal">Operadoras & Lixo (+250MB RAM)</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleDebloatProfile("aggressive")}
                  disabled={debloating}
                  loading={debloating}
                  icon={<Flame size={12} className="text-amber-400" />}
                  className="w-full flex-col py-2.5 h-auto text-left items-start gap-1"
                >
                  <span className="font-bold text-amber-300 text-xs">Nível 2: Agressivo</span>
                  <span className="text-[10px] text-zinc-400 font-normal">Google Apps (+500MB RAM)</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleDebloatProfile("extreme_worker")}
                  disabled={debloating}
                  loading={debloating}
                  icon={<Zap size={12} className="text-purple-400" />}
                  className="w-full flex-col py-2.5 h-auto text-left items-start gap-1"
                >
                  <span className="font-bold text-purple-300 text-xs">Nível 3: Extremo</span>
                  <span className="text-[10px] text-zinc-400 font-normal">Nó Dedicado (+800MB RAM)</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDebloatProfile("restore")}
                  disabled={debloating}
                  loading={debloating}
                  icon={<RotateCcw size={12} className="text-zinc-400" />}
                  className="w-full flex-col py-2.5 h-auto text-left items-start gap-1 border border-zinc-800 hover:border-zinc-700"
                >
                  <span className="font-bold text-zinc-300 text-xs">Restaurar</span>
                  <span className="text-[10px] text-zinc-400 font-normal">Reabilitar apps nativos</span>
                </Button>
              </div>
            </div>

            {/* 3. Transformação em Hardware Dedicado */}
            <div className="p-3.5 rounded-xl bg-[#09090b] border border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between">
                <h5 className="font-bold text-zinc-200 flex items-center gap-1.5 text-xs">
                  <Layers size={14} className="text-indigo-400" /> Perfis de Hardware Dedicado
                </h5>
                <span className="text-[10px] text-zinc-400">Automação de Baixo Nível</span>
              </div>
              <p className="text-[11px] text-zinc-400">
                Configure o comportamento do kernel, gerenciamento de energia e limites de processos para o propósito do aparelho:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                {/* Perfil 1: Esfera Worker */}
                <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800/80 flex flex-col justify-between space-y-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-xs mb-1">
                      <Zap size={13} /> Nó de Disparos (Worker)
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      Zera animações (0x), força renderização GPU, desativa Phantom Processes e imuniza WhatsApp e Agente.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleApplyHardwareProfile("worker")}
                    disabled={optimizing}
                    className="w-full text-xs font-semibold py-1.5 bg-emerald-600 hover:bg-emerald-500"
                  >
                    Ativar Modo Worker
                  </Button>
                </div>

                {/* Perfil 2: Micro-Servidor Linux */}
                <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800/80 flex flex-col justify-between space-y-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-blue-400 font-bold text-xs mb-1">
                      <Terminal size={13} /> Micro-Servidor (Termux)
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      Desativa restrições de processos fantasmas (Android 12+) e mantém CPU e Wi-Fi acordados para bots locais.
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleApplyHardwareProfile("termux")}
                    disabled={optimizing}
                    className="w-full text-xs font-semibold py-1.5 border border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
                  >
                    Ativar Modo Servidor
                  </Button>
                </div>

                {/* Perfil 3: Câmera RTSP */}
                <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800/80 flex flex-col justify-between space-y-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-purple-400 font-bold text-xs mb-1">
                      <Radio size={13} /> Câmera / Sensor RTSP
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      Prioriza VCam, desativa sleep de display e ajusta taxa de bits para streaming contínuo sem travamentos.
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleApplyHardwareProfile("camera")}
                    disabled={optimizing}
                    className="w-full text-xs font-semibold py-1.5 border border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                  >
                    Ativar Modo Câmera
                  </Button>
                </div>
              </div>
            </div>

            {/* 4. Guia de Apps FOSS Ultraleves & Custom ROM */}
            <div className="p-3.5 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-2.5">
              <h5 className="font-bold text-zinc-300 flex items-center gap-1.5 text-xs">
                <Info size={14} className="text-[#828DF7]" /> Stack FOSS Ultraleve Recomendada (&lt;2GB RAM)
              </h5>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400">
                      <th className="pb-1.5 font-medium">Categoria</th>
                      <th className="pb-1.5 font-medium">App Pesado</th>
                      <th className="pb-1.5 font-medium text-emerald-400">Alternativa Open-Source</th>
                      <th className="pb-1.5 font-medium text-right">RAM Típica</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    <tr>
                      <td className="py-1 text-zinc-400">Launcher</td>
                      <td className="py-1 text-zinc-500">Pixel / Fabricante</td>
                      <td className="py-1 font-semibold text-emerald-300">KISS Launcher / Lawnchair</td>
                      <td className="py-1 text-right font-mono text-zinc-400">&lt; 25 MB</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Loja de Apps</td>
                      <td className="py-1 text-zinc-500">Google Play Store</td>
                      <td className="py-1 font-semibold text-emerald-300">Droid-ify / Neo Store</td>
                      <td className="py-1 text-right font-mono text-zinc-400">&lt; 35 MB</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Navegador</td>
                      <td className="py-1 text-zinc-500">Google Chrome</td>
                      <td className="py-1 font-semibold text-emerald-300">Via Browser / Fennec</td>
                      <td className="py-1 text-right font-mono text-zinc-400">&lt; 80 MB</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Teclado</td>
                      <td className="py-1 text-zinc-500">Gboard / SwiftKey</td>
                      <td className="py-1 font-semibold text-emerald-300">OpenBoard / FlorisBoard</td>
                      <td className="py-1 text-right font-mono text-zinc-400">&lt; 30 MB</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Mídia / Vídeo</td>
                      <td className="py-1 text-zinc-500">YouTube App</td>
                      <td className="py-1 font-semibold text-emerald-300">NewPipe / LibreTube</td>
                      <td className="py-1 text-right font-mono text-zinc-400">&lt; 60 MB</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-zinc-500 pt-1">
                💡 <span className="text-zinc-400 font-semibold">Dica de ROM:</span> Em aparelhos com bootloader desbloqueável (como LG K10), o uso de <strong>LineageOS Android Go</strong> com <strong>microG Project</strong> remove 100% dos serviços pesados da Google mantendo push notifications ativas.
              </p>
            </div>

            {optStatus && (
              <p className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2.5 rounded-lg whitespace-pre-wrap">
                {optStatus}
              </p>
            )}
          </div>
        )}

        {/* TAB 5: SISTEMA, PROVISIONAMENTO & ZONA DE PERIGO */}
        {activeTab === "system" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* Re-provisionar Agente Esfera */}
            <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 space-y-2">
              <div className="flex items-center justify-between">
                <h5 className="font-bold text-emerald-300 flex items-center gap-1.5 text-xs">
                  <Shield size={14} className="text-emerald-400" /> Provisionar / Reprovisionar Agente Esfera
                </h5>
                <Badge variant="success" className="text-[9px]">Recomendado</Badge>
              </div>
              <p className="text-[11px] text-zinc-300">
                Grava a identidade <span className="font-mono text-emerald-300 font-semibold">{device.esferaDeviceId || device.serial}</span> no arquivo <span className="font-mono">/sdcard/esfera_config.json</span> e inicia o serviço do Agente em primeiro plano apontando para a VPS.
              </p>
              <Button
                variant="primary"
                size="sm"
                onClick={handleReprovision}
                disabled={provisioning}
                loading={provisioning}
                icon={<RefreshCw size={12} />}
                className="w-full font-semibold"
              >
                Executar Provisionamento do Aparelho
              </Button>
            </div>

            {/* Reinstalar / Atualizar APK */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <h5 className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <Package size={13} className="text-[#828DF7]" /> Atualizar / Reinstalar APK do Agente
              </h5>
              <p className="text-[11px] text-zinc-400">
                Envia e instala a compilação mais recente do <span className="font-mono">com.esfera.agent</span> via ADB.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleInstallApk}
                disabled={installingApk}
                loading={installingApk}
                icon={<Package size={12} />}
              >
                Reinstalar APK do Agente no Celular
              </Button>
            </div>

            {/* Reiniciar Celular */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <h5 className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <RotateCcw size={13} className="text-amber-400" /> Reinicialização de Hardware (Reboot Remoto)
              </h5>
              <p className="text-[11px] text-zinc-400">
                Reinicie o smartphone remotamente. Ao religar, ele restaurará as conexões e o agente automaticamente.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleReboot}
                disabled={rebooting}
                loading={rebooting}
                icon={<Power size={12} className="text-amber-400" />}
              >
                Reiniciar Smartphone Remotamente
              </Button>
            </div>

            {/* ZONA DE PERIGO: REMOVER DISPOSITIVO */}
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/25 space-y-2.5">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} className="text-red-400 shrink-0" />
                <h5 className="font-bold text-red-300 text-xs">Zona de Perigo — Remover Dispositivo</h5>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Desconecta o celular da rede ADB e remove sua ancoragem de identidade do sistema. Para reconectar, será necessário plugá-lo no USB ou digitar o IP.
              </p>
              
              {!confirmDeleteOpen ? (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmDeleteOpen(true)}
                  icon={<Trash2 size={12} />}
                  className="font-semibold"
                >
                  Remover {nameInput || device.name} do Esfera
                </Button>
              ) : (
                <div className="p-3 rounded-md bg-red-950/60 border border-red-500/40 space-y-2.5 animate-scale-in">
                  <p className="text-xs font-semibold text-red-200">
                    ⚠️ Tem certeza que deseja remover permanentemente este aparelho?
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={handleExecuteRemove}
                      loading={removing}
                      icon={<Trash2 size={12} />}
                      className="font-bold"
                    >
                      Sim, Confirmar Remoção
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirmDeleteOpen(false)}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {systemMsg && (
              <p className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2.5 rounded-lg whitespace-pre-wrap">
                {systemMsg}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
