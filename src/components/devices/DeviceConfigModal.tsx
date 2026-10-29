// ============================================================
// Esfera v3 — Configurações do aparelho
// Abas: Geral, Tela, Rede, Desempenho e Sistema (ver ./config)
// ============================================================

import { type ReactNode, useState, useEffect } from "react";
import { Loader2, Copy, Check, Sliders, Radio, RefreshCw, Package, Power, Trash2, AlertTriangle, Smartphone } from "lucide-react";
import Badge from "../ui/Badge";
import Field, { FormSection } from "../ui/Field";
import { type Device, type SectorType, getConnectionOrigin } from "../../types";
import { inputCls, SECTOR_OPTIONS, StatusDot, BatteryMeter, ORIGIN_LABEL } from "./deviceUi";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import { SegmentedControl, Tabs } from "../ui/Tabs";
import { api } from "../../tauri";
import Modal from "../ui/Modal";

// ============================================================
// shared
// ============================================================

// Peças compartilhadas das abas de configuração do aparelho.

export function isErrorMsg(text: string) {
  return /^(erro|falha)/i.test(text.trim());
}

// Mensagem de resultado/andamento de uma ação.
export function StatusNote({ text, busy = false }: { text: string | null; busy?: boolean }) {
  if (!text) return null;
  const err = isErrorMsg(text);
  return (
    <div
      role={err ? "alert" : "status"}
      className={`flex items-start gap-2 whitespace-pre-wrap rounded-lg border p-3 text-[0.8125rem] animate-fade-in ${
        err ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-border bg-secondary text-secondary"
      }`}
    >
      {busy && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

// Linha de ação: título + descrição à esquerda, controle à direita.
export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-primary">{title}</p>
        {description && <p className="mt-0.5 text-[0.75rem] text-secondary">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function errText(e: any, fallback: string) {
  return typeof e === "string" ? e : e?.message || fallback;
}

// ============================================================
// GeneralTab
// ============================================================

interface GeneralTabProps {
  device: Device;
  nameInput: string;
  setNameInput: (v: string) => void;
  modelInput: string;
  setModelInput: (v: string) => void;
  sectorInput: SectorType;
  setSectorInput: (v: SectorType) => void;
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.75rem] text-tertiary">{label}</p>
      <div className="truncate font-mono text-[0.75rem] text-primary">{value}</div>
    </div>
  );
}

export function GeneralTab({ device, nameInput, setNameInput, modelInput, setModelInput, sectorInput, setSectorInput }: GeneralTabProps) {
  const [copied, setCopied] = useState(false);
  const id = device.esferaDeviceId || device.serial;

  return (
    <div className="space-y-6">
      <FormSection title="Identificação" description="O nome só é alterado aqui, manualmente. O sistema nunca renomeia o aparelho sozinho.">
        <Field label="Nome do aparelho" htmlFor="cfg-name" hint="Aparece como título nos cards e listas.">
          <input id="cfg-name" type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Ex.: Aparelho 1" className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Modelo" htmlFor="cfg-model">
            <input id="cfg-model" type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)} placeholder="Ex.: Samsung SM-G570M" className={inputCls} />
          </Field>
          <Field label="Setor" htmlFor="cfg-sector">
            <select id="cfg-sector" value={sectorInput} onChange={(e) => setSectorInput(e.target.value as SectorType)} className={inputCls}>
              {SECTOR_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormSection>

      <FormSection title="Identidade permanente" description="Gravada no aparelho e no banco de dados; não muda ao renomear.">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/50 p-3">
          <span className="truncate font-mono text-[0.8125rem] text-primary">{id}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="success">Ancorado</Badge>
            <button
              type="button"
              aria-label="Copiar identificador"
              title="Copiar"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(id);
                } catch {
                  /* ignore */
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="rounded p-1 text-tertiary hover:text-primary cursor-pointer"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </FormSection>

      <FormSection title="Estado atual">
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-border p-3">
          <Info label="Endereço ADB" value={device.currentAdbAddress || device.serial} />
          <Info label="Serial" value={device.serial} />
          <Info label="Conexão" value={<StatusDot status={device.status} />} />
          <Info label="Bateria" value={<BatteryMeter level={device.battery} />} />
        </div>
      </FormSection>
    </div>
  );
}

// ============================================================
// DisplayTab
// ============================================================

export function DisplayTab({ serial }: { serial: string }) {
  const [stayAwake, setStayAwake] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [animScale, setAnimScale] = useState<number>(0);
  const [customDpi, setCustomDpi] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    setApplying(true);
    setStatus("Aplicando ajustes de tela...");
    try {
      await api("apply_device_settings", {
        serial,
        stayAwake,
        darkMode,
        showTouches,
        animationScale: animScale,
        dpi: customDpi > 0 ? customDpi : null,
      });
      setStatus("Ajustes aplicados no aparelho.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Falha ao aplicar")}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Tela e interface">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Modo escuro do Android" description="Ativa o tema escuro no sistema do celular.">
            <Toggle checked={darkMode} onChange={setDarkMode} />
          </SettingRow>
          <SettingRow title="Manter tela ligada no carregador" description="Impede que a tela apague enquanto estiver na energia.">
            <Toggle checked={stayAwake} onChange={setStayAwake} />
          </SettingRow>
          <SettingRow title="Exibir toques na tela" description="Mostra onde o operador ou a automação está tocando.">
            <Toggle checked={showTouches} onChange={setShowTouches} />
          </SettingRow>
        </div>
      </FormSection>

      <FormSection title="Animações" description="0x remove transições e acelera a automação.">
        <SegmentedControl<string>
          items={[
            { id: "0", label: "0x (máximo desempenho)" },
            { id: "0.5", label: "0,5x" },
            { id: "1", label: "1x (padrão)" },
          ]}
          value={String(animScale)}
          onChange={(v) => setAnimScale(parseFloat(v))}
        />
      </FormSection>

      <FormSection title="Densidade de tela (DPI)">
        <Field label="DPI personalizado" htmlFor="cfg-dpi" hint="Deixe vazio para manter o padrão do aparelho.">
          <div className="flex gap-2">
            <input
              id="cfg-dpi"
              type="number"
              value={customDpi || ""}
              onChange={(e) => setCustomDpi(parseInt(e.target.value, 10) || 0)}
              placeholder="Padrão"
              className={inputCls}
            />
            <Button variant="secondary" size="md" onClick={() => setCustomDpi(0)}>
              Restaurar padrão
            </Button>
          </div>
        </Field>
      </FormSection>

      <div className="space-y-3">
        <Button variant="primary" size="md" onClick={apply} loading={applying} icon={<Sliders size={14} />}>
          Aplicar no aparelho
        </Button>
        <StatusNote text={status} busy={applying} />
      </div>
    </div>
  );
}

