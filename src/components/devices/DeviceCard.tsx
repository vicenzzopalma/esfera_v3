// ============================================================
// Esfera v3 — Sub-componente DeviceCard (Linear SaaS Style)
// Card compacto e elegante para exibição do celular no Hub
// ============================================================

import { memo, useState, useRef, useEffect } from "react";
import type { Device } from "../../types";
import Button from "../ui/Button";
import { api } from "../../tauri";
import {
  Trash2,
  Zap,
  Camera,
  MoreVertical,
  Sliders,
  Shield,
  BatteryCharging,
} from "lucide-react";

interface DeviceCardProps {
  device: Device;
  activeUserDisplayName?: string;
  isSelected: boolean;
  onToggleSelect: () => void;
  onRemove: () => void;
  onOpenMirror: () => void;
  onOpenConfig: () => void;
  onOpenRegion: () => void;
  onForceWireless: () => void;
}

export const DeviceCard = memo(function DeviceCard({
  device,
  activeUserDisplayName,
  isSelected,
  onToggleSelect,
  onRemove,
  onOpenMirror,
  onOpenConfig,
  onOpenRegion,
  onForceWireless,
}: DeviceCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const displayName = device.name || device.serial;
  const isUsbOnly = !device.serial.includes(":") && !device.viaTunnel;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <div
      className={`rounded-lg bg-[#141418] border transition-all duration-150 p-3.5 flex flex-col justify-between space-y-3 relative group ${
        isSelected
          ? "border-[#5E6AD2] bg-[#5E6AD2]/[0.04] ring-1 ring-[#5E6AD2]/30"
          : "border-white/[0.07] hover:border-white/[0.15]"
      }`}
    >
      {/* Header Line: Checkbox + Status Dot + Name + Sector + Dropdown */}
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="w-3.5 h-3.5 rounded border-white/20 bg-zinc-900 text-[#5E6AD2] focus:ring-0 cursor-pointer shrink-0"
          />

          {/* Status Dot */}
          <span className="relative flex h-2 w-2 shrink-0">
            {device.status === "online" && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                device.status === "online"
                  ? "bg-emerald-400"
                  : device.status === "connecting"
                  ? "bg-amber-400"
                  : "bg-zinc-600"
              }`}
            />
          </span>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs text-zinc-100 truncate" title={displayName}>
                {displayName}
              </span>
              <span className="px-1.5 py-0.2 rounded bg-white/[0.06] text-zinc-400 text-[9px] font-mono uppercase">
                {device.sector.replace("_", " ")}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
              {device.model} {isUsbOnly && "(USB)"}
            </p>
          </div>
        </div>

        {/* Options Dropdown */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="Ações do celular"
          >
            <MoreVertical size={14} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-1 w-44 rounded-md bg-[#19191e] border border-white/[0.1] shadow-xl p-1 z-50 animate-scale-in text-xs">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpenConfig();
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <Sliders size={13} />
                <span>Configurar</span>
              </button>

              <button
                onClick={async () => {
                  setMenuOpen(false);
                  try {
                    const targetSerial = (device.status === "online" && device.currentAdbAddress) ? device.currentAdbAddress : device.serial;
                    const msg = await api<string>("provision_device", { serial: targetSerial, server_url: null });
                    alert(`Provisionado: ${msg}`);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao provisionar.");
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <Shield size={13} className="text-emerald-400" />
                <span>{device.esferaDeviceId ? "Reprovisionar" : "Provisionar"}</span>
              </button>

              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (confirm(`Deseja remover ${displayName}?`)) onRemove();
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-red-400 hover:bg-red-500/10 transition-colors border-t border-white/[0.06] mt-1 pt-1.5"
              >
                <Trash2 size={13} />
                <span>Remover</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Active User Banner (if any) */}
      {activeUserDisplayName && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span>Em uso: <strong>{activeUserDisplayName}</strong></span>
        </div>
      )}

      {/* IP/Serial & Battery */}
      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 bg-white/[0.02] p-1.5 rounded border border-white/[0.04]">
        <span className="text-zinc-500 truncate max-w-[140px]" title={device.currentAdbAddress || device.serial}>
          {device.currentAdbAddress || device.serial}
        </span>
        <div className="flex items-center gap-1 text-zinc-300 shrink-0">
          <BatteryCharging size={11} className="text-zinc-500" />
          <span>{device.battery}%</span>
        </div>
      </div>

      {/* Primary Actions (USB vs Wireless) */}
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
