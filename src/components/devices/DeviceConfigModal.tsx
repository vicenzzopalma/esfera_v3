// ============================================================
// Esfera v3 — Configurações do aparelho
// Abas: Geral, Chip, Tela, Rede, Desempenho e Sistema
// ============================================================

import { type ReactNode, useState, useEffect, useCallback } from "react";
import { Loader2, Copy, Check, Sliders, Radio, RefreshCw, Package, Power, Trash2, AlertTriangle, Smartphone, Ban, ShieldCheck } from "lucide-react";
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
  sectorLabel,
  crmChipsForDevice,
  crmStatusTone,
  crmLastSeenText,
  whatsappStatusView,
  type DeviceChip,
  type CrmChip,
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
export function StatusNote({ text: raw, busy = false }: { text: string | null; busy?: boolean }) {
  // Mensagens do backend às vezes começam com emoji: mostra só o texto.
  const text = raw ? raw.replace(/^[^\p{L}\p{N}]+/u, "") : raw;
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
// ChipTab — sem gestão de chips: os números vêm do CRM do VERITAS (só leitura).
// O Esfera mantém sozinho uma linha de envio por aparelho (limites, descanso,
// conta restrita); aqui ela só aparece quando impede o envio.
// ============================================================

const CHIP_TONE_BADGE = { success: "success", warning: "warning", danger: "danger", neutral: "neutral" } as const;

export function ChipTab({ device, onChanged }: { device: Device; onChanged?: (deviceId: number) => void }) {
  const deviceId = device.id;
  const [line, setLine] = useState<DeviceChip | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deviceId) return;
    try {
      const list = await api<DeviceChip[]>("get_device_chips", { deviceId });
      setLine(Array.isArray(list) && list.length > 0 ? list[0] : null);
    } catch {
      setLine(null);
    }
  }, [deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  const release = async () => {
    if (!line) return;
    setActing(true);
    setMsg(null);
    try {
      await api("confirm_chip_release", { chipId: line.id });
      setConfirming(false);
      setMsg("Aparelho liberado. Ele volta a entrar nos disparos.");
      await load();
      onChanged?.(deviceId);
    } catch (e) {
      setMsg(`Erro: ${errorText(e, "Não foi possível liberar o aparelho.")}`);
    } finally {
      setActing(false);
    }
  };

  const view = line ? chipStatusView(line) : null;
  const blocked = view && !view.canSend;

  return (
    <div className="space-y-6">
      {blocked && view && (
        <FormSection title="Envio bloqueado neste aparelho" description={view.detail.replace("Este chip", "Este aparelho").replace("o chip", "o aparelho")}>
          <Badge variant={CHIP_TONE_BADGE[view.tone]} dot>
            {view.label}
          </Badge>
          {line?.status !== "pausado" &&
            (confirming ? (
              <InlineConfirm
                question="Liberar este aparelho para voltar aos disparos?"
                detail="Libere só se você conferiu no aparelho que o WhatsApp abre e envia normalmente. Se a conta estiver mesmo bloqueada, o Esfera volta a bloquear o aparelho na próxima tentativa."
                confirmLabel="Sim, liberar"
                danger={false}
                busy={acting}
                onConfirm={release}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <Button variant="secondary" size="sm" icon={<ShieldCheck size={13} />} onClick={() => setConfirming(true)}>
                Liberar aparelho
              </Button>
            ))}
        </FormSection>
      )}

      <CrmChipsSection device={device} />

      <StatusNote text={msg} busy={acting} />
    </div>
  );
}