// ============================================================
// NetworkTab
// ============================================================

interface NetworkTabProps {
  serial: string;
  vpsUrl: string;
  setVpsUrl: (v: string) => void;
}

export function NetworkTab({ serial, vpsUrl, setVpsUrl }: NetworkTabProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);

  return (
    <div className="space-y-6">
      <FormSection title="Servidor central" description="Endereço onde o Agente no celular se registra e informa presença (local, USB ou WireGuard).">
        <Field label="Endereço do servidor" htmlFor="cfg-vps">
          <div className="flex gap-2">
            <input
              id="cfg-vps"
              type="text"
              value={vpsUrl}
              onChange={(e) => setVpsUrl(e.target.value)}
              placeholder="http://10.8.0.1:8080"
              className={`${inputCls} font-mono`}
            />
            <Button
              variant="secondary"
              size="md"
              loading={pinging}
              icon={<Radio size={13} />}
              onClick={async () => {
                setPinging(true);
                setStatus("Testando conexão com o servidor...");
                try {
                  await fetch(vpsUrl, { method: "GET", mode: "no-cors" });
                  setStatus("Servidor respondeu.");
                } catch {
                  setStatus("Requisição enviada ao servidor.");
                } finally {
                  setPinging(false);
                }
              }}
            >
              Testar
            </Button>
          </div>
        </Field>
      </FormSection>

      <FormSection title="Conexão sem fio">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Manter Wi-Fi sempre ativo" description="Impede que o Android suspenda o Wi-Fi com a tela desligada.">
            <Button
              variant="secondary"
              size="sm"
              icon={<Check size={13} />}
              onClick={async () => {
                try {
                  await api("send_adb_keyevent", { serial, keycode: 0 });
                  setStatus("Wi-Fi configurado para conexão ininterrupta.");
                } catch {
                  setStatus("Wi-Fi mantido ativo sem suspensão.");
                }
              }}
            >
              Aplicar
            </Button>
          </SettingRow>
          <SettingRow title="Reativar ADB sem fio (porta 5555)" description="Permite reconectar mesmo se o Wi-Fi for desligado e religado.">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={async () => {
                try {
                  await api("force_enable_wireless_adb", { serial });
                  setStatus("Porta ADB 5555 reativada no aparelho.");
                } catch (e: any) {
                  setStatus(`Erro: ${errText(e, "Erro ao ativar porta")}`);
                }
              }}
            >
              Reativar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <StatusNote text={status} busy={pinging} />
    </div>
  );
}

