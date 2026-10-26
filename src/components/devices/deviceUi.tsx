// Utilitários visuais compartilhados da área de Dispositivos.
import { Battery, BatteryLow, BatteryMedium, BatteryFull } from "lucide-react";
import type { Device, DeviceStatus, ConnectionOrigin } from "../../types";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export const STATUS_CONFIG: Record<DeviceStatus, { label: string; tone: StatusTone }> = {
  online: { label: "Online", tone: "success" },
  online_agent: { label: "Online", tone: "success" },
  connecting: { label: "Conectando", tone: "warning" },
  degraded: { label: "Sem ADB", tone: "warning" },
  error: { label: "Erro", tone: "danger" },
  offline: { label: "Offline", tone: "neutral" },
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
    <span className={`inline-flex items-center gap-1.5 text-[0.75rem] font-medium ${TEXT[s.tone]} ${className}`}>
      <span className={`h-2 w-2 rounded-full ${DOT[s.tone]} ${status === "connecting" ? "animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

export function BatteryMeter({ level, className = "" }: { level: number; className?: string }) {
  const value = Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 0;
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

export function sectorLabel(sector?: string) {
  const s = (sector || "junior").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function deviceDisplayName(device: Device) {
  return device.name && device.name.trim() ? device.name.trim() : device.model || device.serial;
}

export const SECTOR_OPTIONS = [
  { id: "junior", label: "Junior" },
  { id: "senior", label: "Senior" },
  { id: "pa_fixa", label: "PA Fixa" },
  { id: "pesquisa", label: "Pesquisa" },
  { id: "juridico", label: "Jurídico" },
  { id: "comercial", label: "Comercial" },
];

export function normSector(s?: string) {
  return String(s || "junior").toLowerCase().replace(/[- _.]/g, "");
}

export const iconBtn =
  "inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:text-primary hover:bg-secondary transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-primary px-3 text-[0.8125rem] text-primary placeholder:text-tertiary focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-glow)] disabled:opacity-50";
