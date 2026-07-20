// ============================================================
// Esfera v3 — Sidebar
// Navegação lateral com breadcrumb, role-based tabs, tema
// ============================================================

import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { MOCK_COMPANIES } from "../mock-data";
import {
  Smartphone,
  Megaphone,
  Bot,
  ScrollText,
  Settings,
  Building2,
  LogOut,
  ChevronLeft,
  Sun,
  Moon,
  Zap,
} from "lucide-react";

interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: React.ReactNode;
  roles: string[];
  requiresCompany: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "companies",
    path: "/companies",
    label: "Empresas",
    icon: <Building2 size={20} />,
    roles: ["master"],
    requiresCompany: false,
  },
  {
    id: "devices",
    path: "/devices",
    label: "Dispositivos",
    icon: <Smartphone size={20} />,
    roles: ["master", "gestor", "colaborador"],
    requiresCompany: true,
  },
  {
    id: "campaigns",
    path: "/campaigns",
    label: "Campanhas",
    icon: <Megaphone size={20} />,
    roles: ["master", "gestor"],
    requiresCompany: true,
  },
  {
    id: "automations",
    path: "/automations",
    label: "Automações",
    icon: <Bot size={20} />,
    roles: ["master", "gestor"],
    requiresCompany: true,
  },
  {
    id: "logs",
    path: "/logs",
    label: "Logs",
    icon: <ScrollText size={20} />,
    roles: ["master", "gestor", "colaborador"],
    requiresCompany: true,
  },
  {
    id: "settings",
    path: "/settings",
    label: "Configurações",
    icon: <Settings size={20} />,
    roles: ["master", "gestor"],
    requiresCompany: true,
  },
];

export default function Sidebar() {
  const { user, selectedCompanyId, leaveCompany, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  if (!user) return null;

  const insideCompany = selectedCompanyId !== null;
  const selectedCompany = MOCK_COMPANIES.find((c) => c.id === selectedCompanyId);

  // Filtra itens de navegação baseado no role e contexto
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(user.role)) return false;
    if (item.requiresCompany && !insideCompany) return false;
    if (item.id === "companies" && insideCompany) return false;
    return true;
  });

  const handleNavClick = (path: string) => {
    navigate(path);
  };

  const handleBackToCompanies = () => {
    leaveCompany();
    navigate("/companies");
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 flex flex-col z-40
      bg-sidebar border-r border-border">

      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl
          bg-gradient-to-br from-violet-600 to-indigo-600 shadow-lg shadow-violet-500/30">
          <Zap size={22} className="text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-primary tracking-tight">Esfera</h1>
          <p className="text-[10px] text-tertiary uppercase tracking-widest">v3.0</p>
        </div>
      </div>

      {/* Breadcrumb - voltar para empresas (Master dentro de empresa) */}
      {user.role === "master" && insideCompany && selectedCompany && (
        <button
          onClick={handleBackToCompanies}
          className="flex items-center gap-2 mx-3 mt-3 px-3 py-2 rounded-xl
            text-sm text-violet-400 hover:bg-violet-500/10
            transition-colors cursor-pointer group"
        >
          <ChevronLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" />
          <span className="truncate">← {selectedCompany.name}</span>
        </button>
      )}

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
        {visibleItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.path)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl
                text-sm font-medium transition-all duration-200 cursor-pointer
                ${isActive
                  ? "bg-gradient-to-r from-violet-600/20 to-indigo-600/20 text-violet-400 shadow-sm border border-violet-500/20"
                  : "text-secondary hover:text-primary hover:bg-white/5"
                }`}
            >
              <span className={isActive ? "text-violet-400" : ""}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-3 space-y-2">
        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl
            text-sm text-secondary hover:text-primary hover:bg-white/5
            transition-colors cursor-pointer"
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
          <span>{isDark ? "Modo Claro" : "Modo Escuro"}</span>
        </button>

        {/* User Info + Logout */}
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-full
            bg-gradient-to-br from-violet-600 to-indigo-600 text-white text-xs font-bold">
            {user.displayName.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-primary truncate">{user.displayName}</p>
            <p className="text-[11px] text-tertiary capitalize">{user.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded-lg text-secondary hover:text-red-400
              hover:bg-red-500/10 transition-colors cursor-pointer"
            title="Sair"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
