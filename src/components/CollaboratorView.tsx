// ============================================================
// Esfera v3 — Tela Exclusiva do Colaborador (CollaboratorView.tsx)
// Exibe dispositivos atribuídos ao colaborador, permite solicitar
// permissão de uso do celular ao Gestor e acompanhar aprovação.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
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
  CheckCircle2,
  AlertCircle,
  Monitor,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import PageHeader from "./ui/PageHeader";
import EmptyState from "./ui/EmptyState";
import Field from "./ui/Field";
import { inputCls, StatusDot, BatteryMeter } from "./devices/deviceUi";

export default function CollaboratorView() {
  const { user, selectedCompanyId } = useAuth();
  const [assignedDevices, setAssignedDevices] = useState<Device[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestingSerial, setRequestingSerial] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [launchingScrcpy, setLaunchingScrcpy] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const companyId = selectedCompanyId || user?.companyId || 1;

  const handleLaunchScrcpy = async (dev: Device, turnScreenOff: boolean = false) => {
    const devKey = dev.serial;
    const targetSerial = dev.currentAdbAddress || dev.serial || dev.esferaDeviceId || "";
    setLaunchingScrcpy((prev) => ({ ...prev, [devKey]: true }));
    setMessage(null);
    try {
      const res = await api<string>("launch_scrcpy_stream", {
        serial: targetSerial,
        turnScreenOff,
      });
      setMessage({
        type: "success",
        text: `Espelhamento aberto para ${dev.name || dev.model || dev.serial}. (${res})`,
      });
    } catch (err: any) {
      console.error("Erro ao iniciar Scrcpy para o colaborador:", err);
      const errMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
      setMessage({
        type: "error",
        text: `Falha ao abrir o espelhamento: ${errMsg}`,
      });
    } finally {
      setLaunchingScrcpy((prev) => ({ ...prev, [devKey]: false }));
    }
  };

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
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
      setAssignedDevices(devices || []);
      setPermissionRequests(requests || []);
      setLoadError(null);
    } catch (err: any) {
      console.error("Erro ao carregar dados do colaborador:", err);
      setLoadError(typeof err === "string" ? err : err?.message || "Falha ao buscar os dados.");
    } finally {
      setLoading(false);
    }
  }, [user, companyId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRequestAccess = async (serial: string) => {
    setSubmitting(true);
    setMessage(null);
    try {
      await api("request_device_access", {
        deviceSerial: serial,
        reason: reasonInput || "Uso operacional do colaborador",
      });
      setMessage({ type: "success", text: "Solicitação enviada com sucesso ao Gestor!" });
      setRequestingSerial(null);
      setReasonInput("");
      await loadData();
    } catch (err: any) {
      setMessage({ type: "error", text: err.toString() || "Falha ao solicitar permissão." });
    } finally {
      setSubmitting(false);
    }
  };

  const handleEndSession = async (requestId: number) => {
    try {
      await api("end_device_access", { requestId });
      setMessage({ type: "success", text: "Sessão encerrada com sucesso." });
      await loadData();
    } catch (err: any) {
      setMessage({ type: "error", text: err.toString() || "Erro ao encerrar sessão." });
    }
  };

  const getDeviceRequestStatus = (dev: Device) => {
    const userReqs = permissionRequests.filter(
      (r) =>
        r.userId === user?.id &&
        (r.adbDeviceId === dev.serial ||
          r.adbDeviceId === dev.esferaDeviceId ||
          r.adbDeviceId === dev.currentAdbAddress ||
          (dev.currentAdbAddress && r.adbDeviceId.includes(dev.currentAdbAddress.split(":")[0])))
    );
    if (userReqs.length === 0) return null;
    return userReqs[0];
  };

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <PageHeader
        title="Meus celulares"
        description="Peça permissão ao gestor para usar o celular pelo qual você é responsável."
        icon={<Smartphone size={18} />}
        actions={
          <Button variant="secondary" onClick={loadData} loading={loading} icon={<RefreshCw size={14} />}>
            Atualizar
          </Button>
        }
      />

      {message && (
        <div
          role={message.type === "error" ? "alert" : "status"}
          className={`flex items-center gap-2.5 rounded-lg border p-3 text-[0.8125rem] ${
            message.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
          }`}
        >
          {message.type === "success" ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}
          <span className="min-w-0 break-words">{message.text}</span>
        </div>
      )}

      {loading && assignedDevices.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : loadError && assignedDevices.length === 0 ? (
        <EmptyState
          icon={<AlertCircle size={18} />}
          title="Não foi possível carregar seus celulares"
          description={loadError}
          action={
            <Button variant="secondary" size="sm" onClick={loadData} icon={<RefreshCw size={13} />}>
              Tentar novamente
            </Button>
          }
        />
      ) : assignedDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum celular vinculado"
          description="Você ainda não tem aparelhos atribuídos. Peça ao gestor para vincular um celular à sua conta."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {assignedDevices.map((dev) => {
            const req = getDeviceRequestStatus(dev);
            const isApproved = req && req.status === "approved";
            const isPending = req && req.status === "pending";
            const isRejected = req && req.status === "rejected";

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
                        #{dev.deviceNumber || 1} · {dev.brand} {dev.model}
                      </p>
                      <p className="truncate font-mono text-[0.6875rem] text-tertiary">{dev.serial}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusDot status={dev.status} />
                      <BatteryMeter level={dev.battery} />
                    </div>
                  </div>

                  <div className="space-y-1 rounded-lg bg-secondary/60 p-3">
                    <p className="text-[0.75rem] text-secondary">Permissão de uso</p>
                    {isApproved ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck size={16} /> Concedida pelo gestor
                      </p>
                    ) : isPending ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-amber-600 dark:text-amber-400">
                        <Clock size={16} /> Aguardando aprovação
                      </p>
                    ) : isRejected ? (
                      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-red-600 dark:text-red-400">
                        <ShieldAlert size={16} /> Recusada pelo gestor
                      </p>
                    ) : (
                      <p className="flex items-center gap-2 text-[0.8125rem] text-secondary">
                        <ShieldAlert size={16} /> Não solicitada
                      </p>
                    )}
                    {req?.requestedAt && (
                      <p className="text-[0.75rem] text-tertiary">Última solicitação: {new Date(req.requestedAt).toLocaleString("pt-BR")}</p>
                    )}
                  </div>

                  {isApproved ? (
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
                        title="Abre o espelhamento no computador com a tela física do celular apagada"
                      >
                        Espelhar com a tela do celular apagada
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => handleEndSession(req.requestId)} icon={<Power size={13} />} className="w-full">
                        Encerrar uso do celular
                      </Button>
                    </div>
                  ) : requestingSerial === dev.serial ? (
                    <div className="space-y-3">
                      <Field label="Motivo do pedido" htmlFor={`reason-${dev.serial}`}>
                        <input
                          id={`reason-${dev.serial}`}
                          type="text"
                          value={reasonInput}
                          onChange={(e) => setReasonInput(e.target.value)}
                          placeholder="Ex.: Testes de campanha no WhatsApp"
                          className={inputCls}
                        />
                      </Field>
                      <div className="flex items-center gap-2">
                        <Button variant="primary" size="sm" onClick={() => handleRequestAccess(dev.serial)} loading={submitting} icon={<Send size={13} />} className="flex-1">
                          {submitting ? "Enviando..." : "Enviar pedido"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRequestingSerial(null)}>
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
                      {isPending ? "Aguardando gestor" : "Pedir permissão de uso"}
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
