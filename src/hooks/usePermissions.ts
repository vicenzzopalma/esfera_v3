// ============================================================
// Esfera v3 — Hook de Permissões Granulares
// Facilita verificação de permissões em qualquer componente
// ============================================================

import { useAuth } from "../context/AuthContext";
import type { Role } from "../types";

// Padrão de cada função quando o usuário não tem linha em ESF_Permission.
// Usuários criados pela tela não recebem linhas; sem este padrão, um gestor ou
// supervisor novo via "Acesso restrito" no Dashboard que o menu e a rota liberam.
// Uma linha explícita no banco sempre prevalece sobre o padrão.
const ROLE_DEFAULTS: Record<Role, Record<string, boolean>> = {
  master: { allow_all_tabs: true, allow_edit_devices: true, allow_manage_users: true, allow_dashboard: true, is_active: true },
  gestor: { allow_all_tabs: true, allow_edit_devices: true, allow_manage_users: true, allow_dashboard: true, is_active: true },
  supervisor: { allow_all_tabs: false, allow_edit_devices: false, allow_manage_users: false, allow_dashboard: true, is_active: true },
  colaborador: { allow_all_tabs: false, allow_edit_devices: false, allow_manage_users: false, allow_dashboard: false, is_active: true },
};

export function usePermissions() {
  const { user, permissions, sectorPermissions, hasPermission, hasSectorPermission } = useAuth();

  const isMaster = user?.role === "master";
  const isGestor = user?.role === "gestor";
  const isSupervisor = user?.role === "supervisor";
  const isColaborador = user?.role === "colaborador";

  /** Permissão efetiva: master tudo; senão a linha do banco; sem linha, o padrão da função. */
  const allows = (key: string): boolean => {
    if (!user) return false;
    if (isMaster) return true;
    const explicit = permissions.find((p) => p.permissionKey === key);
    if (explicit) return explicit.enabled;
    return ROLE_DEFAULTS[user.role]?.[key] ?? false;
  };

  const canEditDevices = allows("allow_edit_devices");
  const canManageUsers = allows("allow_manage_users");
  const canAccessDashboard = allows("allow_dashboard");
  const canSeeAllTabs = allows("allow_all_tabs");
  const isActive = allows("is_active");

  const canViewSector = (sector: string) => hasSectorPermission(sector, "view");
  const canConfigureSector = (sector: string) => hasSectorPermission(sector, "configure");

  return {
    user,
    isMaster,
    isGestor,
    isSupervisor,
    isColaborador,
    permissions,
    sectorPermissions,
    canEditDevices,
    canManageUsers,
    canAccessDashboard,
    canSeeAllTabs,
    isActive,
    canViewSector,
    canConfigureSector,
    hasPermission,
    hasSectorPermission,
  } as const;
}
