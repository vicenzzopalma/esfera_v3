// ============================================================
// Esfera v3 — Painel de Monitoramento do Supervisor (SupervisorView.tsx)
// Permite ao Supervisor visualizar TODOS os celulares em tempo real,
// interagir via controle ADB e identificar quem é o colaborador que
// está no momento utilizando cada celular.
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { DeviceWithActiveUser, DevicePermissionRequest } from "../types";
import {
  Eye,
  Smartphone,
  UserCheck,
  RefreshCw,
  ArrowLeft,
  Home,
  Activity,
  Layers,
  Monitor,
  Camera,
  Search,
  Bell,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

export default function SupervisorView() {
  const { user, selectedCompanyId } = useAuth();
  const [devicesWithUsers, setDevicesWithUsers] = useState<DeviceWithActiveUser[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [sectorTab, setSectorTab] = useState<string>("junior");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [screenImages, setScreenImages] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<Record<string, boolean>>({});
  const [launchingScrcpy, setLaunchingScrcpy] = useState<Record<string, boolean>>({});
  const autoRefreshRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const companyId = selectedCompanyId || user?.companyId || 1;

  const loadData = useCallback(async () => {
    try {
      const [devsData, reqsData] = await Promise.all([
        api<DeviceWithActiveUser[]>("get_devices_with_active_user_map", { companyId }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId }),
      ]);
      setDevicesWithUsers(devsData || []);
      setPermissionRequests(reqsData || []);
    } catch (err) {
      console.error("Erro ao carregar aparelhos do supervisor:", err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const handleApproveRequest = async (requestId: number) => {
    try {
      await api("approve_device_access", { requestId });
      loadData();
    } catch (err: any) {
      alert(typeof err === "string" ? err : err?.message || "Erro ao aprovar solicitação.");
    }
  };

  const handleRejectRequest = async (requestId: number) => {
    try {
      await api("reject_device_access", { requestId });
      loadData();
    } catch (err: any) {
      alert(typeof err === "string" ? err : err?.message || "Erro ao rejeitar solicitação.");
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, [loadData]);

  // ---- Auto-captura da tela a cada 3s por aparelho online ----
  const captureScreen = useCallback(async (targetSerial: string, devKey: string) => {
    setCapturing((prev) => ({ ...prev, [devKey]: true }));
    try {
      const base64 = await api<string>("capture_device_screen", { serial: targetSerial });
      if (base64 && base64.length > 50) {
        const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
        setScreenImages((prev) => ({
          ...prev,
          [devKey]: src,
          [targetSerial]: src,
        }));
      }
    } catch {
      // silencioso: dispositivo pode estar ocupado
    } finally {
      setCapturing((prev) => ({ ...prev, [devKey]: false }));
    }
  }, []);

  // Inicia auto-refresh de tela para cada aparelho online
  useEffect(() => {
    const onlineDevs = devicesWithUsers.filter((d) => d.status === "online");
    const activeKeys = onlineDevs.map((d) => d.serial);

    // Para aparelhos que ficaram offline
    Object.keys(autoRefreshRef.current).forEach((k) => {
      if (!activeKeys.includes(k)) {
        clearInterval(autoRefreshRef.current[k]);
        delete autoRefreshRef.current[k];
      }
    });

    // Inicia para os novos aparelhos online
    onlineDevs.forEach((dev) => {
      const targetSerial = dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
      const devKey = dev.serial;
      if (!autoRefreshRef.current[devKey]) {
        captureScreen(targetSerial, devKey);
        autoRefreshRef.current[devKey] = setInterval(() => captureScreen(targetSerial, devKey), 3000);
      }
    });

    return () => {
      Object.values(autoRefreshRef.current).forEach(clearInterval);
    };
  }, [devicesWithUsers, captureScreen]);

  const handleAdbTap = async (serial: string, x: number, y: number) => {
    try {
      await api("send_adb_tap", { serial, x, y });
    } catch (err) {
      console.error("Erro ao enviar toque ADB:", err);
    }
  };

  const handleAdbKey = async (serial: string, keycode: number) => {
    try {
      await api("send_adb_keyevent", { serial, keycode });
    } catch (err) {
      console.error("Erro ao enviar keyevent:", err);
    }
  };

  const handleLaunchScrcpy = async (dev: DeviceWithActiveUser) => {
    const serial = dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
    setLaunchingScrcpy((prev) => ({ ...prev, [dev.serial]: true }));
    try {
      const res = await api<string>("launch_scrcpy_stream", { serial, turnScreenOff: false });
      console.log("Scrcpy iniciado:", res);
    } catch (e: any) {
      console.error("Erro ao iniciar Scrcpy:", e);
      const errMsg = typeof e === "string" ? e : e?.message || "Falha ao iniciar espelhamento Scrcpy.";
      alert(`Erro Scrcpy: ${errMsg}`);
    } finally {
      setTimeout(() => setLaunchingScrcpy((prev) => ({ ...prev, [dev.serial]: false })), 1500);
    }
  };

  // Filtragem de dispositivos por setor e texto (nome, serial, final do número, etc.)
  const filteredDevices = useMemo(() => {
    return (devicesWithUsers || [])
      .filter((dev) => {
        if (!dev) return false;
        const serial = String(dev.serial || "");
        const model = String(dev.model || "");
        const brand = String(dev.brand || "");
        const name = String(dev.name || "");
        const esfId = String(dev.esferaDeviceId || "");
        const curAdb = String(dev.currentAdbAddress || "");
        const activeUser = String(dev.activeUserDisplayName || dev.activeUserName || "");
        const assignedUser = String(dev.assignedUserName || "");
        const devNum = String(dev.deviceNumber ?? "");
        const devNumPad = devNum.padStart(2, "0");
        const sector = String(dev.sector || "junior").toLowerCase().replace(/[- _.]/g, "");

        if (sectorTab !== "all") {
          const targetSector = sectorTab.toLowerCase().replace(/[- _.]/g, "");
          if (sector !== targetSector) return false;
        }

        if (searchQuery) {
          const q = searchQuery.toLowerCase().trim();
          return (
            name.toLowerCase().includes(q) ||
            esfId.toLowerCase().includes(q) ||
            model.toLowerCase().includes(q) ||
            brand.toLowerCase().includes(q) ||
            serial.toLowerCase().includes(q) ||
            curAdb.toLowerCase().includes(q) ||
            activeUser.toLowerCase().includes(q) ||
            assignedUser.toLowerCase().includes(q) ||
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
  }, [devicesWithUsers, sectorTab, searchQuery]);

  const pendingRequests = useMemo(() => {
    return (permissionRequests || []).filter((r) => r.status === "pending");
  }, [permissionRequests]);

  return (
    <div className="space-y-4 font-sans text-zinc-100">
      {/* Cabeçalho do Supervisor */}
      <div className="bg-gradient-to-r from-purple-900/40 via-indigo-900/30 to-slate-900 border border-purple-500/30 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 bg-purple-500/20 border border-purple-500/40 rounded-xl text-purple-400">
              <Eye size={28} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Painel de Supervisão e Controle
                </span>
                <span className="text-xs text-slate-400">| Supervisor: {user?.displayName}</span>
              </div>
              <h1 className="text-xl font-bold text-white mt-1">Visão Geral dos Celulares Conectados</h1>
              <p className="text-slate-300 text-xs">
                Preview em tempo real • Clique na tela para enviar toque ADB • Abra o Scrcpy para controle completo.
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 text-slate-300 hover:text-white border border-slate-700 text-xs py-1.5"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Atualizar
          </Button>
        </div>
      </div>

      {/* Banner de Solicitações Pendentes para o Supervisor */}
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

      {/* Barra Filtradora de Setores (Pills) e Campo de Busca */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#141418] border border-white/[0.07] p-3 rounded-xl">
        {/* Left: Sector Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar py-0.5">
          {[
            { id: "junior", label: "Junior" },
            { id: "senior", label: "Senior" },
            { id: "pa_fixa", label: "PA FIXA" },
            { id: "pesquisa", label: "Pesquisa" },
            { id: "juridico", label: "Juridico" },
            { id: "comercial", label: "Comercial" },
            { id: "all", label: "Todos" },
          ].map((tab) => {
            const count =
              tab.id === "all"
                ? devicesWithUsers.length
                : devicesWithUsers.filter(
                    (d) =>
                      String(d.sector || "junior")
                        .toLowerCase()
                        .replace(/[- _.]/g, "") === tab.id.replace(/[- _.]/g, "")
                  ).length;

            const isActive = sectorTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => setSectorTab(tab.id)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-1.5 shrink-0 ${
                  isActive
                    ? "bg-[#5057D9] text-white shadow-md shadow-[#5057D9]/30 border border-[#636bf6]"
                    : "bg-white/[0.04] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.08] border border-white/[0.06]"
                }`}
              >
                <span>{tab.label}</span>
                {tab.id === "all" && (
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${isActive ? "bg-white/20 text-white" : "bg-white/[0.08] text-zinc-400"}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right: Search */}
        <div className="relative min-w-[220px] sm:min-w-[280px] flex items-center">
          <Search size={14} className="input-icon-left text-cyan-400/80" />
          <input
            type="text"
            placeholder="Pesquisar por nome ou final do número..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 bg-[#09090b] border border-white/[0.1] text-zinc-100 rounded-full input-with-icon-left pr-3 text-xs placeholder:text-zinc-500 focus:outline-none focus:border-[#5057D9] focus:ring-1 focus:ring-[#5057D9]/40 transition-all"
          />
        </div>
      </div>

      {/* Grid de Celulares para o Supervisor */}
      {loading && devicesWithUsers.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-slate-400">
          <RefreshCw size={32} className="animate-spin text-purple-400 mb-3" />
          <p>Mapeando celulares e colaboradores ativos...</p>
        </div>
      ) : filteredDevices.length === 0 ? (
        <Card className="p-8 text-center border border-slate-800 bg-slate-900/60">
          <Smartphone size={48} className="mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-semibold text-white">Nenhum dispositivo encontrado neste setor</h3>
          <p className="text-slate-400 text-sm mt-1">Conecte celulares via ADB USB ou Wi-Fi ou selecione outro setor no filtro.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredDevices.map((dev) => {
            const hasActiveUser = !!dev.activeUserDisplayName;
            const targetSerial = dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
            const screenImg = screenImages[dev.serial] || screenImages[targetSerial] || screenImages[dev.esferaDeviceId || ""];
            const isCapturing = !!(capturing[dev.serial] || capturing[targetSerial]);
            const isOnline = dev.status === "online";
            const devPendingReq = pendingRequests.find(
              (r) =>
                r.status === "pending" &&
                (r.adbDeviceId === dev.serial ||
                  r.adbDeviceId === dev.currentAdbAddress ||
                  r.adbDeviceId === dev.esferaDeviceId ||
                  (dev.currentAdbAddress && r.adbDeviceId.includes(dev.currentAdbAddress.split(":")[0])))
            );

            return (
              <Card
                key={dev.serial}
                className={`relative overflow-hidden transition-all duration-300 border ${
                  hasActiveUser
                    ? "border-purple-500/50 bg-purple-950/20 shadow-lg shadow-purple-950/40"
                    : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                }`}
              >
                {/* Banner Destacado do Colaborador Ativo */}
                <div
                  className={`px-4 py-2.5 flex items-center justify-between text-xs font-bold ${
                    hasActiveUser
                      ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white"
                      : "bg-slate-800/80 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <UserCheck size={16} />
                    <span>
                      {hasActiveUser
                        ? `Em uso por: ${dev.activeUserDisplayName}`
                        : "Disponível (Sem Colaborador Ativo)"}
                    </span>
                  </div>
                  {hasActiveUser && (
                    <span className="bg-emerald-500 text-slate-950 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full animate-pulse">
                      Ao Vivo
                    </span>
                  )}
                </div>

                <div className="p-5 space-y-4">
                  {/* Informações do Aparelho */}
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                        Aparelho #{dev.deviceNumber || 1} • Setor: {dev.sector}
                      </span>
                      <h3 className="text-lg font-bold text-white mt-0.5">{dev.name || dev.model}</h3>
                      <p className="text-xs text-slate-400">{dev.brand} {dev.model} • {dev.serial}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={isOnline ? "success" : "neutral"}
                        className="capitalize"
                      >
                        {dev.status}
                      </Badge>
                      <span className="text-xs text-slate-400 flex items-center gap-1">
                        <Activity size={12} /> {dev.battery}%
                      </span>
                    </div>
                  </div>

                  {/* Responsável Vinculado */}
                  {dev.assignedUserName && (
                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800 text-xs flex items-center justify-between">
                      <span className="text-slate-400">Responsável Vinculado:</span>
                      <span className="font-semibold text-indigo-300">{dev.assignedUserName}</span>
                    </div>
                  )}

                  {/* Alerta de Solicitação Pendente deste Aparelho */}
                  {devPendingReq && (
                    <div className="p-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-xs flex flex-col gap-1.5 animate-pulse">
                      <div className="flex items-center justify-between text-amber-300 font-bold text-[10px]">
                        <span className="flex items-center gap-1 truncate">
                          <Bell size={12} className="shrink-0 text-amber-400" />
                          <span className="truncate">{devPendingReq.userDisplayName || devPendingReq.userName} solicitou acesso</span>
                        </span>
                        <span className="text-[8px] bg-amber-500/20 px-1.5 py-0.5 rounded text-amber-200 uppercase font-semibold shrink-0">
                          Pendente
                        </span>
                      </div>
                      {devPendingReq.requestedReason && (
                        <p className="text-[10px] text-zinc-400 italic truncate">
                          "{devPendingReq.requestedReason}"
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => handleApproveRequest(devPendingReq.requestId)}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] py-1 font-bold"
                        >
                          Aprovar
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleRejectRequest(devPendingReq.requestId)}
                          className="text-[10px] py-1 font-bold"
                        >
                          Recusar
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Preview da Tela do Celular */}
                  <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-800 aspect-[9/16] max-h-72 flex flex-col items-center justify-center">
                    {screenImg ? (
                      <img
                        src={screenImg}
                        alt={`Tela ${dev.serial}`}
                        className="w-full h-full object-contain cursor-crosshair"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = Math.round(((e.clientX - rect.left) / rect.width) * 1080);
                          const y = Math.round(((e.clientY - rect.top) / rect.height) * 2340);
                          handleAdbTap(targetSerial, x, y);
                        }}
                      />
                    ) : (
                      <div className="text-center p-4 space-y-3">
                        <Smartphone size={36} className="mx-auto text-slate-700" />
                        <p className="text-xs text-slate-500">
                          {isOnline ? "Carregando preview..." : "Aparelho offline"}
                        </p>
                        {isOnline && (
                          <div className="flex justify-center">
                            <RefreshCw size={14} className="animate-spin text-purple-400" />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Badge de status da captura */}
                    {screenImg && isCapturing && (
                      <div className="absolute top-2 left-2 bg-slate-900/80 rounded-full px-2 py-0.5 flex items-center gap-1 text-[10px] text-purple-300">
                        <RefreshCw size={10} className="animate-spin" />
                        Atualizando
                      </div>
                    )}

                    {/* Botão de captura manual */}
                    <Button
                      variant="ghost"
                      onClick={() => captureScreen(targetSerial, dev.serial)}
                      disabled={isCapturing || !isOnline}
                      className="absolute bottom-2 right-2 bg-slate-900/80 hover:bg-slate-800 text-xs px-2.5 py-1 text-slate-200 border border-slate-700 backdrop-blur-sm"
                    >
                      <Camera size={11} />
                    </Button>
                  </div>

                  {/* Controles Rápidos */}
                  <div className="space-y-2 pt-1">
                    <span className="text-xs font-semibold text-slate-400 block uppercase">
                      Ações do Supervisor:
                    </span>

                    {/* Botão Scrcpy — Controle Completo */}
                    <Button
                      variant="primary"
                      onClick={() => handleLaunchScrcpy(dev)}
                      disabled={launchingScrcpy[dev.serial] || !isOnline}
                      className="w-full flex items-center justify-center gap-2 py-2 text-xs font-bold bg-gradient-to-r from-[#5E6AD2] to-[#6C77D8] hover:from-[#6B77E0] hover:to-[#7882E4] border-0"
                    >
                      {launchingScrcpy[dev.serial] ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Monitor size={14} />
                      )}
                      {launchingScrcpy[dev.serial] ? "Abrindo Scrcpy..." : "Espelhamento Scrcpy — Controle Total"}
                    </Button>

                    {/* Botões ADB Rápidos */}
                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(targetSerial, 4)} // BACK
                        disabled={!isOnline}
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <ArrowLeft size={12} /> Voltar
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(targetSerial, 3)} // HOME
                        disabled={!isOnline}
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <Home size={12} /> Home
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(targetSerial, 187)} // APP_SWITCH
                        disabled={!isOnline}
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <Layers size={12} /> Apps
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
