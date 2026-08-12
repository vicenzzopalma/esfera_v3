// ============================================================
// Esfera v3 — Sub-componente DeviceIdentityModal (Linear SaaS Style)
// Modal de diagnóstico de identidade e estado de cada dispositivo
// ============================================================

import Modal from "../ui/Modal";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import type { Device } from "../../types";
import { getConnectionOrigin, CONNECTION_BADGE_CONFIG } from "../../types";
import {
  Smartphone,
  BatteryCharging,
  BatteryLow,
  BatteryFull,
  BatteryWarning,
  Clock,
  Copy,
  Check,
} from "lucide-react";
import { useState } from "react";

interface DeviceIdentityModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device | null;
}

function BatteryIcon({ level }: { level: number }) {
  if (level >= 75) return <BatteryFull size={14} className="text-emerald-400" />;
  if (level >= 40) return <BatteryCharging size={14} className="text-amber-400" />;
  if (level >= 15) return <BatteryWarning size={14} className="text-orange-400" />;
  return <BatteryLow size={14} className="text-red-400" />;
}

function FieldRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
      <span className="text-[11px] text-zinc-500 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 ml-4">
        <span
          className={`text-[11px] text-zinc-200 truncate ${mono ? "font-mono" : ""}`}
          title={value}
        >
          {value}
        </span>
        <button
          onClick={handleCopy}
          className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors shrink-0 cursor-pointer"
          title="Copiar"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
      </div>
    </div>
  );
}

export function DeviceIdentityModal({ isOpen, onClose, device }: DeviceIdentityModalProps) {
  if (!device) return null;

  const origin = getConnectionOrigin(device);
  const badge = CONNECTION_BADGE_CONFIG[origin];
  const displayName = device.name || device.model || `Aparelho ${device.deviceNumber}`;

  const statusConfig = {
    online: { label: "Online", dot: "bg-emerald-400", text: "text-emerald-400" },
    connecting: { label: "Conectando", dot: "bg-amber-400", text: "text-amber-400" },
    offline: { label: "Offline", dot: "bg-zinc-600", text: "text-zinc-400" },
    error: { label: "Erro", dot: "bg-red-400", text: "text-red-400" },
    online_agent: { label: "Online (Agente)", dot: "bg-emerald-400", text: "text-emerald-400" },
  };

  const status = statusConfig[device.status] || statusConfig.offline;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Diagnóstico de Dispositivo"
      size="md"
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Device Header */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-[#09090b] border border-white/[0.06]">
          <div className="p-2.5 rounded-lg bg-[#5E6AD2]/10 border border-[#5E6AD2]/20">
            <Smartphone size={20} className="text-[#828DF7]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{displayName}</h3>
            <p className="text-[10px] text-zinc-500 font-mono">{device.model}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`w-2 h-2 rounded-full ${status.dot} ${device.status === "online" ? "animate-pulse" : ""}`} />
            <span className={`text-[11px] font-medium ${status.text}`}>{status.label}</span>
          </div>
        </div>

        {/* Connection Badge */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase font-semibold text-zinc-500 tracking-wider">Origem:</span>
          <Badge variant={badge.badgeVariant} dot pulse={device.status === "online"}>
            <span>{badge.icon} {badge.label}</span>
          </Badge>
          {device.viaTunnel && (
            <Badge variant="purple">
              <span>Túnel Reverso</span>
            </Badge>
          )}
        </div>

        {/* Diagnostic Fields */}
        <div className="rounded-lg bg-[#09090b] border border-white/[0.06] p-3 space-y-0">
          <FieldRow label="Serial ADB Local" value={device.serial} mono />
          <FieldRow
            label="EsferaDeviceId (VPS)"
            value={device.esferaDeviceId || "Não provisionado"}
            mono
          />
          <FieldRow
            label="IP / Porta ADB"
            value={device.currentAdbAddress || device.ip || "N/A"}
            mono
          />
          <FieldRow label="Company ID" value={String(device.companyId)} mono />
          <div className="flex items-center justify-between py-2 border-b border-white/[0.04]">
            <span className="text-[11px] text-zinc-500">Bateria</span>
            <div className="flex items-center gap-1.5">
              <BatteryIcon level={device.battery} />
              <span className="text-[11px] text-zinc-200 font-mono">{device.battery}%</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-[11px] text-zinc-500 flex items-center gap-1">
              <Clock size={11} />
              Último Sinal (UTC)
            </span>
            <span className="text-[11px] text-zinc-200 font-mono truncate ml-4" title={device.lastSeenUtc || device.lastSeen || "N/A"}>
              {device.lastSeenUtc || device.lastSeen || "N/A"}
            </span>
          </div>
        </div>

        {/* Setor & Número */}
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] flex items-center justify-between">
            <span className="text-[10px] text-zinc-500">Setor</span>
            <span className="text-[11px] text-zinc-200 uppercase font-medium">{device.sector}</span>
          </div>
          <div className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] flex items-center justify-between">
            <span className="text-[10px] text-zinc-500">Nº Dispositivo</span>
            <span className="text-[11px] text-zinc-200 font-mono">#{device.deviceNumber}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
