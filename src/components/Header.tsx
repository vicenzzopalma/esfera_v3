// ============================================================
// Esfera v3 — Global Header Component
// Barra superior com breadcrumb, switcher de empresas, status ADB e perfil
// ============================================================

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { MOCK_COMPANIES, MOCK_DEVICES } from "../mock-data";
import {
  Building2,
  ChevronDown,
  Sun,
  Moon,
  Search,
  CheckCircle2,
  Cpu,
  LogOut,
  UserCheck,
} from "lucide-react";

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  "/companies": { title: "Gestão de Empresas", subtitle: "Gerencie permissões e cotas de clientes" },
  "/devices": { title: "Hub de Dispositivos ADB", subtitle: "Conexões ativas e status em tempo real" },
  "/campaigns": { title: "Central de Campanhas", subtitle: "Disparos inteligentes e fluxo de contatos" },
  "/automations": { title: "Regras de Automação", subtitle: "Respostas automáticas por palavras-chave" },
  "/logs": { title: "Logs do Sistema", subtitle: "Histórico detalhado de eventos e execuções" },
  "/settings": { title: "Configurações da Empresa", subtitle: "Preferências e conexões de infraestrutura" },
};

export default function Header() {
  const { user, selectedCompanyId, enterCompany, leaveCompany, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  if (!user) return null;

  const currentRoute = PAGE_TITLES[location.pathname] || {
    title: "Esfera v3",
    subtitle: "Plataforma de Disparos Inteligentes",
  };

  const selectedCompany = MOCK_COMPANIES.find((c) => c.id === selectedCompanyId);
  const companyDevices = MOCK_DEVICES.filter((d) => d.companyId === selectedCompanyId);
  const onlineDevicesCount = companyDevices.filter((d) => d.status === "online").length;

  const handleCompanySelect = (companyId: number) => {
    enterCompany(companyId);
    setCompanyDropdownOpen(false);
    navigate("/devices");
  };

  const handleLeaveCompany = () => {
    leaveCompany();
    setCompanyDropdownOpen(false);
    navigate("/companies");
  };

  return (
    <header className="sticky top-0 z-30 h-16 w-full glass-header flex items-center justify-between px-6 transition-all">
      {/* Left: Title & Context */}
      <div className="flex items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-primary tracking-tight">
              {currentRoute.title}
            </h1>
            {selectedCompany && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">
                <Building2 size={11} />
                {selectedCompany.name}
              </span>
            )}
          </div>
          <p className="text-xs text-tertiary hidden sm:block">{currentRoute.subtitle}</p>
        </div>
      </div>

      {/* Right: Actions, Search, Switcher & User */}
      <div className="flex items-center gap-3">
        {/* Quick Search Bar */}
        <div className="relative hidden md:flex items-center">
          <Search size={15} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
          <input
            type="text"
            placeholder="Pesquisa rápida (Ctrl+K)..."
            className="w-56 input-with-icon-left focus:w-64 focus:border-violet-500/40 transition-all"
          />
        </div>

        {/* Engine ADB Status Badge */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-border text-xs">
          <Cpu size={14} className="text-indigo-400" />
          <span className="text-tertiary">ADB Engine:</span>
          <span className="font-semibold text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {onlineDevicesCount > 0 ? `${onlineDevicesCount} Online` : "Pronto"}
          </span>
        </div>

        {/* Company Switcher Dropdown (Master only) */}
        {user.role === "master" && (
          <div className="relative">
            <button
              onClick={() => setCompanyDropdownOpen(!companyDropdownOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-border hover:bg-white/10 text-xs font-medium text-primary transition-all cursor-pointer"
            >
              <Building2 size={14} className="text-violet-400" />
              <span className="max-w-[120px] truncate">
                {selectedCompany ? selectedCompany.name : "Selecionar Empresa"}
              </span>
              <ChevronDown size={14} className="text-tertiary" />
            </button>

            {companyDropdownOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-2xl glass-panel shadow-2xl p-1.5 z-50 animate-scale-in">
                <div className="px-3 py-2 text-[10px] uppercase font-bold text-tertiary tracking-wider border-b border-border mb-1">
                  Trocar Empresa
                </div>
                {MOCK_COMPANIES.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleCompanySelect(c.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer ${
                      selectedCompanyId === c.id
                        ? "bg-violet-600/20 text-violet-300 font-semibold"
                        : "text-secondary hover:text-primary hover:bg-white/5"
                    }`}
                  >
                    <span className="truncate">{c.name}</span>
                    {selectedCompanyId === c.id && <CheckCircle2 size={13} className="text-violet-400" />}
                  </button>
                ))}
                {selectedCompanyId !== null && (
                  <button
                    onClick={handleLeaveCompany}
                    className="w-full text-left px-3 py-2 mt-1 border-t border-border text-xs text-red-400 hover:bg-red-500/10 rounded-xl transition-colors cursor-pointer"
                  >
                    Ver todas as empresas
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-xl bg-white/5 border border-border text-secondary hover:text-primary hover:bg-white/10 transition-all cursor-pointer"
          title={isDark ? "Modo Claro" : "Modo Escuro"}
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* User Profile Menu */}
        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 p-1 rounded-xl hover:bg-white/5 transition-all cursor-pointer"
          >
            <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white font-bold text-xs shadow-md shadow-violet-500/20">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-2 w-48 rounded-2xl glass-panel shadow-2xl p-2 z-50 animate-scale-in">
              <div className="px-3 py-2 border-b border-border mb-1">
                <p className="text-xs font-semibold text-primary truncate">{user.displayName}</p>
                <p className="text-[10px] text-tertiary capitalize">{user.role}</p>
              </div>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate("/settings");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-secondary hover:text-primary hover:bg-white/5 transition-colors cursor-pointer"
              >
                <UserCheck size={14} />
                <span>Perfil & Ajustes</span>
              </button>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  logout();
                  navigate("/login");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer mt-1"
              >
                <LogOut size={14} />
                <span>Sair da conta</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
