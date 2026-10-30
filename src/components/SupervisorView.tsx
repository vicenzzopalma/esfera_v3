// ============================================================
// Esfera v3 — Painel de Monitoramento do Supervisor (SupervisorView.tsx)
// Permite ao Supervisor visualizar TODOS os celulares em tempo real,
// interagir via controle ADB e identificar quem é o colaborador que
// está no momento utilizando cada celular.
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import { apiErrorText } from "../hooks/useQueries";
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
  AlertCircle,
  X,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import Badge from "./ui/Badge";
import Modal from "./ui/Modal";
import Toggle from "./ui/Toggle";
import PageHeader from "./ui/PageHeader";
import StatCard from "./ui/StatCard";
import EmptyState from "./ui/EmptyState";
import { SegmentedControl } from "./ui/Tabs";
import { SECTOR_OPTIONS, normSector, sectorLabel, StatusDot, BatteryMeter } from "./devices/deviceUi";

/** Intervalo entre uma captura e a próxima. As telas são capturadas UMA de cada vez, em rodízio. */
const PREVIEW_GAP_MS = 1500;
const DATA_REFRESH_MS = 8000;

const isOnline = (status: string) => status === "online" || status === "online_agent";

function targetOf(dev: DeviceWithActiveUser) {
  return dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
}

