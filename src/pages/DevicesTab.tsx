

// ============================================================
// Esfera v3 — Aparelhos (hub de gestão dos celulares via ADB)
// Modularizado & Redesenhado em Linear SaaS Style
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { isOnlineStatus, deviceKey, deviceDisplayName, errorText, notify, confirmAction, type DeviceChip } from "../components/devices/deviceUi";
import { ConnectDeviceModal } from "../components/devices/ConnectDeviceModal";
import { DeviceConfigModal, type ConfigTab } from "../components/devices/DeviceConfigModal";
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

// ============================================================
// Apoio: dados estáveis entre atualizações
// ============================================================

const POLL_MS = 7000;
const CHIPS_POLL_MS = 60000;
const LINK_TIMEOUT_MS = 25000;

// Reaproveita o objeto anterior quando nada mudou: os cards (memo) não redesenham.
function sameDevice(a: Device, b: Device) {
  const keys = Object.keys(b) as (keyof Device)[];
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((k) => a[k] === b[k]);
}

function mergeStable(prev: Device[], next: Device[]): Device[] {
  const byKey = new Map(prev.map((d) => [`${d.id}|${d.serial}`, d]));
  let changed = prev.length !== next.length;
  const merged = next.map((d, i) => {
    const old = byKey.get(`${d.id}|${d.serial}`);
    if (old && sameDevice(old, d)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return d;
  });
  return changed ? merged : prev;
}

function ipOf(value?: string | null) {
  return value && value.includes(":") ? value.split(":")[0] : "";
}

// Pedido de acesso pertence ao aparelho por serial, endereço, ID ou IP exato.
function requestMatchesDevice(r: DevicePermissionRequest, d: Device) {
  if (!r.adbDeviceId) return false;
  if (r.adbDeviceId === d.serial || r.adbDeviceId === d.currentAdbAddress || r.adbDeviceId === d.esferaDeviceId) return true;
  const rip = ipOf(r.adbDeviceId);
  return !!rip && (rip === ipOf(d.currentAdbAddress) || rip === ipOf(d.serial) || rip === d.ip);
}

// Mensagens do backend vêm com emoji e tempo em ms: mostra só o que interessa.
function prettyResult(text: string) {
  return String(text || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+em\s+\d+\s*ms!?/i, ".")
    .trim();
}

type ModalTarget = { key: string; serial: string; snapshot: Device };

const modalTarget = (device: Device): ModalTarget => ({ key: deviceKey(device), serial: device.serial, snapshot: device });

function ManagerDevicesView() {
  const { selectedCompanyId } = useAuth();

  // Filter & View State
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorTab, setSectorTab] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Device Data & Selection
  const [devicesList, setDevicesList] = useState<Device[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentUpdateStatus>>({});
  const [chipsByDevice, setChipsByDevice] = useState<Record<number, DeviceChip[]>>({});
  const [selectedSerials, setSelectedSerials] = useState<string[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [activeUserMap, setActiveUserMap] = useState<
    Record<string, { activeUserId?: number; activeUserDisplayName?: string }>
  >({});

  // Modais: guardam a chave do aparelho e mostram sempre a versão atual da lista.
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [diagnosticModalOpen, setDiagnosticModalOpen] = useState(false);
  const [mirrorTarget, setMirrorTarget] = useState<ModalTarget | null>(null);
  const [regionModalOpen, setRegionModalOpen] = useState(false);
  const [selectedSerialForRegion, setSelectedSerialForRegion] = useState("");
  const [configTarget, setConfigTarget] = useState<(ModalTarget & { tab: ConfigTab }) | null>(null);
  const [identityTarget, setIdentityTarget] = useState<ModalTarget | null>(null);

  // Connecting timeout tracking (15s)
  const [connectingTimestamps, setConnectingTimestamps] = useState<Record<string, number>>({});

  // USB Device Scanning & Linking Status
  const [usbDevices, setUsbDevices] = useState<{ serial: string; state: string; model: string }[]>([]);
  const [loadingUsb, setLoadingUsb] = useState(false);
  const [linkingSerial, setLinkingSerial] = useState<string | null>(null);
  const [linkingStatus, setLinkingStatus] = useState<string | null>(null);

  const effectiveCompanyId = selectedCompanyId || 1;

  // Se a janela Conectar for fechada no meio da conexão, o resultado vira aviso.
  const connectOpenRef = useRef(false);
  connectOpenRef.current = connectModalOpen;
  const reportIfClosed = (ok: boolean, title: string, detail?: string) => {
    if (!connectOpenRef.current) notify(ok ? "success" : "danger", title, detail);
  };

  // Timers de mensagens/fechamento: cancelados ao sair da tela.
  const timers = useRef(new Set<number>());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }, []);
  const cancelLater = useCallback((id: number) => {
    window.clearTimeout(id);
    timers.current.delete(id);
  }, []);
  useEffect(() => {
    const set = timers.current;
    return () => set.forEach((id) => window.clearTimeout(id));
  }, []);

  // ---------------------------------------------------------------------------
  // Carregamento: só a resposta mais recente da empresa aberta é aplicada, e a
  // atualização automática não empilha pedidos enquanto o anterior não volta.
  // ---------------------------------------------------------------------------
  const companyRef = useRef(effectiveCompanyId);
  companyRef.current = effectiveCompanyId;
  const reqSeq = useRef(0);
  const inFlightSince = useRef(0);

  const refreshDevices = useCallback(
    (opts?: { manual?: boolean }) => {
      const now = Date.now();
      if (!opts?.manual && inFlightSince.current && now - inFlightSince.current < 30000) return;
      const seq = ++reqSeq.current;
      const company = effectiveCompanyId;
      const fresh = () => seq === reqSeq.current && company === companyRef.current;
      inFlightSince.current = now;
      if (opts?.manual) setRefreshing(true);

      api<Device[]>("get_devices", { companyId: company })
        .then((data) => {
          if (!fresh()) return;
          if (data && Array.isArray(data)) setDevicesList((prev) => mergeStable(prev, data));
          setLoadError(null);
        })
        .catch((err) => {
          if (!fresh()) return;
          console.warn("Retorno temporário de IPC para get_devices:", err);
          setLoadError(errorText(err, "Não foi possível carregar os aparelhos."));
        })
        .finally(() => {
          if (seq !== reqSeq.current) return;
          inFlightSince.current = 0;
          setLoadingDevices(false);
          setRefreshing(false);
        });

      api<AgentUpdateStatus[]>("get_agent_update_status", { companyId: company })
        .then((items) => {
          if (fresh()) setAgentStatuses(Object.fromEntries((items || []).map((item) => [item.deviceId, item])));
        })
        .catch(() => {
          if (fresh()) setAgentStatuses({});
        });

      api<DeviceWithActiveUser[]>("get_devices_with_active_user_map", { companyId: company })
        .then((data) => {
          if (!fresh() || !data || !Array.isArray(data)) return;
          const map: Record<string, { activeUserId?: number; activeUserDisplayName?: string }> = {};
          for (const d of data) {
            if (d.activeUserId && d.activeUserDisplayName) {
              map[d.serial] = { activeUserId: d.activeUserId, activeUserDisplayName: d.activeUserDisplayName };
            }
          }
          setActiveUserMap(map);
        })
        .catch(() => {});

      api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId: company })
        .then((data) => {
          if (fresh() && data && Array.isArray(data)) setPermissionRequests(data);
        })
        .catch(() => {});
    },
    [effectiveCompanyId]
  );

  // Ao trocar de empresa, a lista anterior some na hora (antes ficava na tela até a resposta).
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!firstLoad.current) {
      setDevicesList([]);
      setAgentStatuses({});
      setActiveUserMap({});
      setPermissionRequests([]);
      setSelectedSerials([]);
      setLoadError(null);
      setLoadingDevices(true);
    }
    firstLoad.current = false;
    inFlightSince.current = 0;
    refreshDevices();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) refreshDevices();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) refreshDevices();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshDevices]);

  // Chips por aparelho (o disparo exige exatamente um): ao mudar a lista e a cada minuto.
  const loadChips = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => api<DeviceChip[]>("get_device_chips", { deviceId: id })));
    setChipsByDevice((prev) => {
      let changed = false;
      const next = { ...prev };
      results.forEach((r, i) => {
        if (r.status !== "fulfilled" || !Array.isArray(r.value)) return;
        const old = prev[ids[i]];
        if (old && JSON.stringify(old) === JSON.stringify(r.value)) return;
        next[ids[i]] = r.value;
        changed = true;
      });
      return changed ? next : prev;
    });
  }, []);

  const deviceIdsKey = useMemo(
    () =>
      devicesList
        .map((d) => d.id)
        .filter((id) => id > 0)
        .sort((a, b) => a - b)
        .join(","),
    [devicesList]
  );

  useEffect(() => {
    const ids = deviceIdsKey ? deviceIdsKey.split(",").map(Number) : [];
    loadChips(ids);
    const t = setInterval(() => {
      if (!document.hidden) loadChips(ids);
    }, CHIPS_POLL_MS);
    return () => clearInterval(t);
  }, [deviceIdsKey, loadChips]);

  // Seleção só com aparelhos que ainda existem na lista.
  useEffect(() => {
    setSelectedSerials((prev) => {
      if (prev.length === 0) return prev;
      const valid = prev.filter((s) => devicesList.some((d) => d.serial === s));
      return valid.length === prev.length ? prev : valid;
    });
  }, [devicesList]);

  // Realtime updates from check-in server via Tauri event
  useEffect(() => {
    const unlisten = listen<{ esferaDeviceId: string; currentAdbAddress: string; status: string; lastSeenUtc: string; viaTunnel?: boolean }>(
      "device-updated",
      (event) => {
        const newStatus = event.payload.status as DeviceStatus;
        const devId = event.payload.esferaDeviceId;

        // Evento de aparelho fora da lista (ex.: de outra empresa) não mexe no estado.
        setDevicesList((prev) => {
          let hit = false;
          const next = prev.map((d) => {
            if (d.esferaDeviceId !== devId) return d;
            hit = true;
            return {
              ...d,
              currentAdbAddress: event.payload.currentAdbAddress,
              status: newStatus,
              lastSeenUtc: event.payload.lastSeenUtc,
              ...(typeof event.payload.viaTunnel === "boolean" ? { viaTunnel: event.payload.viaTunnel } : {}),
            };
          });
          return hit ? next : prev;
        });

        // Track connecting timestamps for 15s timeout
        if (newStatus === "connecting") {
          setConnectingTimestamps((prev) => (prev[devId] ? prev : { ...prev, [devId]: Date.now() }));
        } else {
          setConnectingTimestamps((prev) => {
            if (!(devId in prev)) return prev;
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
    if (Object.keys(connectingTimestamps).length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const expiredIds = Object.entries(connectingTimestamps)
        .filter(([, ts]) => now - ts > 15000)
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

  // ---------------------------------------------------------------------------
  // USB e conexão
  // ---------------------------------------------------------------------------
  const fetchUsbDevices = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoadingUsb(true);
      setLinkingStatus(null);
    }
    try {
      const data = await api<{ serial: string; state: string; model: string }[]>("list_usb_devices");
      setUsbDevices(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("Falha ao buscar dispositivos ADB nativos:", err);
      if (!quiet) setUsbDevices([]);
    } finally {
      if (!quiet) setLoadingUsb(false);
    }
  }, []);

  // Com a janela aberta, a lista USB se atualiza sozinha (ex.: depois de tocar em Permitir).
  useEffect(() => {
    if (!connectModalOpen) return;
    fetchUsbDevices();
    const t = setInterval(() => {
      if (!document.hidden) fetchUsbDevices(true);
    }, 5000);
    return () => clearInterval(t);
  }, [connectModalOpen, fetchUsbDevices]);

  // source "modal": progresso dentro da janela Conectar; "card": aviso no canto da tela.
  const handleForceWirelessAdb = async (serial: string, deviceNumber: number, sector: string, deviceName: string, source: "modal" | "card" = "modal") => {
    if (linkingSerial) {
      if (source === "card") notify("info", "Aguarde: outra conexão está em andamento.");
      return;
    }
    const label = deviceName.trim() || serial;
    setLinkingSerial(serial);
    if (source === "modal") setLinkingStatus("Ativando o controle por Wi-Fi e obtendo o IP do aparelho...");

    let timedOut = false;
    const timeoutId = later(() => {
      timedOut = true;
      const msg = "Tempo esgotado (25 s): o aparelho não respondeu. Se ele for remoto, já está ligado pelo túnel.";
      setLinkingSerial(null);
      if (source === "card") notify("warning", `Sem resposta de ${label}.`, msg);
      else setLinkingStatus(msg);
    }, LINK_TIMEOUT_MS);

    try {
      const result = await api<string>("force_enable_wireless_adb", {
        serial,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName.trim() || undefined,
      });
      cancelLater(timeoutId);
      if (timedOut) return;
      refreshDevices({ manual: true });
      if (source === "card") {
        setLinkingSerial(null);
        notify("success", `Wi-Fi ativado em ${label}.`, prettyResult(result) || undefined);
        return;
      }
      setLinkingStatus(result);
      reportIfClosed(true, `${label} conectado.`, prettyResult(result) || undefined);
      later(() => {
        setConnectModalOpen(false);
        setLinkingSerial(null);
        setLinkingStatus(null);
      }, 2000);
    } catch (err: any) {
      cancelLater(timeoutId);
      if (timedOut) return;
      const errMsg = errorText(err, "Não foi possível ativar o Wi-Fi.");
      if (source === "card") {
        setLinkingSerial(null);
        notify("danger", `Não foi possível ativar o Wi-Fi em ${label}.`, errMsg);
        return;
      }
      setLinkingStatus(`Erro: ${errMsg}`);
      reportIfClosed(false, `Não foi possível conectar ${label}.`, errMsg);
      later(() => setLinkingSerial(null), 4000);
    }
  };

  const handleConnectDevice = async (ipAddress: string, portNumber: number, deviceNumber: number, sector: string, deviceName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(ipAddress);
    setLinkingStatus("Conectando...");

    let timedOut = false;
    const timeoutId = later(() => {
      timedOut = true;
      setLinkingStatus("Tempo esgotado (25 s): verifique se o IP está acessível na mesma rede.");
      setLinkingSerial(null);
    }, LINK_TIMEOUT_MS);

    try {
      let finalIp = ipAddress.trim();
      let finalPort = portNumber;

      if (finalIp.includes(":")) {
        const parts = finalIp.split(":");
        finalIp = parts[0].trim();
        finalPort = parseInt(parts[1], 10) || portNumber || 5555;
      }

      const result = await api<string>("connect_adb_device", {
        ip: finalIp,
        port: finalPort,
        companyId: effectiveCompanyId,
        deviceNumber,
        sector,
        deviceName: deviceName.trim() || undefined,
      });
      cancelLater(timeoutId);
      if (!timedOut) {
        refreshDevices({ manual: true });
        setConnectModalOpen(false);
        setLinkingStatus(null);
        notify("success", `${deviceName.trim() || finalIp} conectado.`, prettyResult(result) || undefined);
      }
    } catch (err: any) {
      cancelLater(timeoutId);
      if (!timedOut) {
        const errMsg = errorText(err, "Não foi possível conectar por IP.");
        setLinkingStatus(`Erro: ${errMsg}`);
        reportIfClosed(false, `Não foi possível conectar ${deviceName.trim() || ipAddress}.`, errMsg);
      }
    } finally {
      cancelLater(timeoutId);
      if (!timedOut) setLinkingSerial(null);
    }
  };

  const handlePairAndConnectDevice = async (ip: string, pPort: number, code: string, cPort: number, devNum: number, sec: string, devName: string) => {
    if (linkingSerial) return;
    setLinkingSerial(ip);
    setLinkingStatus("Enviando o código de pareamento ao aparelho...");

    let timedOut = false;
    const timeoutId = later(() => {
      timedOut = true;
      setLinkingStatus("Tempo esgotado (25 s): confira o IP, a porta e o código, que expira em poucos minutos.");
      setLinkingSerial(null);
    }, LINK_TIMEOUT_MS);

    try {
      const result = await api<string>("pair_and_connect_adb_device", {
        ip,
        pairPort: pPort,
        pairCode: code,
        connectPort: cPort || 5555,
        companyId: effectiveCompanyId,
        deviceNumber: devNum,
        sector: sec,
        deviceName: devName.trim() || undefined,
      });
      cancelLater(timeoutId);
      if (timedOut) return;
      setLinkingStatus(result);
      reportIfClosed(true, `${devName.trim() || ip} pareado e conectado.`);
      refreshDevices({ manual: true });
      later(() => {
        setConnectModalOpen(false);
        setLinkingSerial(null);
        setLinkingStatus(null);
      }, 2000);
    } catch (err: any) {
      cancelLater(timeoutId);
      if (timedOut) return;
      const errMsg = errorText(err, "O pareamento por código falhou.");
      setLinkingStatus(`Erro: ${errMsg}`);
      reportIfClosed(false, "O pareamento por código falhou.", errMsg);
      later(() => setLinkingSerial(null), 4000);
    }
  };

  // ---------------------------------------------------------------------------
  // Pedidos de acesso
  // ---------------------------------------------------------------------------
  const handleApproveRequest = useCallback(
    async (requestId: number) => {
      try {
        await api("approve_device_access", { requestId });
        notify("success", "Acesso aprovado.");
        refreshDevices({ manual: true });
      } catch (err) {
        notify("danger", "Não foi possível aprovar o pedido.", errorText(err, "Tente novamente."));
      }
    },
    [refreshDevices]
  );

  const handleRejectRequest = useCallback(
    async (requestId: number) => {
      try {
        await api("reject_device_access", { requestId });
        notify("info", "Pedido recusado.");
        refreshDevices({ manual: true });
      } catch (err) {
        notify("danger", "Não foi possível recusar o pedido.", errorText(err, "Tente novamente."));
      }
    },
    [refreshDevices]
  );

  // ---------------------------------------------------------------------------
  // Remoção (individual, em lote e offline)
  // ---------------------------------------------------------------------------

  // Lança erro se o banco recusar: a janela de configurações mostra a mensagem.
  const handleRemoveDevice = async (dev: Device) => {
    const target = dev.esferaDeviceId || dev.currentAdbAddress || dev.serial;
    await api("disconnect_adb_device", { serial: dev.currentAdbAddress || dev.serial }).catch(() => undefined);
    await api("delete_device", { serial: target });
    setDevicesList((prev) => prev.filter((d) => deviceKey(d) !== deviceKey(dev) && d.serial !== dev.serial));
    setSelectedSerials((prev) => prev.filter((s) => s !== dev.serial));
    setConfigTarget(null);
    notify("success", `${deviceDisplayName(dev)} removido.`);
    refreshDevices({ manual: true });
  };

  const removeMany = async (targets: Device[], label: string) => {
    setDeleting(true);
    const results = await Promise.allSettled(targets.map((d) => api("delete_device", { serial: d.serial })));
    setDeleting(false);
    const removed = targets.filter((_, i) => results[i].status === "fulfilled");
    const failed = targets
      .map((d, i) => ({ d, r: results[i] }))
      .filter((x): x is { d: Device; r: PromiseRejectedResult } => x.r.status === "rejected");
    const removedSerials = new Set(removed.map((d) => d.serial));
    setDevicesList((prev) => prev.filter((d) => !removedSerials.has(d.serial)));
    setSelectedSerials((prev) => prev.filter((s) => !removedSerials.has(s)));
    refreshDevices({ manual: true });
    if (failed.length === 0) {
      notify("success", `${removed.length} ${removed.length === 1 ? "aparelho removido" : "aparelhos removidos"}${label}.`);
    } else {
      const reason = errorText(failed[0].r.reason, "erro desconhecido");
      notify(
        "danger",
        `${removed.length} removido(s), ${failed.length} com falha.`,
        `${failed
          .slice(0, 3)
          .map((x) => deviceDisplayName(x.d))
          .join(", ")}${failed.length > 3 ? ` e mais ${failed.length - 3}` : ""}: ${reason}`
      );
    }
  };

  const namesPreview = (list: Device[]) => (
    <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-primary">
      {list.slice(0, 6).map((d) => (
        <li key={`${d.id}|${d.serial}`} className="truncate">
          {deviceDisplayName(d)}
        </li>
      ))}
      {list.length > 6 && <li className="list-none text-secondary">e mais {list.length - 6}</li>}
    </ul>
  );

  const handleBatchDeleteSelected = async () => {
    const targets = devicesList.filter((d) => selectedSerials.includes(d.serial));
    if (targets.length === 0) {
      setSelectedSerials([]);
      return;
    }
    const connected = targets.filter((d) => d.status !== "offline").length;
    const ok = await confirmAction({
      title: targets.length === 1 ? "Remover aparelho" : `Remover ${targets.length} aparelhos`,
      danger: true,
      confirmLabel: targets.length === 1 ? "Remover" : `Remover ${targets.length}`,
      message: (
        <>
          <p>O cadastro e o nome destes aparelhos serão apagados:</p>
          {namesPreview(targets)}
          {connected > 0 && (
            <p>
              {connected} ainda {connected === 1 ? "está conectado e volta" : "estão conectados e voltam"} para a lista como aparelho novo enquanto estiver no cabo ou na rede.
            </p>
          )}
        </>
      ),
    });
    if (!ok) return;
    await removeMany(targets, "");
  };

  const handleClearAllOfflineDevices = async () => {
    const offlineDevs = devicesList.filter((d) => d.status === "offline");
    if (offlineDevs.length === 0) {
      notify("info", "Nenhum aparelho offline para remover.");
      return;
    }
    const ok = await confirmAction({
      title: "Remover aparelhos offline",
      danger: true,
      confirmLabel: `Remover ${offlineDevs.length}`,
      message: (
        <>
          <p>
            Apagar o cadastro e o nome de {offlineDevs.length === 1 ? "1 aparelho offline" : `todos os ${offlineDevs.length} aparelhos offline`}?
          </p>
          {namesPreview(offlineDevs)}
        </>
      ),
    });
    if (!ok) return;
    await removeMany(offlineDevs, " (offline)");
  };

  // ---------------------------------------------------------------------------
  // Filtros e números
  // ---------------------------------------------------------------------------
  const filteredDevices = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const qDigits = q.replace(/\D/g, "");
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

        if (q) {
          const name = String(device.name || "");
          const esfId = String(device.esferaDeviceId || "");
          const curAdb = String(device.currentAdbAddress || "");
          const devNum = String(device.deviceNumber ?? "");
          const devNumPad = devNum.padStart(2, "0");
          const chipHit =
            qDigits.length >= 4 && (chipsByDevice[device.id] || []).some((c) => String(c.phoneNumber || "").replace(/\D/g, "").includes(qDigits));
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
            `#${devNumPad}`.includes(q) ||
            chipHit
          );
        }

        return true;
      })
      .sort((a, b) => {
        const nameA = String(a.name || a.model || a.serial || "");
        const nameB = String(b.name || b.model || b.serial || "");
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
      });
  }, [devicesList, sectorTab, searchQuery, statusFilter, activeUserMap, chipsByDevice]);

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

  // Pedido pendente de cada aparelho (calculado uma vez, não por card a cada render).
  const pendingByDevice = useMemo(() => {
    const map = new Map<string, DevicePermissionRequest>();
    if (pendingRequests.length === 0) return map;
    for (const d of devicesList) {
      const r = pendingRequests.find((req) => requestMatchesDevice(req, d));
      if (r) map.set(`${d.id}|${d.serial}`, r);
    }
    return map;
  }, [devicesList, pendingRequests]);

  const deviceForRequest = useCallback((r: DevicePermissionRequest) => devicesList.find((d) => requestMatchesDevice(r, d)), [devicesList]);

  const selectedSet = useMemo(() => new Set(selectedSerials), [selectedSerials]);
  const allFilteredSelected = filteredDevices.length > 0 && filteredDevices.every((d) => selectedSet.has(d.serial));

  const hasFilters = !!searchQuery || sectorTab !== "all" || statusFilter !== "all";
  const clearFilters = () => {
    setSearchQuery("");
    setSectorTab("all");
    setStatusFilter("all");
  };

  // ---------------------------------------------------------------------------
  // Ações dos cards: funções estáveis (o memo dos cards depende disso)
  // ---------------------------------------------------------------------------
  const toggleSelectDevice = useCallback((device: Device) => {
    setSelectedSerials((prev) => (prev.includes(device.serial) ? prev.filter((s) => s !== device.serial) : [...prev, device.serial]));
  }, []);
  const openMirror = useCallback((device: Device) => setMirrorTarget(modalTarget(device)), []);
  const openConfig = useCallback((device: Device, tab: ConfigTab = "general") => setConfigTarget({ ...modalTarget(device), tab }), []);
  const openRegion = useCallback((device: Device) => {
    setSelectedSerialForRegion(device.serial);
    setRegionModalOpen(true);
  }, []);
  const openIdentity = useCallback((device: Device) => setIdentityTarget(modalTarget(device)), []);

  const forceWirelessRef = useRef(handleForceWirelessAdb);
  forceWirelessRef.current = handleForceWirelessAdb;
  const forceWireless = useCallback(
    (device: Device) => forceWirelessRef.current(device.serial, device.deviceNumber, device.sector, device.name || "", "card"),
    []
  );

  const resolveTarget = (t: ModalTarget | null) =>
    t ? devicesList.find((d) => deviceKey(d) === t.key) || devicesList.find((d) => d.serial === t.serial) || t.snapshot : null;
  const mirrorDevice = resolveTarget(mirrorTarget);
  const configDevice = resolveTarget(configTarget);
  const identityDevice = resolveTarget(identityTarget);

  const agentFor = (device: Device) => {
    const s = agentStatuses[device.esferaDeviceId || device.serial];
    return s && s.companyId === effectiveCompanyId ? s : undefined;
  };

  const handleSaveDevice = async (updated: Device) => {
    await api("update_device", { device: updated });
    setDevicesList((prev) =>
      prev.map((d) => {
        const isMatch =
          (d.esferaDeviceId && updated.esferaDeviceId && d.esferaDeviceId === updated.esferaDeviceId) ||
          d.serial === updated.serial ||
          (d.currentAdbAddress && updated.currentAdbAddress && d.currentAdbAddress === updated.currentAdbAddress);
        return isMatch ? { ...d, ...updated } : d;
      })
    );
    setConfigTarget(null);
    notify("success", "Alterações salvas.", `${deviceDisplayName(updated)} atualizado.`);
    refreshDevices({ manual: true });
  };

  const showSkeleton = loadingDevices && devicesList.length === 0;
  const showError = !!loadError && devicesList.length === 0 && !loadingDevices;
  const gridCls = "grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3";

  const itemProps = (device: Device) => ({
    device,
    agentStatus: agentFor(device),
    activeUserDisplayName: activeUserMap[device.serial]?.activeUserDisplayName,
    pendingRequest: pendingByDevice.get(`${device.id}|${device.serial}`),
    chips: device.id > 0 ? chipsByDevice[device.id] : undefined,
    linking: linkingSerial === device.serial,
    isSelected: selectedSet.has(device.serial),
    onApproveRequest: handleApproveRequest,
    onRejectRequest: handleRejectRequest,
    onToggleSelect: toggleSelectDevice,
    onOpenMirror: openMirror,
    onOpenConfig: openConfig,
    onOpenRegion: openRegion,
    onForceWireless: forceWireless,
    onOpenDiagnostic: openIdentity,
  });

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Aparelhos"
        description="Status, chip, agente e controle remoto de cada aparelho."
        icon={<Smartphone size={18} />}
        actions={
          <DeviceHeaderActions
            devicesList={devicesList}
            loading={refreshing}
            onOpenConnectModal={() => setConnectModalOpen(true)}
            onOpenDiagnosticModal={() => setDiagnosticModalOpen(true)}
            onRefreshDevices={() => refreshDevices({ manual: true })}
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
            {pendingRequests.length === 1 ? "1 pedido de acesso pendente" : `${pendingRequests.length} pedidos de acesso pendentes`}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {pendingRequests.map((req) => {
              const dev = deviceForRequest(req);
              return (
                <div key={req.requestId} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0">
                    <p className="truncate text-[0.8125rem] font-medium text-primary">{req.userDisplayName || req.userName}</p>
                    <p className="truncate text-[0.75rem] text-secondary" title={req.adbDeviceId}>
                      {dev ? deviceDisplayName(dev) : <span className="font-mono">{req.adbDeviceId}</span>}
                    </p>
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
              );
            })}
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
          deleting={deleting}
          onClearSelection={() => setSelectedSerials([])}
          onBatchDelete={handleBatchDeleteSelected}
        />

        {loadError && devicesList.length > 0 && (
          <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-700 dark:text-amber-400">
            <span className="flex min-w-0 items-center gap-2">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="truncate">A última atualização falhou; a lista pode estar desatualizada. {loadError}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => refreshDevices({ manual: true })} loading={refreshing} icon={<RefreshCw size={13} />}>
              Tentar de novo
            </Button>
          </div>
        )}

        {showSkeleton ? (
          <div className={gridCls}>
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
              <Button variant="secondary" size="sm" onClick={() => refreshDevices({ manual: true })} loading={refreshing} icon={<RefreshCw size={13} />}>
                Tentar novamente
              </Button>
            }
          />
        ) : filteredDevices.length === 0 ? (
          devicesList.length === 0 ? (
            <EmptyState
              icon={<Smartphone size={18} />}
              title="Nenhum aparelho cadastrado"
              description="Conecte um aparelho Android por cabo USB, Wi-Fi ou túnel para controlar e usar nos disparos."
              action={
                <Button variant="primary" size="sm" onClick={() => setConnectModalOpen(true)} icon={<Plus size={14} />}>
                  Conectar aparelho
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
          <div className={gridCls}>
            {filteredDevices.map((device) => (
              <DeviceCard key={`${device.id}|${device.serial}`} {...itemProps(device)} />
            ))}
          </div>
        ) : (
          <Card padding="none">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-secondary text-[0.75rem] font-medium text-secondary">
                    <th className="w-10 px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Selecionar todos os aparelhos da lista"
                        checked={allFilteredSelected}
                        onChange={() => {
                          const keys = filteredDevices.map((d) => d.serial);
                          if (allFilteredSelected) setSelectedSerials((prev) => prev.filter((s) => !keys.includes(s)));
                          else setSelectedSerials((prev) => Array.from(new Set([...prev, ...keys])));
                        }}
                        className="h-4 w-4 rounded border-border-strong bg-secondary accent-[var(--color-accent)] cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Aparelho</th>
                    <th className="px-3 py-2.5 font-medium">Status e chip</th>
                    <th className="px-3 py-2.5 font-medium">Bateria</th>
                    <th className="px-3 py-2.5 font-medium">Setor</th>
                    <th className="px-3 py-2.5 font-medium">Endereço</th>
                    <th className="px-3 py-2.5 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredDevices.map((device) => (
                    <DeviceRow key={`${device.id}|${device.serial}`} {...itemProps(device)} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Sub-modais modularizados */}
      {configTarget && configDevice && (
        <DeviceConfigModal
          isOpen
          onClose={() => setConfigTarget(null)}
          device={configDevice}
          initialTab={configTarget.tab}
          agentStatus={agentFor(configDevice)}
          onRemove={handleRemoveDevice}
          onSave={handleSaveDevice}
          onChipsChanged={(id) => loadChips([id])}
        />
      )}

      <ConnectDeviceModal
        isOpen={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        usbDevices={usbDevices}
        loadingUsb={loadingUsb}
        existingDevices={devicesList}
        onFetchUsb={() => fetchUsbDevices()}
        onForceWirelessAdb={(serial, num, sector, name) => handleForceWirelessAdb(serial, num, sector, name, "modal")}
        onConnectDevice={handleConnectDevice}
        onPairAndConnectDevice={handlePairAndConnectDevice}
        linkingSerial={linkingSerial}
        linkingStatus={linkingStatus}
        nextDeviceNumber={devicesList.reduce((max, d) => Math.max(max, d.deviceNumber || 0), 0) + 1}
      />

      {mirrorTarget && mirrorDevice && (
        <MirrorModal
          isOpen
          onClose={() => setMirrorTarget(null)}
          device={mirrorDevice}
          onOpenRegion={() => {
            setSelectedSerialForRegion(mirrorDevice.serial);
            setRegionModalOpen(true);
          }}
        />
      )}

      <DiagnosticModal isOpen={diagnosticModalOpen} onClose={() => setDiagnosticModalOpen(false)} />

      <ScreenRegionModal isOpen={regionModalOpen} onClose={() => setRegionModalOpen(false)} serial={selectedSerialForRegion} />

      <DeviceIdentityModal
        isOpen={!!identityTarget}
        onClose={() => setIdentityTarget(null)}
        device={identityDevice}
        chips={identityDevice && identityDevice.id > 0 ? chipsByDevice[identityDevice.id] : undefined}
        agentStatus={identityDevice ? agentFor(identityDevice) : undefined}
      />

    </div>
  );
}
