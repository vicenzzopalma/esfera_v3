// ============================================================
// Esfera v3 — Sub-componente DeviceToolbar (Linear SaaS Style)
// Toolbar unificada e limpa para filtros, busca e ações
// ============================================================

import { useState, useRef, useEffect } from "react";
import Button from "../ui/Button";
import { api } from "../../tauri";
import type { Device } from "../../types";
import {
  Search,
  Plus,
  MoreHorizontal,
  RefreshCw,
  Zap,
  Shield,
  AlertTriangle,
  Grid,
  Table,
  Trash2,
  XCircle,
} from "lucide-react";

interface DeviceToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sectorTab: string;
  onSectorChange: (s: string) => void;
  viewMode: "grid" | "table";
  onViewModeChange: (m: "grid" | "table") => void;
  devicesList: Device[];
  onOpenConnectModal: () => void;
  onOpenDiagnosticModal: () => void;
  onRefreshDevices: () => void;
  selectedSerials: string[];
  onBatchDelete: () => void;
  onClearOffline: () => void;
}

export function DeviceToolbar({
  searchQuery,
  onSearchChange,
  sectorTab,
  onSectorChange,
  viewMode,
  onViewModeChange,
  devicesList,
  onOpenConnectModal,
  onOpenDiagnosticModal,
  onRefreshDevices,
  selectedSerials,
  onBatchDelete,
  onClearOffline,
}: DeviceToolbarProps) {
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const offlineCount = devicesList.filter((d) => d.status === "offline").length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setMoreActionsOpen(false);
      }
    };
    if (moreActionsOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreActionsOpen]);

  return (
    <div className="space-y-3">
      {/* Top Main Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#141418] border border-white/[0.07] p-3 rounded-xl">
        {/* Left: Sector Pills */}
        <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar">
          {[
            { id: "all", label: "Todos" },
            { id: "junior", label: "Junior" },
            { id: "senior", label: "Senior" },
            { id: "pa_fixa", label: "PA Fixa" },
            { id: "pesquisa", label: "Pesquisa" },
          ].map((tab) => {
            const count =
              tab.id === "all"
                ? devicesList.length
                : devicesList.filter(
                    (d) =>
                      String(d.sector || "junior")
                        .toLowerCase()
                        .replace(/[- _.]/g, "") === tab.id.replace(/[- _.]/g, "")
                  ).length;

            const isActive = sectorTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => onSectorChange(tab.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                  isActive
                    ? "bg-[#5E6AD2]/15 text-[#828DF7] border border-[#5E6AD2]/30"
                    : "bg-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                }`}
              >
                <span>{tab.label}</span>
                <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${isActive ? "bg-[#5E6AD2]/20 text-[#828DF7]" : "bg-white/[0.06] text-zinc-500"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right: Search, Conectar, Dropdown Menu */}
        <div className="flex items-center gap-2">
          {/* Search bar */}
          <div className="relative min-w-[200px] sm:min-w-[260px] flex items-center">
            <Search size={14} className="input-icon-left text-zinc-500" />
            <input
              type="text"
              placeholder="Buscar por modelo, serial ou IP..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full h-8 bg-[#09090b] border border-white/[0.08] text-zinc-100 rounded-md input-with-icon-left pr-3 text-xs placeholder:text-zinc-600 focus:outline-none focus:border-[#5E6AD2]"
            />
          </div>

          {/* Primary Action Button */}
          <Button
            variant="primary"
            size="sm"
            onClick={onOpenConnectModal}
            icon={<Plus size={14} />}
          >
            Conectar Celular
          </Button>

          {/* View Mode Switcher */}
          <div className="flex items-center bg-[#09090b] border border-white/[0.08] rounded-md p-0.5">
            <button
              onClick={() => onViewModeChange("grid")}
              className={`p-1 rounded transition-colors cursor-pointer ${
                viewMode === "grid" ? "bg-white/[0.1] text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
              title="Grade"
            >
              <Grid size={14} />
            </button>
            <button
              onClick={() => onViewModeChange("table")}
              className={`p-1 rounded transition-colors cursor-pointer ${
                viewMode === "table" ? "bg-white/[0.1] text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
              title="Tabela"
            >
              <Table size={14} />
            </button>
          </div>

          {/* Secondary Actions Dropdown (...) */}
          <div className="relative" ref={dropdownRef}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setMoreActionsOpen(!moreActionsOpen)}
              icon={<MoreHorizontal size={14} />}
              title="Mais ações do sistema"
            />

            {moreActionsOpen && (
              <div className="absolute right-0 mt-1.5 w-60 rounded-lg bg-[#19191e] border border-white/[0.08] shadow-2xl p-1 z-50 animate-scale-in text-xs">
                <div className="px-2.5 py-1 text-[9px] uppercase font-bold text-zinc-500 tracking-wider border-b border-white/[0.06] mb-1">
                  Ações ADB & Automação
                </div>

                <button
                  onClick={async () => {
                    setMoreActionsOpen(false);
                    const unprovisioned = devicesList.filter((d) => !d.esferaDeviceId);
                    if (unprovisioned.length === 0) {
                      alert("Todos os dispositivos já estão provisionados.");
                      return;
                    }
                    if (!confirm(`Provisionar ${unprovisioned.length} dispositivo(s)?`)) return;
                    for (const d of unprovisioned) {
                      try {
                        const targetSerial = d.status === "online" && d.currentAdbAddress ? d.currentAdbAddress : d.serial;
                        await api<string>("provision_device", { serial: targetSerial, server_url: null });
                      } catch (e: any) {
                        console.warn(`Erro ao provisionar ${d.serial}:`, e);
                      }
                    }
                    onRefreshDevices();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <Shield size={13} className="text-emerald-400" />
                  <span>Provisionar Todos</span>
                </button>

                <button
                  onClick={async () => {
                    setMoreActionsOpen(false);
                    try {
                      const msg = await api<string>("inject_all_devices_immunity", {});
                      alert(msg);
                      onRefreshDevices();
                    } catch (e: any) {
                      alert(typeof e === "string" ? e : e?.message || "Erro ao injetar imunidade.");
                    }
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <Shield size={13} className="text-cyan-400" />
                  <span>Injetar Imunidade & MAC Físico</span>
                </button>

                <button
                  onClick={async () => {
                    setMoreActionsOpen(false);
                    try {
                      await api<string>("force_reconnect_all_adb", {});
                      onRefreshDevices();
                    } catch (e: any) {
                      console.error("Erro ao forçar reconexão:", e);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <Zap size={13} className="text-amber-400" />
                  <span>Forçar Reconexão Wi-Fi</span>
                </button>

                <button
                  onClick={() => {
                    setMoreActionsOpen(false);
                    onRefreshDevices();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <RefreshCw size={13} className="text-emerald-400" />
                  <span>Sincronizar ADB</span>
                </button>

                <button
                  onClick={() => {
                    setMoreActionsOpen(false);
                    onOpenDiagnosticModal();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <AlertTriangle size={13} className="text-amber-400" />
                  <span>Diagnóstico ADB</span>
                </button>

                <div className="border-t border-white/[0.06] my-1" />

                <button
                  onClick={() => {
                    setMoreActionsOpen(false);
                    onClearOffline();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-amber-400 hover:bg-amber-500/10 transition-colors"
                >
                  <XCircle size={13} />
                  <span>Limpar Celulares Offline ({offlineCount})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Batch Selection Banner (If any selected) */}
      {selectedSerials.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 rounded-lg text-xs animate-fade-in">
          <span className="text-[#828DF7] font-medium font-mono">
            {selectedSerials.length} celular(es) selecionado(s)
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={onBatchDelete}
            icon={<Trash2 size={13} />}
          >
            Apagar Selecionados
          </Button>
        </div>
      )}
    </div>
  );
}
