// ============================================================
// Esfera v3 — Configurações do aparelho
// Abas: Geral, Chip, Tela, Rede, Desempenho e Sistema
// ============================================================

import { type ReactNode, useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Copy, Check, Sliders, Radio, RefreshCw, Package, Power, Trash2, AlertTriangle, Smartphone, CardSim, Ban, ShieldCheck } from "lucide-react";
import Badge from "../ui/Badge";
import Field, { FormSection } from "../ui/Field";
import { type Device, type SectorType, getConnectionOrigin } from "../../types";
import {
  inputCls,
  isOnlineStatus,
  SECTOR_OPTIONS,
  StatusDot,
  BatteryMeter,
  ORIGIN_LABEL,
  errorText,
  chipStatusView,
  formatPhone,
  formatWhen,
  parseDbDate,
  type DeviceChip,
} from "./deviceUi";
import { describeAgent, type AgentUpdateStatus } from "./DeviceCard";
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
  return errorText(e, fallback);
}

// Confirmação embutida (sem janela por cima da janela): pergunta + confirmar/cancelar.
function InlineConfirm({
  question,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  danger = true,
}: {
  question: ReactNode;
  detail?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`space-y-3 rounded-lg border bg-card p-3 animate-scale-in ${danger ? "border-red-500/40" : "border-border-strong"}`}>
      <p className="text-[0.8125rem] font-medium text-primary">{question}</p>
      {detail && <p className="text-[0.75rem] text-secondary">{detail}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </div>
  );
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
  const currentName = (device.name || "").trim();
  const renaming = !!currentName && nameInput.trim() !== "" && nameInput.trim() !== currentName;

  return (
    <div className="space-y-6">
      <FormSection title="Identificação" description="O nome só é alterado aqui, manualmente. O sistema nunca renomeia o aparelho sozinho.">
        <Field
          label="Nome do aparelho"
          htmlFor="cfg-name"
          hint={renaming ? `Hoje: "${currentName}". O novo nome vale depois de clicar em Salvar alterações.` : "Aparece como título nos cards e listas."}
        >
          <input id="cfg-name" type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Ex.: Cobrança 01" className={inputCls} />
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
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary p-3">
          <span className="truncate font-mono text-[0.8125rem] text-primary">{id}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={device.esferaDeviceId ? "success" : "warning"}>{device.esferaDeviceId ? "Ancorado" : "Sem ID do Esfera"}</Badge>
            <button
              type="button"
              aria-label="Copiar identificador"
              title="Copiar"
              onClick={() => {
                navigator.clipboard
                  .writeText(id)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() => {
                    /* área de transferência indisponível */
                  });
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
// ChipTab — o motor de disparo exige exatamente um chip por aparelho
// ============================================================

const CHIP_TONE_BADGE = { success: "success", warning: "warning", danger: "danger", neutral: "neutral" } as const;

function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 12 && digits.startsWith("55") ? digits.slice(2) : digits;
}

export function ChipTab({ device, onChanged }: { device: Device; onChanged?: (deviceId: number) => void }) {
  const deviceId = device.id;
  const [chips, setChips] = useState<DeviceChip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ chipId: number; action: "release" | "ban" } | null>(null);
  const [acting, setActing] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const my = ++reqId.current;
    if (!deviceId) {
      setLoading(false);
      setLoadError("Este aparelho ainda não está salvo no banco. Atualize a lista de aparelhos e abra de novo.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api<DeviceChip[]>("get_device_chips", { deviceId });
      if (my === reqId.current) setChips(Array.isArray(list) ? list : []);
    } catch (e) {
      if (my === reqId.current) setLoadError(errorText(e, "Não foi possível carregar o chip deste aparelho."));
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  const normalized = normalizePhone(phone);
  const phoneValid = normalized.length === 10 || normalized.length === 11;
  const phoneError = phone.trim() && !phoneValid ? "Informe DDD + número (10 ou 11 dígitos)." : undefined;

  const register = async () => {
    if (!phoneValid || saving) return;
    setSaving(true);
    setMsg(null);
    try {
      await api<number>("add_device_chip", { deviceId, phone: normalized, name: label.trim() });
      setPhone("");
      setLabel("");
      setMsg("Chip cadastrado. O aquecimento começa hoje: o limite diário de envios cresce aos poucos.");
      await load();
      onChanged?.(deviceId);
    } catch (e) {
      setMsg(`Erro: ${errorText(e, "Não foi possível cadastrar o chip.")}`);
    } finally {
      setSaving(false);
    }
  };

  const runPending = async () => {
    if (!pending) return;
    setActing(true);
    setMsg(null);
    try {
      if (pending.action === "release") {
        await api("confirm_chip_release", { chipId: pending.chipId });
        setMsg("Chip liberado. Ele volta a entrar nos disparos.");
      } else {
        await api("update_chip_status", { chipId: pending.chipId, status: "banido" });
        setMsg("Chip marcado como banido. Este aparelho para de enviar com ele.");
      }
      setPending(null);
      await load();
      onChanged?.(deviceId);
    } catch (e) {
      setMsg(`Erro: ${errorText(e, "Não foi possível alterar o chip.")}`);
    } finally {
      setActing(false);
    }
  };

  if (loading && !chips) {
    return (
      <div className="flex items-center gap-2 py-8 text-[0.8125rem] text-secondary">
        <Loader2 size={14} className="animate-spin" /> Carregando o chip do aparelho…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <StatusNote text={`Erro: ${loadError}`} />
        <Button variant="secondary" size="sm" onClick={load} icon={<RefreshCw size={13} />}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const list = chips || [];

  return (
    <div className="space-y-6">
      <FormSection
        title="Chip (linha do WhatsApp)"
        description="O disparo usa exatamente um chip por aparelho para contar limites, aquecimento e descanso do número."
      >
        {list.length === 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[0.8125rem] text-amber-700 dark:text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>Nenhum chip cadastrado: este aparelho não entra nos disparos até você cadastrar o número abaixo.</span>
          </div>
        )}
        {list.length > 1 && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[0.8125rem] text-red-600 dark:text-red-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>Há {list.length} chips cadastrados neste aparelho. O disparo exige exatamente um: peça ao suporte para remover o cadastro antigo.</span>
          </div>
        )}

        {list.map((chip) => {
          const view = chipStatusView(chip);
          const created = parseDbDate(chip.createdAt);
          const canRelease = ["banido", "restrito_24h", "restrito_7d", "restrito_custom", "em_uso"].includes(chip.status) || (chip.status === "livre" && !!chip.restrictedUntil);
          const canBan = chip.status !== "banido";
          return (
            <div key={chip.id} className="space-y-3 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
                    <CardSim size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-semibold text-primary">{formatPhone(chip.phoneNumber)}</p>
                    <p className="truncate text-[0.75rem] text-secondary">
                      {chip.chipName ? `${chip.chipName} · ` : ""}
                      {created ? `cadastrado ${formatWhen(created)}` : "sem data de cadastro"}
                    </p>
                  </div>
                </div>
                <Badge variant={CHIP_TONE_BADGE[view.tone]} dot>
                  {view.label}
                </Badge>
              </div>
              <p className="text-[0.8125rem] text-secondary">{view.detail}</p>

              {pending?.chipId === chip.id ? (
                pending.action === "release" ? (
                  <InlineConfirm
                    question="Liberar este chip para voltar aos disparos?"
                    detail="Libere só se você conferiu no aparelho que o WhatsApp abre e envia normalmente. Se o número estiver mesmo bloqueado, o Esfera volta a marcá-lo como banido na próxima tentativa."
                    confirmLabel="Sim, liberar"
                    danger={false}
                    busy={acting}
                    onConfirm={runPending}
                    onCancel={() => setPending(null)}
                  />
                ) : (
                  <InlineConfirm
                    question="Marcar este chip como banido?"
                    detail="O aparelho para de enviar com este chip até alguém liberá-lo aqui."
                    confirmLabel="Sim, marcar como banido"
                    busy={acting}
                    onConfirm={runPending}
                    onCancel={() => setPending(null)}
                  />
                )
              ) : (
                (canRelease || canBan) && (
                  <div className="flex flex-wrap gap-2">
                    {canRelease && (
                      <Button variant="secondary" size="sm" icon={<ShieldCheck size={13} />} onClick={() => setPending({ chipId: chip.id, action: "release" })}>
                        Liberar chip
                      </Button>
                    )}
                    {canBan && (
                      <Button variant="ghost" size="sm" icon={<Ban size={13} />} onClick={() => setPending({ chipId: chip.id, action: "ban" })}>
                        Marcar como banido
                      </Button>
                    )}
                  </div>
                )
              )}
            </div>
          );
        })}
      </FormSection>

      {list.length === 0 && (
        <FormSection title="Cadastrar chip" description="Informe o número do WhatsApp que está neste aparelho.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label="Número com DDD" htmlFor="chip-phone" required error={phoneError} hint="Ex.: (75) 98805-2539">
              <input
                id="chip-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") register();
                }}
                placeholder="(DDD) 9XXXX-XXXX"
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label="Apelido (opcional)" htmlFor="chip-label">
              <input id="chip-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Vivo 1" className={inputCls} />
            </Field>
          </div>
          <Button variant="primary" size="md" onClick={register} loading={saving} disabled={!phoneValid} icon={<CardSim size={14} />}>
            Cadastrar chip
          </Button>
        </FormSection>
      )}

      <StatusNote text={msg} busy={saving || acting} />
    </div>
  );
}

