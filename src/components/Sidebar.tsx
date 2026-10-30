// ============================================================
// Esfera v3 — Sidebar Lateral com Permissões Granulares
// Filtra itens de navegação por role E permissões do usuário.
// Pode ser recolhida (só ícones) para sobrar espaço em telas 1280x720;
// a largura vem da variável --sidebar-w (index.css), que Layout e StatusBar seguem.
// ============================================================

import { useLayoutEffect, useState } from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

const STORAGE_KEY_COLLAPSED = "esfera_v3_sidebar_collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === "1";
  } catch {
    return false;
  }
}

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
  const [collapsed, setCollapsed] = useState(readCollapsed);

  // Aplica a largura antes da pintura (sem "pulo" ao abrir o app recolhido) e lembra a escolha.
  useLayoutEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "1" : "0");
    } catch { /* localStorage indisponível */ }
  }, [collapsed]);

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
  const companyName = selectedCompany?.name || "Empresa ativa";

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

  const toggleCollapsed = () => setCollapsed((c) => !c);
  const avatar = (
    <div
      className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-accent-glow)] text-[var(--color-accent-light)] font-semibold text-xs shrink-0"
      title={collapsed ? `${user.displayName} · ${user.role}` : undefined}
    >
      {user.displayName.charAt(0).toUpperCase()}
    </div>
  );

  return (
    <aside
      aria-label="Menu principal"
      className="sidebar-panel fixed left-0 top-0 bottom-0 flex flex-col z-40 bg-sidebar border-r border-border select-none overflow-x-hidden"
    >
      {/* Marca + recolher/expandir */}
      {collapsed ? (
        <div className="flex items-center justify-center h-12 border-b border-border shrink-0">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Expandir menu"
            aria-label="Expandir menu"
            aria-expanded={false}
            className="group relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-hover transition-colors cursor-pointer"
          >
            <img src="/logo.png" alt="" className="w-7 h-7 object-contain group-hover:opacity-0 group-focus-visible:opacity-0 transition-opacity" />
            <PanelLeftOpen
              size={16}
              className="absolute text-secondary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
            />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 pl-4 pr-2 h-12 border-b border-border shrink-0">
          <img src="/logo.png" alt="Esfera" className="w-7 h-7 object-contain" />
          <span className="text-sm font-semibold text-primary tracking-tight">Esfera</span>
          <span className="px-1.5 rounded text-[10px] font-mono font-medium text-tertiary border border-border">v3</span>
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Recolher menu (mais espaço para o conteúdo)"
            aria-label="Recolher menu"
            aria-expanded={true}
            className="ml-auto p-1.5 rounded-md text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer shrink-0"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      )}

      {/* Empresa ativa (altura fixa, sem salto de layout) */}
      {insideCompany &&
        (collapsed ? (
          <div className="flex justify-center mt-2.5 shrink-0">
            {user.role === "master" ? (
              <button
                type="button"
                onClick={handleBackToCompanies}
                title={`${companyName} — voltar às empresas`}
                aria-label={`Empresa ${companyName}. Voltar às empresas`}
                className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer"
              >
                <Building2 size={15} />
              </button>
            ) : (
              <div
                title={companyName}
                className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card text-tertiary"
              >
                <Building2 size={15} />
              </div>
            )}
          </div>
        ) : (
          <div className="mx-2.5 mt-2.5 px-2.5 h-10 rounded-lg border border-border bg-card flex items-center shrink-0">
            <div className="flex items-center justify-between gap-2 w-full">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Building2 size={14} className="text-tertiary shrink-0" />
                {loadingCompany && !selectedCompany ? (
                  <div className="skeleton h-3.5 w-28" aria-label="Carregando empresa" />
                ) : (
                  <span className="text-[0.8125rem] font-medium text-primary truncate" title={companyName}>
                    {companyName}
                  </span>
                )}
              </div>
              {user.role === "master" && (
                <button
                  type="button"
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
        ))}

      {/* Navigation List — Compact Linear Style */}
      <nav className={`flex-1 py-3 overflow-y-auto overflow-x-hidden custom-scrollbar ${collapsed ? "px-2 space-y-2" : "px-2.5 space-y-4"}`}>
        {NAV_GROUPS.map((group, groupIdx) => {
          const visibleItems = group.items.filter((item) => {
            if (!item.roles.includes(user.role)) return false;
            if (item.requiresCompany && !insideCompany) return false;
            if (item.permissionKey && !hasPermission(item.permissionKey)) return false;
            return true;
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.groupName} role="group" aria-label={group.groupName}>
              {collapsed ? (
                groupIdx > 0 && <div className="mx-2 mb-2 border-t border-border" />
              ) : (
                <div className="px-2.5 pb-1 text-[11px] uppercase font-medium text-tertiary tracking-wider">
                  {group.groupName}
                </div>
              )}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = item.id === activeItemId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigate(item.path)}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      title={collapsed ? item.label : undefined}
                      className={`group w-full h-8 flex items-center rounded-lg text-[0.8125rem] transition-colors cursor-pointer ${
                        collapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
                      } ${
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
                      {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}
                      {!collapsed && item.badge && (
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
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5 py-1">
            {avatar}
            <button
              type="button"
              onClick={handleLogout}
              className="p-1.5 rounded-lg text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
              title="Sair da conta"
              aria-label="Sair da conta"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1.5 py-1">
            <div className="flex items-center gap-2.5 min-w-0">
              {avatar}
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium text-primary truncate leading-tight" title={user.displayName}>
                  {user.displayName}
                </p>
                <p className="text-xs text-tertiary capitalize leading-tight mt-0.5">{user.role}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="p-1.5 rounded-lg text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
              title="Sair da conta"
              aria-label="Sair da conta"
            >
              <LogOut size={15} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
