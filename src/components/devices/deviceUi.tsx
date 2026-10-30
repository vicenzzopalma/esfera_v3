// Utilitários visuais compartilhados da área de Dispositivos.
import type { ReactNode } from "react";
import { Battery, BatteryLow, BatteryMedium, BatteryFull, BatteryWarning } from "lucide-react";
import type { Device, DeviceStatus, ConnectionOrigin } from "../../types";
import { confirmDialog } from "../ui/Modal";
import { showToast, type ToastVariant } from "../ui/ToastContainer";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export const STATUS_CONFIG: Record<DeviceStatus, { label: string; tone: StatusTone; hint?: string }> = {
  online: { label: "Online", tone: "success" },
  online_agent: { label: "Online", tone: "success" },
  connecting: {
    label: "Conectando",
    tone: "warning",
    hint: "Se o aparelho estiver no cabo USB, desbloqueie a tela e toque em Permitir na janela de depuração USB.",
  },
  degraded: {
    label: "Sem conexão",
    tone: "warning",
    hint: "Cadastrado, mas este computador não consegue controlá-lo agora: sem cabo USB, Wi-Fi ou túnel ativo.",
  },
  error: { label: "Erro", tone: "danger" },
  offline: { label: "Offline", tone: "neutral", hint: "Sem sinal do aparelho." },
};

const DOT: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-zinc-500",
};

const TEXT: Record<StatusTone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  neutral: "text-secondary",
};

export function getStatus(status: DeviceStatus) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.offline;
}

export function isOnlineStatus(status: DeviceStatus) {
  return status === "online" || status === "online_agent";
}

export function StatusDot({ status, className = "" }: { status: DeviceStatus; className?: string }) {
  const s = getStatus(status);
  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.75rem] font-medium ${TEXT[s.tone]} ${className}`} title={s.hint}>
      <span className={`h-2 w-2 rounded-full ${DOT[s.tone]} ${status === "connecting" ? "animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

// Bateria 0 vem de aparelho sem leitura (offline): mostra "—" em vez de um 0% vermelho falso.
export function BatteryMeter({ level, className = "" }: { level: number; className?: string }) {
  const known = Number.isFinite(level) && level > 0;
  if (!known) {
    return (
      <span className={`inline-flex items-center gap-1 text-[0.75rem] tabular-nums text-tertiary ${className}`} title="Bateria sem leitura">
        <BatteryWarning size={14} className="text-tertiary" />—
      </span>
    );
  }
  const value = Math.max(0, Math.min(100, level));
  const color = value > 50 ? "text-emerald-500" : value > 20 ? "text-amber-500" : "text-red-500";
  const Icon = value > 75 ? BatteryFull : value > 30 ? BatteryMedium : value > 10 ? BatteryLow : Battery;
  return (
    <span className={`inline-flex items-center gap-1 text-[0.75rem] tabular-nums text-secondary ${className}`} title={`Bateria ${value}%`}>
      <Icon size={14} className={color} />
      {value}%
    </span>
  );
}

export const ORIGIN_LABEL: Record<ConnectionOrigin, string> = {
  vps: "Nuvem",
  usb: "USB",
  wifi: "Wi-Fi",
};

export const SECTOR_OPTIONS = [
  { id: "junior", label: "Júnior" },
  { id: "senior", label: "Sênior" },
  { id: "pa_fixa", label: "PA Fixa" },
  { id: "pesquisa", label: "Pesquisa" },
  { id: "juridico", label: "Jurídico" },
  { id: "comercial", label: "Comercial" },
];

export function normSector(s?: string) {
  return String(s || "junior").toLowerCase().replace(/[- _.]/g, "");
}

export function sectorLabel(sector?: string) {
  const known = SECTOR_OPTIONS.find((o) => normSector(o.id) === normSector(sector));
  if (known) return known.label;
  const s = (sector || "junior").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function deviceDisplayName(device: Device) {
  return device.name && device.name.trim() ? device.name.trim() : device.model || device.serial;
}

// Chave estável do aparelho: o ID do Esfera (ESF-…) não muda com IP ou cabo.
export function deviceKey(device: Pick<Device, "esferaDeviceId" | "serial">) {
  return device.esferaDeviceId || device.serial;
}

export const iconBtn =
  "inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:text-primary hover:bg-secondary transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-[var(--color-bg-input)] px-3 text-[0.8125rem] text-primary placeholder:text-tertiary focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-glow)] disabled:opacity-50";

// ============================================================
// Mensagens de erro legíveis
// ============================================================

// Traduz erros técnicos do backend para o operador; o resto passa como veio.
export function errorText(e: unknown, fallback: string): string {
  const raw = typeof e === "string" ? e : (e as { message?: string } | null)?.message || "";
  const msg = String(raw).trim();
  if (!msg) return fallback;
  const lower = msg.toLowerCase();
  if (lower.includes("token de sessão inválido")) return "Sua sessão expirou. Entre novamente.";
  if (lower.includes("missing required key") || lower.includes("invalid args")) return `${fallback} O app enviou dados incompletos; atualize o Esfera.`;
  if (lower.includes("command") && lower.includes("not found")) return `${fallback} Esta função não existe nesta versão do app.`;
  if (lower.startsWith("erro no processo")) return `${fallback} Houve uma falha interna; tente novamente.`;
  if (lower.startsWith("acesso negado")) return msg.replace(/^acesso negado:\s*/i, "Sem permissão: ");
  return msg.replace(/^(erro|error)\s*:\s*/i, "");
}

// ============================================================
// Datas (SQLite grava em UTC: "AAAA-MM-DD HH:MM:SS")
// ============================================================

export function parseDbDate(value?: string | null): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const iso = v.includes("T") ? v : `${v.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatWhen(d: Date) {
  const now = new Date();
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `hoje às ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `amanhã às ${time}`;
  const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return `${date} às ${time}`;
}

export function formatAgo(d: Date) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return formatWhen(d);
}

