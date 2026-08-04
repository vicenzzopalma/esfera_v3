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
    <aside style={{ width: "240px" }} className="fixed left-0 top-0 bottom-0 flex flex-col z-40 bg-[#0b0b0e] border-r border-white/[0.07]">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-white/[0.07]">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[#5E6AD2] text-white font-black text-xs shadow-md shadow-[#5E6AD2]/20">
            E
          </div>
          <div>
            <h1 className="text-xs font-bold text-white tracking-tight leading-tight">Esfera</h1>
          </div>
        </div>
      </div>

      {/* Empresa Ativa Widget */}
      {insideCompany && selectedCompany && (
        <div className="mx-2.5 mt-2.5 p-2 rounded-lg border border-white/[0.07] bg-white/[0.02]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Building2 size={14} className="text-zinc-400 shrink-0" />
              <span className="text-xs font-medium text-zinc-200 truncate" title={selectedCompany.name}>{selectedCompany.name}</span>
            </div>
            {user.role === "master" && (
              <button
                onClick={handleBackToCompanies}
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                title="Voltar às Empresas"
              >
                <ChevronLeft size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Navigation List — Compact Linear Style */}
      <nav className="flex-1 px-2.5 py-3 space-y-3 overflow-y-auto custom-scrollbar">
        {NAV_GROUPS.map((group, groupIdx) => {
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
              {groupIdx > 0 && <hr className="my-2 border-white/[0.06]" />}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigate(item.path)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                        isActive
                          ? "bg-[#5E6AD2]/15 text-[#828DF7] font-semibold border-l-2 border-[#5E6AD2]"
                          : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
                      }`}
                    >
                      <span className={`shrink-0 ${isActive ? "text-[#828DF7]" : "text-zinc-400"}`}>
                        {item.icon}
                      </span>
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      {item.badge && (
                        <span className="px-1.5 py-0.5 text-[9px] rounded bg-white/10 text-zinc-300 font-mono whitespace-nowrap shrink-0">
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
      <div className="border-t border-white/[0.07] p-2.5">
        <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[#5E6AD2] text-white font-bold text-xs shrink-0">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200 truncate leading-tight" title={user.displayName}>{user.displayName}</p>
              <p className="text-[10px] text-zinc-500 capitalize leading-tight mt-0.5">{user.role}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            title="Sair"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