// ============================================================
// DisplayTab
// ============================================================

const DPI_MIN = 120;
const DPI_MAX = 640;

export function DisplayTab({ serial }: { serial: string }) {
  const [stayAwake, setStayAwake] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [animScale, setAnimScale] = useState<number>(0);
  const [customDpi, setCustomDpi] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [resettingDpi, setResettingDpi] = useState(false);

  const dpiInvalid = customDpi !== 0 && (customDpi < DPI_MIN || customDpi > DPI_MAX);

  const apply = async () => {
    if (dpiInvalid) {
      setStatus(`Erro: informe um DPI entre ${DPI_MIN} e ${DPI_MAX}, ou deixe o campo vazio.`);
      return;
    }
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
      setStatus("Ajustes enviados ao aparelho.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Falha ao aplicar")}`);
    } finally {
      setApplying(false);
    }
  };

  // DPI 0 = "wm density reset": volta à densidade de fábrica sem mexer nos outros ajustes.
  const resetDpi = async () => {
    setResettingDpi(true);
    setStatus("Restaurando a densidade original da tela...");
    try {
      await api("apply_device_settings", { serial, dpi: 0 });
      setCustomDpi(0);
      setStatus("Densidade original da tela restaurada no aparelho.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Falha ao restaurar a densidade")}`);
    } finally {
      setResettingDpi(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Tela e interface" description="Estes ajustes são enviados juntos ao clicar em Aplicar no aparelho.">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Modo escuro do Android" description="Ativa o tema escuro no sistema do aparelho.">
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
        <Field
          label="DPI personalizado"
          htmlFor="cfg-dpi"
          error={dpiInvalid ? `Use um valor entre ${DPI_MIN} e ${DPI_MAX}.` : undefined}
          hint="Deixe vazio para não mexer na densidade atual."
        >
          <div className="flex gap-2">
            <input
              id="cfg-dpi"
              type="number"
              min={DPI_MIN}
              max={DPI_MAX}
              value={customDpi || ""}
              onChange={(e) => setCustomDpi(parseInt(e.target.value, 10) || 0)}
              placeholder="Atual"
              className={inputCls}
            />
            <Button variant="secondary" size="md" onClick={resetDpi} loading={resettingDpi} disabled={applying} title="Volta o aparelho à densidade de fábrica">
              Restaurar original
            </Button>
          </div>
        </Field>
      </FormSection>

      <div className="space-y-3">
        <Button variant="primary" size="md" onClick={apply} loading={applying} disabled={resettingDpi} icon={<Sliders size={14} />}>
          Aplicar no aparelho
        </Button>
        <StatusNote text={status} busy={applying || resettingDpi} />
      </div>
    </div>
  );
}