// ============================================================
// Chips (linha do WhatsApp) por aparelho
// ============================================================

// Formato devolvido por get_device_chips. O status pode vir como "pausado" (descanso
// automático por poucas respostas), que não existe no tipo Chip global.
export interface DeviceChip {
  id: number;
  deviceId: number;
  phoneNumber: string;
  chipName: string;
  status: string;
  restrictedUntil?: string | null;
  createdAt: string;
}

export type ChipTone = "success" | "warning" | "danger" | "neutral";

export function formatPhone(raw: string) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw || "sem número";
}

function untilText(value?: string | null) {
  const d = parseDbDate(value);
  if (d) return d.getFullYear() >= 9000 ? null : formatWhen(d);
  const m = /^(\d+)\s*days?$/i.exec(String(value || "").trim());
  if (m) return `por ${m[1]} dia${m[1] === "1" ? "" : "s"}`;
  return null;
}

// Rótulo, tom e explicação do status de um chip. Só "livre" sem restrição envia.
export function chipStatusView(chip: DeviceChip): { label: string; tone: ChipTone; detail: string; canSend: boolean } {
  const until = untilText(chip.restrictedUntil);
  switch (chip.status) {
    case "livre":
      if (chip.restrictedUntil) return { label: "Restrito", tone: "warning", detail: until ? `Restrito ${until.startsWith("por") ? until : `até ${until}`}.` : "Restrito.", canSend: false };
      return { label: "Livre", tone: "success", detail: "Pronto para enviar.", canSend: true };
    case "pausado":
      return {
        label: "Em descanso",
        tone: "warning",
        detail: `Poucas respostas recentes: o chip descansa${until ? ` até ${until}` : ""} para proteger o número. Ele volta sozinho.`,
        canSend: false,
      };
    case "banido":
      return { label: "Banido", tone: "danger", detail: "O WhatsApp indicou conta restrita ou banida. Este chip não envia.", canSend: false };
    case "restrito_24h":
    case "restrito_7d":
    case "restrito_custom":
      return { label: "Restrito", tone: "warning", detail: until ? `Restrito ${until.startsWith("por") ? until : `até ${until}`}.` : "Restrito.", canSend: false };
    case "em_uso":
      return { label: "Em uso", tone: "warning", detail: "Marcado como em uso: fica fora dos disparos.", canSend: false };
    default:
      return { label: chip.status || "Desconhecido", tone: "neutral", detail: "Status não reconhecido.", canSend: false };
  }
}

// Resumo para o card: o disparo exige exatamente um chip cadastrado por aparelho.
export function chipSummary(chips: DeviceChip[] | undefined): { label: string; tone: ChipTone; title: string; phone?: string } | null {
  if (!chips) return null;
  if (chips.length === 0) {
    return { label: "Sem chip", tone: "warning", title: "Cadastre o chip em Configurações > Chip. Sem ele o aparelho não entra nos disparos." };
  }
  if (chips.length > 1) {
    return { label: `${chips.length} chips`, tone: "danger", title: "O disparo exige exatamente um chip por aparelho. Deixe só o chip em uso." };
  }
  const view = chipStatusView(chips[0]);
  return { label: `Chip ${view.label.toLowerCase()}`, tone: view.tone, title: view.detail, phone: formatPhone(chips[0].phoneNumber) };
}

// ============================================================
// Confirmação e avisos: usam a fila global do app (ConfirmHost e ToastContainer
// montados no App.tsx), no lugar de window.confirm e window.alert.
// ============================================================

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  return confirmDialog(req);
}

export type NoticeTone = ToastVariant;
export type Notify = (variant: NoticeTone, title: string, description?: string) => void;

// Erro fica na tela até o operador fechar; o resto some sozinho.
export const notify: Notify = (variant, title, description) => {
  showToast(variant, title, { description, duration: variant === "danger" ? 0 : undefined });
};
