// ============================================================
// Esfera v3 — Sidebar Lateral com Permissões Granulares
// Filtra itens de navegação por role E permissões do usuário
// ============================================================

import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import { api } from "../tauri";
import type { Company } from "../types";
import { useState, useEffect } from "react";
import {
  Smartphone,
  Megaphone,
  Bot,
  ScrollText,
  Settings,
  Building2,
  LogOut,
  ChevronLeft,
  Zap,
  Shield,
  BarChart3,
  ClipboardList,
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
    groupName: "ACESSO",
    items: [
      {
        id: "my-requests",
        path: "/devices",
        label: "Minhas Solicitações",
        icon: <ClipboardList size={18} />,
        roles: ["colaborador"],
        requiresCompany: true,
      },
      {
        id: "supervisor",
        path: "/devices",
        label: "Supervisão",
        icon: <ShieldAlert size={18} />,
        roles: ["supervisor"],
        requiresCompany: true,
      },
      {
        id: "users",
        path: "/permissions",
        label: "Usuários",
        icon: <Users size={18} />,
        roles: ["master", "gestor"],
        requiresCompany: false,
      },
    ],
  },
  {
    groupName: "GERENCIAMENTO",
    items: [
      {
        id: "companies",
        path: "/companies",
        label: "Empresas",
        icon: <Building2 size={18} />,
        roles: ["master"],
        requiresCompany: false,
      },
      {
        id: "permissions",
        path: "/permissions",
        label: "Central de Controle",
        icon: <Shield size={18} />,
        roles: ["master", "gestor"],
        requiresCompany: false,
      },
    ],
  },
  {
    groupName: "OPERAÇÕES",
    items: [
      {
        id: "dashboard",
        path: "/dashboard",
        label: "Dashboard",
        icon: <BarChart3 size={18} />,
        roles: ["master", "gestor", "supervisor"],
        requiresCompany: true,
      },
      {
        id: "devices",
        path: "/devices",
        label: "Dispositivos ADB",
        icon: <Smartphone size={18} />,
        roles: ["master", "gestor", "supervisor", "colaborador"],
        requiresCompany: true,
      },
      {
        id: "campaigns",
        path: "/campaigns",
        label: "Campanhas",
        icon: <Megaphone size={18} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
      {
        id: "automations",
        path: "/automations",
        label: "Automações",
        icon: <Bot size={18} />,
        roles: ["master", "gestor"],
        requiresCompany: true,
      },
    ],
  },
  {
    groupName: "SISTEMA",
    items: [
      {
        id: "logs",
        path: "/logs",
        label: "Logs do Engine",
        icon: <ScrollText size={18} />,
        roles: ["master", "gestor", "supervisor", "colaborador"],
        requiresCompany: true,
      },
      {
        id: "settings",
        path: "/settings",
        label: "Configurações",
        icon: <Settings size={18} />,
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

  if (!user) return null;

  const insideCompany = selectedCompanyId !== null;

  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => {
    let mounted = true;
    api<Company[]>("get_companies")
      .then((data) => { if (mounted) setCompanies(data || []); })
      .catch(() => { if (mounted) setCompanies([]); });
    return () => { mounted = false; };
  }, []);

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  const handleBackToCompanies = () => {
    leaveCompany();
    navigate("/companies");
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside style={{ width: "256px" }} className="fixed left-0 top-0 bottom-0 flex flex-col z-40 bg-sidebar border-r border-white/[0.06] shadow-xl">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-5 h-16 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 shadow-md shadow-violet-500/30 shrink-0">
            <Zap size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-base font-extrabold text-primary tracking-tight leading-tight">Esfera</h1>
            <p className="text-[10px] text-violet-400 font-semibold tracking-wider leading-none mt-0.5">v3.0 HIGH PERFORMANCE</p>
          </div>
        </div>
      </div>

      {/* Empresa Ativa Widget */}
      {insideCompany && selectedCompany && (
        <div className="mx-3 mt-3 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <Building2 size={16} className="text-violet-400 shrink-0" />
              <span className="text-xs font-semibold text-primary truncate" title={selectedCompany.name}>{selectedCompany.name}</span>
            </div>
            {user.role === "master" && (
              <button
                onClick={handleBackToCompanies}
                className="p-1.5 rounded-lg text-tertiary hover:text-violet-400 hover:bg-violet-500/10 transition-colors cursor-pointer shrink-0"
                title="Voltar às Empresas"
              >
                <ChevronLeft size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Navigation List — Filtrado por role + permissões */}
      <nav className="flex-1 px-3 py-5 space-y-6 overflow-y-auto custom-scrollbar">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) => {
            if (!item.roles.includes(user.role)) return false;
            if (item.requiresCompany && !insideCompany) return false;
            if (item.id === "companies" && insideCompany) return false;
            if (item.permissionKey && !hasPermission(item.permissionKey)) return false;
            return true;
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.groupName}>
              <h3 className="px-3 text-[10px] font-bold text-tertiary uppercase tracking-wider mb-2.5">
                {group.groupName}
              </h3>
              <div className="space-y-1">
                {visibleItems.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigate(item.path)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                        isActive
                          ? "bg-gradient-to-r from-violet-600/20 to-indigo-600/20 text-violet-300 font-semibold border border-violet-500/30 shadow-sm"
                          : "text-secondary hover:text-primary hover:bg-white/5"
                      }`}
                    >
                      <span className={`shrink-0 ${isActive ? "text-violet-400" : "text-tertiary"}`}>
                        {item.icon}
                      </span>
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      {item.badge && (
                        <span className="px-1.5 py-0.5 text-[9px] rounded-md bg-violet-500/20 text-violet-300 font-mono whitespace-nowrap shrink-0">
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

      {/* Footer Profile & Logout */}
      <div className="border-t border-white/[0.06] p-3">
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 text-white font-bold text-xs shrink-0 shadow-sm">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-primary truncate leading-tight" title={user.displayName}>{user.displayName}</p>
              <p className="text-[10px] text-tertiary capitalize leading-tight mt-0.5">{user.role}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded-lg text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
            title="Sair"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
