// ============================================================
// Esfera v3 — Painel de Permissões Granulares (Master Only)
// Gerencia permissões por usuário e por setor
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { invoke } from "@tauri-apps/api/core";
import { MOCK_USERS } from "../mock-data";
import { Shield, Users, Save, RotateCcw, Check, Info } from "lucide-react";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Card from "../components/ui/Card";
import type { Permission, SectorPermission } from "../types";

const PERMISSION_LABELS: Record<string, string> = {
  allow_all_tabs: "Acessar todas as abas",
  allow_edit_devices: "Editar dispositivos",
  allow_manage_users: "Gerenciar usuários",
  allow_dashboard: "Ver dashboard",
  is_active: "Conta ativa",
};

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  allow_edit_devices: "Pode adicionar, remover e gerenciar chips nos dispositivos",
  allow_manage_users: "Pode criar, editar e configurar outros usuários",
  allow_dashboard: "Pode acessar o painel de indicadores",
  allow_all_tabs: "Pode acessar todas as abas do sistema",
  is_active: "Status da conta do usuário",
};

const SECTOR_LABELS: Record<string, string> = {
  junior: "Junior",
  senior: "Senior",
  pesquisa: "Pesquisa",
  pa_fixa_1: "PA Fixa 1",
  pa_fixa_2: "PA Fixa 2",
  comercial: "Comercial",
};

const SECTOR_COLORS: Record<string, string> = {
  junior: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  senior: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  pesquisa: "bg-green-500/20 text-green-300 border-green-500/30",
  pa_fixa_1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  pa_fixa_2: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  comercial: "bg-pink-500/20 text-pink-300 border-pink-500/30",
};

const DEFAULT_PERMISSIONS: Permission[] = [
  { userId: 0, permissionKey: "allow_all_tabs", enabled: true },
  { userId: 0, permissionKey: "allow_edit_devices", enabled: true },
  { userId: 0, permissionKey: "allow_manage_users", enabled: false },
  { userId: 0, permissionKey: "allow_dashboard", enabled: true },
  { userId: 0, permissionKey: "is_active", enabled: true },
];

const DEFAULT_SECTOR_PERMISSIONS: SectorPermission[] = [
  { userId: 0, sector: "junior", canView: true, canConfigure: false },
  { userId: 0, sector: "senior", canView: true, canConfigure: false },
  { userId: 0, sector: "pesquisa", canView: true, canConfigure: false },
  { userId: 0, sector: "pa_fixa_1", canView: true, canConfigure: false },
  { userId: 0, sector: "pa_fixa_2", canView: true, canConfigure: false },
  { userId: 0, sector: "comercial", canView: true, canConfigure: false },
];

