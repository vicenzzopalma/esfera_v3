// ============================================================
// Esfera v3 — Sub-componente DeviceCard (Linear SaaS Style)
// Card compacto e elegante para exibição do celular no Hub
// ============================================================

import { memo, useState } from "react";
import type { Device } from "../../types";
import { getConnectionOrigin, CONNECTION_BADGE_CONFIG } from "../../types";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import {
  Zap,
  Camera,
  MoreVertical,
  BatteryCharging,
  Info,
} from "lucide-react";

interface DeviceCardProps {
  device: Device;
  activeUserDisplayName?: string;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpenMirror: () => void;
  onOpenConfig: () => void;
  onOpenRegion: () => void;
  onForceWireless: () => void;
  onOpenDiagnostic: () => void;
}

export const DeviceCard = memo(function DeviceCard({
  device,
  activeUserDisplayName,
  isSelected,
  onToggleSelect,
  onOpenMirror,
  onOpenConfig,
  onOpenRegion,
  onForceWireless,
  onOpenDiagnostic,
}: DeviceCardProps) {

  const displayName = device.name || (device.deviceNumber ? `Aparelho ${device.deviceNumber}` : device.serial);
  const displayModel = device.model && device.model !== "Smartphone" && device.model !== "Android"
    ? device.model
    : (device.brand && device.brand !== "Android" ? `${device.brand} Smartphone` : "Android Smartphone");
  const isUsbOnly = device.status === "online" && !device.serial.includes(":") && !device.viaTunnel;
  const origin = getConnectionOrigin(device);
  const originBadge = CONNECTION_BADGE_CONFIG[origin];

  const [copiedId, setCopiedId] = useState(false);

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    const id = device.esferaDeviceId || device.serial;
    navigator.clipboard.writeText(id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1500);
  };

  return (
    <div
      className={`rounded-lg bg-[#141418] border transition-all duration-150 p-3.5 flex flex-col justify-between space-y-3 relative group ${
        isSelected
          ? "border-[#5E6AD2] bg-[#5E6AD2]/[0.04] ring-1 ring-[#5E6AD2]/30"
          : "border-white/[0.07] hover:border-[#5E6AD2]/40 hover:bg-[#16161b]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="w-3.5 h-3.5 rounded border-white/20 bg-zinc-900 text-[#5E6AD2] focus:ring-0 cursor-pointer shrink-0"
          />

          <span className="relative flex h-2 w-2 shrink-0">
            {device.status === "online" && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            )}
            {(device.status === "connecting" || device.status === "degraded") && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-pulse" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                device.status === "online"
                  ? "bg-emerald-400"
                  : device.status === "connecting"
                  ? "bg-amber-400"
                  : device.status === "degraded"
                  ? "bg-amber-500"
                  : device.status === "error"
                  ? "bg-red-400"
                  : "bg-zinc-600"
              }`}
            />
          </span>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-sm text-zinc-100 truncate" title={displayName}>
                {displayName}
              </span>
              <span className="px-1.5 py-0.2 rounded bg-[#5E6AD2]/15 text-[#828DF7] text-[9px] font-mono uppercase font-semibold border border-[#5E6AD2]/30">
                {device.sector.replace("_", " ")}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="text-[11px] text-zinc-400 font-medium truncate" title={displayModel}>
                {displayModel}
              </p>
              <Badge variant={originBadge.badgeVariant} className="text-[8px] px-1 py-0">
                {originBadge.icon} {originBadge.label}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onOpenDiagnostic}
            className="p-1 rounded text-zinc-500 hover:text-[#828DF7] hover:bg-[#5E6AD2]/10 transition-colors cursor-pointer"
            title="Diagnóstico do dispositivo"
          >
            <Info size={14} />
          </button>

          <button
            onClick={onOpenConfig}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="Configurações, provisionamento e ações do celular"
          >
            <MoreVertical size={14} />
          </button>
        </div>
      </div>

      {activeUserDisplayName && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span>Em uso: <strong>{activeUserDisplayName}</strong></span>
        </div>
      )}

      <div className="flex flex-col gap-1 text-[10px] font-mono bg-white/[0.02] p-2 rounded border border-white/[0.04]">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleCopyId}
            className="text-zinc-300 font-semibold flex items-center gap-1 min-w-0 hover:text-white transition-colors cursor-pointer group/id"
            title="Clique para copiar ID de hardware"
          >
            <span className="text-[#828DF7] font-bold">ID:</span>
            <span className="truncate max-w-[125px] text-zinc-200 group-hover/id:text-[#828DF7]" title={device.esferaDeviceId || device.serial}>
              {device.esferaDeviceId || device.serial}
            </span>
            <span className="text-[9px] px-1 py-0.2 rounded bg-white/[0.06] text-zinc-400 shrink-0 font-sans">
              {copiedId ? "Copiado!" : "copiar"}
            </span>
          </button>
          <div className="flex items-center gap-1 text-zinc-300 shrink-0 ml-2">
            <BatteryCharging size={11} className={device.battery > 50 ? "text-emerald-400" : device.battery > 20 ? "text-amber-400" : "text-red-400"} />
            <span className="font-mono">{device.battery}%</span>
          </div>
        </div>
        <div className="flex items-center justify-between text-zinc-500 text-[9px] pt-1 border-t border-white/[0.03]">
          <span className="truncate max-w-[140px]" title={device.currentAdbAddress || device.ip || device.serial}>
            {device.currentAdbAddress || device.ip || device.serial}
          </span>
          {device.viaTunnel && (
            <span className="text-emerald-400 font-sans font-medium text-[8px] bg-emerald-500/10 px-1 rounded">
              Túnel
            </span>
          )}
        </div>
      </div>

      {isUsbOnly ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onForceWireless}
          className="w-full text-[11px] font-medium bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20 gap-1.5 mt-1"
        >
          <Zap size={12} className="text-amber-400" />
          <span>Ativar Wi-Fi ADB</span>
        </Button>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <Button
            variant="primary"
            size="sm"
            onClick={onOpenMirror}
            className="w-full text-[11px] font-medium gap-1 py-1"
            title="Espelhar tela do dispositivo em tempo real"
          >
            <Zap size={12} />
            <span>Espelhar</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpenRegion}
            className="w-full text-[11px] font-medium gap-1 py-1"
            title="Câmera Virtual para leitura de QR Code"
          >
            <Camera size={12} className="text-zinc-400" />
            <span>Câmera</span>
          </Button>
        </div>
      )}
    </div>
  );
});
