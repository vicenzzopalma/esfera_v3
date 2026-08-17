

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
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import type { Device, DeviceStatus, DeviceWithActiveUser, DevicePermissionRequest } from "../types";
import { api } from "../tauri";

// Sub-componentes modularizados
import { DeviceCard } from "../components/devices/DeviceCard";
import { DeviceToolbar } from "../components/devices/DeviceToolbar";
import { ConnectDeviceModal } from "../components/devices/ConnectDeviceModal";
import { DeviceConfigModal } from "../components/devices/DeviceConfigModal";
import { MirrorModal } from "../components/devices/MirrorModal";
import { DiagnosticModal } from "../components/devices/DiagnosticModal";
import { ScreenRegionModal } from "../components/devices/ScreenRegionModal";
import { DeviceIdentityModal } from "../components/devices/DeviceIdentityModal";

import {
  Smartphone,
  Plus,
  RefreshCw,
  Eye,
  Bell,
} from "lucide-react";

export default function DevicesTab() {
  const { user, selectedCompanyId } = useAuth();

  // Role Gate
  if (user?.role === "colaborador") return <CollaboratorView />;
  if (user?.role === "supervisor") return <SupervisorView />;

  // Filter & View State
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorTab, setSectorTab] = useState<string>("junior");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Device Data & Selection
  const [devicesList, setDevicesList] = useState<Device[]>([]);
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
      })
      .catch((err) => {
        console.warn("Retorno temporário de IPC para get_devices:", err);
      });

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
    setLinkingStatus("⚡ Forçando ativação da porta 5555 TCP/IP e extraindo IP...");

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLinkingStatus("⏰ Timeout (25s): dispositivo não respondeu. Se é remoto (VPS), já está conectado via túnel.");
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
        setLinkingStatus(`❌ Erro: ${errMsg}`);
        setTimeout(() => setLinkingSerial(null), 4000);
      }
    }
  };

  const handleConnectDevice = async (ipAddress: string, portNumber: number, deviceNumber: number, sector: string, deviceName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(ipAddress);
    setLinkingStatus("🔌 Conectando sem bloquear a interface...");

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLinkingStatus("⏰ Timeout (25s): verifique se o IP está acessível na mesma rede.");
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
        setLinkingStatus(`❌ Erro: ${errMsg}`);
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
    setLinkingStatus("🔑 Enviando código de pareamento para o Android...");
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
      setLinkingStatus(`❌ Erro: ${errMsg}`);
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
  }, [devicesList, sectorTab, searchQuery]);

  const pendingRequests = useMemo(() => {
    return (permissionRequests || []).filter((r) => r.status === "pending");
  }, [permissionRequests]);

  return (
    <div className="space-y-4 animate-fade-in font-sans text-zinc-100 pb-8">
      {/* Banner de Solicitações Pendentes para o Gestor */}
      {pendingRequests.length > 0 && (
        <div className="p-3.5 rounded-xl bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-slate-900 border border-amber-500/40 shadow-xl space-y-2.5 animate-scale-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <h3 className="text-xs font-bold text-amber-300 flex items-center gap-1.5 uppercase tracking-wider">
                <Bell size={14} /> {pendingRequests.length} Solicitação(ões) de Acesso Pendente(s)
              </h3>
            </div>
            <span className="text-[10px] text-amber-400/80 font-mono">
              Aprovação imediata de celular
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {pendingRequests.map((req) => (
              <div
                key={req.requestId}
                className="p-2.5 rounded-lg bg-black/40 border border-amber-500/30 flex items-center justify-between gap-2.5 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-bold text-white truncate">
                    {req.userDisplayName || req.userName}
                  </p>
                  <p className="text-[11px] text-amber-300/90 truncate font-mono">
                    Aparelho: {req.adbDeviceId}
                  </p>
                  {req.requestedReason && (
                    <p className="text-[10px] text-zinc-400 italic truncate">
                      "{req.requestedReason}"
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => handleApproveRequest(req.requestId)}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] px-2.5 py-1 font-bold"
                  >
                    Aprovar
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleRejectRequest(req.requestId)}
                    className="text-[10px] px-2 py-1 font-bold"
                  >
                    Recusar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reusable Clean Toolbar */}
      <DeviceToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sectorTab={sectorTab}
        onSectorChange={setSectorTab}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        devicesList={devicesList}
        onOpenConnectModal={() => setConnectModalOpen(true)}
        onOpenDiagnosticModal={() => setDiagnosticModalOpen(true)}
        onRefreshDevices={refreshDevices}
        selectedSerials={selectedSerials}
        onBatchDelete={handleBatchDeleteSelected}
        onClearOffline={handleClearAllOfflineDevices}
      />

      {/* Grid or Table view */}
      {viewMode === "grid" ? (
        filteredDevices.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
            {filteredDevices.map((device) => {
              const devPendingReq = pendingRequests.find(
                (r) =>
                  r.status === "pending" &&
                  (r.adbDeviceId === device.serial ||
                    r.adbDeviceId === device.currentAdbAddress ||
                    r.adbDeviceId === device.esferaDeviceId ||
                    (device.currentAdbAddress && r.adbDeviceId.includes(device.currentAdbAddress.split(":")[0])))
              );

              return (
                <DeviceCard
                  key={device.serial}
                  device={device}
                  activeUserDisplayName={activeUserMap[device.serial]?.activeUserDisplayName}
                  pendingRequest={devPendingReq}
                  onApproveRequest={handleApproveRequest}
                  onRejectRequest={handleRejectRequest}
                  isSelected={selectedSerials.includes(device.serial)}
                  onToggleSelect={() => toggleSelectDevice(device.serial)}
                  onOpenMirror={() => {
                    setSelectedDeviceForMirror(device);
                    setMirrorModalOpen(true);
                  }}
                  onOpenConfig={() => {
                    setSelectedDeviceForConfig(device);
                    setConfigModalOpen(true);
                  }}
                  onOpenRegion={() => {
                    setSelectedSerialForRegion(device.serial);
                    setRegionModalOpen(true);
                  }}
                  onForceWireless={() => {
                    handleForceWirelessAdb(
                      device.serial,
                      device.deviceNumber,
                      device.sector,
                      device.name || device.model || device.serial
                    );
                  }}
                  onOpenDiagnostic={() => {
                    setSelectedDeviceForDiagnostic(device);
                    setIdentityModalOpen(true);
                  }}
                />
              );
            })}
          </div>
        ) : (
          /* Empty State */
          <div className="py-14 text-center bg-[#141418] border border-dashed border-white/[0.08] rounded-xl p-6 space-y-3 shadow-sm">
            <Smartphone size={36} className="mx-auto text-zinc-600 animate-pulse" />
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Nenhum celular encontrado neste setor</h3>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto mt-0.5">
                Conecte um aparelho Android via USB ou Wi-Fi (ADB) para gerenciá-lo em tempo real.
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={() => setConnectModalOpen(true)} icon={<Plus size={14} />}>
                Conectar Celular
              </Button>
              <Button variant="secondary" size="sm" onClick={refreshDevices} icon={<RefreshCw size={13} />}>
                Sincronizar ADB
              </Button>
            </div>
          </div>
        )
      ) : (
        /* Table View */
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.07] text-[10px] font-semibold text-zinc-400 uppercase tracking-wider bg-white/[0.02]">
                  <th className="px-3.5 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={selectedSerials.length > 0 && selectedSerials.length === filteredDevices.length}
                      onChange={() => {
                        if (selectedSerials.length === filteredDevices.length) setSelectedSerials([]);
                        else setSelectedSerials(filteredDevices.map((d) => d.serial));
                      }}
                      className="w-3.5 h-3.5 rounded border-white/20 bg-zinc-900 text-[#5E6AD2] focus:ring-0 cursor-pointer"
                    />
                  </th>
                  <th className="px-3.5 py-3">Dispositivo</th>
                  <th className="px-4 py-3 font-mono">IP / Serial</th>
                  <th className="px-4 py-3">Setor</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 font-mono">Bateria</th>
                  <th className="px-4 py-3 text-right">Controle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {filteredDevices.map((device) => (
                  <tr key={device.serial} className={`hover:bg-white/[0.02] transition-colors ${selectedSerials.includes(device.serial) ? "bg-[#5E6AD2]/10" : ""}`}>
                    <td className="px-3.5 py-3">
                      <input
                        type="checkbox"
                        checked={selectedSerials.includes(device.serial)}
                        onChange={() => toggleSelectDevice(device.serial)}
                        className="w-3.5 h-3.5 rounded border-white/20 bg-zinc-900 text-[#5E6AD2] focus:ring-0 cursor-pointer"
                      />
                    </td>
                    <td className="px-3.5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Smartphone size={16} className="text-[#828DF7] shrink-0" />
                        <div>
                          <p className="font-semibold text-zinc-100">{device.name || device.model}</p>
                          <p className="text-[10px] text-zinc-500">{device.model}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300 text-[11px]">{device.currentAdbAddress || device.serial}</td>
                    <td className="px-4 py-3 uppercase font-medium text-[10px] text-zinc-400">{device.sector}</td>
                    <td className="px-4 py-3">
                      <Badge variant={device.status === "online" ? "success" : (device.status === "connecting" || device.status === "degraded") ? "warning" : "danger"} dot>
                        {device.status === "degraded" ? "degradado (sem ADB)" : device.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300">{device.battery}%</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Eye size={13} />}
                        onClick={() => {
                          setSelectedDeviceForMirror(device);
                          setMirrorModalOpen(true);
                        }}
                      >
                        Espelhar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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
        nextDeviceNumber={devicesList.length + 1}
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




