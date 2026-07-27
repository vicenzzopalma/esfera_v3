// ============================================================
// Esfera v3 — Central de Gestão de Usuários, Permissões e Celulares
// (Gestor / Master Control Center)
// Gerencia criação de usuários com papéis (Colaborador, Supervisor, Gestor),
// vínculo de celulares e concessão de permissões de uso.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { User, Role, Device, DevicePermissionRequest } from "../types";
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
} from "lucide-react";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Card from "../components/ui/Card";

export default function PermissionsTab() {
  const { user: currentUser, selectedCompanyId } = useAuth();
  const companyId = selectedCompanyId || currentUser?.companyId || 1;

  const [activeSubTab, setActiveSubTab] = useState<"requests" | "users" | "assignments">("requests");
  const [usersList, setUsersList] = useState<User[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<DevicePermissionRequest[]>([]);
  const [companyDevices, setCompanyDevices] = useState<Device[]>([]);
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

  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersData, reqsData, devsData] = await Promise.all([
        api<User[]>("get_users", { companyId }),
        api<DevicePermissionRequest[]>("get_device_permission_requests", { companyId }),
        api<Device[]>("get_devices", { companyId }),
      ]);
      setUsersList(usersData || []);
      setPermissionRequests(reqsData || []);
      setCompanyDevices(devsData || []);
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
      setFeedbackMsg({ type: "success", text: `Usuário '${newDisplayName}' criado como ${newRole.toUpperCase()} com sucesso!` });
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

  const pendingRequests = permissionRequests.filter((r) => r.status === "pending");

  return (
    <div className="space-y-6">
      {/* Cabeçalho do Painel do Gestor */}
      <div className="bg-gradient-to-r from-emerald-900/40 via-teal-900/30 to-slate-900 border border-emerald-500/30 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-emerald-400">
              <Shield size={32} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Central do Gestor
                </span>
                <span className="text-xs text-slate-400">| Concessão de Acesso & Usuários</span>
              </div>
              <h1 className="text-2xl font-bold text-white mt-1">Gestão de Usuários e Permissões</h1>
              <p className="text-slate-300 text-sm">
                Cadastre colaboradores, supervisores e gestores, vincule celulares e gerencie solicitações de acesso.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg shadow-emerald-900/30 font-semibold"
            >
              <UserPlus size={18} />
              Criar Novo Usuário
            </Button>

            <Button
              variant="ghost"
              onClick={loadData}
              disabled={loading}
              className="p-2.5 text-slate-300 border border-slate-700 hover:text-white"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </div>

      {feedbackMsg && (
        <div
          className={`p-4 rounded-xl border flex items-center justify-between text-sm font-medium ${
            feedbackMsg.type === "success"
              ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
              : "bg-red-500/15 border-red-500/30 text-red-300"
          }`}
        >
          <div className="flex items-center gap-3">
            {feedbackMsg.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span>{feedbackMsg.text}</span>
          </div>
          <button onClick={() => setFeedbackMsg(null)} className="text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Navegação entre Sub-Abas do Gestor */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveSubTab("requests")}
          className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-all ${
            activeSubTab === "requests"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              : "text-slate-400 hover:text-white hover:bg-slate-800/50"
          }`}
        >
          <Zap size={16} />
          Solicitações de Acesso
          {pendingRequests.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-amber-500 text-slate-950">
              {pendingRequests.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab("users")}
          className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-all ${
            activeSubTab === "users"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              : "text-slate-400 hover:text-white hover:bg-slate-800/50"
          }`}
        >
          <Users size={16} />
          Usuários do Sistema ({usersList.length})
        </button>

        <button
          onClick={() => setActiveSubTab("assignments")}
          className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-all ${
            activeSubTab === "assignments"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              : "text-slate-400 hover:text-white hover:bg-slate-800/50"
          }`}
        >
          <Link size={16} />
          Vínculo de Celulares
        </button>
      </div>

      {/* CONTEÚDO 1: Solicitações de Acesso dos Colaboradores */}
      {activeSubTab === "requests" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Clock size={20} className="text-emerald-400" />
              Solicitações de Permissão Enviadas pelos Colaboradores
            </h2>
            <span className="text-xs text-slate-400">Total: {permissionRequests.length} solicitações</span>
          </div>

          {permissionRequests.length === 0 ? (
            <Card className="p-8 text-center bg-slate-900/60 border border-slate-800">
              <ShieldCheck size={48} className="mx-auto text-slate-600 mb-3" />
              <h3 className="text-base font-semibold text-white">Nenhuma solicitação no momento</h3>
              <p className="text-xs text-slate-400 mt-1">
                Quando colaboradores pedirem permissão para usar seus celulares vinculados, elas aparecerão aqui em tempo real.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {permissionRequests.map((req) => {
                const isPending = req.status === "pending";
                const isApproved = req.status === "approved";

                return (
                  <Card
                    key={req.requestId}
                    className={`p-5 space-y-4 border transition-all ${
                      isPending
                        ? "border-amber-500/50 bg-amber-950/20 shadow-lg shadow-amber-950/30"
                        : isApproved
                        ? "border-emerald-500/40 bg-emerald-950/20"
                        : "border-slate-800 bg-slate-900/60 opacity-80"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          Colaborador Pedinte
                        </span>
                        <h4 className="text-base font-bold text-white mt-0.5">
                          {req.userDisplayName || req.userName}
                        </h4>
                        <p className="text-xs text-emerald-400 font-mono mt-0.5">
                          Celular: {req.adbDeviceId}
                        </p>
                      </div>

                      <Badge
                        variant={
                          isApproved ? "success" : isPending ? "warning" : "danger"
                        }
                        className="capitalize"
                      >
                        {req.status}
                      </Badge>
                    </div>

                    <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-xs space-y-1">
                      <span className="text-slate-400 font-medium block">Motivo Informado:</span>
                      <p className="text-slate-200 italic">
                        "{req.requestedReason || "Sem observações adicionais"}"
                      </p>
                      <p className="text-[10px] text-slate-500 pt-1">
                        Solicitado em: {new Date(req.requestedAt).toLocaleString("pt-BR")}
                      </p>
                    </div>

                    {/* Botões de Decisão do Gestor */}
                    <div className="pt-1">
                      {isPending ? (
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            variant="primary"
                            onClick={() => handleApproveRequest(req.requestId)}
                            className="bg-emerald-600 hover:bg-emerald-500 text-xs py-2 flex items-center justify-center gap-1 font-semibold"
                          >
                            <Check size={16} />
                            Aprovar
                          </Button>

                          <Button
                            variant="danger"
                            onClick={() => handleRejectRequest(req.requestId)}
                            className="text-xs py-2 flex items-center justify-center gap-1"
                          >
                            <X size={16} />
                            Recusar
                          </Button>
                        </div>
                      ) : isApproved ? (
                        <div className="space-y-2">
                          <p className="text-xs text-emerald-400 font-medium text-center">
                            Aprovado por: {req.approvedByName || "Gestor"}
                          </p>
                          <Button
                            variant="danger"
                            onClick={() => handleEndSession(req.requestId)}
                            className="w-full text-xs py-2 flex items-center justify-center gap-1"
                          >
                            <Power size={14} />
                            Revogar / Encerrar Permissão
                          </Button>
                        </div>
                      ) : (
                        <p className="text-xs text-red-400 text-center font-medium">
                          Solicitação Recusada
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

      {/* CONTEÚDO 2: Lista e Cadastro de Usuários por Role */}
      {activeSubTab === "users" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Users size={20} className="text-emerald-400" />
              Usuários Cadastrados na Empresa
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {usersList.map((u) => (
              <Card key={u.id} className="p-5 border border-slate-800 bg-slate-900/80 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2.5 rounded-xl border ${
                        u.role === "gestor" || u.role === "master"
                          ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                          : u.role === "supervisor"
                          ? "bg-purple-500/20 border-purple-500/40 text-purple-400"
                          : "bg-blue-500/20 border-blue-500/40 text-blue-400"
                      }`}
                    >
                      {u.role === "gestor" || u.role === "master" ? (
                        <Shield size={20} />
                      ) : u.role === "supervisor" ? (
                        <Eye size={20} />
                      ) : (
                        <Users size={20} />
                      )}
                    </div>
                    <div>
                      <h4 className="text-base font-bold text-white">{u.displayName}</h4>
                      <p className="text-xs text-slate-400">@{u.username}</p>
                    </div>
                  </div>

                  <span
                    className={`text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg border ${
                      u.role === "gestor" || u.role === "master"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : u.role === "supervisor"
                        ? "bg-purple-500/15 text-purple-300 border-purple-500/30"
                        : "bg-blue-500/15 text-blue-300 border-blue-500/30"
                    }`}
                  >
                    {u.role}
                  </span>
                </div>

                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-xs space-y-1">
                  <span className="text-slate-400 block font-medium">Permissões de Tela:</span>
                  <p className="text-slate-300">
                    {u.role === "colaborador"
                      ? "Acesso restrito para solicitar uso dos celulares atribuídos."
                      : u.role === "supervisor"
                      ? "Visualiza todos os celulares e monitora colaborador ativo."
                      : "Acesso total ao sistema e central de aprovação do Gestor."}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* CONTEÚDO 3: Vínculo de Celulares aos Colaboradores */}
      {activeSubTab === "assignments" && (
        <div className="space-y-6">
          <Card className="p-6 border border-slate-800 bg-slate-900/80 space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Link size={18} className="text-emerald-400" />
              Vincular Celular a um Colaborador Responsável
            </h3>
            <p className="text-xs text-slate-400">
              Selecione o colaborador e o celular para tornar o colaborador responsável por aquele aparelho.
            </p>

            <form onSubmit={handleAssignDevice} className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Colaborador:
                </label>
                <select
                  value={selectedUserForAssign}
                  onChange={(e) => setSelectedUserForAssign(e.target.value ? Number(e.target.value) : "")}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="">Selecione um usuário...</option>
                  {usersList.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.role})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Celular ADB:
                </label>
                <select
                  value={selectedDeviceForAssign}
                  onChange={(e) => setSelectedDeviceForAssign(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="">Selecione o aparelho...</option>
                  {companyDevices.map((d) => (
                    <option key={d.serial} value={d.serial}>
                      {d.name || d.model} ({d.serial})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={assigning || !selectedUserForAssign || !selectedDeviceForAssign}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs flex items-center justify-center gap-2"
                >
                  <Link size={14} />
                  {assigning ? "Vinculando..." : "Confirmar Vínculo"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* MODAL: Criação de Usuário com Seleção de Tipo (Role Selector) */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-emerald-400">
                  <UserPlus size={24} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Criar Novo Usuário</h3>
                  <p className="text-xs text-slate-400">Escolha a função e credenciais do usuário</p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Nome de Exibição (Ex: João Silva):
                </label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Nome completo do usuário"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Usuário de Login (Username):
                  </label>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="joao.silva"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Senha:
                  </label>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              {/* SELETOR VISUAL DO TIPO DE USUÁRIO / ROLE */}
              <div className="space-y-2 pt-2">
                <label className="text-xs font-semibold text-slate-300 block">
                  Selecione o Tipo de Login / Função:
                </label>

                <div className="grid grid-cols-3 gap-3">
                  {/* Card Colaborador */}
                  <div
                    onClick={() => setNewRole("colaborador")}
                    className={`p-3 rounded-xl border cursor-pointer transition-all space-y-1 ${
                      newRole === "colaborador"
                        ? "bg-blue-500/20 border-blue-500 text-blue-300 shadow-md shadow-blue-950/50"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <Users size={20} className={newRole === "colaborador" ? "text-blue-400" : "text-slate-500"} />
                    <h5 className="text-xs font-bold text-white">Colaborador</h5>
                    <p className="text-[10px] leading-tight text-slate-400">
                      Pede permissão para celulares vinculados.
                    </p>
                  </div>

                  {/* Card Supervisor */}
                  <div
                    onClick={() => setNewRole("supervisor")}
                    className={`p-3 rounded-xl border cursor-pointer transition-all space-y-1 ${
                      newRole === "supervisor"
                        ? "bg-purple-500/20 border-purple-500 text-purple-300 shadow-md shadow-purple-950/50"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <Eye size={20} className={newRole === "supervisor" ? "text-purple-400" : "text-slate-500"} />
                    <h5 className="text-xs font-bold text-white">Supervisor</h5>
                    <p className="text-[10px] leading-tight text-slate-400">
                      Monitora todos os celulares e quem opera.
                    </p>
                  </div>

                  {/* Card Gestor */}
                  <div
                    onClick={() => setNewRole("gestor")}
                    className={`p-3 rounded-xl border cursor-pointer transition-all space-y-1 ${
                      newRole === "gestor"
                        ? "bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950/50"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <Shield size={20} className={newRole === "gestor" ? "text-emerald-400" : "text-slate-500"} />
                    <h5 className="text-xs font-bold text-white">Gestor</h5>
                    <p className="text-[10px] leading-tight text-slate-400">
                      Acesso total + Aprova permissões.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-4 border-t border-slate-800">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={creatingUser}
                  className="flex-1 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 font-semibold text-xs flex items-center justify-center gap-2"
                >
                  <UserPlus size={16} />
                  {creatingUser ? "Criando Usuário..." : "Concluir Cadastro"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowCreateModal(false)}
                  className="py-2.5 text-xs text-slate-400"
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
