// ============================================================
// Esfera v3 — Usuários e permissões
// Cadastro de usuários por função, vínculo de aparelhos e pedidos de acesso.
// ============================================================

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import { apiErrorText, formatDbDate } from "../hooks/useQueries";
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
  Building2,
  Minus,
} from "lucide-react";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import Field, { FormSection } from "../components/ui/Field";
import { Tabs, SegmentedControl } from "../components/ui/Tabs";

type RequestFilter = "pending" | "approved" | "history";

const REQUEST_STATUS: Record<string, { label: string; variant: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  pending: { label: "Pendente", variant: "warning" },
  approved: { label: "Liberado", variant: "success" },
  active: { label: "Em uso", variant: "success" },
  rejected: { label: "Recusado", variant: "danger" },
  ended: { label: "Encerrado", variant: "neutral" },
};

// O que cada função pode fazer hoje (rotas de App.tsx, menu lateral e travas do backend).
type Access = true | false | string;
const ROLE_MATRIX: { role: Role; label: string; items: Access[] }[] = [
  { role: "master", label: "Master", items: [true, true, true, true, true, "Ver e limpar", true] },
  { role: "gestor", label: "Gestor", items: [true, true, true, true, true, "Ver e limpar", true] },
  { role: "supervisor", label: "Supervisor", items: [true, "Supervisão de todos", false, false, false, "Ver", true] },
  { role: "colaborador", label: "Colaborador", items: [false, "Só os vinculados, com pedido de uso", false, false, false, "Ver", false] },
];
const ROLE_MATRIX_COLUMNS = ["Dashboard", "Aparelhos", "Campanhas e automações", "Usuários", "Configurações", "Logs", "Aprova pedidos de uso"];

const roleLabel = (r: string) =>
  r === "master" ? "Master" : r === "gestor" ? "Gestor" : r === "supervisor" ? "Supervisor" : "Colaborador";
const roleVariant = (r: string): "success" | "purple" | "info" =>
  r === "gestor" || r === "master" ? "success" : r === "supervisor" ? "purple" : "info";
const roleDescription = (r: string) =>
  r === "colaborador"
    ? "Pede para usar os aparelhos vinculados a ele."
    : r === "supervisor"
    ? "Acompanha todos os aparelhos e aprova pedidos de uso."
    : r === "master"
    ? "Acesso total, em todas as empresas."
    : "Acesso total à empresa: campanhas, usuários e configurações.";

/** Erros conhecidos do backend em português claro. */
function friendlyError(err: unknown, fallback: string) {
  const text = apiErrorText(err, fallback);
  if (/UNIQUE constraint failed: ESF_User\.Username/i.test(text)) return "Já existe um usuário com esse login.";
  return text;
}