// ============================================================
// NetworkTab
// ============================================================

interface NetworkTabProps {
  device: Device;
  serial: string;
  vpsUrl: string;
  setVpsUrl: (v: string) => void;
}

export function NetworkTab({ device, serial, vpsUrl, setVpsUrl }: NetworkTabProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const online = isOnlineStatus(device.status);

  const testServer = async () => {
    const url = vpsUrl.trim();
    if (!url) return;
    setPinging(true);
    setStatus("Testando conexão com o servidor...");
    try {
      await fetch(url, { method: "GET", mode: "no-cors" });
      setStatus("O servidor respondeu neste endereço.");
    } catch {
      setStatus(`Erro: nenhum servidor respondeu em ${url}.`);
    } finally {
      setPinging(false);
    }
  };

  // Mantém o nome, o número e o setor atuais: reativar a porta nunca renomeia o aparelho.
  const reactivate = async () => {
    setReactivating(true);
    setStatus("Reativando o controle por Wi-Fi (porta 5555)...");
    try {
      const res = await api<string>("force_enable_wireless_adb", {
        serial,
        companyId: device.companyId,
        deviceNumber: device.deviceNumber || 0,
        sector: device.sector || "junior",
        deviceName: (device.name || "").trim() || undefined,
      });
      setStatus(res || "Controle por Wi-Fi reativado no aparelho.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Não foi possível reativar o Wi-Fi.")}`);
    } finally {
      setReactivating(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection
        title="Teste de servidor"
        description="O provisionamento já configura o agente sozinho: este computador como principal (conexão reversa) e o servidor da empresa como reserva. Use este campo só para testar se um endereço responde."
      >
        <Field label="Endereço para testar" htmlFor="cfg-vps">
          <div className="flex gap-2">
            <input
              id="cfg-vps"
              type="text"
              value={vpsUrl}
              onChange={(e) => setVpsUrl(e.target.value)}
              placeholder="http://10.8.0.1:8080"
              className={`${inputCls} font-mono`}
            />
            <Button variant="secondary" size="md" loading={pinging} disabled={!vpsUrl.trim()} icon={<Radio size={13} />} onClick={testServer}>
              Testar
            </Button>
          </div>
        </Field>
      </FormSection>

      <FormSection title="Conexão sem fio">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Wi-Fi ativo com a tela apagada" description="Aplicado automaticamente na proteção do aparelho, a cada conexão.">
            <Badge variant="success">Automático</Badge>
          </SettingRow>
          <SettingRow
            title="Reativar Wi-Fi (porta 5555)"
            description={online ? "Religa o controle sem fio se o aparelho perdeu a conexão depois de desligar o Wi-Fi." : "Disponível com o aparelho online (cabo USB ou Wi-Fi)."}
          >
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={reactivate} loading={reactivating} disabled={!online}>
              Reativar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <StatusNote text={status} busy={pinging || reactivating} />
    </div>
  );
}

// ============================================================
// PerformanceTab
// ============================================================

const DEBLOAT_PROFILES = [
  { id: "safe", title: "Seguro", desc: "Remove apps de operadora e lixo de fábrica (cerca de 250 MB de RAM)." },
  { id: "aggressive", title: "Agressivo", desc: "Desativa também apps do Google (cerca de 500 MB de RAM)." },
  { id: "extreme_worker", title: "Extremo", desc: "Aparelho dedicado só a disparos (cerca de 800 MB de RAM)." },
  { id: "restore", title: "Restaurar", desc: "Reativa os apps nativos desativados." },
];

const HARDWARE_PROFILES = [
  { id: "worker", title: "Disparos", desc: "Zera animações, força GPU, desativa processos fantasmas e protege WhatsApp e Agente." },
  { id: "termux", title: "Micro-servidor (Termux)", desc: "Libera processos em segundo plano e mantém CPU e Wi-Fi acordados para bots locais." },
  { id: "camera", title: "Câmera / sensor RTSP", desc: "Prioriza a câmera virtual e evita suspensão da tela para streaming contínuo." },
];

export function PerformanceTab({ serial }: { serial: string }) {
  const [optimizing, setOptimizing] = useState(false);
  const [debloating, setDebloating] = useState<string | null>(null);
  const [confirmProfile, setConfirmProfile] = useState<string | null>(null);
  const [hardwareBusy, setHardwareBusy] = useState<string | null>(null);
  const [confirmHardware, setConfirmHardware] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const busy = optimizing || !!debloating || !!hardwareBusy;

  const optimizeRam = async () => {
    setOptimizing(true);
    setStatus("Liberando memória e aplicando ajustes de desempenho...");
    try {
      const res = await api<string>("optimize_device_hpc", { serial });
      setStatus(res || "Memória liberada e ajustes de desempenho aplicados.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Não foi possível liberar a memória.")}`);
    } finally {
      setOptimizing(false);
    }
  };

  const debloat = async (profile: string) => {
    const title = DEBLOAT_PROFILES.find((p) => p.id === profile)?.title || profile;
    setConfirmProfile(null);
    setDebloating(profile);
    setStatus(`Aplicando a limpeza "${title}"...`);
    try {
      const res = await api<string>("debloat_device_profile", { serial, profile });
      setStatus(res || `Limpeza "${title}" aplicada.`);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro na limpeza")}`);
    } finally {
      setDebloating(null);
    }
  };

  const hardware = async (profile: string) => {
    const title = HARDWARE_PROFILES.find((p) => p.id === profile)?.title || profile;
    setConfirmHardware(null);
    setHardwareBusy(profile);
    setStatus(`Aplicando o perfil "${title}"...`);
    try {
      const res = await api<string>("apply_hardware_profile", { serial, profile });
      setStatus(res || `Perfil "${title}" aplicado.`);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro ao aplicar perfil")}`);
    } finally {
      setHardwareBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Memória">
        <div className="rounded-xl border border-border px-4">
          <SettingRow title="Liberar RAM e cache" description="Limpa caches do Android, zera animações e protege WhatsApp e Agente contra o modo de economia.">
            <Button variant="secondary" size="sm" onClick={optimizeRam} loading={optimizing} disabled={busy && !optimizing} icon={<RefreshCw size={13} />}>
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
              {confirmProfile === p.id ? (
                <InlineConfirm
                  question={`Aplicar a limpeza "${p.title}"?`}
                  detail="Isso desativa apps do sistema neste aparelho. Dá para desfazer com Restaurar."
                  confirmLabel="Sim, aplicar"
                  onConfirm={() => debloat(p.id)}
                  onCancel={() => setConfirmProfile(null)}
                />
              ) : (
                <Button
                  variant={p.id === "restore" ? "ghost" : "secondary"}
                  size="sm"
                  onClick={() => (p.id === "restore" ? debloat(p.id) : setConfirmProfile(p.id))}
                  disabled={busy && debloating !== p.id}
                  loading={debloating === p.id}
                >
                  {p.id === "restore" ? "Restaurar apps" : "Aplicar"}
                </Button>
              )}
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
              {confirmHardware === p.id ? (
                <InlineConfirm
                  question={`Ativar o perfil "${p.title}"?`}
                  detail="Muda energia e limites de processos do aparelho."
                  confirmLabel="Sim, ativar"
                  danger={false}
                  onConfirm={() => hardware(p.id)}
                  onCancel={() => setConfirmHardware(null)}
                />
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmHardware(p.id)} disabled={busy && hardwareBusy !== p.id} loading={hardwareBusy === p.id}>
                  Ativar
                </Button>
              )}
            </div>
          ))}
        </div>
      </FormSection>

      <StatusNote text={status} busy={busy} />
    </div>
  );
}

