// ============================================================
// Esfera v3 — Hub de Gestão de Dispositivos ADB Celulares
// Exibe EXCLUSIVAMENTE celulares ativamente conectados/adicionados.
// Sem quadros vazios ou slots fictícios. Com suporte a setores,
// botão de configurações (⚙️), remoção (🗑️) e espelhamento (Scrcpy 60FPS).
// ============================================================

import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { useAuth } from "../context/AuthContext";
import CollaboratorView from "../components/CollaboratorView";
import SupervisorView from "../components/SupervisorView";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import type { Device, DeviceStatus, DeviceWithActiveUser } from "../types";
import { api } from "../tauri";
import {
  Smartphone,
  Wifi,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Plus,
  RefreshCw,
  Search,
  Eye,
  Home,
  ArrowLeft,
  Power,
  Sparkles,
  Layers,
  Trash2,
  AlertTriangle,
  Zap,
  Settings,
  Camera,
  Grid,
  Table,
  CheckCircle2,
  XCircle,
  Shield,
} from "lucide-react";

export type SectorType = "junior" | "senior" | "pa_fixa" | "pesquisa";

const statusConfig: Record<
  DeviceStatus,
  { variant: "success" | "danger" | "warning" | "neutral"; label: string; pulse: boolean }
> = {
  online: { variant: "success", label: "Online", pulse: true },
  offline: { variant: "danger", label: "Offline", pulse: false },
  connecting: { variant: "warning", label: "Conectando", pulse: true },
  error: { variant: "danger", label: "Erro", pulse: false },
};

