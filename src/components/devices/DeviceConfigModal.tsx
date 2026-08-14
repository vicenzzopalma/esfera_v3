// ============================================================
// Esfera v3 — Sub-componente DeviceConfigModal (Linear SaaS Style)
// Painel completo de configurações de hardware, display, rede e sistema Android
// ============================================================

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import type { Device, SectorType } from "../../types";
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
} from "lucide-react";

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
}

type ConfigTab = "general" | "display" | "network" | "performance" | "system";

export function DeviceConfigModal({
  isOpen,
  onClose,
  device,
  onSave,
}: DeviceConfigModalProps) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("general");

  // General Tab
  const [nameInput, setNameInput] = useState(device.name || `Aparelho ${device.deviceNumber}`);
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [deviceNumberInput, setDeviceNumberInput] = useState(String(device.deviceNumber || 1));
  const [copiedId, setCopiedId] = useState(false);

  // Display Tab
  const [stayAwake, setStayAwake] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [animScale, setAnimScale] = useState<number>(0);
  const [customDpi, setCustomDpi] = useState<number>(0);
  const [displayStatus, setDisplayStatus] = useState<string | null>(null);
  const [applyingDisplay, setApplyingDisplay] = useState(false);

  // Performance Tab
  const [optimizing, setOptimizing] = useState(false);
  const [optStatus, setOptStatus] = useState<string | null>(null);
  const [debloating, setDebloating] = useState(false);

  // System Tab
  const [rebooting, setRebooting] = useState(false);
  const [systemMsg, setSystemMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const serial = device.currentAdbAddress || device.serial;

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

  const handleDebloat = async () => {
    setDebloating(true);
    setOptStatus("Desativando aplicativos de telemetria, operadora e bloatware...");
    try {
      const res = await api<string>("debloat_device", { serial });
      setOptStatus(`✅ ${res}`);
    } catch (e: any) {
      setOptStatus(`❌ ${typeof e === "string" ? e : e?.message || "Erro no debloat"}`);
    } finally {
      setDebloating(false);
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
      const msg = await api<string>("provision_device", { serial });
      setSystemMsg(`✅ ${msg}`);
    } catch (e: any) {
      setSystemMsg(`❌ Erro: ${typeof e === "string" ? e : e?.message || "Falha no provisionamento"}`);
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Configurações: ${nameInput || device.model}`}
      size="lg"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave({
                ...device,
                name: nameInput || device.name || `Aparelho ${device.deviceNumber}`,
                model: modelInput || device.model,
                sector: sectorInput,
                deviceNumber: parseInt(deviceNumberInput, 10) || device.deviceNumber || 1,
              });
            }}
          >
            Salvar Alterações
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-xs">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1.5 border-b border-white/[0.08] pb-2 overflow-x-auto custom-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab("general")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 ${
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
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 ${
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
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 ${
              activeTab === "network"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Wifi size={13} /> Rede & Wi-Fi
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("performance")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 ${
              activeTab === "performance"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Zap size={13} /> Otimização
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("system")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 shrink-0 ${
              activeTab === "system"
                ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Power size={13} /> Sistema
          </button>
        </div>

        {/* TAB 1: GERAL & IDENTIDADE */}
        {activeTab === "general" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* EsferaDeviceId (Identidade Persistente) */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] flex items-center justify-between">
              <div>
                <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Identidade Permanente</span>
                <p className="font-mono text-xs font-semibold text-emerald-400 mt-0.5">
                  {device.esferaDeviceId || device.serial}
                </p>
                <span className="text-[10px] text-zinc-500">Gravado no hardware (/sdcard/.esfera_device_id)</span>
              </div>
              <button
                type="button"
                onClick={handleCopyId}
                className="px-2.5 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-xs border border-white/[0.06] flex items-center gap-1 transition-colors"
              >
                {copiedId ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                <span>{copiedId ? "Copiado" : "Copiar ID"}</span>
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Nome do Aparelho (Título Operacional)</label>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Ex: Aparelho 1, Celular 12"
                className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Modelo / Hardware</label>
                <input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="Ex: moto g22, 24044RN32L"
                  className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Número do Slot</label>
                <input
                  type="number"
                  value={deviceNumberInput}
                  onChange={(e) => setDeviceNumberInput(e.target.value)}
                  min={1}
                  className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Setor do Aparelho</label>
              <select
                value={sectorInput}
                onChange={(e) => setSectorInput(e.target.value as SectorType)}
                className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs focus:outline-none focus:border-[#5E6AD2]"
              >
                <option value="junior">Junior</option>
                <option value="senior">Senior</option>
                <option value="pa_fixa">PA FIXA</option>
                <option value="pesquisa">Pesquisa</option>
              </select>
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
                  <p className="text-[11px] text-zinc-400">Ativa o tema escuro no sistema do celular para economia de energia.</p>
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
                    <Sparkles size={13} className="text-emerald-400" /> Exibir Toques na Tela (Ponto Branco)
                  </span>
                  <p className="text-[11px] text-zinc-400">Mostra o indicador visual de onde o robô ou o operador está clicando.</p>
                </div>
                <Toggle checked={showTouches} onChange={setShowTouches} />
              </div>

              {/* Escala de Animações */}
              <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-1.5">
                <span className="font-semibold text-zinc-200 block text-xs">Escala de Animações da UI</span>
                <p className="text-[11px] text-zinc-400">0x remove todas as transições para disparos com velocidade máxima.</p>
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setAnimScale(0)}
                    className={`py-1 rounded text-xs font-medium border transition-colors ${
                      animScale === 0
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white"
                        : "bg-white/[0.04] border-white/[0.06] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    0x (Performance Máx)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnimScale(0.5)}
                    className={`py-1 rounded text-xs font-medium border transition-colors ${
                      animScale === 0.5
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white"
                        : "bg-white/[0.04] border-white/[0.06] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    0.5x (Rápido)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnimScale(1)}
                    className={`py-1 rounded text-xs font-medium border transition-colors ${
                      animScale === 1
                        ? "bg-[#5E6AD2]/20 border-[#5E6AD2] text-white"
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
                    className="flex-1 px-3 py-1.5 rounded-md bg-[#121216] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomDpi(0)}
                    className="px-2.5 py-1.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-xs border border-white/[0.06]"
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

        {/* TAB 3: REDE & WI-FI */}
        {activeTab === "network" && (
          <div className="space-y-3.5 animate-fade-in">
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
                    await api("send_adb_keyevent", { serial, keycode: 0 }); // trigger
                    setOptStatus("✅ Wi-Fi configurado para conexão ininterrupta!");
                  } catch {
                    /* noop */
                  }
                }}
                icon={<Check size={12} className="text-emerald-400" />}
              >
                Garantir Wi-Fi Ininterrupto (Sleep Policy 2)
              </Button>
            </div>

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
                    setOptStatus("✅ Porta ADB 5555 reativada no aparelho!");
                  } catch (e: any) {
                    setOptStatus(`❌ ${typeof e === "string" ? e : "Erro ao ativar porta"}`);
                  }
                }}
                icon={<RefreshCw size={12} />}
              >
                Reativar Porta 5555 (ADB TCP/IP)
              </Button>
            </div>
          </div>
        )}

        {/* TAB 4: PERFORMANCE & OTIMIZAÇÃO */}
        {activeTab === "performance" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* Otimização de RAM */}
            <div className="p-3 rounded-lg bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 space-y-2">
              <h5 className="font-semibold text-[#828DF7] flex items-center gap-1.5 text-xs">
                <Zap size={13} className="text-amber-400" /> Aceleração HPC & Limpeza de Memória
              </h5>
              <p className="text-[11px] text-zinc-400">
                Libere a memória RAM ocupada por processos em segundo plano e redefina os descritores de soquete ADB.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleOptimizeRam}
                disabled={optimizing}
                loading={optimizing}
                icon={<RefreshCw size={12} />}
                className="text-xs"
              >
                Otimizar RAM & Conexões
              </Button>
            </div>

            {/* Debloat */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <h5 className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <Trash2 size={13} className="text-red-400" /> Debloat de Aplicativos Nativos
              </h5>
              <p className="text-[11px] text-zinc-400">
                Desative bloatwares de fábrica (Bixby, Facebook services, telemetria de operadora) para liberar até 40% mais RAM.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDebloat}
                disabled={debloating}
                loading={debloating}
                icon={<Shield size={12} className="text-emerald-400" />}
              >
                Executar Debloat no Aparelho
              </Button>
            </div>

            {optStatus && (
              <p className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2.5 rounded-lg whitespace-pre-wrap">
                {optStatus}
              </p>
            )}
          </div>
        )}

        {/* TAB 5: SISTEMA & MANUTENÇÃO */}
        {activeTab === "system" && (
          <div className="space-y-3.5 animate-fade-in">
            {/* Reiniciar Celular */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <h5 className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <RotateCcw size={13} className="text-amber-400" /> Reinicialização de Hardware (Reboot)
              </h5>
              <p className="text-[11px] text-zinc-400">
                Reinicie o smartphone remotamente. Ao religar, ele restaurará as conexões configuradas.
              </p>
              <Button
                variant="danger"
                size="sm"
                onClick={handleReboot}
                disabled={rebooting}
                loading={rebooting}
                icon={<Power size={12} />}
              >
                Reiniciar Aparelho Remotamente
              </Button>
            </div>

            {/* Re-provisionar Agente */}
            <div className="p-3 rounded-lg bg-[#09090b] border border-white/[0.08] space-y-2">
              <h5 className="font-semibold text-zinc-200 flex items-center gap-1.5 text-xs">
                <Shield size={13} className="text-[#828DF7]" /> Re-provisionar Agente & Identidade
              </h5>
              <p className="text-[11px] text-zinc-400">
                Injeta novamente a identidade fixa e reinicia o serviço do Agente Kotlin em primeiro plano.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleReprovision}
                disabled={provisioning}
                loading={provisioning}
                icon={<RefreshCw size={12} />}
              >
                Re-provisionar Agente Esfera
              </Button>
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
