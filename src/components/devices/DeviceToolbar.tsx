// ============================================================
// Esfera v3 — Toolbar de Dispositivos
// Busca, filtros, alternância grade/lista, barra de seleção e
// ações do cabeçalho (conectar, sincronizar, menu de sistema).
// ============================================================

import { useState } from "react";
import Button from "../ui/Button";
import { SegmentedControl } from "../ui/Tabs";
import { api } from "../../tauri";
import type { Device } from "../../types";
import { RowMenu } from "./RowMenu";
import { SECTOR_OPTIONS, normSector } from "./deviceUi";
import {
  Search,
  Plus,
  RefreshCw,
  Zap,
  Shield,
  Stethoscope,
  LayoutGrid,
  List,
  Trash2,
  X,
  PlugZap,
} from "lucide-react";

export type StatusFilter = "all" | "online" | "offline" | "inuse";

interface DeviceToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sectorTab: string;
  onSectorChange: (s: string) => void;
  viewMode: "grid" | "table";
  onViewModeChange: (m: "grid" | "table") => void;
  devicesList: Device[];
  statusFilter: StatusFilter;
  onStatusFilterChange: (s: StatusFilter) => void;
  inUseCount: number;
  filteredCount: number;
  selectedSerials: string[];
  onClearSelection: () => void;
  onBatchDelete: () => void;
}

export function DeviceToolbar({
  searchQuery,
  onSearchChange,
  sectorTab,
  onSectorChange,
  viewMode,
  onViewModeChange,
  devicesList,
  statusFilter,
  onStatusFilterChange,
  inUseCount,
  filteredCount,
  selectedSerials,
  onClearSelection,
  onBatchDelete,
}: DeviceToolbarProps) {
  const onlineCount = devicesList.filter((d) => d.status === "online" || d.status === "online_agent").length;
  const offlineCount = devicesList.filter((d) => d.status === "offline").length;

  const sectorItems = [
    { id: "all", label: "Todos os setores", count: devicesList.length },
    ...SECTOR_OPTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      count: devicesList.filter((d) => normSector(d.sector) === normSector(s.id)).length,
    })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            type="text"
            aria-label="Buscar aparelhos"
            placeholder="Buscar por nome, número, serial ou IP"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ paddingLeft: "2.25rem" }}
            className="h-9 w-full rounded-lg border border-border bg-primary pr-8 text-[0.8125rem] text-primary placeholder:text-tertiary focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-glow)]"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => onSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-tertiary hover:text-primary cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <SegmentedControl<StatusFilter>
          items={[
            { id: "all", label: "Todos", count: devicesList.length },
            { id: "online", label: "Online", count: onlineCount },
            { id: "offline", label: "Offline", count: offlineCount },
            { id: "inuse", label: "Em uso", count: inUseCount },
          ]}
          value={statusFilter}
          onChange={onStatusFilterChange}
        />

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[0.75rem] text-tertiary sm:inline tabular-nums">
            {filteredCount} de {devicesList.length}
          </span>
          <SegmentedControl<"grid" | "table">
            items={[
              { id: "grid", label: "", icon: <LayoutGrid size={14} /> },
              { id: "table", label: "", icon: <List size={14} /> },
            ]}
            value={viewMode}
            onChange={onViewModeChange}
          />
        </div>
      </div>

      <div className="overflow-x-auto pb-1 custom-scrollbar">
        <SegmentedControl items={sectorItems} value={sectorTab} onChange={onSectorChange} />
      </div>

      {selectedSerials.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-glow)] px-3 py-2 animate-fade-in">
          <span className="text-[0.8125rem] font-medium text-primary">
            {selectedSerials.length} {selectedSerials.length === 1 ? "aparelho selecionado" : "aparelhos selecionados"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClearSelection}>
              Limpar seleção
            </Button>
            <Button variant="danger" size="sm" onClick={onBatchDelete} icon={<Trash2 size={13} />}>
              Apagar selecionados
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface HeaderActionsProps {
  devicesList: Device[];
  loading?: boolean;
  onOpenConnectModal: () => void;
  onOpenDiagnosticModal: () => void;
  onRefreshDevices: () => void;
  onClearOffline: () => void;
}

// Ações do cabeçalho: uma primária (Conectar), sincronizar e menu com ações de sistema.
export function DeviceHeaderActions({
  devicesList,
  loading,
  onOpenConnectModal,
  onOpenDiagnosticModal,
  onRefreshDevices,
  onClearOffline,
}: HeaderActionsProps) {
  const [busy, setBusy] = useState(false);
  const offlineCount = devicesList.filter((d) => d.status === "offline").length;

  const provisionAll = async () => {
    const unprovisioned = devicesList.filter((d) => !d.esferaDeviceId);
    if (unprovisioned.length === 0) {
      alert("Todos os dispositivos já estão provisionados.");
      return;
    }
    if (!confirm(`Provisionar ${unprovisioned.length} dispositivo(s)?`)) return;
    setBusy(true);
    for (const d of unprovisioned) {
      try {
        const targetSerial = d.status === "online" && d.currentAdbAddress ? d.currentAdbAddress : d.serial;
        await api<string>("provision_device", { serial: targetSerial, server_url: null, companyId: d.companyId });
      } catch (e: any) {
        console.warn(`Erro ao provisionar ${d.serial}:`, e);
      }
    }
    setBusy(false);
    onRefreshDevices();
  };

  const injectImmunity = async () => {
    try {
      const msg = await api<string>("inject_all_devices_immunity", {});
      alert(msg);
      onRefreshDevices();
    } catch (e: any) {
      alert(typeof e === "string" ? e : e?.message || "Erro ao injetar imunidade.");
    }
  };

  const reconnectAll = async () => {
    try {
      await api<string>("force_reconnect_all_adb", {});
      onRefreshDevices();
    } catch (e: any) {
      console.error("Erro ao forçar reconexão:", e);
    }
  };

  return (
    <>
      <Button variant="secondary" size="md" onClick={onRefreshDevices} loading={loading || busy} icon={<RefreshCw size={14} />}>
        Sincronizar
      </Button>
      <RowMenu
        label="Mais ações"
        items={[
          { label: "Provisionar todos", icon: <Shield size={14} />, onClick: provisionAll },
          { label: "Aplicar imunidade e MAC físico", icon: <Shield size={14} />, onClick: injectImmunity },
          { label: "Forçar reconexão Wi-Fi", icon: <Zap size={14} />, onClick: reconnectAll },
          { label: "Diagnóstico ADB", icon: <Stethoscope size={14} />, onClick: onOpenDiagnosticModal },
          "sep",
          { label: `Remover offline (${offlineCount})`, icon: <PlugZap size={14} />, onClick: onClearOffline, danger: true },
        ]}
      />
      <Button variant="primary" size="md" onClick={onOpenConnectModal} icon={<Plus size={14} />}>
        Conectar celular
      </Button>
    </>
  );
}
