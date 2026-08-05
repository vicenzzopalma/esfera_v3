

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
import type { Device, DeviceStatus, DeviceWithActiveUser } from "../types";
import { api } from "../tauri";

// Sub-componentes modularizados
import { DeviceCard } from "../components/devices/DeviceCard";
import { DeviceToolbar } from "../components/devices/DeviceToolbar";
import { ConnectDeviceModal } from "../components/devices/ConnectDeviceModal";
import { DeviceConfigModal } from "../components/devices/DeviceConfigModal";
import { MirrorModal } from "../components/devices/MirrorModal";
import { DiagnosticModal } from "../components/devices/DiagnosticModal";
import { ScreenRegionModal } from "../components/devices/ScreenRegionModal";

import {
  Smartphone,
  Plus,
  RefreshCw,
  Eye,
} from "lucide-react";

export default function DevicesTab() {
  const { user, selectedCompanyId } = useAuth();

  // Role Gate
  if (user?.role === "colaborador") return <CollaboratorView />;
  if (user?.role === "supervisor") return <SupervisorView />;

  // Filter & View State
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorTab, setSectorTab] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Device Data & Selection
  const [devicesList, setDevicesList] = useState<Device[]>([]);
  const [selectedSerials, setSelectedSerials] = useState<string[]>([]);
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
  }, [effectiveCompanyId]);

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
        setDevicesList((prev) =>
          prev.map((d) =>
            d.esferaDeviceId === event.payload.esferaDeviceId
              ? {
                  ...d,
                  currentAdbAddress: event.payload.currentAdbAddress,
                  status: event.payload.status as DeviceStatus,
                  lastSeenUtc: event.payload.lastSeenUtc,
                }
              : d
          )
        );
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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
    try {
      const result = await api<string>("force_enable_wireless_adb", {
        serial,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName || serial,
      });
      setLinkingStatus(result);
      refreshDevices();
      setTimeout(() => {
        setConnectModalOpen(false);
        setLinkingSerial(null);
        setLinkingStatus(null);
      }, 2000);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro ao forçar depuração Wi-Fi.";
      setLinkingStatus(`❌ Erro: ${errMsg}`);
      setTimeout(() => setLinkingSerial(null), 4000);
    }
  };

  const handleConnectDevice = async (ipAddress: string, portNumber: number, deviceNumber: number, sector: string, deviceName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(ipAddress);
    setLinkingStatus("🔌 Conectando sem bloquear a interface...");
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
      refreshDevices();
      setConnectModalOpen(false);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro ao conectar por IP.";
      setLinkingStatus(`❌ Erro: ${errMsg}`);
    } finally {
      setLinkingSerial(null);
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

  const handleRemoveDevice = async (serial: string) => {
    try {
      await api("delete_device", { serial });
      setDevicesList((prev) => prev.filter((d) => d.serial !== serial));
      setSelectedSerials((prev) => prev.filter((s) => s !== serial));
      refreshDevices();
    } catch (e) {
      console.warn("Falha ao apagar dispositivo:", e);
    }
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
      .filter((device, _, arr) => {
        if (!device) return false;
        const serial = String(device.serial || "");
        const status = String(device.status || "offline");
        const model = String(device.model || "");
        const brand = String(device.brand || "");
        const ip = String(device.ip || "");
        const sector = String(device.sector || "junior").toLowerCase().replace(/[- _.]/g, "");

        if (status === "offline" && !serial.includes(":")) {
          const hasOnlineWireless = arr.some(
            (other) => other && String(other.model || "") === model && String(other.status || "") === "online" && String(other.serial || "").includes(":")
          );
          if (hasOnlineWireless) return false;
        }

        if (sectorTab !== "all") {
          const targetSector = sectorTab.toLowerCase().replace(/[- _.]/g, "");
          if (sector !== targetSector) return false;
        }

        if (searchQuery) {
          const q = searchQuery.toLowerCase().trim();
          return (
            model.toLowerCase().includes(q) ||
            brand.toLowerCase().includes(q) ||
            serial.toLowerCase().includes(q) ||
            ip.toLowerCase().includes(q)
          );
        }

        return true;
      })
      .sort((a, b) => {
        const nameA = String(a.name || a.model || `Aparelho ${a.deviceNumber || 1}`);
        const nameB = String(b.name || b.model || `Aparelho ${b.deviceNumber || 1}`);
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
      });
  }, [devicesList, sectorTab, searchQuery]);

  return (
    <div className="space-y-4 animate-fade-in font-sans text-zinc-100 pb-8">
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
            {filteredDevices.map((device) => (
              <DeviceCard
                key={device.serial}
                device={device}
                activeUserDisplayName={activeUserMap[device.serial]?.activeUserDisplayName}
                isSelected={selectedSerials.includes(device.serial)}
                onToggleSelect={() => toggleSelectDevice(device.serial)}
                onRemove={() => handleRemoveDevice(device.serial)}
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
                    device.name || `Aparelho ${device.deviceNumber}`
                  );
                }}
              />
            ))}
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
                      <Badge variant={device.status === "online" ? "success" : device.status === "connecting" ? "warning" : "danger"} dot>
                        {device.status}
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
          onSave={async (updated) => {
            try {
              await api("update_device", { device: updated });
            } catch (e) {
              console.warn("Erro ao salvar no SQLite:", e);
            }
            setDevicesList((prev) => prev.map((d) => (d.serial === updated.serial ? updated : d)));
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
    </div>
  );
}




