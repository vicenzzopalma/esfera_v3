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
  Activity,
  Eye,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

export default function CollaboratorView() {
  const { user, selectedCompanyId } = useAuth();
  const [assignedDevices, setAssignedDevices] = useState<Device[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestingSerial, setRequestingSerial] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const companyId = selectedCompanyId || user?.companyId || 1;

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
    } catch (err) {
      console.error("Erro ao carregar dados do colaborador:", err);
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

  const getDeviceRequestStatus = (serial: string) => {
    const userReqs = permissionRequests.filter(
      (r) => r.adbDeviceId === serial && r.userId === user?.id
    );
    if (userReqs.length === 0) return null;
    return userReqs[0];
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho da Tela do Colaborador */}
      <div className="bg-gradient-to-r from-blue-900/40 via-purple-900/30 to-slate-900 border border-blue-500/30 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-500/20 border border-blue-500/40 rounded-xl text-blue-400">
              <Smartphone size={32} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  Painel de Uso Exclusivo
                </span>
                <span className="text-xs text-slate-400">| Colaborador: {user?.displayName}</span>
              </div>
              <h1 className="text-2xl font-bold text-white mt-1">Meus Celulares Responsáveis</h1>
              <p className="text-slate-300 text-sm">
                Solicite permissão para utilizar o celular pelo qual você é responsável. O acesso será liberado pelo seu Gestor.
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 text-slate-300 hover:text-white border border-slate-700"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Atualizar Status
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`p-4 rounded-xl border flex items-center gap-3 text-sm font-medium ${
            message.type === "success"
              ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
              : "bg-red-500/15 border-red-500/30 text-red-300"
          }`}
        >
          {message.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Lista de Celulares Atribuídos ao Colaborador */}
      {loading && assignedDevices.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-slate-400">
          <RefreshCw size={32} className="animate-spin text-blue-400 mb-3" />
          <p>Buscando seus celulares atribuídos...</p>
        </div>
      ) : assignedDevices.length === 0 ? (
        <Card className="p-8 text-center border border-slate-800 bg-slate-900/60">
          <Smartphone size={48} className="mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-semibold text-white">Nenhum celular vinculado no momento</h3>
          <p className="text-slate-400 text-sm mt-1 max-w-md mx-auto">
            Você ainda não possui aparelhos atribuídos ao seu usuário. Solicite ao seu Gestor para vincular um celular à sua conta.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {assignedDevices.map((dev) => {
            const req = getDeviceRequestStatus(dev.serial);
            const isApproved = req && req.status === "approved";
            const isPending = req && req.status === "pending";
            const isRejected = req && req.status === "rejected";

            return (
              <Card
                key={dev.serial}
                className={`relative overflow-hidden transition-all duration-300 border ${
                  isApproved
                    ? "border-emerald-500/50 bg-emerald-950/20 shadow-lg shadow-emerald-950/40"
                    : isPending
                    ? "border-amber-500/50 bg-amber-950/20"
                    : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                }`}
              >
                <div className="p-5 space-y-4">
                  {/* Cabeçalho do Card */}
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                        Aparelho #{dev.deviceNumber || 1}
                      </span>
                      <h3 className="text-lg font-bold text-white mt-0.5">{dev.name || dev.model}</h3>
                      <p className="text-xs text-slate-400">{dev.brand} {dev.model} • {dev.serial}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={dev.status === "online" ? "success" : "neutral"}
                        className="capitalize"
                      >
                        {dev.status}
                      </Badge>
                      <span className="text-xs text-slate-400 flex items-center gap-1">
                        <Activity size={12} /> Bateria: {dev.battery}%
                      </span>
                    </div>
                  </div>

                  {/* Status da Permissão de Uso */}
                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-2">
                    <span className="text-xs font-semibold text-slate-400 block uppercase">
                      Status da Permissão:
                    </span>

                    {isApproved ? (
                      <div className="flex items-center gap-2 text-emerald-400 font-medium text-sm">
                        <ShieldCheck size={18} className="text-emerald-400 animate-pulse" />
                        <span>Permissão Concedida pelo Gestor</span>
                      </div>
                    ) : isPending ? (
                      <div className="flex items-center gap-2 text-amber-400 font-medium text-sm">
                        <Clock size={18} className="text-amber-400 animate-spin" />
                        <span>Aguardando Aprovação do Gestor...</span>
                      </div>
                    ) : isRejected ? (
                      <div className="flex items-center gap-2 text-red-400 font-medium text-sm">
                        <ShieldAlert size={18} className="text-red-400" />
                        <span>Solicitação Recusada pelo Gestor</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-slate-400 text-sm">
                        <ShieldAlert size={18} className="text-slate-500" />
                        <span>Acesso Não Solicitado</span>
                      </div>
                    )}

                    {req?.requestedAt && (
                      <p className="text-[11px] text-slate-500">
                        Última solicitação: {new Date(req.requestedAt).toLocaleString("pt-BR")}
                      </p>
                    )}
                  </div>

                  {/* Ações do Colaborador */}
                  <div className="pt-2">
                    {isApproved ? (
                      <div className="space-y-2">
                        <div className="p-3 bg-emerald-500/15 rounded-xl border border-emerald-500/30 text-emerald-300 text-xs flex flex-col gap-1">
                          <div className="flex items-center justify-between font-semibold">
                            <span className="flex items-center gap-1.5">
                              <Zap size={14} /> Celular Autorizado pelo Gestor!
                            </span>
                            <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded-md">Ativo</span>
                          </div>
                          <p className="text-[11px] text-slate-400">
                            🔒 Permissão Restrita: Apenas visualização de tela habilitada. Câmeras e processamento em segundo plano desativados.
                          </p>
                        </div>

                        {/* Botão Único Permitido: Visualizar Tela */}
                        <Button
                          variant="primary"
                          onClick={async () => {
                            try {
                              await api("launch_scrcpy_stream", { serial: dev.serial, turnScreenOff: false });
                              setMessage({ type: "success", text: `Visualização de tela iniciada para ${dev.name || dev.serial}.` });
                            } catch (e: any) {
                              setMessage({ type: "error", text: `Erro ao abrir tela: ${e.toString()}` });
                            }
                          }}
                          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 font-bold py-2.5 shadow-lg shadow-blue-950/40"
                        >
                          <Eye size={18} />
                          Visualizar Tela do Celular
                        </Button>

                        <Button
                          variant="danger"
                          onClick={() => handleEndSession(req.requestId)}
                          className="w-full flex items-center justify-center gap-2 text-xs py-2"
                        >
                          <Power size={14} />
                          Encerrar Uso do Celular
                        </Button>
                      </div>
                    ) : requestingSerial === dev.serial ? (
                      <div className="space-y-3 p-3 bg-slate-800/80 rounded-xl border border-blue-500/40">
                        <label className="text-xs font-semibold text-slate-300 block">
                          Motivo / Observação do Pedido:
                        </label>
                        <input
                          type="text"
                          value={reasonInput}
                          onChange={(e) => setReasonInput(e.target.value)}
                          placeholder="Ex: Realizar testes de campanha WhatsApp..."
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            onClick={() => handleRequestAccess(dev.serial)}
                            disabled={submitting}
                            className="flex-1 text-xs py-2 flex items-center justify-center gap-1.5"
                          >
                            <Send size={14} />
                            {submitting ? "Enviando..." : "Enviar Pedido"}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setRequestingSerial(null)}
                            className="text-xs py-2 text-slate-400"
                          >
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => {
                          setRequestingSerial(dev.serial);
                          setReasonInput("");
                        }}
                        disabled={!!isPending}
                        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 font-semibold shadow-lg shadow-blue-900/30"
                      >
                        <Zap size={16} />
                        {isPending ? "Aguardando Gestor..." : "Pedir Permissão para Usar Celular"}
                      </Button>
                    )}
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
