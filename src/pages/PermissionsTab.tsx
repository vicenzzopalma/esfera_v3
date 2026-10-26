// ============================================================
// Esfera v3 — Usuários e permissões
// Cadastro de usuários por função, vínculo de aparelhos e pedidos de acesso.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { User, Role, Device, DevicePermissionRequest, DeviceAssignmentInfo } from "../types";
import {
  Shield,
  Users,
  UserPlus,
  Check,
  X,
  Clock,
  Zap,
  Power,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Eye,
  ShieldCheck,
  Link,
  Unlink,
  Smartphone,
  Search,
} from "lucide-react";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import Field, { FormSection } from "../components/ui/Field";
import { Tabs } from "../components/ui/Tabs";

export default function PermissionsTab() {
  const { user: currentUser, selectedCompanyId } = useAuth();
  const companyId = selectedCompanyId || currentUser?.companyId || 1;

  const [activeSubTab, setActiveSubTab] = useState<"requests" | "users" | "assignments">("requests");
  const [usersList, setUsersList] = useState<User[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [companyDevices, setCompanyDevices] = useState<Device[]>([]);
  const [assignmentsList, setAssignmentsList] = useState<DeviceAssignmentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Formulário de Criação de Usuário
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<Role>("colaborador");
  const [creatingUser, setCreatingUser] = useState(false);

  // Vínculo de Celular
  const [selectedUserForAssign, setSelectedUserForAssign] = useState<number | "">("");
  const [selectedDeviceForAssign, setSelectedDeviceForAssign] = useState<string>("");
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState<number | null>(null);

  const [userSearch, setUserSearch] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; confirmLabel: string; run: () => void | Promise<void> } | null>(null);

  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersData, reqsData, devsData, assignData] = await Promise.all([
        api<User[]>("get_users", { companyId }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId }),
        api<Device[]>("get_devices", { companyId }),
        api<DeviceAssignmentInfo[]>("get_all_device_assignments", { companyId }),
      ]);
      setUsersList(usersData || []);
      setPermissionRequests(reqsData || []);
      setCompanyDevices(devsData || []);
      setAssignmentsList(assignData || []);
    } catch (err) {
      console.error("Erro ao carregar dados de permissões:", err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword || !newDisplayName) {
      setFeedbackMsg({ type: "error", text: "Preencha todos os campos obrigatórios." });
      return;
    }
    setCreatingUser(true);
    setFeedbackMsg(null);
    try {
      await api("create_user", {
        username: newUsername,
        password: newPassword,
        displayName: newDisplayName,
        role: newRole,
        companyId,
      });
      setFeedbackMsg({ type: "success", text: `Usuário '${newDisplayName}' criado com sucesso.` });
      setShowCreateModal(false);
      setNewUsername("");
      setNewPassword("");
      setNewDisplayName("");
      setNewRole("colaborador");
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Falha ao criar usuário." });
    } finally {
      setCreatingUser(false);
    }
  };

  const handleApproveRequest = async (requestId: number) => {
    try {
      await api("approve_device_access", { requestId });
      setFeedbackMsg({ type: "success", text: "Permissão concedida ao colaborador!" });
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Erro ao aprovar solicitação." });
    }
  };

  const handleRejectRequest = async (requestId: number) => {
    try {
      await api("reject_device_access", { requestId });
      setFeedbackMsg({ type: "success", text: "Solicitação recusada." });
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Erro ao rejeitar solicitação." });
    }
  };

  const handleEndSession = async (requestId: number) => {
    try {
      await api("end_device_access", { requestId });
      setFeedbackMsg({ type: "success", text: "Sessão de uso do celular encerrada." });
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Erro ao encerrar sessão." });
    }
  };

  const handleAssignDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserForAssign || !selectedDeviceForAssign) return;
    setAssigning(true);
    try {
      await api("assign_device_to_user", {
        deviceSerial: selectedDeviceForAssign,
        userId: Number(selectedUserForAssign),
      });
      setFeedbackMsg({ type: "success", text: "Celular vinculado ao colaborador com sucesso!" });
      setSelectedDeviceForAssign("");
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Erro ao vincular celular." });
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassignDevice = async (assignment: DeviceAssignmentInfo) => {
    setUnassigning(assignment.assignmentId);
    try {
      await api("unassign_device_from_user", {
        deviceSerial: assignment.adbDeviceId,
        userId: assignment.userId,
      });
      setFeedbackMsg({ type: "success", text: `Vínculo removido com sucesso.` });
      await loadData();
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err.toString() || "Erro ao desvincular celular." });
    } finally {
      setUnassigning(null);
    }
  };


  const pendingRequests = permissionRequests.filter((r) => r.status === "pending");
  const approvedRequests = permissionRequests.filter((r) => r.status === "approved");

  const roleLabel = (r: string) =>
    r === "master" ? "Master" : r === "gestor" ? "Gestor" : r === "supervisor" ? "Supervisor" : "Colaborador";
  const roleVariant = (r: string): "success" | "purple" | "info" =>
    r === "gestor" || r === "master" ? "success" : r === "supervisor" ? "purple" : "info";
  const roleDescription = (r: string) =>
    r === "colaborador"
      ? "Solicita o uso dos aparelhos atribuídos."
      : r === "supervisor"
      ? "Vê todos os aparelhos e monitora quem opera."
      : "Acesso total e aprovação de permissões.";
  const statusLabel = (s: string) => (s === "approved" ? "Aprovada" : s === "pending" ? "Pendente" : s === "rejected" ? "Recusada" : s);

  const normalizedUserSearch = userSearch.trim().toLowerCase();
  const filteredUsers = usersList.filter(
    (u) =>
      !normalizedUserSearch ||
      u.displayName.toLowerCase().includes(normalizedUserSearch) ||
      u.username.toLowerCase().includes(normalizedUserSearch) ||
      u.role.toLowerCase().includes(normalizedUserSearch)
  );

  const roleOptions: { id: Role; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: "colaborador", label: "Colaborador", desc: "Pede permissão para usar os aparelhos vinculados.", icon: <Users size={18} /> },
    { id: "supervisor", label: "Supervisor", desc: "Monitora todos os aparelhos e quem os opera.", icon: <Eye size={18} /> },
    { id: "gestor", label: "Gestor", desc: "Acesso total e aprova permissões.", icon: <Shield size={18} /> },
  ];

  const runConfirm = async () => {
    if (!confirmAction) return;
    const action = confirmAction.run;
    setConfirmAction(null);
    await action();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Usuários e permissões"
        description="Cadastre usuários, vincule aparelhos e aprove pedidos de acesso."
        icon={<Shield size={18} />}
        actions={
          <>
            <Button variant="secondary" onClick={loadData} disabled={loading} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>
              Atualizar
            </Button>
            <Button onClick={() => setShowCreateModal(true)} icon={<UserPlus size={15} />}>
              Novo usuário
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Pedidos pendentes" value={pendingRequests.length} icon={<Clock size={14} />} tone={pendingRequests.length > 0 ? "warning" : "neutral"} />
        <StatCard label="Acessos liberados" value={approvedRequests.length} icon={<ShieldCheck size={14} />} tone="success" />
        <StatCard label="Usuários" value={usersList.length} icon={<Users size={14} />} tone="accent" />
        <StatCard label="Aparelhos vinculados" value={assignmentsList.length} icon={<Smartphone size={14} />} tone="info" />
      </div>

      {feedbackMsg && (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[0.8125rem] ${
            feedbackMsg.type === "success"
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400"
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            {feedbackMsg.type === "success" ? <CheckCircle2 size={15} className="shrink-0" /> : <AlertCircle size={15} className="shrink-0" />}
            <span className="break-words">{feedbackMsg.text}</span>
          </span>
          <button onClick={() => setFeedbackMsg(null)} aria-label="Fechar aviso" className="shrink-0 cursor-pointer">
            <X size={15} />
          </button>
        </div>
      )}

      <Tabs
        value={activeSubTab}
        onChange={setActiveSubTab}
        items={[
          { id: "requests", label: "Pedidos de acesso", icon: <Zap size={14} />, count: pendingRequests.length },
          { id: "users", label: "Usuários", icon: <Users size={14} />, count: usersList.length },
          { id: "assignments", label: "Aparelhos vinculados", icon: <Link size={14} />, count: assignmentsList.length },
        ]}
      />

      {/* Pedidos de acesso */}
      {activeSubTab === "requests" && (
        loading && permissionRequests.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 rounded-xl border border-border bg-card skeleton" />
            ))}
          </div>
        ) : permissionRequests.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={18} />}
            title="Nenhum pedido de acesso"
            description="Quando um colaborador pedir para usar um aparelho vinculado, o pedido aparece aqui."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {permissionRequests.map((req) => {
              const isPending = req.status === "pending";
              const isApproved = req.status === "approved";
              const who = req.userDisplayName || req.userName;

              return (
                <Card key={req.requestId} padding="md" className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-primary truncate">{who}</h4>
                      <p className="mt-0.5 text-xs text-tertiary font-mono truncate">Aparelho {req.adbDeviceId}</p>
                    </div>
                    <Badge variant={isApproved ? "success" : isPending ? "warning" : "danger"} dot>
                      {statusLabel(req.status)}
                    </Badge>
                  </div>

                  <div className="rounded-lg border border-border bg-secondary p-3 text-xs space-y-1">
                    <p className="text-primary">{req.requestedReason || "Sem motivo informado."}</p>
                    <p className="text-tertiary">Pedido em {new Date(req.requestedAt).toLocaleString("pt-BR")}</p>
                  </div>

                  <div className="mt-auto">
                    {isPending ? (
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="success" size="sm" icon={<Check size={14} />} onClick={() => handleApproveRequest(req.requestId)}>
                          Aprovar
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<X size={14} />}
                          onClick={() =>
                            setConfirmAction({
                              title: "Recusar pedido",
                              message: `O pedido de ${who} para usar o aparelho ${req.adbDeviceId} será recusado.`,
                              confirmLabel: "Recusar",
                              run: () => handleRejectRequest(req.requestId),
                            })
                          }
                        >
                          Recusar
                        </Button>
                      </div>
                    ) : isApproved ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-secondary">Aprovado por {req.approvedByName || "Gestor"}</span>
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Power size={13} />}
                          onClick={() =>
                            setConfirmAction({
                              title: "Encerrar acesso",
                              message: `${who} perderá o acesso ao aparelho ${req.adbDeviceId} imediatamente.`,
                              confirmLabel: "Encerrar acesso",
                              run: () => handleEndSession(req.requestId),
                            })
                          }
                        >
                          Encerrar acesso
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-tertiary">Pedido recusado.</p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* Usuários */}
      {activeSubTab === "users" && (
        <div className="space-y-4">
          <div className="relative max-w-md flex items-center">
            <Search size={16} className="input-icon-left text-tertiary" />
            <input
              type="text"
              aria-label="Buscar usuário"
              placeholder="Buscar por nome, login ou função"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="w-full input-with-icon-left"
            />
          </div>

          {loading && usersList.length === 0 ? (
            <div className="h-40 rounded-xl border border-border bg-card skeleton" />
          ) : filteredUsers.length === 0 ? (
            <EmptyState
              icon={<Users size={18} />}
              title={usersList.length === 0 ? "Nenhum usuário cadastrado" : "Nenhum usuário encontrado"}
              description={usersList.length === 0 ? "Crie o primeiro usuário da empresa." : "Revise o termo buscado."}
              action={
                usersList.length === 0 ? (
                  <Button icon={<UserPlus size={15} />} onClick={() => setShowCreateModal(true)}>Novo usuário</Button>
                ) : (
                  <Button variant="secondary" onClick={() => setUserSearch("")}>Limpar busca</Button>
                )
              }
            />
          ) : (
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border text-xs text-tertiary">
                      <th className="px-4 py-2.5 font-medium">Usuário</th>
                      <th className="px-4 py-2.5 font-medium">Login</th>
                      <th className="px-4 py-2.5 font-medium">Função</th>
                      <th className="px-4 py-2.5 font-medium">Permissões</th>
                      <th className="px-4 py-2.5 font-medium text-right">Aparelhos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-[0.8125rem]">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-hover transition-colors">
                        <td className="px-4 py-3 font-medium text-primary">{u.displayName}</td>
                        <td className="px-4 py-3 font-mono text-xs text-secondary">@{u.username}</td>
                        <td className="px-4 py-3">
                          <Badge variant={roleVariant(u.role)}>{roleLabel(u.role)}</Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-secondary">{roleDescription(u.role)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">
                          {assignmentsList.filter((a) => a.userId === u.id).length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Vínculo de aparelhos */}
      {activeSubTab === "assignments" && (
        <div className="space-y-6">
          <Card padding="md">
            <FormSection title="Vincular aparelho" description="O usuário escolhido passa a ser responsável pelo aparelho.">
              <form onSubmit={handleAssignDevice} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <Field label="Usuário" htmlFor="assign-user">
                  <select
                    id="assign-user"
                    value={selectedUserForAssign}
                    onChange={(e) => setSelectedUserForAssign(e.target.value ? Number(e.target.value) : "")}
                  >
                    <option value="">Selecione um usuário</option>
                    {usersList.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} ({roleLabel(u.role)})
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Aparelho" htmlFor="assign-device">
                  <select
                    id="assign-device"
                    value={selectedDeviceForAssign}
                    onChange={(e) => setSelectedDeviceForAssign(e.target.value)}
                  >
                    <option value="">Selecione o aparelho</option>
                    {companyDevices.map((d) => (
                      <option key={d.serial} value={d.serial}>
                        {d.name || d.model} ({d.serial})
                      </option>
                    ))}
                  </select>
                </Field>

                <Button
                  type="submit"
                  icon={<Link size={14} />}
                  loading={assigning}
                  disabled={!selectedUserForAssign || !selectedDeviceForAssign}
                >
                  {assigning ? "Vinculando..." : "Vincular"}
                </Button>
              </form>
            </FormSection>
          </Card>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-primary">Vínculos atuais ({assignmentsList.length})</h2>

            {assignmentsList.length === 0 ? (
              <EmptyState
                icon={<Smartphone size={18} />}
                title="Nenhum aparelho vinculado"
                description="Use o formulário acima para atribuir um aparelho a um usuário."
              />
            ) : (
              <Card padding="none">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-border text-xs text-tertiary">
                        <th className="px-4 py-2.5 font-medium">Aparelho</th>
                        <th className="px-4 py-2.5 font-medium">Serial</th>
                        <th className="px-4 py-2.5 font-medium">Responsável</th>
                        <th className="px-4 py-2.5 font-medium text-right">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border text-[0.8125rem]">
                      {assignmentsList.map((a) => {
                        const deviceLabel = a.deviceName || a.model || a.adbDeviceId;
                        const owner = a.userDisplayName || a.userName;
                        return (
                          <tr key={a.assignmentId} className="hover:bg-hover transition-colors">
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center gap-2 font-medium text-primary">
                                <Smartphone size={14} className="text-tertiary" />
                                {deviceLabel}
                                {a.deviceNumber ? <span className="text-xs font-normal text-tertiary">#{a.deviceNumber}</span> : null}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-secondary">{a.adbDeviceId}</td>
                            <td className="px-4 py-3 text-secondary">{owner}</td>
                            <td className="px-4 py-3 text-right">
                              <Button
                                variant="danger"
                                size="sm"
                                loading={unassigning === a.assignmentId}
                                icon={<Unlink size={12} />}
                                onClick={() =>
                                  setConfirmAction({
                                    title: "Desvincular aparelho",
                                    message: `${deviceLabel} deixará de estar vinculado a ${owner}.`,
                                    confirmLabel: "Desvincular",
                                    run: () => handleUnassignDevice(a),
                                  })
                                }
                              >
                                Desvincular
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Novo usuário */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Novo usuário"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setShowCreateModal(false)}>
              Cancelar
            </Button>
            <Button type="submit" form="create-user-form" loading={creatingUser} icon={<UserPlus size={15} />}>
              {creatingUser ? "Criando..." : "Criar usuário"}
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={handleCreateUser} className="space-y-4">
          <Field label="Nome" required htmlFor="new-display">
            <input
              id="new-display"
              type="text"
              required
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="Nome completo"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Login" required htmlFor="new-username">
              <input
                id="new-username"
                type="text"
                required
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="joao.silva"
              />
            </Field>
            <Field label="Senha" required htmlFor="new-password">
              <input
                id="new-password"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Senha de acesso"
              />
            </Field>
          </div>

          <Field label="Função">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Função do usuário">
              {roleOptions.map((opt) => {
                const selected = newRole === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setNewRole(opt.id)}
                    className={`rounded-lg border p-3 text-left transition-colors cursor-pointer ${
                      selected
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)]"
                        : "border-border hover:border-border-strong"
                    }`}
                  >
                    <span className={selected ? "text-[var(--color-accent-light)]" : "text-tertiary"}>{opt.icon}</span>
                    <span className="mt-1.5 block text-[0.8125rem] font-medium text-primary">{opt.label}</span>
                    <span className="mt-0.5 block text-xs text-tertiary leading-snug">{opt.desc}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        </form>
      </Modal>

      {/* Confirmação de ações destrutivas */}
      <Modal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.title || ""}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmAction(null)}>Cancelar</Button>
            <Button variant="danger" onClick={runConfirm}>{confirmAction?.confirmLabel}</Button>
          </>
        }
      >
        <p className="text-[0.8125rem] text-secondary">{confirmAction?.message}</p>
      </Modal>
    </div>
  );
}
