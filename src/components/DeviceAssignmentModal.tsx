import React, { useState, useEffect } from "react";
import { User, DeviceWithActiveUser } from "../types";
import { UserCheck, UserX, ShieldAlert, Smartphone, CheckCircle, Clock } from "lucide-react";
import { api } from "../tauri";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import Field, { FormSection } from "./ui/Field";
import { inputCls, errorText } from "./devices/deviceUi";

interface DeviceAssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: DeviceWithActiveUser | null;
  users: User[];
  // Mantido por compatibilidade: as chamadas usam a sessão atual do app (api).
  token?: string;
  onRefresh: () => void;
}

export const DeviceAssignmentModal: React.FC<DeviceAssignmentModalProps> = ({
  isOpen,
  onClose,
  device,
  users,
  onRefresh,
}) => {
  const [selectedUserId, setSelectedUserId] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Só zera o formulário ao abrir ou trocar de aparelho: a atualização periódica da lista
  // cria um objeto novo e antes apagava a escolha e a mensagem de sucesso.
  const deviceSerial = device?.serial;
  const assignedUserId = device?.assignedUserId;
  useEffect(() => {
    setMessage(null);
    setReason("");
  }, [deviceSerial, isOpen]);
  useEffect(() => {
    setSelectedUserId(assignedUserId || "");
  }, [deviceSerial, assignedUserId, isOpen]);

  if (!isOpen || !device) return null;

  const handleAssignResponsible = async () => {
    if (!selectedUserId) {
      setMessage({ text: "Selecione um colaborador da lista.", type: "error" });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await api("set_device_responsible_collaborator", {
        deviceSerial: device.serial,
        userId: Number(selectedUserId),
      });
      setMessage({ text: "Responsável salvo.", type: "success" });
      onRefresh();
    } catch (err: any) {
      setMessage({ text: errorText(err, "Não foi possível salvar o responsável."), type: "error" });
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
      await api("remove_device_responsible_collaborator", {
        deviceSerial: device.serial,
        userId: userIdToRemove,
      });
      setMessage({ text: "Responsável desvinculado.", type: "success" });
      setSelectedUserId("");
      onRefresh();
    } catch (err: any) {
      setMessage({ text: errorText(err, "Não foi possível desvincular o responsável."), type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAccess = async () => {
    setLoading(true);
    setMessage(null);
    try {
      await api("request_device_access", {
        deviceSerial: device.serial,
        reason: reason || "Pedido de acesso feito na tela de aparelhos",
      });
      setMessage({ text: "Pedido enviado ao gestor.", type: "success" });
      onRefresh();
    } catch (err: any) {
      setMessage({ text: errorText(err, "Não foi possível enviar o pedido."), type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const msgBox = message && (
    <div
      role={message.type === "error" ? "alert" : "status"}
      className={`flex items-center gap-2 rounded-lg border p-3 text-[0.8125rem] ${
        message.type === "success"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
      }`}
    >
      {message.type === "success" ? <CheckCircle className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 break-words">{message.text}</span>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Responsável pelo aparelho"
      size="md"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">{device.name || `Aparelho #${device.deviceNumber}`}</h3>
            <p className="truncate font-mono text-[0.75rem] text-tertiary">{device.serial}</p>
          </div>
        </div>

        {msgBox}

        <div className="divide-y divide-border rounded-xl border border-border px-4 text-[0.8125rem]">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <span className="text-secondary">Responsável atual</span>
            <span className="truncate font-medium text-primary">
              {device.assignedUserName || device.responsibleUserName || "Nenhum"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <span className="text-secondary">Em uso agora por</span>
            <span className="truncate font-medium text-primary">
              {device.activeUserDisplayName || device.activeUserName || "Ninguém"}
            </span>
          </div>
        </div>

        <FormSection title="Atribuir responsável" description="O colaborador escolhido passa a responder por este aparelho.">
          <Field label="Colaborador" htmlFor="assign-user">
            <select
              id="assign-user"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value ? Number(e.target.value) : "")}
              className={inputCls}
            >
              <option value="">Selecione um colaborador</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.username} ({u.role})
                </option>
              ))}
            </select>
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={handleAssignResponsible} disabled={!selectedUserId || selectedUserId === device.assignedUserId} loading={loading} icon={<UserCheck className="h-4 w-4" />}>
              Salvar responsável
            </Button>
            {device.assignedUserId && (
              <Button variant="danger" size="sm" onClick={handleRemoveResponsible} disabled={loading} icon={<UserX className="h-4 w-4" />}>
                Desvincular
              </Button>
            )}
          </div>
        </FormSection>

        <FormSection title="Pedir uso ao gestor" description="Envie uma solicitação de acesso a este aparelho.">
          <Field label="Motivo" htmlFor="assign-reason">
            <input
              id="assign-reason"
              type="text"
              placeholder="Ex.: Campanha de vendas SP"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Button variant="secondary" size="sm" onClick={handleRequestAccess} loading={loading} icon={<Clock className="h-4 w-4" />}>
            Enviar pedido de uso
          </Button>
        </FormSection>
      </div>
    </Modal>
  );
};