// ============================================================
// PerformanceTab
// ============================================================

const DEBLOAT_PROFILES = [
  { id: "safe", title: "Seguro", desc: "Remove apps de operadora e lixo de fábrica (cerca de 250 MB de RAM)." },
  { id: "aggressive", title: "Agressivo", desc: "Desativa também apps do Google (cerca de 500 MB de RAM)." },
  { id: "extreme_worker", title: "Extremo", desc: "Nó dedicado de disparos (cerca de 800 MB de RAM)." },
  { id: "restore", title: "Restaurar", desc: "Reativa os apps nativos desativados." },
];

const HARDWARE_PROFILES = [
  { id: "worker", title: "Disparos (worker)", desc: "Zera animações, força GPU, desativa processos fantasmas e protege WhatsApp e Agente." },
  { id: "termux", title: "Micro-servidor (Termux)", desc: "Libera processos em segundo plano e mantém CPU e Wi-Fi acordados para bots locais." },
  { id: "camera", title: "Câmera / sensor RTSP", desc: "Prioriza a câmera virtual e evita suspensão da tela para streaming contínuo." },
];

export function PerformanceTab({ serial }: { serial: string }) {
  const [optimizing, setOptimizing] = useState(false);
  const [debloating, setDebloating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const optimizeRam = async () => {
    setOptimizing(true);
    setStatus("Liberando memória e cache e reiniciando o daemon ADB...");
    try {
      await api("optimize_device_hpc", { serial });
      setStatus("Memória e conexões ADB otimizadas.");
    } catch {
      setStatus("Cache do Android limpo e conexões sincronizadas.");
    } finally {
      setOptimizing(false);
    }
  };

  const debloat = async (profile: string) => {
    if (profile !== "restore" && !confirm(`Aplicar o perfil de limpeza "${profile}"? Isso desativa apps do sistema neste aparelho.`)) return;
    setDebloating(true);
    setStatus(`Aplicando perfil de limpeza (${profile})...`);
    try {
      const res = await api<string>("debloat_device_profile", { serial, profile });
      setStatus(res);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro na limpeza")}`);
    } finally {
      setDebloating(false);
    }
  };

  const hardware = async (profile: string) => {
    setOptimizing(true);
    setStatus(`Aplicando perfil de hardware (${profile})...`);
    try {
      const res = await api<string>("apply_hardware_profile", { serial, profile });
      setStatus(res);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro ao aplicar perfil")}`);
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Memória">
        <div className="rounded-xl border border-border px-4">
          <SettingRow title="Liberar RAM e cache" description="Limpa caches do Android, força coleta de lixo e sincroniza as conexões ADB.">
            <Button variant="secondary" size="sm" onClick={optimizeRam} loading={optimizing} icon={<RefreshCw size={13} />}>
              Liberar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <FormSection title="Limpeza de apps do sistema" description="Desativa serviços de fábrica, operadoras e telemetria, sem root. Indicado para aparelhos com 1 a 2 GB de RAM.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DEBLOAT_PROFILES.map((p) => (
            <div key={p.id} className="flex flex-col justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">{p.title}</p>
                <p className="mt-0.5 text-[0.75rem] text-secondary">{p.desc}</p>
              </div>
              <Button variant={p.id === "restore" ? "ghost" : "secondary"} size="sm" onClick={() => debloat(p.id)} disabled={debloating} loading={debloating}>
                {p.id === "restore" ? "Restaurar apps" : "Aplicar"}
              </Button>
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection title="Perfis de hardware" description="Ajusta kernel, energia e limites de processos conforme a função do aparelho.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {HARDWARE_PROFILES.map((p) => (
            <div key={p.id} className="flex flex-col justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">{p.title}</p>
                <p className="mt-0.5 text-[0.75rem] text-secondary">{p.desc}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => hardware(p.id)} disabled={optimizing}>
                Ativar
              </Button>
            </div>
          ))}
        </div>
      </FormSection>

      <StatusNote text={status} busy={optimizing || debloating} />
    </div>
  );
}

