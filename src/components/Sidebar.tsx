// ============================================================
// Esfera v3 — Sidebar Lateral com Permissões Granulares
// Filtra itens de navegação por role E permissões do usuário
// ============================================================

import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import { api } from "../tauri";
import type { Company } from "../types";
import {
  Smartphone,
  Megaphone,
  Bot,
  ScrollText,
  Settings,
  Building2,
  LogOut,
  ChevronLeft,
  BarChart3,
  Users,
  ShieldAlert,
} from "lucide-react";

interface NavGroup {
  groupName: string;
  items: {
    id: string;
    path: string;
    label: string;
    icon: React.ReactNode;
    roles: string[];
    requiresCompany: boolean;
    permissionKey?: string;
    badge?: string;
  }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    groupName: "Operações",
    items: [
      {
        id: "dashboard",
        path: "/dashboard",
        label: "Dashboard",
        icon: <BarChart3 size={16} />,
        roles: ["master", "gestor", "supervisor"],
        requiresCompany: true,
      },
      {
        id: "devices",
        path: "/devices",
        label: "Aparelhos",
        icon: <Smartphone size={16} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
      {
        id: "supervisor-devices",
        path: "/devices",
        label: "Supervisão",
        icon: <ShieldAlert size={16} />,
        roles: ["supervisor"],
        requiresCompany: true,
      },
      {
        id: "collaborator-station",
        path: "/devices",
        label: "Minha estação",
        icon: <Smartphone size={16} />,
        roles: ["colaborador"],
        requiresCompany: true,
      },
      {
        id: "campaigns",
        path: "/campaigns",
        label: "Campanhas",
        icon: <Megaphone size={16} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
      {
        id: "automations",
        path: "/automations",
        label: "Automações",
        icon: <Bot size={16} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
    ],
  },
  {
    groupName: "Gestão",
    items: [
      {
        id: "companies",
        path: "/companies",
        label: "Empresas",
        icon: <Building2 size={16} />,
        roles: ["master"],
        requiresCompany: false,
      },
      {
        id: "permissions",
        path: "/permissions",
        label: "Usuários e permissões",
        icon: <Users size={16} />,
        roles: ["master", "gestor"],
        requiresCompany: false,
      },
    ],
  },
  {
    groupName: "Sistema",
    items: [
      {
        id: "logs",
        path: "/logs",
        label: "Logs",
        icon: <ScrollText size={16} />,
        roles: ["master", "gestor", "supervisor", "colaborador"],
        requiresCompany: true,
      },
      {
        id: "settings",
        path: "/settings",
        label: "Configurações",
        icon: <Settings size={16} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
    ],
  },
];

export default function Sidebar() {
  const { user, selectedCompanyId, leaveCompany, logout } = useAuth();
  const { hasPermission } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();

  // Mesma consulta do Header e da StatusBar (cache compartilhado).
  const companiesQuery = useQuery({
    queryKey: ["companies"],
    queryFn: () => api<Company[]>("get_companies"),
    staleTime: 60_000,
  });
  const companies = companiesQuery.data || [];
  const loadingCompany = companiesQuery.isPending;

  if (!user) return null;

  const insideCompany = selectedCompanyId !== null;
  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  // Garante que apenas UM item por vez seja marcado como ativo (isActive)
  const allVisibleItems = NAV_GROUPS.flatMap((group) =>
    group.items.filter((item) => {
      if (!item.roles.includes(user.role)) return false;
      if (item.requiresCompany && !insideCompany) return false;
      if (item.permissionKey && !hasPermission(item.permissionKey)) return false;
      return true;
    })
  );
  const activeItem =
    allVisibleItems.find((item) => location.pathname === item.path) ||
    allVisibleItems.find((item) => location.pathname.startsWith(`${item.path}/`));
  const activeItemId = activeItem?.id ?? null;

  const handleBackToCompanies = () => {
    leaveCompany();
    navigate("/companies");
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside
      style={{ width: "240px" }}
      className="sidebar-panel fixed left-0 top-0 bottom-0 flex flex-col z-40 bg-sidebar border-r border-border select-none"
    >
      {/* Marca */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border shrink-0">
        <img src="/logo.png" alt="Esfera" className="w-7 h-7 object-contain" />
        <span className="text-sm font-semibold text-primary tracking-tight">Esfera</span>
        <span className="px-1.5 rounded text-[10px] font-mono font-medium text-tertiary border border-border">v3</span>
      </div>

      {/* Empresa ativa (altura fixa, sem salto de layout) */}
      {insideCompany && (
        <div className="mx-2.5 mt-2.5 px-2.5 h-10 rounded-lg border border-border bg-card flex items-center shrink-0">
          <div className="flex items-center justify-between gap-2 w-full">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Building2 size={14} className="text-tertiary shrink-0" />
              {loadingCompany && !selectedCompany ? (
                <div className="skeleton h-3.5 w-28" aria-label="Carregando empresa" />
              ) : (
                <span
                  className="text-[0.8125rem] font-medium text-primary truncate"
                  title={selectedCompany?.name || "Empresa ativa"}
                >
                  {selectedCompany?.name || "Empresa ativa"}
                </span>
              )}
            </div>
            {user.role === "master" && (
              <button
                onClick={handleBackToCompanies}
                className="p-1 rounded-md text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer shrink-0"
                title="Voltar às empresas"
                aria-label="Voltar às empresas"
              >
                <ChevronLeft size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Navigation List — Compact Linear Style */}
      <nav className="flex-1 px-2.5 py-3 space-y-4 overflow-y-auto custom-scrollbar">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) => {
            if (!item.roles.includes(user.role)) return false;
            if (item.requiresCompany && !insideCompany) return false;
            if (item.permissionKey && !hasPermission(item.permissionKey)) return false;
            return true;
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.groupName}>
              <div className="px-2.5 pb-1 text-[11px] uppercase font-medium text-tertiary tracking-wider">
                {group.groupName}
              </div>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = item.id === activeItemId;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigate(item.path)}
                      aria-current={isActive ? "page" : undefined}
                      className={`group w-full h-8 flex items-center gap-2.5 px-2.5 rounded-lg text-[0.8125rem] transition-colors cursor-pointer ${
                        isActive
                          ? "bg-[var(--color-accent-glow)] text-primary font-medium"
                          : "text-secondary hover:text-primary hover:bg-hover"
                      }`}
                    >
                      <span
                        className={`shrink-0 transition-colors ${
                          isActive ? "text-[var(--color-accent-light)]" : "text-tertiary group-hover:text-secondary"
                        }`}
                      >
                        {item.icon}
                      </span>
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      {item.badge && (
                        <span className="px-1.5 text-[11px] rounded-full bg-hover text-secondary tabular-nums whitespace-nowrap shrink-0">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Perfil e saída */}
      <div className="border-t border-border p-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-accent-glow)] text-[var(--color-accent-light)] font-semibold text-xs shrink-0">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium text-primary truncate leading-tight" title={user.displayName}>
                {user.displayName}
              </p>
              <p className="text-xs text-tertiary capitalize leading-tight mt-0.5">{user.role}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded-lg text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
            title="Sair da conta"
            aria-label="Sair da conta"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
