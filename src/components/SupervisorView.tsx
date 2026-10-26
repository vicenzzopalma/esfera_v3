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
import PageHeader from "./ui/PageHeader";
import StatCard from "./ui/StatCard";
import EmptyState from "./ui/EmptyState";
import { SegmentedControl } from "./ui/Tabs";
import { SECTOR_OPTIONS, normSector, sectorLabel, StatusDot, BatteryMeter } from "./devices/deviceUi";

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

  const sectorItems = [
    ...SECTOR_OPTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      count: devicesWithUsers.filter((d) => normSector(d.sector) === normSector(s.id)).length,
    })),
    { id: "all", label: "Todos", count: devicesWithUsers.length },
  ];
  const inUseCount = devicesWithUsers.filter((d) => !!d.activeUserDisplayName).length;
  const onlineCount = devicesWithUsers.filter((d) => d.status === "online").length;

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Supervisão de celulares"
        description={`Preview em tempo real. Clique na tela para enviar um toque. Supervisor: ${user?.displayName || ""}`}
        icon={<Eye size={18} />}
        actions={
          <Button variant="secondary" onClick={loadData} loading={loading} icon={<RefreshCw size={14} />}>
            Atualizar
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Total" value={devicesWithUsers.length} icon={<Smartphone size={14} />} />
        <StatCard label="Online" value={onlineCount} icon={<Activity size={14} />} tone="success" />
        <StatCard label="Em uso" value={inUseCount} icon={<UserCheck size={14} />} tone="accent" />
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

      <div className="space-y-3">
        <div className="relative max-w-sm">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            type="text"
            aria-label="Buscar aparelhos"
            placeholder="Buscar por nome, número ou colaborador"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ paddingLeft: "2.25rem" }}
            className="h-9 w-full rounded-lg border border-border bg-primary pr-3 text-[0.8125rem] text-primary placeholder:text-tertiary focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-glow)]"
          />
        </div>
        <div className="overflow-x-auto pb-1 custom-scrollbar">
          <SegmentedControl items={sectorItems} value={sectorTab} onChange={setSectorTab} />
        </div>
      </div>

      {loading && devicesWithUsers.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-96 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : filteredDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum celular encontrado"
          description="Conecte celulares por USB ou Wi-Fi, ou escolha outro setor ou busca."
          action={
            <Button variant="secondary" size="sm" onClick={() => { setSearchQuery(""); setSectorTab("all"); }}>
              Ver todos os setores
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
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
              <Card key={dev.serial} padding="none" className={hasActiveUser ? "!border-[var(--color-accent)]" : ""}>
                <div className={`flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-[0.75rem] ${hasActiveUser ? "bg-[var(--color-accent-glow)] text-primary" : "bg-secondary/50 text-secondary"}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <UserCheck size={14} className="shrink-0" />
                    <span className="truncate">{hasActiveUser ? `Em uso por ${dev.activeUserDisplayName}` : "Disponível"}</span>
                  </span>
                  {hasActiveUser && <Badge variant="success" dot pulse>Ao vivo</Badge>}
                </div>

                <div className="space-y-4 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-primary">{dev.name || dev.model}</h3>
                      <p className="truncate text-[0.75rem] text-secondary">
                        #{dev.deviceNumber || 1} · {sectorLabel(dev.sector)} · {dev.brand} {dev.model}
                      </p>
                      <p className="truncate font-mono text-[0.6875rem] text-tertiary">{dev.serial}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusDot status={dev.status} />
                      <BatteryMeter level={dev.battery} />
                    </div>
                  </div>

                  {dev.assignedUserName && (
                    <div className="flex items-center justify-between rounded-lg bg-secondary/60 px-3 py-2 text-[0.75rem]">
                      <span className="text-secondary">Responsável</span>
                      <span className="font-medium text-primary">{dev.assignedUserName}</span>
                    </div>
                  )}

                  {devPendingReq && (
                    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                      <p className="flex items-center gap-1.5 truncate text-[0.75rem] font-medium text-amber-600 dark:text-amber-400">
                        <Bell size={12} className="shrink-0" />
                        <span className="truncate">{devPendingReq.userDisplayName || devPendingReq.userName} pediu acesso</span>
                      </p>
                      {devPendingReq.requestedReason && <p className="truncate text-[0.75rem] text-secondary">"{devPendingReq.requestedReason}"</p>}
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="success" onClick={() => handleApproveRequest(devPendingReq.requestId)}>
                          Aprovar
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => handleRejectRequest(devPendingReq.requestId)}>
                          Recusar
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="relative flex aspect-[9/16] max-h-72 flex-col items-center justify-center overflow-hidden rounded-xl border border-border bg-black/90">
                    {screenImg ? (
                      <img
                        src={screenImg}
                        alt={`Tela de ${dev.name || dev.serial}`}
                        className="h-full w-full cursor-crosshair object-contain"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = Math.round(((e.clientX - rect.left) / rect.width) * 1080);
                          const y = Math.round(((e.clientY - rect.top) / rect.height) * 2340);
                          handleAdbTap(targetSerial, x, y);
                        }}
                      />
                    ) : (
                      <div className="space-y-2 p-4 text-center text-zinc-400">
                        <Smartphone size={28} className="mx-auto" />
                        <p className="text-[0.75rem]">{isOnline ? "Carregando preview..." : "Aparelho offline"}</p>
                        {isOnline && <RefreshCw size={14} className="mx-auto animate-spin" />}
                      </div>
                    )}

                    {screenImg && isCapturing && (
                      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[0.6875rem] text-zinc-200">
                        <RefreshCw size={10} className="animate-spin" />
                        Atualizando
                      </div>
                    )}

                    <button
                      type="button"
                      aria-label="Atualizar imagem"
                      title="Atualizar imagem"
                      onClick={() => captureScreen(targetSerial, dev.serial)}
                      disabled={isCapturing || !isOnline}
                      className="absolute bottom-2 right-2 rounded-lg bg-black/70 p-1.5 text-zinc-200 hover:bg-black/90 disabled:opacity-40 cursor-pointer"
                    >
                      <Camera size={13} />
                    </button>
                  </div>

                  <div className="space-y-2">
                    <Button
                      variant="primary"
                      size="md"
                      onClick={() => handleLaunchScrcpy(dev)}
                      disabled={!isOnline}
                      loading={!!launchingScrcpy[dev.serial]}
                      icon={<Monitor size={14} />}
                      className="w-full"
                    >
                      {launchingScrcpy[dev.serial] ? "Abrindo..." : "Controle total (Scrcpy)"}
                    </Button>
                    <div className="grid grid-cols-3 gap-2">
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(targetSerial, 4)} disabled={!isOnline} icon={<ArrowLeft size={12} />}>
                        Voltar
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(targetSerial, 3)} disabled={!isOnline} icon={<Home size={12} />}>
                        Início
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(targetSerial, 187)} disabled={!isOnline} icon={<Layers size={12} />}>
                        Apps
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