export default function PermissionsTab() {
  const { user: currentUser, hasPermission } = useAuth();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"user" | "sectors">("user");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [sectorPermissions, setSectorPermissions] = useState<SectorPermission[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const manageableUsers = MOCK_USERS.filter(
    (u) => u.id !== currentUser?.id && u.role !== "master"
  );

  const loadUserPermissions = useCallback(async (userId: number) => {
    setLoading(true);
    try {
      const [perms, sectorPerms] = await Promise.all([
        invoke<Permission[]>("get_user_permissions", { userId }),
        invoke<SectorPermission[]>("get_sector_permissions", { userId }),
      ]);
      setPermissions(perms.length > 0 ? perms : DEFAULT_PERMISSIONS.map((p) => ({ ...p, userId })));
      setSectorPermissions(sectorPerms.length > 0 ? sectorPerms : DEFAULT_SECTOR_PERMISSIONS.map((sp) => ({ ...sp, userId })));
    } catch {
      setPermissions(DEFAULT_PERMISSIONS.map((p) => ({ ...p, userId })));
      setSectorPermissions(DEFAULT_SECTOR_PERMISSIONS.map((sp) => ({ ...sp, userId })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      loadUserPermissions(Number(selectedUserId));
      setSaved(false);
    }
  }, [selectedUserId, loadUserPermissions]);

  const togglePermission = (key: string) => {
    setPermissions((prev) =>
      prev.map((p) => (p.permissionKey === key ? { ...p, enabled: !p.enabled } : p))
    );
    setSaved(false);
  };

  const toggleSectorPermission = (sector: string, type: "canView" | "canConfigure") => {
    setSectorPermissions((prev) =>
      prev.map((sp) => (sp.sector === sector ? { ...sp, [type]: !sp[type] } : sp))
    );
    setSaved(false);
  };

  const handleSave = async () => {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      for (const perm of permissions) {
        await invoke("update_user_permission", {
          userId: Number(selectedUserId),
          permissionKey: perm.permissionKey,
          enabled: perm.enabled,
        });
      }
      for (const sp of sectorPermissions) {
        await invoke("update_sector_permission", {
          userId: Number(selectedUserId),
          sector: sp.sector,
          canView: sp.canView,
          canConfigure: sp.canConfigure,
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Erro ao salvar permissões:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (selectedUserId) loadUserPermissions(Number(selectedUserId));
  };

  const selectedUser = manageableUsers.find((u) => u.id === Number(selectedUserId));

  if (!hasPermission("allow_manage_users")) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20">
          <Shield size={32} className="text-red-400" />
        </div>
        <h2 className="text-lg font-bold text-primary">Acesso Restrito</h2>
        <p className="text-sm text-tertiary text-center max-w-sm">
          Você não tem permissão para gerenciar permissões de outros usuários.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-primary tracking-tight">Gerenciar Permissões</h2>
          <p className="text-sm text-tertiary mt-1">Controle granular de acesso por usuário e por setor</p>
        </div>
        <Badge variant="purple" className="gap-1">
          <Shield size={12} />
          Master
        </Badge>
      </div>

      {/* Seleção de Usuário */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-primary flex items-center gap-2 mb-3">
          <Users size={16} className="text-violet-400" />
          Selecionar Usuário
        </h3>
        <p className="text-xs text-tertiary mb-3">Escolha o usuário para configurar permissões</p>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="w-full max-w-md px-3 py-2 rounded-xl bg-white/[0.03] border border-border text-sm text-primary focus:outline-none focus:border-violet-500/50"
        >
          <option value="">Selecione um usuário...</option>
          {manageableUsers.map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.displayName} — {u.role === "gestor" ? "Gestor" : "Colaborador"}
            </option>
          ))}
        </select>
      </Card>

      {/* Configurações */}
      {selectedUserId && (
        <>
          {/* Tabs */}
          <div className="flex gap-2 p-1 rounded-xl bg-white/[0.03] border border-border w-fit">
            <button
              onClick={() => setActiveTab("user")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === "user"
                  ? "bg-gradient-to-r from-violet-600/20 to-indigo-600/20 text-violet-300 border border-violet-500/30"
                  : "text-secondary hover:text-primary hover:bg-white/5"
              }`}
            >
              <Shield size={14} />
              Permissões de Usuário
            </button>
            <button
              onClick={() => setActiveTab("sectors")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === "sectors"
                  ? "bg-gradient-to-r from-violet-600/20 to-indigo-600/20 text-violet-300 border border-violet-500/30"
                  : "text-secondary hover:text-primary hover:bg-white/5"
              }`}
            >
              <Users size={14} />
              Permissões por Setor
            </button>
          </div>

          {/* Tab: Permissões de Usuário */}
          {activeTab === "user" && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-primary mb-1">
                Permissões Gerais — {selectedUser?.displayName}
              </h3>
              <p className="text-xs text-tertiary mb-4">Controle o acesso às funcionalidades do sistema</p>

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-3">
                  {permissions.map((perm) => (
                    <div
                      key={perm.permissionKey}
                      className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-border hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${perm.enabled ? "bg-green-400" : "bg-gray-500"}`} />
                        <div>
                          <p className="text-sm font-medium text-primary">
                            {PERMISSION_LABELS[perm.permissionKey] || perm.permissionKey}
                          </p>
                          <p className="text-xs text-tertiary">
                            {PERMISSION_DESCRIPTIONS[perm.permissionKey] || ""}
                          </p>
                        </div>
                      </div>
                      <Toggle
                        checked={perm.enabled}
                        onChange={() => togglePermission(perm.permissionKey)}
                        disabled={perm.permissionKey === "is_active"}
                        size="sm"
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Tab: Permissões por Setor */}
          {activeTab === "sectors" && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-primary mb-1">
                Permissões por Setor — {selectedUser?.displayName}
              </h3>
              <p className="text-xs text-tertiary mb-4">Controle a visualização e configuração de cada setor</p>

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Header */}
                  <div className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 text-xs font-semibold text-tertiary uppercase">
                    <span>Setor</span>
                    <span className="text-center">Visualizar</span>
                    <span className="text-center">Configurar</span>
                  </div>
                  <div className="h-px bg-border" />

                  {sectorPermissions.map((sp) => (
                    <div
                      key={sp.sector}
                      className="grid grid-cols-[1fr_100px_100px] gap-2 items-center p-3 rounded-xl bg-white/[0.02] border border-border hover:bg-white/[0.04] transition-colors"
                    >
                      <Badge
                        variant="neutral"
                        className={`text-xs w-fit ${SECTOR_COLORS[sp.sector] || ""}`}
                      >
                        {SECTOR_LABELS[sp.sector] || sp.sector}
                      </Badge>
                      <div className="flex justify-center">
                        <Toggle
                          checked={sp.canView}
                          onChange={() => toggleSectorPermission(sp.sector, "canView")}
                          size="sm"
                        />
                      </div>
                      <div className="flex justify-center">
                        <Toggle
                          checked={sp.canConfigure}
                          onChange={() => toggleSectorPermission(sp.sector, "canConfigure")}
                          size="sm"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-start gap-2 p-3 rounded-xl bg-violet-500/10 border border-violet-500/20 mt-4">
                <Info size={16} className="text-violet-400 mt-0.5 shrink-0" />
                <p className="text-xs text-violet-300">
                  <strong>Visualizar</strong> permite ver os dispositivos e dados do setor.{" "}
                  <strong>Configurar</strong> permite editar configurações, campanhas e automações do setor.
                </p>
              </div>
            </Card>
          )}

          {/* Botões de Ação */}
          <div className="flex items-center justify-between p-4 rounded-2xl bg-white/[0.02] border border-border">
            <div className="flex items-center gap-2 text-xs text-tertiary">
              {saved ? (
                <>
                  <Check size={14} className="text-green-400" />
                  <span className="text-green-400 font-medium">Salvo com sucesso!</span>
                </>
              ) : (
                <>
                  <RotateCcw size={14} />
                  <span>Alterações não salvas</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleReset}>
                <RotateCcw size={14} />
                Reverter
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                loading={saving}
              >
                <Save size={14} />
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
