import React, { useState, useEffect } from "react";
import { User, DeviceWithActiveUser } from "../types";
import { UserCheck, UserX, ShieldAlert, Smartphone, CheckCircle, Clock } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface DeviceAssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: DeviceWithActiveUser | null;
  users: User[];
  token: string;
  onRefresh: () => void;
}

export const DeviceAssignmentModal: React.FC<DeviceAssignmentModalProps> = ({
  isOpen,
  onClose,
  device,
  users,
  token,
  onRefresh,
}) => {
  const [selectedUserId, setSelectedUserId] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    if (device?.assignedUserId) {
      setSelectedUserId(device.assignedUserId);
    } else {
      setSelectedUserId("");
    }
    setMessage(null);
    setReason("");
  }, [device]);

  if (!isOpen || !device) return null;

  const handleAssignResponsible = async () => {
    if (!selectedUserId) {
      setMessage({ text: "Selecione um colaborador da lista.", type: "error" });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await invoke("set_device_responsible_collaborator", {
        token,
        deviceSerial: device.serial,
        userId: Number(selectedUserId),
      });
      setMessage({ text: "Colaborador atribuído como responsável com sucesso!", type: "success" });
      onRefresh();
    } catch (err: any) {
      setMessage({ text: String(err), type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveResponsible = async () => {
    if (!device.assignedUserId && !selectedUserId) return;
    setLoading(true);
    setMessage(null);
    try {
      const userIdToRemove = device.assignedUserId || Number(selectedUserId);
      await invoke("remove_device_responsible_collaborator", {
        token,
        deviceSerial: device.serial,
        userId: userIdToRemove,
      });
      setMessage({ text: "Vínculo de responsabilidade removido.", type: "success" });
      setSelectedUserId("");
      onRefresh();
    } catch (err: any) {
      setMessage({ text: String(err), type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAccess = async () => {
    setLoading(true);
    setMessage(null);
    try {
      await invoke("request_device_access", {
        token,
        deviceSerial: device.serial,
        reason: reason || "Solicitação de acesso direto pelo painel de dispositivos",
      });
      setMessage({ text: "Solicitação enviada ao Gestor com sucesso!", type: "success" });
      onRefresh();
    } catch (err: any) {
      setMessage({ text: String(err), type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="px-6 py-5 bg-gradient-to-r from-slate-900 via-emerald-950/30 to-slate-900 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-100">Vínculo de Responsabilidade</h3>
              <p className="text-xs text-slate-400 font-mono">
                {device.name || `Celular #${device.deviceNumber}`} ({device.serial})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6">
          {message && (
            <div
              className={`p-3.5 rounded-xl border text-sm flex items-center space-x-2 ${
                message.type === "success"
                  ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-950/40 border-rose-500/30 text-rose-300"
              }`}
            >
              {message.type === "success" ? (
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              )}
              <span>{message.text}</span>
            </div>
          )}

          {/* Estado Atual do Celular */}
          <div className="bg-slate-950/60 border border-slate-800/60 rounded-xl p-4 space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Responsável Atual:</span>
              <span className="font-medium text-emerald-400">
                {device.assignedUserName || device.responsibleUserName || "Nenhum responsável atribuído"}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Operador Ativo no Momento:</span>
              <span className="font-medium text-cyan-400">
                {device.activeUserDisplayName || device.activeUserName || "Nenhum"}
              </span>
            </div>
          </div>

          {/* Seleção de Colaborador Responsável (Gestor) */}
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Atribuir Colaborador Responsável pelo Celular
            </label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value ? Number(e.target.value) : "")}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition-colors"
            >
              <option value="">Selecione um Colaborador...</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.username} ({u.role})
                </option>
              ))}
            </select>

            <div className="flex space-x-3 pt-1">
              <button
                onClick={handleAssignResponsible}
                disabled={loading || !selectedUserId}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium px-4 py-2.5 rounded-xl text-sm transition-all shadow-lg shadow-emerald-950/30 flex items-center justify-center space-x-2"
              >
                <UserCheck className="w-4 h-4" />
                <span>Salvar Responsável</span>
              </button>

              {device.assignedUserId && (
                <button
                  onClick={handleRemoveResponsible}
                  disabled={loading}
                  className="bg-slate-800 hover:bg-rose-950/60 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-slate-300 font-medium px-4 py-2.5 rounded-xl text-sm transition-all flex items-center space-x-2"
                >
                  <UserX className="w-4 h-4" />
                  <span>Desvincular</span>
                </button>
              )}
            </div>
          </div>

          <div className="border-t border-slate-800 pt-5 space-y-3">
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Ou Enviar Solicitação de Pedido de Uso ao Gestor
            </label>
            <input
              type="text"
              placeholder="Motivo do pedido (ex: Campanha Vendas SP)..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <button
              onClick={handleRequestAccess}
              disabled={loading}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium px-4 py-2.5 rounded-xl text-sm transition-all border border-slate-700 flex items-center justify-center space-x-2"
            >
              <Clock className="w-4 h-4 text-cyan-400" />
              <span>Enviar Pedido de Uso</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
