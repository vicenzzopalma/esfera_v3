// ============================================================
// Esfera v3 — Tela Exclusiva do Colaborador (CollaboratorView.tsx)
// Exibe dispositivos atribuídos ao colaborador, permite solicitar
// permissão de uso do celular ao Gestor e acompanhar aprovação.
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import { apiErrorText, formatDbDate } from "../hooks/useQueries";
import type { Device, DevicePermissionRequest } from "../types";
import {
  Smartphone,
  ShieldAlert,
  ShieldCheck,
  Clock,
  Zap,
  Send,
  Power,
  RefreshCw,
  AlertCircle,
  Monitor,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import PageHeader from "./ui/PageHeader";
import EmptyState from "./ui/EmptyState";
import Field from "./ui/Field";
import { toast } from "./ui/ToastContainer";
import { StatusDot, BatteryMeter } from "./devices/deviceUi";

const DATA_REFRESH_MS = 8000;

/** Pedido pertence a este aparelho? Compara serial, id Esfera, endereço ou o mesmo IP (sem casar prefixo). */
function requestMatchesDevice(req: DevicePermissionRequest, dev: Device) {
  if (req.adbDeviceId === dev.serial || req.adbDeviceId === dev.esferaDeviceId || req.adbDeviceId === dev.currentAdbAddress) return true;
  if (!dev.currentAdbAddress) return false;
  return req.adbDeviceId.split(":")[0] === dev.currentAdbAddress.split(":")[0];
}

export default function CollaboratorView() {
  const { user, selectedCompanyId } = useAuth();
  const [assignedDevices, setAssignedDevices] = useState<Device[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestingSerial, setRequestingSerial] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [endingId, setEndingId] = useState<number | null>(null);
  const [launchingScrcpy, setLaunchingScrcpy] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const companyId = selectedCompanyId ?? user?.companyId ?? null;

  const handleLaunchScrcpy = async (dev: Device, turnScreenOff: boolean = false) => {
    const devKey = dev.serial;
    const targetSerial = dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
    setLaunchingScrcpy((prev) => ({ ...prev, [devKey]: true }));
    try {
      await api<string>("launch_scrcpy_stream", {
        serial: targetSerial,
        turnScreenOff,
      });
      toast.success(`Espelhamento aberto para ${dev.name || dev.model || dev.serial}.`);
    } catch (err) {
      console.error("Erro ao abrir o espelhamento para o colaborador:", err);
      toast.error("Não foi possível abrir o espelhamento.", {
        description: `Confira se o aparelho está desbloqueado e conectado. (${apiErrorText(err, "erro desconhecido")})`,
      });
    } finally {
      setLaunchingScrcpy((prev) => ({ ...prev, [devKey]: false }));
    }
  };

  const loadData = useCallback(async (showSpinner = false) => {
    if (!user || !companyId) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    if (showSpinner) setLoading(true);
    try {
      const [devices, requests] = await Promise.all([
        api<Device[]>("get_assigned_devices_for_user", {
          userId: user.id,
          companyId,
        }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", {
          companyId,
        }),
      ]);
      if (seq !== seqRef.current) return;
      setAssignedDevices(devices || []);
      // Só os pedidos do próprio colaborador interessam aqui.
      setPermissionRequests((requests || []).filter((r) => r.userId === user.id));
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      console.error("Erro ao carregar dados do colaborador:", err);
      setLoadError(apiErrorText(err, "Não foi possível buscar os seus aparelhos."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [user, companyId]);

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

  const handleRequestAccess = async (serial: string) => {
    setSubmitting(true);
    try {
      await api("request_device_access", {
        deviceSerial: serial,
        reason: reasonInput.trim() || "Uso operacional do colaborador",
      });
      toast.success("Pedido enviado. Aguarde a aprovação do gestor ou do supervisor.");
      setRequestingSerial(null);
      setReasonInput("");
      await loadData(false);
    } catch (err) {
      toast.error(apiErrorText(err, "Não foi possível enviar o pedido."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEndSession = async (requestId: number) => {
    setEndingId(requestId);
    try {
      await api("end_device_access", { requestId });
      toast.success("Uso do aparelho encerrado.");
      await loadData(false);
    } catch (err) {
      toast.error(apiErrorText(err, "Não foi possível encerrar o uso."));
    } finally {
      setEndingId(null);
    }
  };

  // O backend devolve os pedidos do mais novo para o mais antigo: o primeiro é o atual.
  const getDeviceRequestStatus = (dev: Device) => permissionRequests.find((r) => requestMatchesDevice(r, dev)) ?? null;

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Meus aparelhos"
        description="Peça ao gestor ou ao supervisor para usar os aparelhos pelos quais você é responsável."
        icon={<Smartphone size={18} />}
        actions={
          <Button variant="secondary" onClick={() => loadData(true)} loading={loading} icon={<RefreshCw size={14} />}>
            Atualizar
          </Button>
        }
      />

      {loadError && assignedDevices.length > 0 && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-700 dark:text-amber-400">
          <AlertCircle size={15} className="shrink-0" />
          A última atualização falhou; os dados abaixo podem estar desatualizados.
        </p>
      )}

      {loading && assignedDevices.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-56 rounded-xl border border-border bg-card skeleton" />
          ))}
        </div>
      ) : loadError && assignedDevices.length === 0 ? (
        <EmptyState
          icon={<AlertCircle size={18} />}
          title="Não foi possível carregar seus aparelhos"
          description={loadError}
          action={
            <Button variant="secondary" size="sm" onClick={() => loadData(true)} icon={<RefreshCw size={13} />}>
              Tentar novamente
            </Button>
          }
        />
      ) : assignedDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum aparelho vinculado"
          description="Você ainda não tem aparelhos atribuídos. Peça ao gestor para vincular um aparelho à sua conta."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {assignedDevices.map((dev) => {
            const req = getDeviceRequestStatus(dev);
            const isApproved = req?.status === "approved" || req?.status === "active";
            const isPending = req?.status === "pending";
            const isRejected = req?.status === "rejected";

            return (
              <Card
                key={dev.serial}
                className={isApproved ? "!border-emerald-500/50" : isPending ? "!border-amber-500/50" : ""}
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-primary">{dev.name || dev.model}</h3>
                      <p className="truncate text-[0.75rem] text-secondary">
                        {dev.deviceNumber ? `#${dev.deviceNumber} · ` : ""}
                        {dev.brand} {dev.model}
                      </p>
                      <p className="truncate font-mono text-[0.6875rem] text-tertiary">{dev.serial}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusDot status={dev.status} />
                      <BatteryMeter level={dev.battery} />
                    </div>
                  </div>

                  <div className="space-y-1 rounded-lg bg-secondary p-3">
                    <p className="text-[0.75rem] text-secondary">Permissão de uso</p>
                    {isApproved ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck size={16} /> Liberada{req?.approvedByName ? ` por ${req.approvedByName}` : ""}
                      </p>
                    ) : isPending ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-amber-600 dark:text-amber-400">
                        <Clock size={16} /> Aguardando aprovação
                      </p>
                    ) : isRejected ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-red-600 dark:text-red-400">
                        <ShieldAlert size={16} /> Pedido recusado
                      </p>
                    ) : (
                      <p className="flex items-center gap-2 text-[0.8125rem] text-secondary">
                        <ShieldAlert size={16} /> {req?.status === "ended" ? "Uso encerrado" : "Não solicitada"}
                      </p>
                    )}
                    {req?.requestedAt && (
                      <p className="text-[0.75rem] text-tertiary">Último pedido: {formatDbDate(req.requestedAt)}</p>
                    )}
                  </div>

                  {isApproved && req ? (
                    <div className="space-y-2">
                      <p className="text-[0.75rem] text-secondary">Acesso restrito: apenas visualização da tela. Câmeras e processamento em segundo plano ficam desativados.</p>
                      <Button
                        variant="primary"
                        size="md"
                        loading={!!launchingScrcpy[dev.serial]}
                        onClick={() => handleLaunchScrcpy(dev, false)}
                        icon={<Monitor size={14} />}
                        className="w-full"
                      >
                        {launchingScrcpy[dev.serial] ? "Abrindo..." : "Espelhar tela"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={launchingScrcpy[dev.serial]}
                        onClick={() => handleLaunchScrcpy(dev, true)}
                        icon={<Smartphone size={13} />}
                        className="w-full"
                        title="Abre o espelhamento no computador com a tela física do aparelho apagada"
                      >
                        Espelhar com a tela do aparelho apagada
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={endingId === req.requestId}
                        onClick={() => handleEndSession(req.requestId)}
                        icon={<Power size={13} />}
                        className="w-full"
                      >
                        Encerrar uso do aparelho
                      </Button>
                    </div>
                  ) : requestingSerial === dev.serial ? (
                    <div className="space-y-3">
                      <Field label="Motivo do pedido" htmlFor={`reason-${dev.serial}`} hint="Opcional. Ajuda o gestor a decidir.">
                        <input
                          id={`reason-${dev.serial}`}
                          type="text"
                          value={reasonInput}
                          onChange={(e) => setReasonInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !submitting) handleRequestAccess(dev.serial);
                          }}
                          placeholder="Ex.: Atendimento dos retornos de hoje"
                          autoFocus
                        />
                      </Field>
                      <div className="flex items-center gap-2">
                        <Button variant="primary" size="sm" onClick={() => handleRequestAccess(dev.serial)} loading={submitting} icon={<Send size={13} />} className="flex-1">
                          {submitting ? "Enviando..." : "Enviar pedido"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRequestingSerial(null)} disabled={submitting}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      size="md"
                      onClick={() => {
                        setRequestingSerial(dev.serial);
                        setReasonInput("");
                      }}
                      disabled={!!isPending}
                      icon={<Zap size={14} />}
                      className="w-full"
                    >
                      {isPending ? "Aguardando aprovação" : isRejected ? "Pedir de novo" : "Pedir permissão de uso"}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
