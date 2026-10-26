// Utilitários e peças pequenas compartilhadas pela tela de Campanhas.
import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import type { Campaign, CampaignStatus, Contact, Device } from "../../types";
import { AI_PROVIDERS } from "../../constants/aiProviders";

export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral" | "purple";

export const STATUS_CONFIG: Record<CampaignStatus | "stopped", { variant: BadgeVariant; label: string }> = {
  running: { variant: "success", label: "Em andamento" },
  paused: { variant: "warning", label: "Pausada" },
  stopped: { variant: "warning", label: "Interrompida" },
  completed: { variant: "info", label: "Concluída" },
  draft: { variant: "neutral", label: "Rascunho" },
  error: { variant: "danger", label: "Erro" },
};

export function statusInfo(status: string) {
  return STATUS_CONFIG[status as CampaignStatus] || STATUS_CONFIG.draft;
}

export const nowTime = () => new Date().toLocaleTimeString("pt-BR");

export function campaignUsesAi(c?: Campaign | null): boolean {
  return Boolean(c?.useAi ?? c?.useAI ?? false);
}

// ---------- Contagens ----------
export interface CampaignCounts {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  progress: number;
}

export function countsFromCampaign(c: Campaign): CampaignCounts {
  const total = c.contactsCount || 0;
  const sent = c.sentCount || 0;
  const failed = c.failedCount || 0;
  const pending = Math.max(0, total - sent - failed);
  const progress = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
  return { total, sent, failed, pending, progress };
}

// Mesma regra da janela de execução original: prioriza a lista real de contatos.
export function countsFromContacts(c: Campaign, contacts: Contact[]): CampaignCounts {
  const total = contacts.length || c.contactsCount || 0;
  const sent = contacts.filter((x) => x.status === "sent").length || c.sentCount || 0;
  const failed = contacts.filter((x) => x.status === "failed").length || c.failedCount || 0;
  const pending = contacts.length ? contacts.filter((x) => x.status === "pending").length : Math.max(0, total - sent - failed);
  const progress = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
  return { total, sent, failed, pending, progress };
}

export function formatNumber(n: number) {
  return n.toLocaleString("pt-BR");
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export function formatDate(value?: string): string {
  if (!value) return "—";
  // O SQLite grava CURRENT_TIMESTAMP em UTC sem fuso ("2026-10-26 20:30:42"): trata como UTC.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : sqliteUtc ? `${value.replace(" ", "T")}Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  const hasTime = value.length > 10;
  return hasTime
    ? d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function delaySummary(min: number, max: number) {
  return min === max ? `${min}s entre mensagens` : `entre ${min}s e ${max}s por mensagem`;
}

// ---------- Contatos (importação) ----------
// Higieniza números no padrão REALESS / Esfera v3 (Brasil, DDI +55).
// NÃO inventa DDD: apenas normaliza o que o usuário informou.
//  - já com DDI 55 (12-13 dígitos) -> mantém
//  - com DDD (10-11 dígitos)         -> prefixa +55
//  - só número local (8-9 dígitos)   -> não infere DDD, retorna limpo
export function sanitizePhoneNumber(raw: string) {
  const clean = raw.replace(/\D/g, "");
  if (clean.length === 0) return "";
  if (clean.startsWith("55") && (clean.length === 12 || clean.length === 13)) return "+" + clean;
  if (clean.length === 10 || clean.length === 11) return "+55" + clean;
  return "+" + clean;
}

export interface ParsedRow {
  line: number;
  raw: string;
  name: string;
  phone: string;
  valid: boolean;
  warning?: string;
  reason?: string;
}

// Mesma regra do importador original: "Nome, Telefone" (separadores , ; ou tab);
// linha sem separador = só telefone com nome "Cliente". Válido se telefone > 5 caracteres.
export function parseContactsText(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const parts = line.split(/[,;\t]/);
    let name = "Cliente";
    let rawPhone = line;
    if (parts.length >= 2) {
      name = parts[0].trim();
      rawPhone = parts[1].trim();
    }
    const phone = sanitizePhoneNumber(rawPhone);
    const valid = phone.length > 5;
    const digits = phone.replace(/\D/g, "");
    let warning: string | undefined;
    if (valid) {
      if (digits.length < 10) warning = "Sem DDD";
      else if (digits.length > 13) warning = "Número longo";
    }
    rows.push({
      line: idx + 1,
      raw: line.trim(),
      name,
      phone,
      valid,
      warning,
      reason: valid ? undefined : digits.length === 0 ? "Sem telefone" : "Telefone curto demais",
    });
  });
  return rows;
}