// ============================================================
// SystemTab
// ============================================================

interface SystemTabProps {
  device: Device;
  serial: string;
  displayName: string;
  agentStatus?: AgentUpdateStatus;
  onRemove?: (device: Device) => Promise<void> | void;
  onClose: () => void;
}

export function SystemTab({ device, serial, displayName, agentStatus, onRemove, onClose }: SystemTabProps) {
  const [msg, setMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [installingApk, setInstallingApk] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [confirmProvision, setConfirmProvision] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const agent = describeAgent(agentStatus);
  const busy = provisioning || installingApk || rebooting;

  // Sem server_url: o backend escolhe o endereço certo (conexão reversa com este computador).
  const reprovision = async () => {
    setConfirmProvision(false);
    setProvisioning(true);
    setMsg("Gravando a identidade e configurando o Agente Esfera...");
    try {
      const res = await api<string>("provision_device", { serial, companyId: device.companyId });
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
    setConfirmReboot(false);
    setRebooting(true);
    setMsg("Enviando comando de reinicialização...");
    try {
      await api("reboot_adb_device", { serial });
      setMsg("Aparelho reiniciando. Ele reconecta sozinho em alguns minutos.");
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
        await onRemove(device);
      } else {
        await api("disconnect_adb_device", { serial }).catch(() => undefined);
        await api("delete_device", { serial: device.esferaDeviceId || serial });
        onClose();
      }
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Não foi possível remover o aparelho.")}`);
      setConfirmDeleteOpen(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Agente Esfera">
        <div className={`rounded-lg border p-3 text-[0.8125rem] ${agent.tone === "danger" ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : agent.tone === "warning" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "border-border bg-secondary text-secondary"}`} title={agent.technical || undefined}>
          {agent.text}
          {agentStatus && agentStatus.expectedCode > 0 && (
            <span className="mt-1 block text-[0.75rem] opacity-80">
              Versão instalada: {agentStatus.versionCode ?? "nenhuma"} · versão do app: {agentStatus.expectedCode}. A atualização é automática.
            </span>
          )}
        </div>
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow
            title="Provisionar agente"
            description={`Grava a identidade ${device.esferaDeviceId || device.serial}, instala ou atualiza o Agente e liga acessibilidade e leitura de notificações (quando o Android permite).`}
          >
            <Button
              variant="primary"
              size="sm"
              onClick={() => setConfirmProvision(true)}
              loading={provisioning}
              disabled={(busy && !provisioning) || confirmProvision}
              icon={<RefreshCw size={13} />}
            >
              Provisionar
            </Button>
          </SettingRow>
          <SettingRow title="Reinstalar APK do Agente" description="Envia e instala de novo a versão do Agente que acompanha este app.">
            <Button variant="secondary" size="sm" onClick={installApk} loading={installingApk} disabled={busy && !installingApk} icon={<Package size={13} />}>
              Reinstalar
            </Button>
          </SettingRow>
          <SettingRow title="Reiniciar aparelho" description="Reinicia o aparelho remotamente; ele reconecta sozinho.">
            <Button variant="secondary" size="sm" onClick={() => setConfirmReboot(true)} loading={rebooting} disabled={(busy && !rebooting) || confirmReboot} icon={<Power size={13} />}>
              Reiniciar
            </Button>
          </SettingRow>
        </div>
        {confirmProvision && (
          <InlineConfirm
            question={`Provisionar ${displayName} agora?`}
            detail="Instala ou atualiza o Agente e reaplica a configuração. Se a instalação falhar com o aparelho no cabo, a conexão ADB de todos os aparelhos é reiniciada: prefira fazer isso fora do horário de disparo."
            confirmLabel="Sim, provisionar"
            danger={false}
            onConfirm={reprovision}
            onCancel={() => setConfirmProvision(false)}
          />
        )}
        {confirmReboot && (
          <InlineConfirm
            question={`Reiniciar ${displayName} agora?`}
            detail="Um envio em andamento neste aparelho será interrompido; o contato volta para a fila."
            confirmLabel="Sim, reiniciar"
            onConfirm={reboot}
            onCancel={() => setConfirmReboot(false)}
          />
        )}
      </FormSection>

      <StatusNote text={msg} busy={busy} />

      <FormSection title="Zona de perigo">
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-[0.8125rem] text-secondary">
              Desconecta o aparelho e apaga o cadastro e o nome dele no sistema. Se ele continuar no cabo ou na rede, volta para a lista como um aparelho novo.
            </p>
          </div>
          {!confirmDeleteOpen ? (
            <Button variant="danger" size="sm" onClick={() => setConfirmDeleteOpen(true)} icon={<Trash2 size={13} />}>
              Remover {displayName}
            </Button>
          ) : (
            <InlineConfirm
              question={
                <>
                  Remover <strong>{displayName}</strong> permanentemente?
                </>
              }
              detail={`ID ${device.esferaDeviceId || device.serial}. Esta ação não pode ser desfeita.`}
              confirmLabel="Sim, remover"
              busy={removing}
              onConfirm={executeRemove}
              onCancel={() => setConfirmDeleteOpen(false)}
            />
          )}
        </div>
      </FormSection>
    </div>
  );
}

// ============================================================
// Página
// ============================================================

export type ConfigTab = "general" | "chip" | "display" | "network" | "performance" | "system";

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  initialTab?: ConfigTab;
  agentStatus?: AgentUpdateStatus;
  // Pode lançar erro: a janela continua aberta e mostra a mensagem.
  onSave: (device: Device) => Promise<void> | void;
  onRemove?: (device: Device) => Promise<void> | void;
  onChipsChanged?: (deviceId: number) => void;
}

export function DeviceConfigModal({ isOpen, onClose, device, initialTab = "general", agentStatus, onSave, onRemove, onChipsChanged }: DeviceConfigModalProps) {
  const [activeTab, setActiveTab] = useState<ConfigTab>(initialTab);

  const [nameInput, setNameInput] = useState(device.name || device.model || "Aparelho");
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [vpsUrl, setVpsUrl] = useState("http://127.0.0.1:8080");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Só recarrega os campos ao abrir ou trocar de aparelho: a atualização periódica da lista
  // gera um objeto novo e apagava o que estava sendo digitado.
  const deviceKey = device.esferaDeviceId || device.serial;
  useEffect(() => {
    if (isOpen) {
      setNameInput(device.name || device.model || "Aparelho");
      setModelInput(device.model || "");
      setSectorInput((device.sector as SectorType) || "junior");
      setActiveTab(initialTab);
      setSaveError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, deviceKey]);

  const serial = isOnlineStatus(device.status) && device.currentAdbAddress ? device.currentAdbAddress : device.serial;
  const origin = getConnectionOrigin(device);
  const dirty =
    nameInput.trim() !== (device.name || device.model || "Aparelho").trim() ||
    modelInput !== (device.model || "") ||
    sectorInput !== ((device.sector as SectorType) || "junior");

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        ...device,
        name: nameInput.trim() || device.name || device.model || "Aparelho",
        model: modelInput || device.model,
        sector: sectorInput,
      });
    } catch (e) {
      setSaveError(errorText(e, "Não foi possível salvar as alterações."));
      setActiveTab("general");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Configurações do aparelho"
      size="lg"
      closeOnOverlayClick={!dirty && !saving}
      footer={
        <>
          {saveError ? (
            <p role="alert" className="mr-auto min-w-0 truncate text-[0.75rem] text-red-600 dark:text-red-400" title={saveError}>
              {saveError}
            </p>
          ) : dirty ? (
            <p className="mr-auto text-[0.75rem] text-tertiary">Alterações de identificação não salvas.</p>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
          <Button variant="primary" size="sm" onClick={save} loading={saving}>
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
            <h3 className="truncate text-sm font-semibold text-primary">{device.name || nameInput}</h3>
            <p className="flex min-w-0 items-center gap-1.5 truncate text-[0.75rem] text-secondary">
              <span className="truncate">
                {modelInput || device.model} · {ORIGIN_LABEL[origin]} ·
              </span>
              <BatteryMeter level={device.battery} />
            </p>
          </div>
        </div>

        <Tabs<ConfigTab>
          items={[
            { id: "general", label: "Geral" },
            { id: "chip", label: "Chip" },
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
        <div className={activeTab === "chip" ? "" : "hidden"}>
          <ChipTab device={device} onChanged={onChipsChanged} />
        </div>
        <div className={activeTab === "display" ? "" : "hidden"}>
          <DisplayTab serial={serial} />
        </div>
        <div className={activeTab === "network" ? "" : "hidden"}>
          <NetworkTab device={device} serial={serial} vpsUrl={vpsUrl} setVpsUrl={setVpsUrl} />
        </div>
        <div className={activeTab === "performance" ? "" : "hidden"}>
          <PerformanceTab serial={serial} />
        </div>
        <div className={activeTab === "system" ? "" : "hidden"}>
          <SystemTab
            device={device}
            serial={serial}
            displayName={device.name || nameInput || "aparelho"}
            agentStatus={agentStatus}
            onRemove={onRemove}
            onClose={onClose}
          />
        </div>
      </div>
    </Modal>
  );
}