export default function PermissionsTab() {
  const { user: currentUser, selectedCompanyId } = useAuth();
  const navigate = useNavigate();
  // Master sem empresa escolhida não cai mais, sem aviso, na empresa 1.
  const companyId = selectedCompanyId ?? currentUser?.companyId ?? null;

  const [activeSubTab, setActiveSubTab] = useState<"requests" | "users" | "assignments">("requests");
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("pending");
  const [usersList, setUsersList] = useState<User[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [companyDevices, setCompanyDevices] = useState<Device[]>([]);
  const [assignmentsList, setAssignmentsList] = useState<DeviceAssignmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Formulário de Criação de Usuário
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<Role>("colaborador");
  const [creatingUser, setCreatingUser] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSubmitted, setCreateSubmitted] = useState(false);

  // Vínculo de Celular
  const [selectedUserForAssign, setSelectedUserForAssign] = useState<number | "">("");
  const [selectedDeviceForAssign, setSelectedDeviceForAssign] = useState<string>("");
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState<number | null>(null);
  const [busyRequest, setBusyRequest] = useState<number | null>(null);

  const [userSearch, setUserSearch] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; confirmLabel: string; danger?: boolean; run: () => void | Promise<void> } | null>(null);

  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Respostas atrasadas (de outra empresa ou de leitura antiga) são descartadas.
  const seqRef = useRef(0);
  const companyRef = useRef(companyId);
  companyRef.current = companyId;

  const loadData = useCallback(async (showSpinner = true) => {
    if (!companyId) return;
    const seq = ++seqRef.current;
    if (showSpinner) setLoading(true);
    try {
      const [usersData, reqsData, devsData, assignData] = await Promise.all([
        api<User[]>("get_users", { companyId }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId }),
        api<Device[]>("get_devices", { companyId }),
        api<DeviceAssignmentInfo[]>("get_all_device_assignments", { companyId }),
      ]);
      if (seq !== seqRef.current) return;
      setUsersList(usersData || []);
      setPermissionRequests(reqsData || []);
      setCompanyDevices(devsData || []);
      setAssignmentsList(assignData || []);
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoadError(apiErrorText(err, "Não foi possível carregar usuários e pedidos."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [companyId]);

  // Só os pedidos mudam com frequência: são relidos a cada 10 s (pausado com a janela minimizada).
  const refreshRequests = useCallback(async () => {
    if (!companyId || document.hidden) return;
    try {
      const reqs = await api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId });
      if (companyRef.current === companyId) setPermissionRequests(reqs || []);
    } catch {
      /* silencioso: a leitura completa mostra o erro */
    }
  }, [companyId]);

  useEffect(() => {
    setUsersList([]);
    setPermissionRequests([]);
    setCompanyDevices([]);
    setAssignmentsList([]);
    setLoadError(null);
    loadData(true);
    const interval = setInterval(refreshRequests, 10_000);
    return () => {
      seqRef.current++;
      clearInterval(interval);
    };
  }, [loadData, refreshRequests]);

  const findDevice = (adbDeviceId: string) => {
    const host = adbDeviceId.split(":")[0];
    return (
      companyDevices.find((d) => d.serial === adbDeviceId || d.esferaDeviceId === adbDeviceId || d.currentAdbAddress === adbDeviceId) ||
      companyDevices.find((d) => !!d.currentAdbAddress && d.currentAdbAddress.split(":")[0] === host)
    );
  };

  /** Nome do aparelho dado pelo operador (soberano); o serial só como último recurso. */
  const deviceLabel = (adbDeviceId: string) => {
    const d = findDevice(adbDeviceId);
    if (!d) return adbDeviceId;
    const name = d.name && d.name.trim() ? d.name.trim() : d.model || d.serial;
    return d.deviceNumber ? `${name} · #${d.deviceNumber}` : name;
  };

  const resetCreateForm = () => {
    setNewUsername("");
    setNewPassword("");
    setNewDisplayName("");
    setNewRole("colaborador");
    setCreateError(null);
    setCreateSubmitted(false);
  };

  const trimmedUsername = newUsername.trim();
  const createErrors = {
    name: !newDisplayName.trim() ? "Informe o nome." : undefined,
    username: !trimmedUsername
      ? "Informe o login."
      : /\s/.test(trimmedUsername)
      ? "O login não pode ter espaços."
      : usersList.some((u) => u.username.toLowerCase() === trimmedUsername.toLowerCase())
      ? "Já existe um usuário com esse login nesta empresa."
      : undefined,
    password: newPassword.length < 6 ? "Use ao menos 6 caracteres." : undefined,
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateSubmitted(true);
    if (createErrors.name || createErrors.username || createErrors.password || !companyId) return;
    setCreatingUser(true);
    setCreateError(null);
    try {
      await api("create_user", {
        username: trimmedUsername,
        password: newPassword,
        displayName: newDisplayName.trim(),
        role: newRole,
        companyId,
      });
      setFeedbackMsg({ type: "success", text: `Usuário ${newDisplayName.trim()} criado.` });
      setShowCreateModal(false);
      resetCreateForm();
      await loadData(false);
    } catch (err) {
      setCreateError(friendlyError(err, "Não foi possível criar o usuário."));
    } finally {
      setCreatingUser(false);
    }
  };

  const runRequestAction = async (requestId: number, action: () => Promise<unknown>, success: string, failure: string) => {
    setBusyRequest(requestId);
    setFeedbackMsg(null);
    try {
      await action();
      setFeedbackMsg({ type: "success", text: success });
      await loadData(false);
    } catch (err) {
      setFeedbackMsg({ type: "error", text: friendlyError(err, failure) });
    } finally {
      setBusyRequest(null);
    }
  };

  const handleApproveRequest = (requestId: number) =>
    runRequestAction(requestId, () => api("approve_device_access", { requestId }), "Uso do aparelho liberado.", "Não foi possível aprovar o pedido.");
  const handleRejectRequest = (requestId: number) =>
    runRequestAction(requestId, () => api("reject_device_access", { requestId }), "Pedido recusado.", "Não foi possível recusar o pedido.");
  const handleEndSession = (requestId: number) =>
    runRequestAction(requestId, () => api("end_device_access", { requestId }), "Acesso ao aparelho encerrado.", "Não foi possível encerrar o acesso.");

  const handleAssignDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserForAssign || !selectedDeviceForAssign) return;
    setAssigning(true);
    setFeedbackMsg(null);
    try {
      await api("assign_device_to_user", {
        deviceSerial: selectedDeviceForAssign,
        userId: Number(selectedUserForAssign),
      });
      setFeedbackMsg({ type: "success", text: "Aparelho vinculado ao usuário." });
      setSelectedDeviceForAssign("");
      await loadData(false);
    } catch (err) {
      setFeedbackMsg({ type: "error", text: friendlyError(err, "Não foi possível vincular o aparelho.") });
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassignDevice = async (assignment: DeviceAssignmentInfo) => {
    setUnassigning(assignment.assignmentId);
    setFeedbackMsg(null);
    try {
      await api("unassign_device_from_user", {
        deviceSerial: assignment.adbDeviceId,
        userId: assignment.userId,
      });
      setFeedbackMsg({ type: "success", text: "Vínculo removido." });
      await loadData(false);
    } catch (err) {
      setFeedbackMsg({ type: "error", text: friendlyError(err, "Não foi possível desvincular o aparelho.") });
    } finally {
      setUnassigning(null);
    }
  };

  const pendingRequests = permissionRequests.filter((r) => r.status === "pending");
  const approvedRequests = permissionRequests.filter((r) => r.status === "approved" || r.status === "active");
  const historyRequests = permissionRequests.filter((r) => r.status === "rejected" || r.status === "ended");
  const visibleRequests =
    requestFilter === "pending" ? pendingRequests : requestFilter === "approved" ? approvedRequests : historyRequests;

  const normalizedUserSearch = userSearch.trim().toLowerCase();
  const filteredUsers = usersList.filter(
    (u) =>
      !normalizedUserSearch ||
      u.displayName.toLowerCase().includes(normalizedUserSearch) ||
      u.username.toLowerCase().includes(normalizedUserSearch) ||
      roleLabel(u.role).toLowerCase().includes(normalizedUserSearch)
  );

  const roleOptions: { id: Role; label: string; desc: string; icon: ReactNode }[] = [
    { id: "colaborador", label: "Colaborador", desc: roleDescription("colaborador"), icon: <Users size={18} /> },
    { id: "supervisor", label: "Supervisor", desc: roleDescription("supervisor"), icon: <Eye size={18} /> },
    { id: "gestor", label: "Gestor", desc: roleDescription("gestor"), icon: <Shield size={18} /> },
  ];

  const runConfirm = async () => {
    if (!confirmAction) return;
    const action = confirmAction.run;
    setConfirmAction(null);
    await action();
  };

  if (!companyId) {
    return (
      <EmptyState
        className="mt-10"
        icon={<Building2 size={18} />}
        title="Escolha uma empresa"
        description="Usuários, vínculos e pedidos de acesso são de cada empresa. Entre em uma empresa para gerenciá-los."
        action={
          <Button size="sm" onClick={() => navigate("/companies")}>
            Ver empresas
          </Button>
        }
      />
    );
  }

  const accessCell = (v: Access) =>
    v === true ? (
      <Check size={15} className="text-emerald-600 dark:text-emerald-400" aria-label="Sim" />
    ) : v === false ? (
      <Minus size={15} className="text-tertiary" aria-label="Não" />
    ) : (
      <span className="text-xs text-secondary">{v}</span>
    );

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Usuários e permissões"
        description="Cadastre usuários, vincule aparelhos e aprove pedidos de acesso."
        icon={<Shield size={18} />}
        actions={
          <>
            <Button variant="secondary" onClick={() => loadData(true)} disabled={loading} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>
              Atualizar
            </Button>
            <Button onClick={() => { resetCreateForm(); setShowCreateModal(true); }} icon={<UserPlus size={15} />}>
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

      {loadError && !loading && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-[0.8125rem] text-red-600 dark:text-red-400">
          <span className="flex min-w-0 items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span className="break-words">{loadError}</span>
          </span>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => loadData(true)}>
            Tentar de novo
          </Button>
        </div>
      )}

      {feedbackMsg && (
        <div
          role={feedbackMsg.type === "error" ? "alert" : "status"}
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
        <div className="space-y-4">
          <SegmentedControl
            value={requestFilter}
            onChange={setRequestFilter}
            items={[
              { id: "pending", label: "Pendentes", count: pendingRequests.length },
              { id: "approved", label: "Liberados", count: approvedRequests.length },
              { id: "history", label: "Histórico", count: historyRequests.length },
            ]}
          />

          {loading && permissionRequests.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-40 rounded-xl border border-border bg-card skeleton" />
              ))}
            </div>
          ) : visibleRequests.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={18} />}
              title={
                requestFilter === "pending"
                  ? "Nenhum pedido pendente"
                  : requestFilter === "approved"
                  ? "Nenhum acesso liberado agora"
                  : "Sem histórico de pedidos"
              }
              description={
                requestFilter === "pending"
                  ? "Quando um colaborador pedir para usar um aparelho vinculado, o pedido aparece aqui."
                  : requestFilter === "approved"
                  ? "Os acessos aprovados e ainda em uso aparecem aqui."
                  : "Pedidos recusados e acessos encerrados aparecem aqui."
              }
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleRequests.map((req) => {
                const isPending = req.status === "pending";
                const isApproved = req.status === "approved" || req.status === "active";
                const who = req.userDisplayName || req.userName || "Usuário";
                const device = deviceLabel(req.adbDeviceId);
                const status = REQUEST_STATUS[req.status] ?? { label: req.status, variant: "neutral" as const };
                const busy = busyRequest === req.requestId;
                // Aprovar encerra o acesso de quem já usa o mesmo aparelho (regra do backend).
                const currentHolder = isPending
                  ? permissionRequests.find(
                      (r) => (r.status === "approved" || r.status === "active") && r.adbDeviceId === req.adbDeviceId && r.requestId !== req.requestId
                    )
                  : undefined;

                return (
                  <Card key={req.requestId} padding="md" className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-primary truncate">{who}</h4>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-secondary truncate" title={req.adbDeviceId}>
                          <Smartphone size={12} className="shrink-0 text-tertiary" />
                          {device}
                        </p>
                      </div>
                      <Badge variant={status.variant} dot>
                        {status.label}
                      </Badge>
                    </div>

                    <div className="rounded-lg border border-border bg-secondary p-3 text-xs space-y-1">
                      <p className="text-primary break-words">{req.requestedReason || "Sem motivo informado."}</p>
                      <p className="text-tertiary">Pedido em {formatDbDate(req.requestedAt)}</p>
                    </div>

                    <div className="mt-auto">
                      {isPending ? (
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            variant="success"
                            size="sm"
                            icon={<Check size={14} />}
                            loading={busy}
                            disabled={busyRequest !== null}
                            onClick={() =>
                              currentHolder
                                ? setConfirmAction({
                                    title: "Aprovar pedido",
                                    message: `${currentHolder.userDisplayName || currentHolder.userName || "Outro usuário"} está usando ${device}. Aprovar encerra esse acesso e libera o aparelho para ${who}.`,
                                    confirmLabel: "Aprovar",
                                    run: () => handleApproveRequest(req.requestId),
                                  })
                                : handleApproveRequest(req.requestId)
                            }
                          >
                            Aprovar
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<X size={14} />}
                            disabled={busyRequest !== null}
                            onClick={() =>
                              setConfirmAction({
                                title: "Recusar pedido",
                                message: `O pedido de ${who} para usar ${device} será recusado.`,
                                confirmLabel: "Recusar",
                                danger: true,
                                run: () => handleRejectRequest(req.requestId),
                              })
                            }
                          >
                            Recusar
                          </Button>
                        </div>
                      ) : isApproved ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 text-xs text-secondary">
                            Aprovado por {req.approvedByName || "gestor"}
                            {req.approvedAt && <span className="block text-tertiary">{formatDbDate(req.approvedAt)}</span>}
                          </span>
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<Power size={13} />}
                            loading={busy}
                            disabled={busyRequest !== null}
                            onClick={() =>
                              setConfirmAction({
                                title: "Encerrar acesso",
                                message: `${who} perderá o acesso a ${device} imediatamente.`,
                                confirmLabel: "Encerrar acesso",
                                danger: true,
                                run: () => handleEndSession(req.requestId),
                              })
                            }
                          >
                            Encerrar acesso
                          </Button>
                        </div>
                      ) : (
                        <p className="text-xs text-tertiary">
                          {req.status === "rejected" ? "Pedido recusado" : "Acesso encerrado"}
                          {req.endedAt ? ` em ${formatDbDate(req.endedAt)}` : ""}.
                        </p>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Usuários */}
      {activeSubTab === "users" && (
        <div className="space-y-4">
          <Card padding="none">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-primary">O que cada função pode fazer</h2>
              <p className="mt-0.5 text-xs text-tertiary">Master também gerencia todas as empresas.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border text-xs text-tertiary">
                    <th className="px-4 py-2 font-medium">Função</th>
                    {ROLE_MATRIX_COLUMNS.map((c) => (
                      <th key={c} className="px-3 py-2 font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border text-[0.8125rem]">
                  {ROLE_MATRIX.map((row) => (
                    <tr key={row.role}>
                      <td className="px-4 py-2">
                        <Badge variant={roleVariant(row.role)}>{row.label}</Badge>
                      </td>
                      {row.items.map((v, i) => (
                        <td key={ROLE_MATRIX_COLUMNS[i]} className="px-3 py-2 align-middle">
                          {accessCell(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

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
                  <Button icon={<UserPlus size={15} />} onClick={() => { resetCreateForm(); setShowCreateModal(true); }}>Novo usuário</Button>
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
                      <th className="px-4 py-2.5 font-medium">O que faz</th>
                      <th className="px-4 py-2.5 font-medium text-right">Aparelhos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-[0.8125rem]">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-hover transition-colors">
                        <td className="px-4 py-3 font-medium text-primary">
                          {u.displayName}
                          {u.id === currentUser?.id && <span className="ml-1.5 text-xs font-normal text-tertiary">(você)</span>}
                        </td>
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
            <FormSection title="Vincular aparelho" description="O usuário escolhido passa a ser responsável pelo aparelho e pode pedir para usá-lo.">
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
                        {d.name || d.model}
                        {d.deviceNumber ? ` · #${d.deviceNumber}` : ""} ({d.serial})
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

            {loading && assignmentsList.length === 0 ? (
              <div className="h-32 rounded-xl border border-border bg-card skeleton" />
            ) : assignmentsList.length === 0 ? (
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
                        const label = a.deviceName || a.model || a.adbDeviceId;
                        const owner = a.userDisplayName || a.userName || "Usuário";
                        return (
                          <tr key={a.assignmentId} className="hover:bg-hover transition-colors">
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center gap-2 font-medium text-primary">
                                <Smartphone size={14} className="text-tertiary" />
                                {label}
                                {a.deviceNumber ? <span className="text-xs font-normal text-tertiary">#{a.deviceNumber}</span> : null}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-tertiary">{a.adbDeviceId}</td>
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
                                    message: `${label} deixará de estar vinculado a ${owner}.`,
                                    confirmLabel: "Desvincular",
                                    danger: true,
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
        onClose={() => { if (!creatingUser) setShowCreateModal(false); }}
        title="Novo usuário"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setShowCreateModal(false)} disabled={creatingUser}>
              Cancelar
            </Button>
            <Button type="submit" form="create-user-form" loading={creatingUser} icon={<UserPlus size={15} />}>
              {creatingUser ? "Criando..." : "Criar usuário"}
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={handleCreateUser} className="space-y-4" noValidate>
          {createError && (
            <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400 break-words">
              {createError}
            </p>
          )}

          <Field label="Nome" required htmlFor="new-display" error={createSubmitted ? createErrors.name : undefined}>
            <input
              id="new-display"
              type="text"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="Nome completo"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Login" required htmlFor="new-username" error={createSubmitted || trimmedUsername ? createErrors.username : undefined}>
              <input
                id="new-username"
                type="text"
                autoComplete="off"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="joao.silva"
              />
            </Field>
            <Field
              label="Senha"
              required
              htmlFor="new-password"
              hint="Ao menos 6 caracteres."
              error={createSubmitted ? createErrors.password : undefined}
            >
              <input
                id="new-password"
                type="password"
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

      {/* Confirmação de ações */}
      <Modal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.title || ""}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmAction(null)}>Cancelar</Button>
            <Button variant={confirmAction?.danger ? "danger" : "primary"} onClick={runConfirm}>{confirmAction?.confirmLabel}</Button>
          </>
        }
      >
        <p className="text-[0.8125rem] text-secondary">{confirmAction?.message}</p>
      </Modal>
    </div>
  );
}