// ---------- Spintax ----------
export function resolveSpintaxLocal(text: string) {
  let resolved = text;
  const spintaxRegex = /\{([^{}]+)\}/g;
  let match;
  let maxIterations = 100;
  while ((match = spintaxRegex.exec(resolved)) !== null && maxIterations-- > 0) {
    const options = match[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)];
    resolved = resolved.replace(match[0], chosen);
    spintaxRegex.lastIndex = 0;
  }
  return resolved;
}

// Conta combinações possíveis (blocos internos primeiro). Limitado para não explodir.
export function spintaxCombinations(text: string): number {
  let work = text;
  let total = 1;
  const re = /\{([^{}]*)\}/;
  let guard = 200;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) && guard-- > 0) {
    const n = m[1].split("|").length;
    total = Math.min(total * n, 1_000_000_000);
    work = work.slice(0, m.index) + "x" + work.slice(m.index + m[0].length);
  }
  return total;
}

const NAME_VARS = /\{(nome|Nome|NOME|name|Name)\}/g;

export function hasNameVariable(text: string) {
  return /\{(nome|Nome|NOME|name|Name)\}/.test(text);
}

export function fillSampleName(text: string, sample = "Maria") {
  return text.replace(NAME_VARS, sample);
}

// Junta saudação + corpo + encerramento como o motor de disparo faz.
export function joinMessage(greeting: string, body: string, closing: string) {
  let full = "";
  if (greeting.trim()) full += greeting + " ";
  full += body;
  if (closing.trim()) full += " " + closing;
  return full.trim();
}

// ---------- Aparelhos ----------
export const deviceKey = (d: Device) => d.esferaDeviceId || d.serial;
export const isDeviceOnline = (d: Device) => d.status === "online";
// Nome do aparelho é soberano: nunca gerar nome; usa o que existe.
export const deviceLabel = (d: Device) => d.name || d.model || d.serial;

export function sortDevices(devices: Device[]) {
  return [...devices].sort((a, b) => {
    const aOnline = isDeviceOnline(a) ? 1 : 0;
    const bOnline = isDeviceOnline(b) ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    const aNum = typeof a.deviceNumber === "number" ? a.deviceNumber : 9999;
    const bNum = typeof b.deviceNumber === "number" ? b.deviceNumber : 9999;
    if (aNum !== bNum) return aNum - bNum;
    return (a.name || a.model || "").localeCompare(b.name || b.model || "", undefined, { numeric: true });
  });
}

// ---------- IA ----------
export function ProviderOptions({ includeDefault }: { includeDefault?: boolean }) {
  return (
    <>
      {includeDefault && <option value="">Padrão da empresa</option>}
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
      <optgroup label="Pagas e personalizadas">
        {AI_PROVIDERS.filter((p) => p.category === "paid_custom").map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </optgroup>
    </>
  );
}

// ---------- Peças visuais ----------
export function ProgressBar({
  total,
  sent,
  failed,
  size = "sm",
  completed,
}: {
  total: number;
  sent: number;
  failed: number;
  size?: "sm" | "lg";
  completed?: boolean;
}) {
  const sentPct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  const failPct = total > 0 ? Math.min(100 - sentPct, (failed / total) * 100) : 0;
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-secondary ${size === "lg" ? "h-2.5" : "h-1.5"}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(sentPct + failPct)}
    >
      <div
        className={`h-full transition-[width] duration-500 ${completed ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`}
        style={{ width: `${sentPct}%` }}
      />
      {failPct > 0 && <div className="h-full bg-red-500/80 transition-[width] duration-500" style={{ width: `${failPct}%` }} />}
    </div>
  );
}

export function InlineAlert({
  tone = "danger",
  title,
  children,
  icon,
  action,
  onDismiss,
}: {
  tone?: "danger" | "warning" | "info" | "success";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    danger: "border-red-500/25 bg-red-500/[0.07] text-red-500 dark:text-red-300",
    warning: "border-amber-500/25 bg-amber-500/[0.07] text-amber-600 dark:text-amber-300",
    info: "border-sky-500/25 bg-sky-500/[0.07] text-sky-600 dark:text-sky-300",
    success: "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-600 dark:text-emerald-300",
  } as const;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[0.8125rem] ${tones[tone]}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={`${title ? "mt-0.5" : ""} text-secondary`}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Fechar aviso" className="shrink-0 rounded-md p-0.5 text-tertiary hover:text-[var(--color-text-primary)] cursor-pointer">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={`relative flex items-center ${className}`}>
      <Search size={15} aria-hidden className="input-icon-left text-tertiary" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        className="input-with-icon-left !h-9"
      />
    </div>
  );
}
