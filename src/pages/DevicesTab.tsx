

// ============================================================
// Esfera v3 — Hub de Gestão de Dispositivos ADB Celulares
// Modularizado & Redesenhado em Linear SaaS Style
// ============================================================

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { listen } from "@tauri-apps/api/event";
import CollaboratorView from "../components/CollaboratorView";
import SupervisorView from "../components/SupervisorView";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import type { Device, DeviceStatus, DeviceWithActiveUser, DevicePermissionRequest } from "../types";
import { api } from "../tauri";

// Sub-componentes modularizados
import { DeviceCard, DeviceRow, type AgentUpdateStatus } from "../components/devices/DeviceCard";
import { DeviceToolbar, DeviceHeaderActions, type StatusFilter } from "../components/devices/DeviceToolbar";
import { isOnlineStatus } from "../components/devices/deviceUi";
import { ConnectDeviceModal } from "../components/devices/ConnectDeviceModal";
import { DeviceConfigModal } from "../components/devices/DeviceConfigModal";
import { MirrorModal } from "../components/devices/MirrorModal";
import { DiagnosticModal } from "../components/devices/DiagnosticModal";
import { ScreenRegionModal } from "../components/devices/ScreenRegionModal";
import { DeviceIdentityModal } from "../components/devices/DeviceIdentityModal";

import { Smartphone, Plus, RefreshCw, Bell, Wifi, WifiOff, UserCheck, AlertTriangle, SearchX } from "lucide-react";

export default function DevicesTab() {
  const { user } = useAuth();

  // Role Gate limpo sem violação das regras de hooks
  if (user?.role === "colaborador") return <CollaboratorView />;
  if (user?.role === "supervisor") return <SupervisorView />;

  return <ManagerDevicesView />;
}