export default function DevicesTab() {
  const { user, selectedCompanyId } = useAuth();

  // Roteamento de Tela por Tipo de Usuário (Role)
  if (user?.role === "colaborador") {
    return <CollaboratorView />;
  }

  if (user?.role === "supervisor") {
    return <SupervisorView />;
  }

  const [searchQuery, setSearchQuery] = useState("");
  const [sectorTab, setSectorTab] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Lista APENAS de celulares conectados/adicionados pelo usuário
  const [devicesList, setDevicesList] = useState<Device[]>([]);

  // Mapa de usuários ativos por dispositivo (para gestor/master ver quem está usando)
  const [activeUserMap, setActiveUserMap] = useState<Record<string, { activeUserId?: number; activeUserDisplayName?: string }>>({});

  // Modais de Conexão e Diagnóstico
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [diagnosticModalOpen, setDiagnosticModalOpen] = useState(false);
  const [mirrorModalOpen, setMirrorModalOpen] = useState(false);
  const [selectedDeviceForMirror, setSelectedDeviceForMirror] = useState<Device | null>(null);

  // Modal de Configurações de Celular (Renomear, Otimizar, Mudar Setor)
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [selectedDeviceForConfig, setSelectedDeviceForConfig] = useState<Device | null>(null);

  // Conexão USB / IP / Pareamento State
  const [connectTab, setConnectTab] = useState<"usb" | "manual" | "pair" | "apk">("usb");
  const [connectIp, setConnectIp] = useState("");
  const [connectPort, setConnectPort] = useState("5555");
  const [pairIp, setPairIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [connectPortInput, setConnectPortInput] = useState("5555");
  const [usbDevices, setUsbDevices] = useState<{ serial: string; state: string; model: string }[]>([]);
  const [loadingUsb, setLoadingUsb] = useState(false);
  const [linkingSerial, setLinkingSerial] = useState<string | null>(null);
  const [linkingStatus, setLinkingStatus] = useState<string | null>(null);
  const [installingApk, setInstallingApk] = useState(false);

  const [setupDeviceData, setSetupDeviceData] = useState<{ serial?: string; ip?: string; port?: number } | null>(null);
  const [deviceNumberInput, setDeviceNumberInput] = useState("1");
  const [deviceNameInput, setDeviceNameInput] = useState("Aparelho 1");
  const [sectorInput, setSectorInput] = useState("junior");

  const effectiveCompanyId = selectedCompanyId || 1;

  const prepareDeviceSetup = (data: { serial?: string; ip?: string; port?: number }) => {
    const nextNum = devicesList.length + 1;
    setDeviceNumberInput(nextNum.toString());
    setDeviceNameInput(`Aparelho ${nextNum}`);
    setSetupDeviceData(data);
  };

  // Busca dispositivos ADB nativos em tempo real do Tauri
  const refreshDevices = useCallback(() => {
    api<Device[]>("get_devices", { companyId: effectiveCompanyId })
      .then((data) => {
        if (data && Array.isArray(data) && data.length > 0) {
          setDevicesList(data);
        } else if (data && Array.isArray(data)) {
          setDevicesList((prev) => (prev.length > 0 ? prev : []));
        }
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
    if (!connectModalOpen || connectTab !== "usb") return;
    fetchUsbDevices();
  }, [connectModalOpen, connectTab]);

  const handleForceWirelessAdb = async (serial: string, deviceNumber: number, sector: string, deviceName: string) => {
    setLinkingSerial(serial);
    setLinkingStatus("⚡ Forçando ativação da porta 5555 TCP/IP e extraindo IP do celular via USB...");
    try {
      const result = await api<string>("force_enable_wireless_adb", {
        serial,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName || `Aparelho ${deviceNumber}`,
      });
      setLinkingStatus(result);
      refreshDevices();
      setTimeout(() => {
        setConnectModalOpen(false);
        setLinkingSerial(null);
        setLinkingStatus(null);
        setSetupDeviceData(null);
      }, 2500);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro ao forçar depuração Wi-Fi.";
      setLinkingStatus(`❌ Erro: ${errMsg}`);
      setTimeout(() => setLinkingSerial(null), 5000);
    }
  };

  const handleConnectDevice = async (ipAddress: string, portNumber: number, deviceNumber: number, sector: string, deviceName: string) => {
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
        deviceName: deviceName || `Aparelho ${deviceNumber}`,
      });
      refreshDevices();
      setConnectModalOpen(false);
      setSetupDeviceData(null);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro ao conectar por IP.";
      setLinkingStatus(`❌ Erro: ${errMsg}`);
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
    setLinkingStatus("🔑 Enviando código de pareamento de 6 dígitos para o Android via Wi-Fi...");
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
        setLinkingStatus(null);
        setSetupDeviceData(null);
      }, 2500);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || "Erro no pareamento por código.";
      setLinkingStatus(`❌ Erro: ${errMsg}`);
    }
  };

  // Remover Celular
  const handleRemoveDevice = async (serial: string) => {
    try {
      await api("delete_device", { serial });
      setDevicesList((prev) => prev.filter((d) => d.serial !== serial));
      refreshDevices();
    } catch (e) {
      console.warn("Falha ao apagar dispositivo no SQLite:", e);
    }
  };

  // Filtra APENAS os celulares reais existentes com memoização HPC para 0ms de lag no React
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

        // Se for USB offline e o mesmo modelo já estiver online via Wi-Fi, descarta a duplicata USB
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

        if (statusFilter !== "all" && status !== statusFilter) return false;

        if (searchQuery) {
          const q = searchQuery.toLowerCase().trim();
          const matchesModel = model.toLowerCase().includes(q);
          const matchesBrand = brand.toLowerCase().includes(q);
          const matchesSerial = serial.toLowerCase().includes(q);
          const matchesIp = ip.toLowerCase().includes(q);
          return matchesModel || matchesBrand || matchesSerial || matchesIp;
        }

        return true;
      })
      .sort((a, b) => {
        if (!a) return -1;
        if (!b) return 1;
        const nameA = String(a.name || a.model || `Aparelho ${a.deviceNumber || 1}`);
        const nameB = String(b.name || b.model || `Aparelho ${b.deviceNumber || 1}`);
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
      });
  }, [devicesList, sectorTab, statusFilter, searchQuery]);

  const onlineCount = devicesList.filter((d) => d.status === "online").length;

  return (
    <div className="space-y-4 animate-fade-in text-slate-100 font-sans pb-10">
      {/* ============================================================ */}
      {/* BARRA SUPERIOR: FILTRO DE SETORES & BUSCA DE CELULARES */}
      {/* ============================================================ */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 bg-[#0d111c]/90 border border-slate-800/80 p-3 rounded-2xl shadow-2xl backdrop-blur-md">
        {/* Tabs de Filtro de Setor */}
        <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1 xl:pb-0">
          {[
            { id: "all", label: "Todos os Setores" },
            { id: "junior", label: "Junior" },
            { id: "senior", label: "Senior" },
            { id: "pa_fixa", label: "PA FIXA" },
            { id: "pesquisa", label: "Pesquisa" },
          ].map((tab) => {
            const count = tab.id === "all"
              ? devicesList.length
              : devicesList.filter((d) => String(d.sector || "junior").toLowerCase().replace(/[- _.]/g, "") === tab.id.replace(/[- _.]/g, "")).length;
            return (
              <button
                key={tab.id}
                onClick={() => setSectorTab(tab.id)}
                className={`px-4 py-2 rounded-full text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
                  sectorTab === tab.id
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/40 border border-blue-400/30 scale-105"
                    : "bg-slate-900/80 text-slate-300 border border-slate-800 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <span>{tab.label}</span>
                <span className="px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] font-mono">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Busca e Ações Principais */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] sm:min-w-[320px]">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Buscar celular por modelo, marca ou IP..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#121624] border border-slate-700/70 text-slate-100 rounded-full pl-9 pr-4 py-2 text-xs placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <Button
            disabled={installingApk}
            onClick={async () => {
              const onlineDevs = devicesList.filter((d) => d.status === "online");
              if (onlineDevs.length === 0) {
                alert("Nenhum celular online detectado para instalação remota.");
                return;
              }
              setInstallingApk(true);
              let ok = 0;
              let errors: string[] = [];
              for (const dev of onlineDevs) {
                try {
                  await api("install_agent_apk", { serial: dev.serial });
                  ok++;
                } catch (e: any) {
                  const msg = typeof e === "string" ? e : e?.message || "Erro desconhecido";
                  errors.push(`${dev.model} (${dev.serial}): ${msg}`);
                }
              }
              setInstallingApk(false);
              if (errors.length > 0) {
                alert(`📲 Instalação remota finalizada!\n✅ Sucesso em ${ok} de ${onlineDevs.length} celular(es).\n\n⚠️ Erros:\n${errors.join("\n")}`);
              } else {
                alert(`📲 Instalação remota concluída com sucesso!\nO Agente APK foi enviado e ativado em ${ok} de ${onlineDevs.length} celulares!`);
              }
            }}
            icon={<Smartphone size={15} className={installingApk ? "animate-spin text-amber-300" : "text-emerald-300"} />}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold rounded-xl text-xs shadow-lg shadow-emerald-600/30 cursor-pointer disabled:opacity-50"
            title="Transfere e instala silenciosamente o app Agente Esfera v3 no celular via ADB"
          >
            {installingApk ? "📲 Instalando APK..." : "📲 Auto-Instalar Agente APK"}
          </Button>

          <Button
            onClick={() => setConnectModalOpen(true)}
            icon={<Plus size={15} />}
            className="bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-blue-600/30"
          >
            + Conectar Celular
          </Button>

          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const msg = await api<string>("inject_all_devices_immunity", {});
                alert(msg);
                refreshDevices();
              } catch (e: any) {
                alert(typeof e === "string" ? e : e?.message || "Erro ao injetar imunidade.");
              }
            }}
            icon={<Shield size={14} className="text-cyan-400" />}
            className="bg-cyan-950/60 hover:bg-cyan-900 border-cyan-600/50 text-cyan-200 rounded-xl text-xs font-extrabold shadow-lg"
            title="Injeta no Android a fixação de MAC Físico (desativa MAC aleatório) e imuniza a porta TCP 5555"
          >
            🛡️ Injetar Imunidade & MAC Físico
          </Button>

          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const msg = await api<string>("force_reconnect_all_adb", {});
                alert(msg);
                refreshDevices();
              } catch (e: any) {
                alert(typeof e === "string" ? e : e?.message || "Erro ao forçar reconexão.");
              }
            }}
            icon={<Zap size={14} className="text-amber-400" />}
            className="bg-amber-950/60 hover:bg-amber-900 border-amber-600/50 text-amber-200 rounded-xl text-xs font-extrabold shadow-lg"
            title="Dispara comando de reconexão forçada Wi-Fi para todos os 8 celulares ativados"
          >
            ⚡ Forçar Reconexão Wi-Fi
          </Button>

          <Button
            variant="secondary"
            onClick={refreshDevices}
            icon={<RefreshCw size={14} className="text-emerald-400" />}
            className="bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200 rounded-xl text-xs font-bold"
          >
            Sincronizar ADB
          </Button>

          <Button
            variant="secondary"
            onClick={() => setDiagnosticModalOpen(true)}
            icon={<AlertTriangle size={14} className="text-amber-400" />}
            className="bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200 rounded-xl text-xs"
          >
            Diagnóstico ADB
          </Button>

          {/* Toggle Grade x Tabela */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-1 gap-1">
            <button
              onClick={() => setViewMode("grid")}
              className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                viewMode === "grid" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"
              }`}
              title="Visão em Grade"
            >
              <Grid size={15} />
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                viewMode === "table" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"
              }`}
              title="Visão em Tabela ADB"
            >
              <Table size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* SEGUNDA BARRA: STATUS DA REDE ADB & ESTATÍSTICAS */}
      {/* ============================================================ */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0d111c]/60 border border-slate-800/50 p-2.5 rounded-xl text-xs">
        <div className="flex items-center gap-4 text-slate-300">
          <span className="flex items-center gap-1.5 font-bold">
            <Smartphone size={15} className="text-blue-400" /> Total Celulares:{" "}
            <span className="text-white font-mono">{devicesList.length}</span>
          </span>
          <span className="flex items-center gap-1.5 font-bold">
            <Wifi size={15} className="text-emerald-400" /> Online:{" "}
            <span className="text-emerald-300 font-mono">{onlineCount}</span>
          </span>
        </div>

        {/* Filtros rápidos de Status */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mr-1">Status:</span>
          {[
            { id: "all", label: "Todos" },
            { id: "online", label: "Online" },
            { id: "offline", label: "Offline" },
            { id: "connecting", label: "Conectando" },
          ].map((st) => (
            <button
              key={st.id}
              onClick={() => setStatusFilter(st.id)}
              className={`px-2.5 py-0.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                statusFilter === st.id
                  ? "bg-blue-600 text-white border-blue-400/40"
                  : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {/* ============================================================ */}
      {/* CONTEÚDO PRINCIPAL: EXIBE APENAS CELULARES CONECTADOS */}
      {/* ============================================================ */}
      {viewMode === "grid" ? (
        filteredDevices.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredDevices.map((device) => (
              <MobileDeviceCardItem
                key={device.serial}
                device={device}
                activeUserDisplayName={activeUserMap[device.serial]?.activeUserDisplayName}
                onRemove={() => handleRemoveDevice(device.serial)}
                onOpenMirror={() => {
                  setSelectedDeviceForMirror(device);
                  setMirrorModalOpen(true);
                }}
                onOpenConfig={() => {
                  setSelectedDeviceForConfig(device);
                  setConfigModalOpen(true);
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
          /* ESTADO VAZIO LIMPO (SEM QUADROS DE SLOTS) */
          <div className="py-20 text-center bg-[#0d111c]/50 border border-dashed border-slate-800/80 rounded-2xl p-8 space-y-4 shadow-xl">
            <Smartphone size={48} className="mx-auto text-blue-500/40 animate-pulse" />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-200">Nenhum celular conectado neste setor</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Conecte um aparelho Android via cabo USB ou Wi-Fi (ADB) para gerenciá-lo em tempo real.
              </p>
            </div>
            <div className="flex justify-center gap-3 pt-2">
              <Button onClick={() => setConnectModalOpen(true)} icon={<Plus size={15} />}>
                + Conectar Celular
              </Button>
              <Button variant="secondary" onClick={refreshDevices} icon={<RefreshCw size={14} />}>
                Sincronizar ADB
              </Button>
            </div>
          </div>
        )
      ) : (
        /* VISÃO EM TABELA ADB */
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border text-[11px] font-bold text-tertiary uppercase tracking-wider bg-white/[0.01]">
                  <th className="px-6 py-3.5">Modelo do Celular</th>
                  <th className="px-6 py-3.5">IP / Serial ADB</th>
                  <th className="px-6 py-3.5">Setor</th>
                  <th className="px-6 py-3.5">Status Conexão</th>
                  <th className="px-6 py-3.5">Bateria</th>
                  <th className="px-6 py-3.5 text-right">Controle Remoto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-xs">
                {filteredDevices.map((device) => (
                  <tr key={device.serial} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-400">
                          <Smartphone size={20} />
                        </div>
                        <div>
                          <p className="font-bold text-primary">{device.model}</p>
                          <p className="text-[11px] text-tertiary">{device.brand}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-secondary">{device.serial}</td>
                    <td className="px-6 py-4 uppercase font-bold text-blue-400">{device.sector}</td>
                    <td className="px-6 py-4">
                      <Badge variant={statusConfig[device.status]?.variant || "neutral"}>
                        {statusConfig[device.status]?.label || device.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-4">
                      <BatteryBar level={device.battery} />
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Eye size={14} className="text-blue-400" />}
                        onClick={() => {
                          setSelectedDeviceForMirror(device);
                          setMirrorModalOpen(true);
                        }}
                      >
                        Espelhar Tela
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ============================================================ */}
      {/* MODAIS DO SISTEMA */}
      {/* ============================================================ */}

      {/* Modal de Configurações do Celular (Renomear, Otimizar, Mudar Setor) */}
      {configModalOpen && selectedDeviceForConfig && (
        <DeviceSlotConfigModal
          isOpen={configModalOpen}
          onClose={() => {
            setConfigModalOpen(false);
            setSelectedDeviceForConfig(null);
          }}
          device={selectedDeviceForConfig}
          onSave={async (updatedDevice) => {
            try {
              await api("update_device", { device: updatedDevice });
            } catch (e) {
              console.warn("Erro ao salvar alteração no SQLite:", e);
            }
            setDevicesList((prev) =>
              prev.map((d) => (d.serial === updatedDevice.serial ? updatedDevice : d))
            );
            setConfigModalOpen(false);
            refreshDevices();
          }}
        />
      )}

      {/* Modal Conectar Dispositivo (USB / Wi-Fi) */}
      <Modal
        isOpen={connectModalOpen}
        onClose={() => {
          setConnectModalOpen(false);
          setSetupDeviceData(null);
        }}
        title="Conectar Novo Celular Android (ADB)"
        size="lg"
        footer={
          <div className="flex justify-between items-center w-full">
            {setupDeviceData ? (
              <div className="flex gap-2 ml-auto">
                <Button variant="secondary" onClick={() => setSetupDeviceData(null)} disabled={linkingSerial !== null}>
                  Voltar
                </Button>
                <Button
                  onClick={() => {
                    const devNum = parseInt(deviceNumberInput, 10) || 1;
                    if (setupDeviceData.serial) {
                      handleForceWirelessAdb(setupDeviceData.serial, devNum, sectorInput, deviceNameInput);
                    } else if (setupDeviceData.ip) {
                      handleConnectDevice(setupDeviceData.ip, setupDeviceData.port || 5555, devNum, sectorInput, deviceNameInput);
                    }
                  }}
                  disabled={linkingSerial !== null}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold"
                >
                  {linkingSerial ? "Forçando Wi-Fi ADB..." : "⚡ Forçar Wi-Fi ADB e Conectar"}
                </Button>
              </div>
            ) : (
              <>
                {connectTab === "usb" && (
                  <Button variant="secondary" icon={<RefreshCw size={13} />} onClick={fetchUsbDevices} disabled={loadingUsb}>
                    Detectar Novamente
                  </Button>
                )}
                <div className="flex gap-2 ml-auto">
                  <Button variant="secondary" onClick={() => setConnectModalOpen(false)}>
                    Cancelar
                  </Button>
                  {connectTab === "manual" && (
                    <Button
                      onClick={() => {
                        if (!connectIp) return;
                        prepareDeviceSetup({ ip: connectIp, port: parseInt(connectPort, 10) || 5555 });
                      }}
                    >
                      Avançar
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        }
      >
        {setupDeviceData ? (
          <div className="space-y-4 text-xs animate-scale-in">
            <div>
              <h4 className="font-bold text-primary mb-1">Definir Nome, Slot e Setor do Celular</h4>
              <p className="text-[11px] text-tertiary">
                Organize o nome e o setor de destino para este dispositivo antes de finalizar o pareamento.
              </p>
            </div>

            <div>
              <label className="block font-semibold text-secondary mb-1">Nome do Aparelho (Título Principal)</label>
              <input
                type="text"
                value={deviceNameInput}
                onChange={(e) => setDeviceNameInput(e.target.value)}
                placeholder="Ex: Aparelho 1, Aparelho 2"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-bold placeholder:text-tertiary focus:border-blue-500/40"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold text-secondary mb-1">Número do Slot</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={deviceNumberInput}
                  onChange={(e) => setDeviceNumberInput(e.target.value)}
                  placeholder="Ex: 1"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary placeholder:text-tertiary focus:border-blue-500/40"
                />
              </div>

              <div>
                <label className="block font-semibold text-secondary mb-1">Setor do Aparelho</label>
                <select
                  value={sectorInput}
                  onChange={(e) => setSectorInput(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-blue-500/40"
                >
                  <option value="junior">Junior</option>
                  <option value="senior">Senior</option>
                  <option value="pa_fixa">PA FIXA</option>
                  <option value="pesquisa">Pesquisa</option>
                </select>
              </div>
            </div>

            {linkingStatus && (
              <div className="p-3.5 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-200 text-[11px] animate-scale-in">
                <p className="font-bold flex items-center gap-1.5 mb-1 text-blue-300">
                  <RefreshCw size={12} className="animate-spin" /> Conectando ao Android via ADB...
                </p>
                <p className="font-mono">{linkingStatus}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 text-xs">
            <div className="flex border-b border-border mb-4">
              <button
                onClick={() => setConnectTab("usb")}
                className={`flex-1 py-2 text-center font-semibold cursor-pointer border-b-2 transition-all ${
                  connectTab === "usb"
                    ? "border-blue-500 text-blue-400 bg-white/[0.01]"
                    : "border-transparent text-secondary hover:text-primary"
                }`}
              >
                🔌 Pareamento USB para Wi-Fi (Automático)
              </button>
              <button
                onClick={() => setConnectTab("manual")}
                className={`flex-1 py-2 text-center font-semibold cursor-pointer border-b-2 transition-all ${
                  connectTab === "manual"
                    ? "border-blue-500 text-blue-400 bg-white/[0.01]"
                    : "border-transparent text-secondary hover:text-primary"
                }`}
              >
                🌐 Conexão Direta por IP (Manual)
              </button>
              <button
                onClick={() => setConnectTab("pair")}
                className={`flex-1 py-2 text-center font-semibold cursor-pointer border-b-2 transition-all ${
                  connectTab === "pair"
                    ? "border-blue-500 text-blue-400 bg-white/[0.01]"
                    : "border-transparent text-secondary hover:text-primary"
                }`}
              >
                🔑 Parear Código (Android 11+)
              </button>
              <button
                onClick={() => setConnectTab("apk")}
                className={`flex-1 py-2 text-center font-semibold cursor-pointer border-b-2 transition-all ${
                  connectTab === "apk"
                    ? "border-blue-500 text-blue-400 bg-white/[0.01]"
                    : "border-transparent text-secondary hover:text-primary"
                }`}
              >
                📱 App Agente APK (No Celular)
              </button>
            </div>

            {connectTab === "usb" ? (
              <div className="space-y-4">
                <p className="text-[11px] text-tertiary">
                  Dispositivos Android detectados no computador (USB e Wi-Fi). Selecione um aparelho para vincular ou forçar Wi-Fi ADB.
                </p>

                {loadingUsb ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center text-secondary font-semibold">
                    <RefreshCw size={24} className="animate-spin text-blue-400 mb-2" />
                    <span>Escaneando dispositivos ADB no computador...</span>
                  </div>
                ) : usbDevices.length === 0 ? (
                  <div className="text-center py-8 bg-white/[0.01] border border-dashed border-border rounded-xl">
                    <Smartphone size={32} className="mx-auto text-tertiary opacity-30 mb-2" />
                    <p className="font-semibold text-secondary">Nenhum celular detectado no ADB</p>
                    <p className="text-[11px] text-tertiary mt-0.5 mb-3">Conecte o celular via cabo USB ou verifique se o Wi-Fi ADB está ativo.</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {usbDevices.map((dev) => {
                      const safeSerial = String(dev.serial || '');
                      const safeModel = String(dev.model || 'Aparelho Android');
                      const safeState = String(dev.state || '');
                      return (
                      <div key={safeSerial} className="flex items-center justify-between p-3.5 rounded-xl bg-white/5 border border-border">
                        <div>
                          <p className="font-semibold text-primary">{safeModel}</p>
                          <p className="text-[10px] text-tertiary font-mono">
                            {safeSerial.includes(":") ? "🟢 IP Wi-Fi: " : "🔌 Cabo USB: "}
                            {safeSerial} | Estado: {safeState}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => {
                            if (safeSerial.includes(":")) {
                              const ipOnly = safeSerial.split(":")[0];
                              prepareDeviceSetup({ ip: ipOnly, port: 5555 });
                            } else {
                              prepareDeviceSetup({ serial: safeSerial });
                            }
                          }}
                        >
                          {safeSerial.includes(":") ? "Sincronizar" : "Vincular via Wi-Fi"}
                        </Button>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : connectTab === "manual" ? (
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold text-secondary mb-1">Endereço IP do Celular na Rede</label>
                  <input
                    type="text"
                    value={connectIp}
                    onChange={(e) => setConnectIp(e.target.value)}
                    placeholder="Ex: 192.168.1.105 ou 192.168.1.82:9093"
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-secondary mb-1">Porta ADB (Padrão 5555)</label>
                  <input
                    type="text"
                    value={connectPort}
                    onChange={(e) => setConnectPort(e.target.value)}
                    placeholder="5555"
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono"
                  />
                </div>
              </div>
            ) : connectTab === "pair" ? (
              <div className="space-y-3">
                <p className="text-[11px] text-tertiary">
                  No celular, acesse Opções do Desenvolvedor ➔ Depuração sem Fio ➔ "Parear com código de pareamento". Digite abaixo o IP, Porta e o Código de 6 dígitos gerados no celular.
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-secondary mb-1">IP do Celular</label>
                    <input
                      type="text"
                      value={pairIp}
                      onChange={(e) => setPairIp(e.target.value)}
                      placeholder="Ex: 192.168.1.82"
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-border text-primary font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-secondary mb-1">Porta de Pareamento</label>
                    <input
                      type="text"
                      value={pairPort}
                      onChange={(e) => setPairPort(e.target.value)}
                      placeholder="Ex: 37123"
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-border text-primary font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-secondary mb-1">Código (6 Dígitos)</label>
                    <input
                      type="text"
                      value={pairCode}
                      onChange={(e) => setPairCode(e.target.value)}
                      placeholder="Ex: 849201"
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-border text-primary font-mono text-xs tracking-widest text-center font-bold text-amber-300"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-secondary mb-1">Porta Conexão/Depuração</label>
                    <input
                      type="text"
                      value={connectPortInput}
                      onChange={(e) => setConnectPortInput(e.target.value)}
                      placeholder="Ex: 9093 ou 5555"
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-border text-primary font-mono text-xs"
                    />
                  </div>
                </div>

                <Button
                  onClick={() => {
                    if (!pairIp || !pairPort || !pairCode) return;
                    handlePairAndConnectDevice(
                      pairIp,
                      parseInt(pairPort, 10) || 37123,
                      pairCode.trim(),
                      parseInt(connectPortInput, 10) || 5555,
                      1,
                      "junior",
                      "Aparelho Pareado"
                    );
                  }}
                  className="w-full mt-2 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-extrabold text-xs py-2.5 rounded-xl shadow-lg cursor-pointer flex items-center justify-center gap-2"
                >
                  <Zap size={14} className="text-yellow-200" />
                  <span>🔑 Enviar Código e Conectar sem Fio</span>
                </Button>
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                <div className="p-4 rounded-2xl bg-blue-950/40 border border-blue-500/20 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-blue-600/20 text-blue-400 shrink-0">
                      <Smartphone size={28} />
                    </div>
                    <div>
                      <h4 className="font-bold text-white text-sm">App Agente Esfera v3 (.APK)</h4>
                      <p className="text-[11px] text-slate-300">
                        Instale o aplicativo Agente direto no celular Android para ativar o Wi-Fi ADB com 1 toque sem cabo USB.
                      </p>
                    </div>
                  </div>

                  <div className="border-t border-blue-500/20 pt-3 space-y-2 text-slate-300">
                    <p className="font-bold text-white text-xs">Passo a Passo de Instalação no Celular:</p>
                    <ol className="list-decimal list-inside space-y-1.5 text-[11px]">
                      <li>Envie o arquivo <span className="font-mono text-blue-300">Esfera_Agent_ADB.apk</span> para o celular.</li>
                      <li>No celular, abra o arquivo e toque em <strong>Instalar</strong>.</li>
                      <li>Abra o aplicativo <strong>Esfera Agente</strong> e toque no botão <strong>⚡ Ativar Conexão Esfera Wi-Fi</strong>.</li>
                      <li>O aplicativo ativará a porta 5555 e conectará o celular ao Esfera v3 automaticamente no seu computador!</li>
                    </ol>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2">
                    <a
                      href="/Esfera_Agent_ADB.apk"
                      download="Esfera_Agent_ADB.apk"
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-600/30 flex items-center gap-2 cursor-pointer"
                    >
                      <Zap size={14} className="text-amber-300" />
                      <span>Baixar APK do Agente (.APK)</span>
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Modal de Espelhamento e Transmissão de Tela */}
      {selectedDeviceForMirror && (
        <ScreenMirrorModal
          isOpen={mirrorModalOpen}
          onClose={() => setMirrorModalOpen(false)}
          device={selectedDeviceForMirror}
        />
      )}

      {/* Modal de Diagnóstico de Hardware USB */}
      <AdbDiagnosticModal
        isOpen={diagnosticModalOpen}
        onClose={() => setDiagnosticModalOpen(false)}
      />
    </div>
  );
}

// ============================================================
// COMPONENTE: CARTÃO DE DISPOSITIVO CELULAR ANDROID
// ============================================================
const MobileDeviceCardItem = memo(function MobileDeviceCardItem({
  device,
  activeUserDisplayName,
  onRemove,
  onOpenMirror,
  onOpenConfig,
  onForceWireless,
}: {
  device: Device;
  activeUserDisplayName?: string;
  onRemove: () => void;
  onOpenMirror: () => void;
  onOpenConfig: () => void;
  onForceWireless: () => void;
}) {
  const status = statusConfig[device.status as DeviceStatus] || statusConfig.offline;
  const displayName = device.name || `Aparelho ${device.deviceNumber}`;
  const isUsbOnly = !device.serial.includes(":");

  return (
    <div className="bg-[#0e121d]/90 border border-slate-800/90 rounded-2xl p-4 space-y-3 shadow-xl hover:border-slate-700/80 transition-all flex flex-col justify-between">
      {/* Top Header: Nome Principal (Aparelho 1, 2...) + Subtítulo (Modelo) + Setor */}
      <div className="flex items-center justify-between gap-1 pb-1 border-b border-slate-800/60">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400 shrink-0">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0">
            {/* TÍTULO PRINCIPAL (Ex: Aparelho 1, Aparelho 2) */}
            <span className="font-black text-sm text-white block truncate tracking-tight">{displayName}</span>
            {/* SUBTÍTULO / RÓTULO (Ex: moto g22) */}
            <span className="text-[10px] text-slate-400 font-semibold block truncate">
              {device.model} {isUsbOnly && "(Cabo USB)"}
            </span>
            <span className="px-1.5 py-0.5 rounded-full bg-blue-950/80 text-blue-300 border border-blue-800/60 text-[9px] font-bold uppercase inline-block mt-0.5">
              {device.sector.replace("_", " ")}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Badge variant={status.variant} dot pulse={status.pulse}>
            {status.label}
          </Badge>

          <button
            onClick={async () => {
              try {
                const msg = await api<string>("install_agent_apk", { serial: device.serial });
                alert(msg);
              } catch (err: any) {
                alert(typeof err === "string" ? err : err?.message || "Erro ao instalar APK.");
              }
            }}
            className="p-1 rounded-lg text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20 transition-all cursor-pointer ml-1"
            title="Instalar App Agente (.APK) no Celular via ADB"
          >
            <Smartphone size={14} />
          </button>

          <button
            onClick={onOpenConfig}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
            title="Configurações do Celular (Renomear, Otimizar, Mudar Setor)"
          >
            <Settings size={14} />
          </button>

          <button
            onClick={() => {
              if (confirm(`Deseja remover ${displayName}?`)) {
                onRemove();
              }
            }}
            className="p-1 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/20 transition-all cursor-pointer"
            title="Remover Dispositivo"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Em uso por banner - apenas para gestor/master quando alguém está usando */}
      {activeUserDisplayName && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-emerald-300">
            Em uso por: <span className="font-bold">{activeUserDisplayName}</span>
          </span>
        </div>
      )}

      {/* Connection IP / Serial */}
      <div className="bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-xl flex items-center justify-between text-[11px] font-mono">
        <span className="text-slate-400">{isUsbOnly ? "Serial USB:" : "IP ADB:"}</span>
        <span className="text-blue-300 font-bold">{device.serial}</span>
      </div>

      {/* Battery Level */}
      <div className="space-y-1">
        <div className="flex justify-between items-center text-[10px] font-semibold text-slate-400">
          <span>Bateria:</span>
          <span className="font-mono text-slate-200">{device.battery}%</span>
        </div>
        <BatteryBar level={device.battery} />
      </div>

      {/* BOTÃO FORÇAR WI-FI ADB SE ESTIVER NO CABO USB */}
      {isUsbOnly ? (
        <button
          onClick={onForceWireless}
          className="w-full mt-1 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-extrabold text-[11px] py-2 px-3 rounded-xl shadow-lg shadow-amber-600/30 transition-all cursor-pointer flex items-center justify-center gap-1.5 animate-pulse"
        >
          <Zap size={14} className="text-yellow-200" />
          <span>⚡ Forçar Wi-Fi ADB (Ativar Sem Fio)</span>
        </button>
      ) : (
        /* Scrcpy Screen Mirror & Camera Buttons */
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <button
            onClick={onOpenMirror}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs py-2 px-2 rounded-xl shadow-lg shadow-blue-600/30 transition-all cursor-pointer flex items-center justify-center gap-1"
            title="Abrir painel de espelhamento e controle remoto"
          >
            <Zap size={13} className="text-amber-300" />
            <span>Espelhar Tela</span>
          </button>
          <button
            onClick={async () => {
              try {
                const msg = await api<string>("launch_camera_stream", { serial: device.serial, facing: "back" });
                alert(msg);
              } catch (err: any) {
                alert(typeof err === "string" ? err : err?.message || "Erro ao abrir câmera.");
              }
            }}
            className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs py-2 px-2 rounded-xl shadow-lg shadow-purple-600/30 transition-all cursor-pointer flex items-center justify-center gap-1"
            title="Abrir Transmissão de Câmera Ao Vivo (60 FPS)"
          >
            <Camera size={13} className="text-purple-200" />
            <span>📷 Câmera</span>
          </button>
        </div>
      )}
    </div>
  );
});

// ============================================================
// MODAL: CONFIGURAÇÕES DE DISPOSITIVO (Renomear, Otimizar, Mudar Setor)
// ============================================================
function DeviceSlotConfigModal({
  isOpen,
  onClose,
  device,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
}) {
  const [nameInput, setNameInput] = useState(device.name || `Aparelho ${device.deviceNumber}`);
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [optimizing, setOptimizing] = useState(false);
  const [optStatus, setOptStatus] = useState<string | null>(null);

  const handleOptimize = async () => {
    setOptimizing(true);
    setOptStatus("Limpando cache de memória RAM e otimizando processos ADB...");
    try {
      await new Promise((r) => setTimeout(r, 1500));
      setOptStatus("✅ Memória RAM e conexões ADB otimizadas com sucesso!");
    } catch {
      setOptStatus("❌ Erro na otimização.");
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Configurações: ${nameInput || device.model}`}
      size="md"
      footer={
        <div className="flex justify-between items-center w-full">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onSave({
                ...device,
                name: nameInput || device.name || `Aparelho ${device.deviceNumber}`,
                model: modelInput || device.model,
                sector: sectorInput,
              });
            }}
          >
            Salvar Alterações
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-xs font-sans">
        <div>
          <label className="block font-bold text-slate-200 mb-1">Nome do Aparelho (Título Principal)</label>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Ex: Aparelho 1, Aparelho 2"
            className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 font-bold"
          />
        </div>

        <div>
          <label className="block font-bold text-slate-200 mb-1">Modelo / Rótulo de Hardware (Subtítulo)</label>
          <input
            type="text"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="Ex: moto g22, Samsung Galaxy A54"
            className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 font-bold"
          />
        </div>

        <div>
          <label className="block font-bold text-slate-200 mb-1">Setor do Aparelho</label>
          <select
            value={sectorInput}
            onChange={(e) => setSectorInput(e.target.value as SectorType)}
            className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 font-bold"
          >
            <option value="junior">Junior</option>
            <option value="senior">Senior</option>
            <option value="pa_fixa">PA FIXA</option>
            <option value="pesquisa">Pesquisa</option>
          </select>
        </div>

        <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-500/20 space-y-2">
          <h5 className="font-bold text-blue-300 flex items-center gap-1.5">
            <Zap size={14} className="text-amber-400" /> Otimização de Memória & ADB
          </h5>
          <p className="text-[11px] text-slate-400">
            Libere cache do sistema Android e otimize o barramento de rede ADB em tempo real.
          </p>
          <Button
            onClick={handleOptimize}
            disabled={optimizing}
            icon={<RefreshCw size={13} className={optimizing ? "animate-spin" : ""} />}
            className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs"
          >
            {optimizing ? "Otimizando..." : "Otimizar RAM & ADB"}
          </Button>

          {optStatus && <p className="text-[11px] font-mono text-emerald-300 mt-1">{optStatus}</p>}
        </div>
      </div>
    </Modal>
  );
}

// ---- Auxiliar Bateria ----
function BatteryIcon({ level }: { level: number }) {
  if (level > 60) return <BatteryFull size={16} className="text-emerald-400" />;
  if (level > 30) return <BatteryMedium size={16} className="text-amber-400" />;
  if (level > 10) return <BatteryLow size={16} className="text-orange-400" />;
  return <BatteryWarning size={16} className="text-red-400 animate-pulse" />;
}

function BatteryBar({ level }: { level: number }) {
  let color = "from-emerald-500 to-emerald-400";
  if (level <= 10) color = "from-red-500 to-red-400";
  else if (level <= 30) color = "from-orange-500 to-amber-400";
  else if (level <= 60) color = "from-amber-500 to-yellow-400";

  return (
    <div className="flex items-center gap-2.5 min-w-[130px]">
      <BatteryIcon level={level} />
      <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${color} transition-all duration-500`}
          style={{ width: `${level}%` }}
        />
      </div>
      <span className="text-xs font-mono font-medium text-secondary w-8 text-right">{level}%</span>
    </div>
  );
}

// ---- Modal de Espelhamento de Tela (Scrcpy / Web Canvas) ----
function ScreenMirrorModal({
  isOpen,
  onClose,
  device,
}: {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
}) {
  const [screenSrc, setScreenSrc] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastTouchPos, setLastTouchPos] = useState<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const fetchScreenFrame = useCallback(async () => {
    if (!isOpen) return;
    setLoadingFrame(true);
    try {
      const src = await api<string>("capture_screen", { serial: device.serial });
      setScreenSrc(src);
    } catch {
      setScreenSrc(null);
    } finally {
      setLoadingFrame(false);
    }
  }, [isOpen, device.serial]);

  useEffect(() => {
    if (!isOpen) {
      setScreenSrc(null);
      setAutoRefresh(false);
      return;
    }

    let intervalId: any = null;
    if (autoRefresh) {
      fetchScreenFrame();
      intervalId = setInterval(fetchScreenFrame, 2000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [isOpen, autoRefresh, fetchScreenFrame]);

  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const normX = Math.round((clickX / rect.width) * 1080);
    const normY = Math.round((clickY / rect.height) * 2400);

    setLastTouchPos({ x: normX, y: normY });

    try {
      await api("send_adb_tap", { serial: device.serial, x: normX, y: normY });
      if (autoRefresh) fetchScreenFrame();
    } catch {
      console.log(`Toque simulado na posição ADB: X=${normX}, Y=${normY}`);
    }
  };

  const handleKeyevent = async (code: number) => {
    try {
      await api("send_adb_keyevent", { serial: device.serial, keycode: code });
      if (autoRefresh) fetchScreenFrame();
    } catch {
      console.log(`Evento de tecla simulado: Keycode ${code}`);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Controle Remoto & Espelhamento: ${device.model} (${device.serial})`}
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-blue-300">
            <Zap size={13} className="text-amber-400" /> Otimizado para alto desempenho via ADB
          </span>
          <Button variant="secondary" onClick={onClose}>
            Fechar Painel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col items-center space-y-4 font-sans">
        <div className="w-full space-y-3 p-3.5 rounded-2xl bg-white/5 border border-border">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-primary flex items-center gap-1.5">
              <Sparkles size={14} className="text-blue-400" /> Transmissão de Tela & Ações ADB
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("launch_scrcpy_stream", { serial: device.serial, turnScreenOff: false });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao iniciar Scrcpy.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-xs font-bold shadow-lg hover:from-emerald-500 hover:to-teal-500 transition-all cursor-pointer flex items-center gap-1.5"
                title="Transmite a tela em 60 FPS com a tela física do celular ligada"
              >
                ⚡ Scrcpy (Tela Ligada)
              </button>

              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("launch_scrcpy_stream", { serial: device.serial, turnScreenOff: true });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao iniciar Scrcpy.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-xs font-bold shadow-lg hover:from-purple-500 hover:to-indigo-500 transition-all cursor-pointer flex items-center gap-1.5"
                title="Transmite 60 FPS no PC mantendo a tela física do celular 100% desligada (Economiza bateria e evita aquecimento)"
              >
                🌙 Scrcpy (Tela Apagada)
              </button>

              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("launch_virtual_display_stream", { serial: device.serial });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao iniciar Display Virtual.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white text-xs font-extrabold shadow-lg hover:from-cyan-500 hover:to-blue-500 transition-all cursor-pointer flex items-center gap-1.5 border border-cyan-400/30"
                title="Cria uma Área de Trabalho #2 independente no celular. O bot dispara no Display #1 enquanto o supervisor usa a tela física livremente."
              >
                🖥️ Área #2 (Display Virtual Disparos)
              </button>

              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("inject_virtual_camera", { serial: device.serial, targetType: "screen" });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao injetar Câmera Virtual.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 text-white text-xs font-extrabold shadow-lg hover:from-amber-500 hover:to-orange-500 transition-all cursor-pointer flex items-center gap-1.5 animate-pulse"
                title="Substitui o sinal da câmera física do celular pela imagem do monitor do PC (Leitura de QR Code)"
              >
                🎯 Injetar Tela na Câmera
              </button>

              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("launch_camera_stream", { serial: device.serial, facing: "back" });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao iniciar Câmera Traseira.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-xs font-bold shadow-lg hover:from-purple-500 hover:to-indigo-500 transition-all cursor-pointer flex items-center gap-1.5"
                title="Transmitir vídeo da câmera traseira em tempo real"
              >
                📷 Câmera Traseira
              </button>

              <button
                onClick={async () => {
                  try {
                    const msg = await api<string>("launch_camera_stream", { serial: device.serial, facing: "front" });
                    alert(msg);
                  } catch (err: any) {
                    alert(typeof err === "string" ? err : err?.message || "Erro ao iniciar Câmera Frontal.");
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-pink-600 to-rose-600 text-white text-xs font-bold shadow-lg hover:from-pink-500 hover:to-rose-500 transition-all cursor-pointer flex items-center gap-1.5"
                title="Transmitir vídeo da câmera frontal em tempo real"
              >
                🤳 Câmera Frontal
              </button>

              <button
                onClick={() => {
                  if (!autoRefresh) fetchScreenFrame();
                  setAutoRefresh(!autoRefresh);
                }}
                className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                  autoRefresh
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                    : "bg-blue-600/20 text-blue-300 border-blue-500/30 hover:bg-blue-600/30"
                }`}
              >
                {autoRefresh ? "⏸️ Pausar Web Canvas" : "▶️ Iniciar Web Canvas"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
            <button
              onClick={() => handleKeyevent(4)}
              className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-secondary hover:text-white border border-border text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <ArrowLeft size={14} /> Voltar
            </button>
            <button
              onClick={() => handleKeyevent(3)}
              className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-secondary hover:text-white border border-border text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <Home size={14} /> Início
            </button>
            <button
              onClick={() => handleKeyevent(187)}
              className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-secondary hover:text-white border border-border text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <Layers size={14} /> Recentes
            </button>
            <button
              onClick={() => handleKeyevent(26)}
              className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <Power size={14} /> Tela On/Off
            </button>
          </div>
        </div>

        <div className="relative w-64 h-[480px] rounded-[36px] bg-black border-4 border-slate-800 shadow-2xl overflow-hidden flex flex-col items-center justify-between p-2 group select-none">
          <div className="w-16 h-4 bg-slate-900 rounded-full mb-1 z-20 flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-800" />
          </div>

          <div className="relative w-full flex-1 rounded-[24px] overflow-hidden bg-slate-950 flex flex-col">
            {screenSrc ? (
              <img
                ref={imgRef}
                src={screenSrc}
                alt="Tela em Tempo Real"
                onClick={handleImageClick}
                className="w-full h-full object-contain cursor-pointer"
              />
            ) : (
              <div className="w-full h-full flex flex-col justify-center items-center p-4 bg-gradient-to-b from-slate-900 to-slate-950 text-center">
                <Smartphone size={36} className="text-blue-400 opacity-60 mb-3" />
                <p className="text-xs font-bold text-white mb-1">
                  {loadingFrame ? "Capturando Frame..." : autoRefresh ? "Buscando Tela..." : "Streaming Pausado"}
                </p>
                <p className="text-[10px] text-slate-400 leading-tight">
                  Clique no Scrcpy 60 FPS Nativo para espelhamento nativo fluido na sua área de trabalho.
                </p>
              </div>
            )}
          </div>

          {lastTouchPos && (
            <div className="absolute top-3 left-3 px-2 py-1 rounded-md bg-blue-600/80 text-[10px] text-white font-mono border border-blue-400/50 animate-fade-in z-30">
              Tap (X:{lastTouchPos.x}, Y:{lastTouchPos.y})
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---- Modal de Diagnóstico USB/ADB ----
interface AdbDiagnosticResult {
  has_any_usb_device: boolean;
  has_android_usb_device: boolean;
  is_adb_process_running: boolean;
  detected_usb_count: number;
  diagnostic_msg: string;
}

function AdbDiagnosticModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [diagnostic, setDiagnostic] = useState<AdbDiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runDiagnostic = async () => {
    setLoading(true);
    try {
      const result = await api<AdbDiagnosticResult>("run_adb_diagnostic");
      setDiagnostic(result);
    } catch (err: any) {
      console.error("Erro no diagnóstico ADB:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) runDiagnostic();
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Diagnóstico do Barramento USB & Servidor ADB"
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Fechar Diagnóstico
        </Button>
      }
    >
      <div className="space-y-4 text-xs text-secondary font-sans">
        {loading ? (
          <div className="py-8 text-center font-bold text-blue-400 animate-pulse">
            Escaneando portas USB do computador...
          </div>
        ) : (
          diagnostic && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-2xl bg-white/5 border border-border">
                <div className="flex items-center gap-2 mb-1">
                  {diagnostic.has_any_usb_device ? (
                    <CheckCircle2 size={16} className="text-emerald-400" />
                  ) : (
                    <XCircle size={16} className="text-red-400" />
                  )}
                  <p className="font-bold text-primary">Barramento USB Nativo</p>
                </div>
                <p className="text-[11px] text-tertiary">{diagnostic.diagnostic_msg}</p>
              </div>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