// Chips do aparelho no CRM de celulares do VERITAS. Só leitura: nada daqui é
// gravado no Esfera e nenhuma alteração é feita no VERITAS.
function CrmChipsSection({ device }: { device: Device }) {
  const [chips, setChips] = useState<CrmChip[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [lendo, setLendo] = useState(false);

  const ler = useCallback(
    async (forcar = false) => {
      setLendo(true);
      try {
        const todos = await api<CrmChip[]>("get_crm_chips", forcar ? { force: true } : {});
        setChips(crmChipsForDevice(Array.isArray(todos) ? todos : [], device.deviceNumber, device.sector));
        setErro(null);
      } catch (e) {
        setChips(null);
        setErro(errorText(e, "CRM de celulares indisponível."));
      } finally {
        setLendo(false);
      }
    },
    [device.deviceNumber, device.sector]
  );

  useEffect(() => {
    ler();
  }, [ler]);

  return (
    <FormSection
      title="No CRM de celulares (VERITAS)"
      description={`Números que o CRM tem para o aparelho ${device.deviceNumber} do setor ${sectorLabel(device.sector)}. Somente leitura: nada é alterado no VERITAS.`}
    >
      {erro && <StatusNote text={`Erro: ${erro}`} />}
      {!erro && chips && chips.length === 0 && (
        <p className="text-[0.8125rem] text-secondary">
          O CRM não tem nenhum número para este aparelho. Confira se o número do aparelho e o setor são os mesmos nos dois sistemas — é por eles que o cruzamento é feito.
        </p>
      )}
      {(chips || []).map((c) => {
        const wa = whatsappStatusView(c.whatsappStatus);
        return (
          <div key={c.id} className="space-y-2 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-primary">{formatPhone(c.phone)}</p>
                <p className="truncate text-[0.75rem] text-secondary">
                  {c.name || "sem nome no CRM"}
                  {c.holder ? ` · com ${c.holder}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge variant={CHIP_TONE_BADGE[crmStatusTone(c.status)]} dot>
                  {c.status || "sem status"}
                </Badge>
                <Badge variant={CHIP_TONE_BADGE[wa.tone]} dot>
                  {wa.label}
                </Badge>
              </div>
            </div>
            <p className="text-[0.8125rem] text-secondary">
              {wa.detail} {c.whatsappName ? `Conexão "${c.whatsappName}". ` : ""}
              <span className="text-tertiary">({crmLastSeenText(c.whatsappLastSeen)})</span>
            </p>
            {c.alarmActive && <p className="text-[0.8125rem] text-amber-700 dark:text-amber-400">Alarme ativo no CRM para este número.</p>}
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={() => ler(true)} loading={lendo} icon={<RefreshCw size={13} />}>
        Ler o CRM de novo
      </Button>
    </FormSection>
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

// ============================================================
// Isolamento de rede por aparelho — gerenciador central
// Perfil próprio, lote de N confirmações com verificação do IP
// de saída medido DE DENTRO do aparelho, e pausa só deste aparelho.
// ============================================================

interface NetProfile {
  deviceId: number; mode: string; proxyUrl: string; allowedEgressIps: string;
  batchSize: number; status: string; pauseReason: string;
  vpnPackage: string; vpnTunnel: string; lockdown: boolean;
  lastEgressIp: string; lastEgressAt: string; lastEgressResult: string; consecutiveFailures: number;
}
interface NetCheck { checkId: number; checkedAt: string; observedIp: string; mode: string; appliedRoute: string; phase: string; result: string; detail: string }
interface NetStatus {
  profile: NetProfile;
  lastCheck: NetCheck | null;
  openBatch: { batchId: number; confirmed: number; failed: number; uncertain: number; target: number } | null;
  recentBatches: { batchId: number; startedAt: string; closedAt: string; confirmed: number; failed: number; uncertain: number; egressIp: string; verification: string }[];
  recentChecks: NetCheck[];
}

const NETWORK_MODES: { id: string; label: string; desc: string }[] = [
  { id: "direto", label: "Direto (fila compartilhada)", desc: "Sem rota própria: o aparelho divide a fila conservadora com os demais e não recebe portão dedicado." },
  { id: "wireguard", label: "WireGuard always-on (recomendado)", desc: "VPN sempre ativa com bloqueio de conexões fora dela. É o único arranjo que captura todo o tráfego do Android, WhatsApp incluído, e a verificação confirma a rota de dentro do aparelho." },
  { id: "socks5", label: "Proxy SOCKS5/HTTP (alternativa)", desc: "Grava o proxy no sistema, mas o WhatsApp não honra proxy de sistema: isto NÃO controla o tráfego dele. Serve só onde o app respeita o proxy, e aqui nunca é tratado como prova de rota." },
];

const PHASE_LABEL: Record<string, string> = {
  pre_lote: "antes do lote",
  fim_lote: "fim do lote",
  manual: "manual",
};

export function NetworkIsolationSection({ device }: { device: Device }) {
  const online = isOnlineStatus(device.status);
  const [st, setSt] = useState<NetStatus | null>(null);
  const [mode, setMode] = useState("direto");
  const [proxyUrl, setProxyUrl] = useState("");
  const [allowed, setAllowed] = useState("");
  const [vpnPackage, setVpnPackage] = useState("com.wireguard.android");
  const [vpnTunnel, setVpnTunnel] = useState("");
  const [lockdown, setLockdown] = useState(true);
  const [batchSize, setBatchSize] = useState(10);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api<NetStatus>("get_device_network_status", { deviceId: device.id });
      setSt(res);
      const p = res.profile;
      setMode(p.mode); setProxyUrl(p.proxyUrl); setAllowed(p.allowedEgressIps);
      setVpnPackage(p.vpnPackage || "com.wireguard.android"); setVpnTunnel(p.vpnTunnel);
      setLockdown(p.lockdown); setBatchSize(p.batchSize);
    } catch { /* a tela continua com o último estado conhecido */ }
  }, [device.id]);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setSaving(true);
    try {
      await api<NetProfile>("set_network_profile", {
        deviceId: device.id, mode, proxyUrl, allowedEgressIps: allowed, batchSize,
        vpnPackage, vpnTunnel, lockdown,
      });
      setStatus("Perfil salvo. Use \"Aplicar no aparelho\" para ligar a rota e conferir o IP de saída de dentro dele.");
      await reload();
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Não foi possível salvar o perfil de rede.")}`);
    } finally { setSaving(false); }
  };

  const applyRoute = async () => {
    setApplying(true);
    try {
      const r = await api<NetCheck>("apply_device_network_route", { deviceId: device.id });
      setStatus(`Rota aplicada e conferida: IP ${r.observedIp || "—"} — ${r.result}${r.detail ? ` (${r.detail})` : ""}`);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Não foi possível aplicar a rota no aparelho.")}`);
    } finally { setApplying(false); await reload(); }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const r = await api<{ observedIp: string; result: string; detail: string }>("check_device_egress_now", { deviceId: device.id });
      setStatus(`Verificação: IP ${r.observedIp || "—"} — ${r.result}${r.detail ? ` (${r.detail})` : ""}`);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Não foi possível verificar a rota agora.")}`);
    } finally { setChecking(false); await reload(); }
  };

  const setPaused = async (paused: boolean) => {
    try {
      await api(paused ? "pause_device_network" : "resume_device_network", { deviceId: device.id, reason: undefined });
      await reload();
    } catch (e: any) { setStatus(`Erro: ${errText(e, "Falha ao alterar a pausa de rede.")}`); }
  };

  const p = st?.profile;
  const paused = p ? p.status !== "ativo" : false;
  const modeInfo = NETWORK_MODES.find((m) => m.id === mode);

  return (
    <FormSection
      title="Isolamento de rede por aparelho"
      description="Este aparelho só divide a fila com os demais se estiver em modo direto. Configurar um proxy NÃO prova que o tráfego do WhatsApp passou por ele: a verdade é o IP público lido de dentro do aparelho a cada lote."
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-medium text-primary">Estado da rede deste aparelho</p>
            <p className="mt-0.5 text-[0.75rem] text-secondary">
              {p ? (
                <>
                  <Badge variant={paused ? "danger" : mode === "direto" ? "neutral" : "success"}>
                    {mode === "direto" ? "Fila compartilhada" : paused ? p.status.replace("_", " ") : "Rota isolada"}
                  </Badge>{" "}
                  Egresso {p.lastEgressIp || "desconhecido"} ({p.lastEgressResult || "sem verificação"}
                  {(() => { const d = p.lastEgressAt ? parseDbDate(p.lastEgressAt) : null; return d ? ` — ${formatWhen(d)}` : ""; })()})
                </>
              ) : "Carregando..."}
            </p>
            {paused && p?.pauseReason && <p className="mt-1 break-words text-[0.75rem] text-red-500">{p.pauseReason}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" icon={<Radio size={13} />} onClick={checkNow} loading={checking} disabled={!online}>
              Verificar agora
            </Button>
            {paused ? (
              <Button variant="secondary" size="sm" icon={<ShieldCheck size={13} />} onClick={() => setPaused(false)} disabled={!online}>
                Retomar
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={<Ban size={13} />} onClick={() => setPaused(true)}>
                Pausar
              </Button>
            )}
          </div>
        </div>

        <Field label="Modo de rede" htmlFor="cfg-net-mode">
          <select id="cfg-net-mode" value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
            {NETWORK_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {modeInfo && <p className="mt-1 text-[0.75rem] text-secondary">{modeInfo.desc}</p>}
        </Field>

        {mode === "wireguard" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="App de VPN (pacote Android)" htmlFor="cfg-net-vpnpkg">
                <input id="cfg-net-vpnpkg" type="text" value={vpnPackage} onChange={(e) => setVpnPackage(e.target.value)} placeholder="com.wireguard.android" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Túnel a subir (opcional)" htmlFor="cfg-net-tunnel">
                <input id="cfg-net-tunnel" type="text" value={vpnTunnel} onChange={(e) => setVpnTunnel(e.target.value)} placeholder="esfera" className={`${inputCls} font-mono`} />
              </Field>
            </div>
            <SettingRow title="Bloquear conexões fora da VPN (lockdown)" description="Sem isso, o Android deixa o tráfego sair direto quando o túnel cai. Exigido para a rota ser considerada íntegra.">
              <Toggle checked={lockdown} onChange={setLockdown} />
            </SettingRow>
          </>
        )}

        {mode === "socks5" && (
          <Field label="Endereço do proxy" htmlFor="cfg-net-proxy">
            <input id="cfg-net-proxy" type="text" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://usuario:senha@host:8080" className={`${inputCls} font-mono`} />
          </Field>
        )}

        {mode !== "direto" && (
          <Field label="IPs de saída autorizados (separados por vírgula; vazio = só registrar)" htmlFor="cfg-net-ips">
            <input id="cfg-net-ips" type="text" value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="203.0.113.7, 203.0.113.8" className={`${inputCls} font-mono`} />
          </Field>
        )}

        <Field label="Envios confirmados por lote (verificação da rota)" htmlFor="cfg-net-batch">
          <input id="cfg-net-batch" type="number" min={1} max={1000} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value) || 10)} className={inputCls} />
          <p className="mt-1 text-[0.75rem] text-secondary">Só envios confirmados contam. A cada {batchSize} o lote fecha, a rota é conferida de dentro do aparelho e o lote seguinte só começa com a verificação aprovada.</p>
        </Field>

        {st?.openBatch && (
          <div className="rounded-lg border border-border px-3 py-2 text-[0.75rem] text-secondary">
            Lote em andamento #{st.openBatch.batchId}: {st.openBatch.confirmed}/{st.openBatch.target} confirmados
            {" · "}{st.openBatch.failed} falhas{st.openBatch.uncertain ? ` · ${st.openBatch.uncertain} incertos` : ""}
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary/30">
              <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${Math.min(100, (st.openBatch.confirmed / Math.max(1, st.openBatch.target)) * 100)}%` }} />
            </div>
          </div>
        )}

        {st && st.recentBatches.length > 0 && (
          <div className="max-h-36 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-[0.72rem] text-secondary">
              <thead className="sticky top-0 bg-secondary/20 text-left">
                <tr><th className="px-2 py-1">Lote</th><th className="px-2 py-1">Confirmados</th><th className="px-2 py-1">Falhas</th><th className="px-2 py-1">Egresso</th><th className="px-2 py-1">Verificação</th></tr>
              </thead>
              <tbody>
                {st.recentBatches.map((b) => (
                  <tr key={b.batchId} className="border-t border-border/50">
                    <td className="px-2 py-1">#{b.batchId}</td>
                    <td className="px-2 py-1">{b.confirmed}</td>
                    <td className="px-2 py-1">{b.failed}{b.uncertain ? ` (+${b.uncertain} incertos)` : ""}</td>
                    <td className="px-2 py-1 font-mono">{b.egressIp || "—"}</td>
                    <td className={`px-2 py-1 ${b.verification === "vazamento" ? "text-red-500" : b.verification === "ok" ? "text-green-500" : ""}`}>{b.verification}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {st && st.recentChecks.length > 0 && (
          <div className="max-h-36 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-[0.72rem] text-secondary">
              <thead className="sticky top-0 bg-secondary/20 text-left">
                <tr><th className="px-2 py-1">Quando</th><th className="px-2 py-1">Fase</th><th className="px-2 py-1">IP observado</th><th className="px-2 py-1">Resultado</th></tr>
              </thead>
              <tbody>
                {st.recentChecks.map((c) => {
                  const d = parseDbDate(c.checkedAt);
                  return (
                    <tr key={c.checkId} className="border-t border-border/50">
                      <td className="px-2 py-1">{d ? formatWhen(d) : c.checkedAt}</td>
                      <td className="px-2 py-1">{PHASE_LABEL[c.phase] || c.phase}</td>
                      <td className="px-2 py-1 font-mono">{c.observedIp || "—"}</td>
                      <td className={`px-2 py-1 ${c.result === "vazamento" ? "text-red-500" : c.result === "ok" ? "text-green-500" : "text-amber-500"}`} title={c.detail}>{c.result}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="md" onClick={save} loading={saving}>Salvar perfil</Button>
          {mode !== "direto" && (
            <Button variant="secondary" size="md" icon={<ShieldCheck size={14} />} onClick={applyRoute} loading={applying} disabled={!online}>
              Aplicar no aparelho e conferir
            </Button>
          )}
        </div>
        <StatusNote text={status} busy={saving || checking || applying} />
      </div>
    </FormSection>
  );
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

      <NetworkIsolationSection device={device} />

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
            { id: "chip", label: "Chips" },
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