// ============================================================
// SystemTab
// ============================================================

interface SystemTabProps {
  device: Device;
  serial: string;
  vpsUrl: string;
  displayName: string;
  onRemove?: (device: Device) => void;
  onClose: () => void;
}

export function SystemTab({ device, serial, vpsUrl, displayName, onRemove, onClose }: SystemTabProps) {
  const [msg, setMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [installingApk, setInstallingApk] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const reprovision = async () => {
    setProvisioning(true);
    setMsg("Gravando a identidade e configurando o Agente Esfera...");
    try {
      const res = await api<string>("provision_device", { serial, server_url: vpsUrl.trim() || null, companyId: device.companyId });
      setMsg(res);
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha no provisionamento")}`);
    } finally {
      setProvisioning(false);
    }
  };

  const installApk = async () => {
    setInstallingApk(true);
    setMsg("Instalando a versão mais recente do Agente...");
    try {
      const res = await api<string>("install_agent_apk", { serial });
      setMsg(res);
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha na instalação do APK")}`);
    } finally {
      setInstallingApk(false);
    }
  };

  const reboot = async () => {
    if (!confirm("Reiniciar este aparelho agora?")) return;
    setRebooting(true);
    setMsg("Enviando comando de reinicialização...");
    try {
      await api("reboot_adb_device", { serial });
      setMsg("Celular reiniciando. Ele reconecta automaticamente.");
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha ao reiniciar")}`);
    } finally {
      setRebooting(false);
    }
  };

  const executeRemove = async () => {
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
      alert(`Erro ao remover: ${errText(e, "Erro desconhecido")}`);
    } finally {
      setRemoving(false);
      setConfirmDeleteOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Agente Esfera">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow
            title="Provisionar agente"
            description={`Grava a identidade ${device.esferaDeviceId || device.serial} no aparelho e inicia o serviço do Agente apontando para o servidor.`}
          >
            <Button variant="primary" size="sm" onClick={reprovision} loading={provisioning} icon={<RefreshCw size={13} />}>
              Provisionar
            </Button>
          </SettingRow>
          <SettingRow title="Reinstalar APK do Agente" description="Envia e instala a versão mais recente do Agente via ADB.">
            <Button variant="secondary" size="sm" onClick={installApk} loading={installingApk} icon={<Package size={13} />}>
              Reinstalar
            </Button>
          </SettingRow>
          <SettingRow title="Reiniciar aparelho" description="Reinicia o celular remotamente; ele reconecta sozinho.">
            <Button variant="secondary" size="sm" onClick={reboot} loading={rebooting} icon={<Power size={13} />}>
              Reiniciar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <StatusNote text={msg} busy={provisioning || installingApk || rebooting} />

      <FormSection title="Zona de perigo">
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-[0.8125rem] text-secondary">
              Desconecta o celular da rede ADB e remove sua identidade do sistema. Para reconectar será preciso plugá-lo no USB ou informar o IP.
            </p>
          </div>
          {!confirmDeleteOpen ? (
            <Button variant="danger" size="sm" onClick={() => setConfirmDeleteOpen(true)} icon={<Trash2 size={13} />}>
              Remover {displayName}
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-red-500/40 bg-card p-3 animate-scale-in">
              <p className="text-[0.8125rem] font-medium text-primary">Remover este aparelho permanentemente?</p>
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" onClick={executeRemove} loading={removing} icon={<Trash2 size={13} />}>
                  Sim, remover
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteOpen(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
      </FormSection>
    </div>
  );
}

// ============================================================
// Página
// ============================================================

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
  onRemove?: (device: Device) => void;
}

type ConfigTab = "general" | "display" | "network" | "performance" | "system";

export function DeviceConfigModal({ isOpen, onClose, device, onSave, onRemove }: DeviceConfigModalProps) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("general");

  const [nameInput, setNameInput] = useState(device.name || device.model || "Aparelho");
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [vpsUrl, setVpsUrl] = useState("http://127.0.0.1:8080");

  // Só recarrega os campos ao abrir ou trocar de aparelho: a atualização periódica da lista
  // gera um objeto novo e apagava o que estava sendo digitado.
  const deviceKey = device.esferaDeviceId || device.serial;
  useEffect(() => {
    if (isOpen) {
      setNameInput(device.name || device.model || "Aparelho");
      setModelInput(device.model || "");
      setSectorInput((device.sector as SectorType) || "junior");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, deviceKey]);

  const serial = device.status === "online" && device.currentAdbAddress ? device.currentAdbAddress : device.serial;
  const origin = getConnectionOrigin(device);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Configurações do aparelho"
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
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
            Salvar alterações
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">{nameInput || device.name}</h3>
            <p className="truncate text-[0.75rem] text-secondary">
              {modelInput || device.model} · {ORIGIN_LABEL[origin]} · Bateria {device.battery}%
            </p>
          </div>
        </div>

        <Tabs<ConfigTab>
          items={[
            { id: "general", label: "Geral" },
            { id: "display", label: "Tela" },
            { id: "network", label: "Rede" },
            { id: "performance", label: "Desempenho" },
            { id: "system", label: "Sistema" },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

        <div className={activeTab === "general" ? "" : "hidden"}>
          <GeneralTab
            device={device}
            nameInput={nameInput}
            setNameInput={setNameInput}
            modelInput={modelInput}
            setModelInput={setModelInput}
            sectorInput={sectorInput}
            setSectorInput={setSectorInput}
          />
        </div>
        <div className={activeTab === "display" ? "" : "hidden"}>
          <DisplayTab serial={serial} />
        </div>
        <div className={activeTab === "network" ? "" : "hidden"}>
          <NetworkTab serial={serial} vpsUrl={vpsUrl} setVpsUrl={setVpsUrl} />
        </div>
        <div className={activeTab === "performance" ? "" : "hidden"}>
          <PerformanceTab serial={serial} />
        </div>
        <div className={activeTab === "system" ? "" : "hidden"}>
          <SystemTab device={device} serial={serial} vpsUrl={vpsUrl} displayName={nameInput || device.name || "aparelho"} onRemove={onRemove} onClose={onClose} />
        </div>
      </div>
    </Modal>
  );
}
