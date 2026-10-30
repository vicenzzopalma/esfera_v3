// ============================================================
// Esfera v3 — Toolbar de Dispositivos
// Busca, filtros, alternância grade/lista, barra de seleção e
// ações do cabeçalho (conectar, atualizar, menu de sistema).
// ============================================================

import { useState } from "react";
import Button from "../ui/Button";
import { SegmentedControl } from "../ui/Tabs";
import { api } from "../../tauri";
import type { Device } from "../../types";
import { RowMenu } from "./RowMenu";
import { SECTOR_OPTIONS, normSector, isOnlineStatus, deviceDisplayName, errorText, notify, confirmAction } from "./deviceUi";
import {
  Search,
  Plus,
  RefreshCw,
  Zap,
  Shield,
  ShieldCheck,
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
  deleting?: boolean;
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
  deleting = false,
  onClearSelection,
  onBatchDelete,
}: DeviceToolbarProps) {
  const onlineCount = devicesList.filter((d) => isOnlineStatus(d.status)).length;
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
            placeholder="Buscar por nome, número, ID, serial ou IP"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) onSearchChange("");
            }}
            style={{ paddingLeft: "2.25rem" }}
            className="h-9 w-full rounded-lg border border-border bg-[var(--color-bg-input)] pr-8 text-[0.8125rem] text-primary placeholder:text-tertiary focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-glow)]"
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
              { id: "grid", label: <span className="sr-only">Grade</span>, icon: <LayoutGrid size={14} aria-hidden /> },
              { id: "table", label: <span className="sr-only">Lista</span>, icon: <List size={14} aria-hidden /> },
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-glow)] px-3 py-2 animate-fade-in">
          <span className="text-[0.8125rem] font-medium text-primary">
            {selectedSerials.length} {selectedSerials.length === 1 ? "aparelho selecionado" : "aparelhos selecionados"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={deleting}>
              Limpar seleção
            </Button>
            <Button variant="danger" size="sm" onClick={onBatchDelete} loading={deleting} icon={<Trash2 size={13} />}>
              {deleting ? "Removendo…" : "Remover selecionados"}
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

// Ações do cabeçalho: uma primária (Conectar), atualizar e menu com ações de sistema.
export function DeviceHeaderActions({
  devicesList,
  loading,
  onOpenConnectModal,
  onOpenDiagnosticModal,
  onRefreshDevices,
  onClearOffline,
}: HeaderActionsProps) {
  const [busy, setBusy] = useState<null | "provision" | "immunity" | "reconnect">(null);
  const offlineCount = devicesList.filter((d) => d.status === "offline").length;

  // Só aparelhos online e ainda sem ID do Esfera; provisionar exige ADB ativo.
  const provisionAll = async () => {
    const unprovisioned = devicesList.filter((d) => !d.esferaDeviceId);
    const targets = unprovisioned.filter((d) => isOnlineStatus(d.status));
    const skipped = unprovisioned.length - targets.length;
    if (unprovisioned.length === 0) {
      notify("info", "Todos os aparelhos já estão provisionados.");
      return;
    }
    if (targets.length === 0) {
      notify("warning", "Nenhum aparelho sem ID está online.", `${skipped} aparelho(s) sem ID estão offline. Conecte-os por cabo ou Wi-Fi e tente de novo.`);
      return;
    }
    const ok = await confirmAction({
      title: "Provisionar aparelhos",
      message: (
        <>
          <p>
            Provisionar {targets.length} {targets.length === 1 ? "aparelho" : "aparelhos"} online sem ID do Esfera? O agente é instalado ou atualizado em cada um.
          </p>
          {skipped > 0 && <p>{skipped} offline ficam de fora.</p>}
        </>
      ),
      confirmLabel: "Provisionar",
    });
    if (!ok) return;
    setBusy("provision");
    const failures: string[] = [];
    for (const d of targets) {
      try {
        const targetSerial = d.currentAdbAddress || d.serial;
        await api<string>("provision_device", { serial: targetSerial, companyId: d.companyId });
      } catch (e) {
        failures.push(`${deviceDisplayName(d)}: ${errorText(e, "falha no provisionamento")}`);
      }
    }
    setBusy(null);
    onRefreshDevices();
    const done = targets.length - failures.length;
    if (failures.length === 0) notify("success", `${done} ${done === 1 ? "aparelho provisionado" : "aparelhos provisionados"}.`);
    else notify("danger", `${done} provisionado(s), ${failures.length} com falha.`, failures.slice(0, 3).join(" · ") + (failures.length > 3 ? ` · e mais ${failures.length - 3}` : ""));
  };

  const applyProtection = async () => {
    const ok = await confirmAction({
      title: "Aplicar proteção em segundo plano",
      message: (
        <p>
          Em todos os aparelhos online: impede o Android de encerrar o Agente e o WhatsApp para economizar bateria, mantém o Wi-Fi ativo com a tela apagada e reaplica a
          identidade gravada. Isso também roda sozinho a cada conexão.
        </p>
      ),
      confirmLabel: "Aplicar em todos",
    });
    if (!ok) return;
    setBusy("immunity");
    try {
      const msg = await api<string>("inject_all_devices_immunity", {});
      notify("success", "Proteção enviada aos aparelhos.", msg);
      onRefreshDevices();
    } catch (e) {
      notify("danger", "Não foi possível aplicar a proteção.", errorText(e, "Tente novamente."));
    } finally {
      setBusy(null);
    }
  };

  const reconnectAll = async () => {
    setBusy("reconnect");
    try {
      const msg = await api<string>("force_reconnect_all_adb", {});
      notify("success", "Reconexão por Wi-Fi solicitada.", msg);
      onRefreshDevices();
    } catch (e) {
      notify("danger", "Não foi possível reconectar os aparelhos.", errorText(e, "Tente novamente."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="secondary" size="md" onClick={onRefreshDevices} loading={loading || !!busy} icon={<RefreshCw size={14} />} title="Recarregar a lista de aparelhos">
        {busy === "provision" ? "Provisionando…" : busy === "immunity" ? "Aplicando…" : busy === "reconnect" ? "Reconectando…" : "Atualizar"}
      </Button>
      <RowMenu
        label="Mais ações"
        items={[
          { label: "Provisionar aparelhos sem ID", icon: <Shield size={14} />, onClick: provisionAll, disabled: !!busy },
          { label: "Aplicar proteção em segundo plano", icon: <ShieldCheck size={14} />, onClick: applyProtection, disabled: !!busy },
          { label: "Reconectar todos por Wi-Fi", icon: <Zap size={14} />, onClick: reconnectAll, disabled: !!busy },
          { label: "Diagnóstico da conexão USB", icon: <Stethoscope size={14} />, onClick: onOpenDiagnosticModal },
          "sep",
          { label: `Remover offline (${offlineCount})`, icon: <PlugZap size={14} />, onClick: onClearOffline, danger: true, disabled: offlineCount === 0 },
        ]}
      />
      <Button variant="primary" size="md" onClick={onOpenConnectModal} icon={<Plus size={14} />}>
        Conectar aparelho
      </Button>
    </>
  );
}