/** Pedido pertence a este aparelho? Compara serial, id Esfera, endereço ou o mesmo IP (sem casar prefixo). */
function requestMatchesDevice(req: DevicePermissionRequest, dev: DeviceWithActiveUser) {
  if (req.adbDeviceId === dev.serial || req.adbDeviceId === dev.currentAdbAddress || req.adbDeviceId === dev.esferaDeviceId) return true;
  if (!dev.currentAdbAddress) return false;
  return req.adbDeviceId.split(":")[0] === dev.currentAdbAddress.split(":")[0];
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function SupervisorView() {
  const { user, selectedCompanyId } = useAuth();
  const [devicesWithUsers, setDevicesWithUsers] = useState<DeviceWithActiveUser[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sectorTab, setSectorTab] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [shots, setShots] = useState<Record<string, { src: string; at: number }>>({});
  const [shotErrors, setShotErrors] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<Record<string, boolean>>({});
  const [launchingScrcpy, setLaunchingScrcpy] = useState<Record<string, boolean>>({});
  const [livePreview, setLivePreview] = useState(true);
  const [busyRequest, setBusyRequest] = useState<number | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DevicePermissionRequest | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const inFlightRef = useRef(new Set<string>());
  const seqRef = useRef(0);
  const now = useNow(5000);

  const companyId = selectedCompanyId ?? user?.companyId ?? null;

  const loadData = useCallback(async (showSpinner = false) => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    if (showSpinner) setLoading(true);
    try {
      const [devsData, reqsData] = await Promise.all([
        api<DeviceWithActiveUser[]>("get_devices_with_active_user_map", { companyId }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId }),
      ]);
      if (seq !== seqRef.current) return;
      setDevicesWithUsers(devsData || []);
      setPermissionRequests(reqsData || []);
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoadError(apiErrorText(err, "Não foi possível carregar os aparelhos."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadData(true);
    const interval = setInterval(() => {
      if (!document.hidden) loadData(false);
    }, DATA_REFRESH_MS);
    return () => {
      seqRef.current++;
      clearInterval(interval);
    };
  }, [loadData]);

  const runRequestAction = async (req: DevicePermissionRequest, approve: boolean) => {
    setBusyRequest(req.requestId);
    setMessage(null);
    try {
      await api(approve ? "approve_device_access" : "reject_device_access", { requestId: req.requestId });
      setMessage({ type: "success", text: approve ? "Uso do aparelho liberado." : "Pedido recusado." });
      await loadData(false);
    } catch (err) {
      setMessage({ type: "error", text: apiErrorText(err, approve ? "Não foi possível aprovar o pedido." : "Não foi possível recusar o pedido.") });
    } finally {
      setBusyRequest(null);
    }
  };

  // ---- Captura de tela: uma por vez, sem rajadas no ADB enquanto o disparo digita ----
  const captureScreen = useCallback(async (dev: DeviceWithActiveUser) => {
    const key = dev.serial;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    setCapturing((prev) => ({ ...prev, [key]: true }));
    try {
      const base64 = await api<string>("capture_device_screen", { serial: targetOf(dev) });
      if (base64 && base64.length > 50) {
        const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
        setShots((prev) => ({ ...prev, [key]: { src, at: Date.now() } }));
        setShotErrors((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    } catch (err) {
      setShotErrors((prev) => ({ ...prev, [key]: apiErrorText(err, "Não foi possível capturar a tela.") }));
    } finally {
      inFlightRef.current.delete(key);
      setCapturing((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const handleAdbTap = async (dev: DeviceWithActiveUser, x: number, y: number) => {
    try {
      await api("send_adb_tap", { serial: targetOf(dev), x, y });
      // Mostra o efeito do toque logo em seguida.
      setTimeout(() => captureScreen(dev), 700);
    } catch (err) {
      setMessage({ type: "error", text: apiErrorText(err, "Não foi possível enviar o toque ao aparelho.") });
    }
  };

  const handleAdbKey = async (dev: DeviceWithActiveUser, keycode: number) => {
    try {
      await api("send_adb_keyevent", { serial: targetOf(dev), keycode });
      setTimeout(() => captureScreen(dev), 700);
    } catch (err) {
      setMessage({ type: "error", text: apiErrorText(err, "Não foi possível enviar o comando ao aparelho.") });
    }
  };

  /** Converte o clique na imagem (object-contain) para a coordenada real da tela do aparelho. */
  const handlePreviewClick = (e: React.MouseEvent<HTMLImageElement>, dev: DeviceWithActiveUser) => {
    const img = e.currentTarget;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    if (!natW || !natH) return;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / natW, rect.height / natH);
    const drawnW = natW * scale;
    const drawnH = natH * scale;
    const px = e.clientX - rect.left - (rect.width - drawnW) / 2;
    const py = e.clientY - rect.top - (rect.height - drawnH) / 2;
    if (px < 0 || py < 0 || px > drawnW || py > drawnH) return; // clique na faixa preta
    handleAdbTap(dev, Math.round(px / scale), Math.round(py / scale));
  };

  const handleLaunchScrcpy = async (dev: DeviceWithActiveUser) => {
    setLaunchingScrcpy((prev) => ({ ...prev, [dev.serial]: true }));
    setMessage(null);
    try {
      await api<string>("launch_scrcpy_stream", { serial: targetOf(dev), turnScreenOff: false });
    } catch (err) {
      console.error("Erro ao abrir o controle total:", err);
      setMessage({
        type: "error",
        text: `Não foi possível abrir o controle de ${dev.name || dev.model || "aparelho"}. Confira se ele está desbloqueado e conectado. (${apiErrorText(err, "erro desconhecido")})`,
      });
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

        if (sectorTab !== "all" && normSector(dev.sector) !== normSector(sectorTab)) return false;

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

  // Rodízio de capturas só dos aparelhos visíveis e online; pausa com a janela minimizada.
  const previewQueueRef = useRef<DeviceWithActiveUser[]>([]);
  previewQueueRef.current = filteredDevices.filter((d) => isOnline(d.status));

  useEffect(() => {
    if (!livePreview) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;
    const tick = async () => {
      if (stopped) return;
      const list = previewQueueRef.current;
      if (!document.hidden && list.length > 0) {
        const dev = list[cursor % list.length];
        cursor = (cursor + 1) % list.length;
        await captureScreen(dev);
      }
      if (!stopped) timer = setTimeout(tick, PREVIEW_GAP_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [livePreview, captureScreen]);

  const pendingRequests = useMemo(() => {
    return (permissionRequests || []).filter((r) => r.status === "pending");
  }, [permissionRequests]);

  const deviceForRequest = (req: DevicePermissionRequest) => devicesWithUsers.find((d) => requestMatchesDevice(req, d));
  const deviceLabel = (dev?: DeviceWithActiveUser) =>
    dev ? `${dev.name || dev.model}${dev.deviceNumber ? ` · #${dev.deviceNumber}` : ""}` : undefined;

  const sectorItems = [
    { id: "all", label: "Todos", count: devicesWithUsers.length },
    ...SECTOR_OPTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      count: devicesWithUsers.filter((d) => normSector(d.sector) === normSector(s.id)).length,
    })),
  ];
  const inUseCount = devicesWithUsers.filter((d) => !!d.activeUserDisplayName).length;
  const onlineCount = devicesWithUsers.filter((d) => isOnline(d.status)).length;

  const ageLabel = (at: number) => {
    const s = Math.max(0, Math.round((now - at) / 1000));
    return s < 5 ? "agora" : s < 60 ? `há ${s} s` : `há ${Math.round(s / 60)} min`;
  };

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Supervisão de aparelhos"
        description={`Telas atualizadas em rodízio. Clique na tela para enviar um toque.${user?.displayName ? ` Supervisor: ${user.displayName}` : ""}`}
        icon={<Eye size={18} />}
        actions={
          <>
            <Toggle checked={livePreview} onChange={setLivePreview} size="sm" label="Atualizar telas" />
            <Button variant="secondary" onClick={() => loadData(true)} loading={loading} icon={<RefreshCw size={14} />}>
              Atualizar
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Total" value={devicesWithUsers.length} icon={<Smartphone size={14} />} />
        <StatCard label="Online" value={onlineCount} icon={<Activity size={14} />} tone="success" />
        <StatCard label="Em uso" value={inUseCount} icon={<UserCheck size={14} />} tone="accent" />
      </div>

      {(message || loadError) && (
        <div
          role={message?.type === "success" ? "status" : "alert"}
          className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[0.8125rem] ${
            message?.type === "success"
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span className="break-words">{message?.text || loadError}</span>
          </span>
          {message ? (
            <button onClick={() => setMessage(null)} aria-label="Fechar aviso" className="shrink-0 cursor-pointer">
              <X size={15} />
            </button>
          ) : (
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => loadData(true)}>
              Tentar de novo
            </Button>
          )}
        </div>
      )}

      {pendingRequests.length > 0 && (
        <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Bell size={14} className="text-amber-500" />
            {pendingRequests.length === 1 ? "1 pedido de acesso pendente" : `${pendingRequests.length} pedidos de acesso pendentes`}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pendingRequests.map((req) => {
              const dev = deviceForRequest(req);
              return (
                <div key={req.requestId} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0">
                    <p className="truncate text-[0.8125rem] font-medium text-primary">{req.userDisplayName || req.userName}</p>
                    <p className="truncate text-[0.75rem] text-secondary" title={req.adbDeviceId}>
                      {deviceLabel(dev) || req.adbDeviceId}
                    </p>
                    {req.requestedReason && <p className="truncate text-[0.75rem] text-tertiary">"{req.requestedReason}"</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="success" loading={busyRequest === req.requestId} disabled={busyRequest !== null} onClick={() => runRequestAction(req, true)}>
                      Aprovar
                    </Button>
                    <Button size="sm" variant="danger" disabled={busyRequest !== null} onClick={() => setRejectTarget(req)}>
                      Recusar
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="space-y-3">
        <div className="relative flex max-w-sm items-center">
          <Search size={14} className="input-icon-left text-tertiary" />
          <input
            type="text"
            aria-label="Buscar aparelhos"
            placeholder="Buscar por nome, número ou colaborador"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full input-with-icon-left"
          />
        </div>
        <div className="overflow-x-auto pb-1 custom-scrollbar">
          <SegmentedControl items={sectorItems} value={sectorTab} onChange={setSectorTab} />
        </div>
      </div>

      {loading && devicesWithUsers.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-96 rounded-xl border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum aparelho encontrado"
          description={
            devicesWithUsers.length === 0
              ? "Nenhum aparelho cadastrado nesta empresa ainda."
              : "Nenhum aparelho neste setor ou com esse termo de busca."
          }
          action={
            devicesWithUsers.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => { setSearchQuery(""); setSectorTab("all"); }}>
                Ver todos os aparelhos
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredDevices.map((dev) => {
            const hasActiveUser = !!dev.activeUserDisplayName;
            const shot = shots[dev.serial];
            const shotError = shotErrors[dev.serial];
            const isCapturing = !!capturing[dev.serial];
            const online = isOnline(dev.status);
            const devPendingReq = pendingRequests.find((r) => requestMatchesDevice(r, dev));

            return (
              <Card key={dev.serial} padding="none" className={hasActiveUser ? "!border-[var(--color-accent)]" : ""}>
                <div className={`flex items-center justify-between gap-2 rounded-t-xl border-b border-border px-4 py-2.5 text-[0.75rem] ${hasActiveUser ? "bg-[var(--color-accent-glow)] text-primary" : "bg-secondary text-secondary"}`}>
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
                        {dev.deviceNumber ? `#${dev.deviceNumber} · ` : ""}
                        {sectorLabel(dev.sector)} · {dev.brand} {dev.model}
                      </p>
                      <p className="truncate font-mono text-[0.6875rem] text-tertiary">{dev.serial}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusDot status={dev.status} />
                      <BatteryMeter level={dev.battery} />
                    </div>
                  </div>

                  {dev.assignedUserName && (
                    <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-[0.75rem]">
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
                        <Button size="sm" variant="success" loading={busyRequest === devPendingReq.requestId} disabled={busyRequest !== null} onClick={() => runRequestAction(devPendingReq, true)}>
                          Aprovar
                        </Button>
                        <Button size="sm" variant="danger" disabled={busyRequest !== null} onClick={() => setRejectTarget(devPendingReq)}>
                          Recusar
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* A tela do aparelho é sempre escura, nos dois temas. */}
                  <div className="relative flex aspect-[9/16] max-h-72 flex-col items-center justify-center overflow-hidden rounded-xl border border-border bg-black/90">
                    {shot ? (
                      <img
                        src={shot.src}
                        alt={`Tela de ${dev.name || dev.serial}`}
                        className={`h-full w-full object-contain ${online ? "cursor-crosshair" : ""}`}
                        onClick={(e) => online && handlePreviewClick(e, dev)}
                      />
                    ) : (
                      <div className="space-y-2 p-4 text-center text-zinc-400">
                        <Smartphone size={28} className="mx-auto" />
                        <p className="text-[0.75rem]">
                          {!online
                            ? "Aparelho offline"
                            : shotError
                            ? "Não foi possível capturar a tela"
                            : livePreview
                            ? "Aguardando a vez na fila de capturas..."
                            : "Atualização de telas desligada"}
                        </p>
                        {online && isCapturing && <RefreshCw size={14} className="mx-auto animate-spin" />}
                      </div>
                    )}

                    {shot && (
                      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[0.6875rem] text-zinc-200">
                        {isCapturing && <RefreshCw size={10} className="animate-spin" />}
                        {isCapturing ? "Atualizando" : ageLabel(shot.at)}
                      </div>
                    )}

                    <button
                      type="button"
                      aria-label="Atualizar imagem"
                      title="Atualizar imagem"
                      onClick={() => captureScreen(dev)}
                      disabled={isCapturing || !online}
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
                      disabled={!online}
                      loading={!!launchingScrcpy[dev.serial]}
                      icon={<Monitor size={14} />}
                      className="w-full"
                      title="Abre a tela do aparelho em uma janela no computador, com mouse e teclado"
                    >
                      {launchingScrcpy[dev.serial] ? "Abrindo..." : "Controle total"}
                    </Button>
                    <div className="grid grid-cols-3 gap-2">
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(dev, 4)} disabled={!online} icon={<ArrowLeft size={12} />}>
                        Voltar
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(dev, 3)} disabled={!online} icon={<Home size={12} />}>
                        Início
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleAdbKey(dev, 187)} disabled={!online} icon={<Layers size={12} />}>
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

      <Modal
        isOpen={!!rejectTarget}
        onClose={() => setRejectTarget(null)}
        title="Recusar pedido"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejectTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              onClick={() => {
                const req = rejectTarget;
                setRejectTarget(null);
                if (req) runRequestAction(req, false);
              }}
            >
              Recusar
            </Button>
          </>
        }
      >
        <p className="text-[0.8125rem] text-secondary">
          O pedido de {rejectTarget?.userDisplayName || rejectTarget?.userName} para usar{" "}
          {(rejectTarget && deviceLabel(deviceForRequest(rejectTarget))) || rejectTarget?.adbDeviceId} será recusado.
        </p>
      </Modal>
    </div>
  );
}