function ManagerDevicesView() {
  const { selectedCompanyId } = useAuth();

  // Filter & View State
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorTab, setSectorTab] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Device Data & Selection
  const [devicesList, setDevicesList] = useState<Device[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentUpdateStatus>>({});
  const [selectedSerials, setSelectedSerials] = useState<string[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [activeUserMap, setActiveUserMap] = useState<
    Record<string, { activeUserId?: number; activeUserDisplayName?: string }>
  >({});

  // Modais State
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [diagnosticModalOpen, setDiagnosticModalOpen] = useState(false);
  const [mirrorModalOpen, setMirrorModalOpen] = useState(false);
  const [selectedDeviceForMirror, setSelectedDeviceForMirror] = useState<Device | null>(null);

  const [regionModalOpen, setRegionModalOpen] = useState(false);
  const [selectedSerialForRegion, setSelectedSerialForRegion] = useState("");

  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [selectedDeviceForConfig, setSelectedDeviceForConfig] = useState<Device | null>(null);

  const [identityModalOpen, setIdentityModalOpen] = useState(false);
  const [selectedDeviceForDiagnostic, setSelectedDeviceForDiagnostic] = useState<Device | null>(null);

  // Connecting timeout tracking (15s)
  const [connectingTimestamps, setConnectingTimestamps] = useState<Record<string, number>>({});

  // USB Device Scanning & Linking Status
  const [usbDevices, setUsbDevices] = useState<{ serial: string; state: string; model: string }[]>([]);
  const [loadingUsb, setLoadingUsb] = useState(false);
  const [linkingSerial, setLinkingSerial] = useState<string | null>(null);
  const [linkingStatus, setLinkingStatus] = useState<string | null>(null);

  const effectiveCompanyId = selectedCompanyId || 1;

  // Real-time ADB devices fetcher
  const refreshDevices = useCallback(() => {
    api<Device[]>("get_devices", { companyId: effectiveCompanyId })
      .then((data) => {
        if (data && Array.isArray(data)) setDevicesList(data);
        setLoadError(null);
      })
      .catch((err) => {
        console.warn("Retorno temporário de IPC para get_devices:", err);
        setLoadError(typeof err === "string" ? err : err?.message || "Não foi possível carregar os aparelhos.");
      })
      .finally(() => setLoadingDevices(false));

    api<AgentUpdateStatus[]>("get_agent_update_status", { companyId: effectiveCompanyId })
      .then((items) => setAgentStatuses(Object.fromEntries(items.map((item) => [item.deviceId, item]))))
      .catch(() => setAgentStatuses({}));

    api<DeviceWithActiveUser[]>("get_devices_with_active_user_map", { companyId: effectiveCompanyId })
      .then((data) => {
        if (data && Array.isArray(data)) {
          const map: Record<string, { activeUserId?: number; activeUserDisplayName?: string }> = {};
          for (const d of data) {
            if (d.activeUserId && d.activeUserDisplayName) {
              map[d.serial] = { activeUserId: d.activeUserId, activeUserDisplayName: d.activeUserDisplayName };
            }
          }
          setActiveUserMap(map);
        }
      })
      .catch(() => {});

    api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId: effectiveCompanyId })
      .then((data) => {
        if (data && Array.isArray(data)) setPermissionRequests(data);
      })
      .catch(() => {});
  }, [effectiveCompanyId]);

  const handleApproveRequest = async (requestId: number) => {
    try {
      await api("approve_device_access", { requestId });
      refreshDevices();
    } catch (err: any) {
      alert(typeof err === "string" ? err : err?.message || "Erro ao aprovar solicitação.");
    }
  };

  const handleRejectRequest = async (requestId: number) => {
    try {
      await api("reject_device_access", { requestId });
      refreshDevices();
    } catch (err: any) {
      alert(typeof err === "string" ? err : err?.message || "Erro ao rejeitar solicitação.");
    }
  };

  useEffect(() => {
    refreshDevices();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) {
        refreshDevices();
      }
    }, 7000);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  // Realtime updates from check-in server via Tauri event
  useEffect(() => {
    const unlisten = listen<{ esferaDeviceId: string; currentAdbAddress: string; status: string; lastSeenUtc: string }>(
      "device-updated",
      (event) => {
        const newStatus = event.payload.status as DeviceStatus;
        const devId = event.payload.esferaDeviceId;

        setDevicesList((prev) =>
          prev.map((d) =>
            d.esferaDeviceId === devId
              ? {
                  ...d,
                  currentAdbAddress: event.payload.currentAdbAddress,
                  status: newStatus,
                  lastSeenUtc: event.payload.lastSeenUtc,
                }
              : d
          )
        );

        // Track connecting timestamps for 15s timeout
        if (newStatus === "connecting") {
          setConnectingTimestamps((prev) => {
            if (!prev[devId]) {
              return { ...prev, [devId]: Date.now() };
            }
            return prev;
          });
        } else {
          // Clear timestamp when status changes away from connecting
          setConnectingTimestamps((prev) => {
            const next = { ...prev };
            delete next[devId];
            return next;
          });
        }
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 15s connecting timeout: force visual to offline if device stays in "connecting"
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const expiredIds = Object.entries(connectingTimestamps)
        .filter(([_id, ts]) => now - ts > 15000)
        .map(([id]) => id);

      if (expiredIds.length > 0) {
        setDevicesList((prev) =>
          prev.map((d) =>
            d.esferaDeviceId && expiredIds.includes(d.esferaDeviceId) && d.status === "connecting"
              ? { ...d, status: "offline" as DeviceStatus }
              : d
          )
        );
        setConnectingTimestamps((prev) => {
          const next = { ...prev };
          for (const id of expiredIds) delete next[id];
          return next;
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [connectingTimestamps]);

  const fetchUsbDevices = async () => {
    setLoadingUsb(true);
    setLinkingStatus(null);
    try {
      const data = await api<any[]>("list_usb_devices");
      setUsbDevices(data || []);
    } catch (err) {
      console.warn("Falha ao buscar dispositivos ADB nativos:", err);
      setUsbDevices([]);
    } finally {
      setLoadingUsb(false);
    }
  };

  useEffect(() => {
    if (connectModalOpen) fetchUsbDevices();
  }, [connectModalOpen]);

  const handleForceWirelessAdb = async (serial: string, deviceNumber: number, sector: string, deviceName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(serial);
    setLinkingStatus("Ativando Wi-Fi ADB (porta 5555) e obtendo o IP...");

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLinkingStatus("Tempo esgotado (25s): o aparelho não respondeu. Se for remoto (VPS), ele já está conectado via túnel.");
      setLinkingSerial(null);
    }, 25000);

    try {
      const result = await api<string>("force_enable_wireless_adb", {
        serial,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName || serial,
      });
      clearTimeout(timeoutId);
      if (!timedOut) {
        setLinkingStatus(result);
        refreshDevices();
        setTimeout(() => {
          setConnectModalOpen(false);
          setLinkingSerial(null);
          setLinkingStatus(null);
        }, 2000);
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (!timedOut) {
        const errMsg = typeof err === "string" ? err : err?.message || "Erro ao forçar depuração Wi-Fi.";
        setLinkingStatus(`Erro: ${errMsg}`);
        setTimeout(() => setLinkingSerial(null), 4000);
      }
    }
  };

  const handleConnectDevice = async (ipAddress: string, portNumber: number, deviceNumber: number, sector: string, deviceName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(ipAddress);
    setLinkingStatus("Conectando...");

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLinkingStatus("Tempo esgotado (25s): verifique se o IP está acessível na mesma rede.");
      setLinkingSerial(null);
    }, 25000);

    try {
      let finalIp = ipAddress.trim();
      let finalPort = portNumber;

      if (finalIp.includes(":")) {
        const parts = finalIp.split(":");
        finalIp = parts[0].trim();
        finalPort = parseInt(parts[1], 10) || portNumber || 5555;
      }

      await api("connect_adb_device", {
        ip: finalIp,
        port: finalPort,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName || finalIp,
      });
      clearTimeout(timeoutId);
      if (!timedOut) {
        refreshDevices();
        setConnectModalOpen(false);
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (!timedOut) {
        const errMsg = typeof err === "string" ? err : err?.message || "Erro ao conectar por IP.";
        setLinkingStatus(`Erro: ${errMsg}`);
      }
    } finally {
      clearTimeout(timeoutId);
      if (!timedOut) {
        setLinkingSerial(null);
      }
    }
  };

  const handlePairAndConnectDevice = async (
    ip: string,
    pPort: number,
    code: string,
    cPort: number,
    devNum: number,
    sec: string,
    devName: string
  ) => {
    if (linkingSerial) return;
    setLinkingSerial(ip);
    setLinkingStatus("Enviando código de pareamento ao Android...");
    try {
      const result = await api<string>("pair_and_connect_adb_device", {
        ip,
        pairPort: pPort,
        pairCode: code,
        connectPort: cPort || 5555,
        companyId: effectiveCompanyId,
        deviceNumber: devNum,
        sector: sec,
        deviceName: devName || `Aparelho ${devNum}`,
      });
      setLinkingStatus(result);
      refreshDevices();
      setTimeout(() => {
        setConnectModalOpen(false);
        setLinkingSerial(null);
        setLinkingStatus(null);
      }, 2000);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro no pareamento por código.";
      setLinkingStatus(`Erro: ${errMsg}`);
      setTimeout(() => setLinkingSerial(null), 4000);
    }
  };

  const handleRemoveDevice = async (serialOrId: string) => {
    try {
      await api("disconnect_adb_device", { serial: serialOrId });
    } catch {
      // noop
    }
    try {
      await api("delete_device", { serial: serialOrId });
    } catch (e: any) {
      console.warn("Falha ao apagar dispositivo:", e);
    }
    setDevicesList((prev) => prev.filter((d) => d.serial !== serialOrId && d.esferaDeviceId !== serialOrId));
    setSelectedSerials((prev) => prev.filter((s) => s !== serialOrId));
    setConfigModalOpen(false);
    setSelectedDeviceForConfig(null);
    refreshDevices();
  };

  const toggleSelectDevice = (serial: string) => {
    setSelectedSerials((prev) =>
      prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]
    );
  };

  const handleBatchDeleteSelected = async () => {
    if (selectedSerials.length === 0) return;
    if (!confirm(`Deseja apagar os ${selectedSerials.length} celular(es) selecionado(s)?`)) return;

    for (const serial of selectedSerials) {
      try {
        await api("delete_device", { serial });
      } catch (e) {
        console.warn("Falha ao apagar no SQLite:", e);
      }
    }
    setDevicesList((prev) => prev.filter((d) => !selectedSerials.includes(d.serial)));
    setSelectedSerials([]);
    refreshDevices();
  };

  const handleClearAllOfflineDevices = async () => {
    const offlineDevs = devicesList.filter((d) => d.status === "offline");
    if (offlineDevs.length === 0) {
      alert("Nenhum celular offline encontrado.");
      return;
    }
    if (!confirm(`Excluir TODOS os ${offlineDevs.length} celular(es) offline?`)) return;

    const offlineSerials = offlineDevs.map((d) => d.serial);
    for (const serial of offlineSerials) {
      try {
        await api("delete_device", { serial });
      } catch (e) {
        console.warn("Falha ao apagar offline:", e);
      }
    }
    setDevicesList((prev) => prev.filter((d) => d.status !== "offline"));
    setSelectedSerials((prev) => prev.filter((s) => !offlineSerials.includes(s)));
    refreshDevices();
  };

  // Filter logic
  const filteredDevices = useMemo(() => {
    return (devicesList || [])
      .filter((device) => {
        if (!device) return false;
        const serial = String(device.serial || "");
        const model = String(device.model || "");
        const brand = String(device.brand || "");
        const ip = String(device.ip || "");
        const sector = String(device.sector || "junior").toLowerCase().replace(/[- _.]/g, "");

        if (sectorTab !== "all") {
          const targetSector = sectorTab.toLowerCase().replace(/[- _.]/g, "");
          if (sector !== targetSector) return false;
        }

        if (statusFilter === "online" && !isOnlineStatus(device.status)) return false;
        if (statusFilter === "offline" && device.status !== "offline") return false;
        if (statusFilter === "inuse" && !activeUserMap[device.serial]?.activeUserDisplayName) return false;

        if (searchQuery) {
          const q = searchQuery.toLowerCase().trim();
          const name = String(device.name || "");
          const esfId = String(device.esferaDeviceId || "");
          const curAdb = String(device.currentAdbAddress || "");
          const devNum = String(device.deviceNumber ?? "");
          const devNumPad = devNum.padStart(2, "0");
          return (
            name.toLowerCase().includes(q) ||
            esfId.toLowerCase().includes(q) ||
            model.toLowerCase().includes(q) ||
            brand.toLowerCase().includes(q) ||
            serial.toLowerCase().includes(q) ||
            ip.toLowerCase().includes(q) ||
            curAdb.toLowerCase().includes(q) ||
            devNum === q ||
            devNumPad === q ||
            `#${devNum}`.includes(q) ||
            `#${devNumPad}`.includes(q)
          );
        }

        return true;
      })
      .sort((a, b) => {
        const nameA = String(a.name || a.model || a.serial || "");
        const nameB = String(b.name || b.model || b.serial || "");
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
      });
  }, [devicesList, sectorTab, searchQuery, statusFilter, activeUserMap]);

  const stats = useMemo(() => {
    const list = devicesList || [];
    return {
      total: list.length,
      online: list.filter((d) => isOnlineStatus(d.status)).length,
      offline: list.filter((d) => d.status === "offline").length,
      inUse: list.filter((d) => !!activeUserMap[d.serial]?.activeUserDisplayName).length,
    };
  }, [devicesList, activeUserMap]);

  const pendingRequests = useMemo(() => {
    return (permissionRequests || []).filter((r) => r.status === "pending");
  }, [permissionRequests]);

  const hasFilters = !!searchQuery || sectorTab !== "all" || statusFilter !== "all";
  const clearFilters = () => {
    setSearchQuery("");
    setSectorTab("all");
    setStatusFilter("all");
  };

  const openMirror = (device: Device) => {
    setSelectedDeviceForMirror(device);
    setMirrorModalOpen(true);
  };
  const openConfig = (device: Device) => {
    setSelectedDeviceForConfig(device);
    setConfigModalOpen(true);
  };
  const openRegion = (device: Device) => {
    setSelectedSerialForRegion(device.serial);
    setRegionModalOpen(true);
  };
  const openIdentity = (device: Device) => {
    setSelectedDeviceForDiagnostic(device);
    setIdentityModalOpen(true);
  };
  const forceWireless = (device: Device) =>
    handleForceWirelessAdb(device.serial, device.deviceNumber, device.sector, device.name || device.model || device.serial);

  const findPending = (device: Device) =>
    pendingRequests.find(
      (r) =>
        r.status === "pending" &&
        (r.adbDeviceId === device.serial ||
          r.adbDeviceId === device.currentAdbAddress ||
          r.adbDeviceId === device.esferaDeviceId ||
          (device.currentAdbAddress && r.adbDeviceId.includes(device.currentAdbAddress.split(":")[0])))
    );

  const itemProps = (device: Device) => ({
    device,
    agentStatus: agentStatuses[device.esferaDeviceId || device.serial]?.companyId === effectiveCompanyId
      ? agentStatuses[device.esferaDeviceId || device.serial] : undefined,
    activeUserDisplayName: activeUserMap[device.serial]?.activeUserDisplayName,
    pendingRequest: findPending(device),
    onApproveRequest: handleApproveRequest,
    onRejectRequest: handleRejectRequest,
    isSelected: selectedSerials.includes(device.serial),
    onToggleSelect: () => toggleSelectDevice(device.serial),
    onOpenMirror: () => openMirror(device),
    onOpenConfig: () => openConfig(device),
    onOpenRegion: () => openRegion(device),
    onForceWireless: () => forceWireless(device),
    onOpenDiagnostic: () => openIdentity(device),
  });

  const showSkeleton = loadingDevices && devicesList.length === 0;
  const showError = !!loadError && devicesList.length === 0 && !loadingDevices;

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Dispositivos"
        description="Aparelhos conectados, status e controle remoto."
        icon={<Smartphone size={18} />}
        actions={
          <DeviceHeaderActions
            devicesList={devicesList}
            onOpenConnectModal={() => setConnectModalOpen(true)}
            onOpenDiagnosticModal={() => setDiagnosticModalOpen(true)}
            onRefreshDevices={refreshDevices}
            onClearOffline={handleClearAllOfflineDevices}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total" value={showSkeleton ? "–" : stats.total} icon={<Smartphone size={14} />} tone="neutral" onClick={() => setStatusFilter("all")} />
        <StatCard label="Online" value={showSkeleton ? "–" : stats.online} icon={<Wifi size={14} />} tone="success" onClick={() => setStatusFilter("online")} />
        <StatCard label="Offline" value={showSkeleton ? "–" : stats.offline} icon={<WifiOff size={14} />} tone="danger" onClick={() => setStatusFilter("offline")} />
        <StatCard label="Em uso" value={showSkeleton ? "–" : stats.inUse} icon={<UserCheck size={14} />} tone="accent" onClick={() => setStatusFilter("inuse")} />
      </div>

      {pendingRequests.length > 0 && (
        <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Bell size={14} className="text-amber-500" />
            {pendingRequests.length === 1 ? "1 solicitação de acesso pendente" : `${pendingRequests.length} solicitações de acesso pendentes`}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pendingRequests.map((req) => (
              <div key={req.requestId} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                <div className="min-w-0">
                  <p className="truncate text-[0.8125rem] font-medium text-primary">{req.userDisplayName || req.userName}</p>
                  <p className="truncate font-mono text-[0.75rem] text-secondary">{req.adbDeviceId}</p>
                  {req.requestedReason && <p className="truncate text-[0.75rem] text-tertiary">"{req.requestedReason}"</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="success" onClick={() => handleApproveRequest(req.requestId)}>
                    Aprovar
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => handleRejectRequest(req.requestId)}>
                    Recusar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="space-y-4">
        <DeviceToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          sectorTab={sectorTab}
          onSectorChange={setSectorTab}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          devicesList={devicesList}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          inUseCount={stats.inUse}
          filteredCount={filteredDevices.length}
          selectedSerials={selectedSerials}
          onClearSelection={() => setSelectedSerials([])}
          onBatchDelete={handleBatchDeleteSelected}
        />

        {showSkeleton ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl border border-border bg-card" />
            ))}
          </div>
        ) : showError ? (
          <EmptyState
            icon={<AlertTriangle size={18} />}
            title="Não foi possível carregar os aparelhos"
            description={loadError}
            action={
              <Button variant="secondary" size="sm" onClick={refreshDevices} icon={<RefreshCw size={13} />}>
                Tentar novamente
              </Button>
            }
          />
        ) : filteredDevices.length === 0 ? (
          devicesList.length === 0 ? (
            <EmptyState
              icon={<Smartphone size={18} />}
              title="Nenhum celular conectado"
              description="Conecte um aparelho Android por cabo USB, Wi-Fi ou túnel para controlar e usar nos disparos."
              action={
                <Button variant="primary" size="sm" onClick={() => setConnectModalOpen(true)} icon={<Plus size={14} />}>
                  Conectar celular
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<SearchX size={18} />}
              title="Nenhum aparelho encontrado"
              description="Nenhum aparelho corresponde à busca ou aos filtros atuais."
              action={
                hasFilters ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Limpar filtros
                  </Button>
                ) : undefined
              }
            />
          )
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredDevices.map((device) => (
              <DeviceCard key={device.serial} {...itemProps(device)} />
            ))}
          </div>
        ) : (
          <Card padding="none">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-[0.75rem] font-medium text-secondary">
                    <th className="w-10 px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Selecionar todos"
                        checked={selectedSerials.length > 0 && selectedSerials.length === filteredDevices.length}
                        onChange={() => {
                          if (selectedSerials.length === filteredDevices.length) setSelectedSerials([]);
                          else setSelectedSerials(filteredDevices.map((d) => d.serial));
                        }}
                        className="h-4 w-4 rounded border-border-strong bg-secondary accent-[var(--color-accent)] cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Aparelho</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Bateria</th>
                    <th className="px-3 py-2.5 font-medium">Setor</th>
                    <th className="px-3 py-2.5 font-medium">Endereço</th>
                    <th className="px-3 py-2.5 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredDevices.map((device) => (
                    <DeviceRow key={device.serial} {...itemProps(device)} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Sub-modais modularizados */}
      {configModalOpen && selectedDeviceForConfig && (
        <DeviceConfigModal
          isOpen={configModalOpen}
          onClose={() => {
            setConfigModalOpen(false);
            setSelectedDeviceForConfig(null);
          }}
          device={selectedDeviceForConfig}
          onRemove={(dev) => handleRemoveDevice(dev.esferaDeviceId || dev.currentAdbAddress || dev.serial)}
          onSave={async (updated) => {
            try {
              await api("update_device", { device: updated });
            } catch (e) {
              console.warn("Erro ao salvar no SQLite:", e);
            }
            setDevicesList((prev) =>
              prev.map((d) => {
                const isMatch =
                  (d.esferaDeviceId && updated.esferaDeviceId && d.esferaDeviceId === updated.esferaDeviceId) ||
                  d.serial === updated.serial ||
                  (d.currentAdbAddress && updated.currentAdbAddress && d.currentAdbAddress === updated.currentAdbAddress);
                return isMatch ? { ...d, ...updated } : d;
              })
            );
            setConfigModalOpen(false);
            refreshDevices();
          }}
        />
      )}

      <ConnectDeviceModal
        isOpen={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        usbDevices={usbDevices}
        loadingUsb={loadingUsb}
        existingDevices={devicesList}
        onFetchUsb={fetchUsbDevices}
        onForceWirelessAdb={handleForceWirelessAdb}
        onConnectDevice={handleConnectDevice}
        onPairAndConnectDevice={handlePairAndConnectDevice}
        linkingSerial={linkingSerial}
        linkingStatus={linkingStatus}
        nextDeviceNumber={devicesList.reduce((max, d) => Math.max(max, d.deviceNumber || 0), 0) + 1}
      />

      {mirrorModalOpen && selectedDeviceForMirror && (
        <MirrorModal
          isOpen={mirrorModalOpen}
          onClose={() => {
            setMirrorModalOpen(false);
            setSelectedDeviceForMirror(null);
          }}
          device={selectedDeviceForMirror}
          onOpenRegion={() => {
            if (selectedDeviceForMirror) {
              setSelectedSerialForRegion(selectedDeviceForMirror.serial);
              setRegionModalOpen(true);
            }
          }}
        />
      )}

      <DiagnosticModal
        isOpen={diagnosticModalOpen}
        onClose={() => setDiagnosticModalOpen(false)}
      />

      <ScreenRegionModal
        isOpen={regionModalOpen}
        onClose={() => setRegionModalOpen(false)}
        serial={selectedSerialForRegion}
      />

      <DeviceIdentityModal
        isOpen={identityModalOpen}
        onClose={() => {
          setIdentityModalOpen(false);
          setSelectedDeviceForDiagnostic(null);
        }}
        device={selectedDeviceForDiagnostic}
      />
    </div>
  );
}




