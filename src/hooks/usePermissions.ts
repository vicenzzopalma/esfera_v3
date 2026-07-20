// ============================================================
// Esfera v3 — Hook de Permissões Granulares
// Facilita verificação de permissões em qualquer componente
// ============================================================

import { useAuth } from "../context/AuthContext";

export function usePermissions() {
  const { user, permissions, sectorPermissions, hasPermission, hasSectorPermission } = useAuth();

  const isMaster = user?.role === "master";
  const isGestor = user?.role === "gestor";
  const isColaborador = user?.role === "colaborador";

  const canEditDevices = hasPermission("allow_edit_devices");
  const canManageUsers = hasPermission("allow_manage_users");
  const canAccessDashboard = hasPermission("allow_dashboard");
  const canSeeAllTabs = hasPermission("allow_all_tabs");
  const isActive = hasPermission("is_active");

  const canViewSector = (sector: string) => hasSectorPermission(sector, "view");
  const canConfigureSector = (sector: string) => hasSectorPermission(sector, "configure");

  return {
    user,
    isMaster,
    isGestor,
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
