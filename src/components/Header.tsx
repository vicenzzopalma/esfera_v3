// ============================================================
// Esfera v3 — Global Header Component
// Barra superior com breadcrumb, switcher de empresas, status ADB e perfil
// ============================================================

import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { api } from "../tauri";
import type { Company, Device } from "../types";
import {
  Building2,
  ChevronDown,
  Sun,
  Moon,
  CheckCircle2,
  Cpu,
  LogOut,
  UserCheck,
} from "lucide-react";

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  "/companies": { title: "Gestão de Empresas", subtitle: "Gerencie permissões e cotas de clientes" },
  "/permissions": { title: "Permissões", subtitle: "Controle de acesso por usuário e setor" },
  "/dashboard": { title: "Dashboard", subtitle: "Indicadores e KPIs em tempo real" },
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
  const [companies, setCompanies] = useState<Company[]>([]);
  const [onlineDevicesCount, setOnlineDevicesCount] = useState(0);

  const companyDropdownRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  if (!user) return null;

  const currentRoute = PAGE_TITLES[location.pathname] || {
    title: "Esfera v3",
    subtitle: "Plataforma de Disparos Inteligentes",
  };

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  useEffect(() => {
    let mounted = true;
    api<Company[]>("get_companies")
      .then((data) => { if (mounted) setCompanies(data || []); })
      .catch(() => { if (mounted) setCompanies([]); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!selectedCompanyId) { if (mounted) setOnlineDevicesCount(0); return; }
    api<Device[]>("get_devices", { companyId: selectedCompanyId })
      .then((data) => {
        const online = (data || []).filter((d) => d.status === "online").length;
        if (mounted) setOnlineDevicesCount(online);
      })
      .catch(() => { if (mounted) setOnlineDevicesCount(0); });
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  // Bug 7: Fechar dropdowns ao clicar fora
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (companyDropdownRef.current && !companyDropdownRef.current.contains(e.target as Node)) {
        setCompanyDropdownOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
    <header className="sticky top-0 z-30 h-12 w-full glass-header flex items-center justify-between px-5 gap-4 transition-all bg-[#0b0b0e]/90 border-b border-white/[0.07]">
      {/* Left: Breadcrumb & Context */}
      <div className="flex items-center gap-2 min-w-0 text-xs">
        {selectedCompany ? (
          <div className="relative" ref={companyDropdownRef}>
            <button
              onClick={() => user.role === "master" && setCompanyDropdownOpen(!companyDropdownOpen)}
              className={`flex items-center gap-1.5 font-medium text-zinc-400 hover:text-zinc-200 transition-colors ${
                user.role === "master" ? "cursor-pointer" : "cursor-default"
              }`}
            >
              <Building2 size={13} className="text-[#828DF7] shrink-0" />
              <span className="truncate max-w-[130px] font-semibold text-zinc-200">{selectedCompany.name}</span>
              {user.role === "master" && <ChevronDown size={12} className="text-zinc-500 shrink-0" />}
            </button>

            {companyDropdownOpen && user.role === "master" && (
              <div className="absolute left-0 mt-1.5 w-52 rounded-lg glass-panel shadow-2xl p-1 z-50 animate-scale-in bg-[#141418] border border-white/[0.08]">
                <div className="px-2.5 py-1.5 text-[9px] uppercase font-bold text-zinc-500 tracking-wider border-b border-white/[0.06] mb-1">
                  Trocar Empresa
                </div>
                {companies.length === 0 && (
                  <div className="px-2.5 py-1.5 text-xs text-zinc-500">Nenhuma empresa</div>
                )}
                {companies.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleCompanySelect(c.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      selectedCompanyId === c.id
                        ? "bg-[#5E6AD2]/20 text-[#828DF7] font-semibold"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
                    }`}
                  >
                    <span className="truncate">{c.name}</span>
                    {selectedCompanyId === c.id && <CheckCircle2 size={12} className="text-[#828DF7]" />}
                  </button>
                ))}
                {selectedCompanyId !== null && (
                  <button
                    onClick={handleLeaveCompany}
                    className="w-full text-left px-2.5 py-1.5 mt-1 border-t border-white/[0.06] text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                  >
                    Todas as empresas
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <span className="text-zinc-400 font-medium">Esfera</span>
        )}

        <span className="text-zinc-600 font-mono">/</span>
        <h1 className="font-semibold text-zinc-100 tracking-tight truncate">
          {currentRoute.title}
        </h1>
      </div>

      {/* Right: Engine Badge & User Profile */}
      <div className="flex items-center gap-3">
        {/* ADB Engine Status Badge */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.03] border border-white/[0.07] text-[11px]">
          <Cpu size={12} className="text-[#828DF7] shrink-0" />
          <span className="text-zinc-500">Engine:</span>
          <span className="font-medium text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            {onlineDevicesCount > 0 ? `${onlineDevicesCount} Online` : "Pronto"}
          </span>
        </div>

        {/* User Profile Menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-1.5 p-1 rounded-md hover:bg-white/[0.05] transition-all cursor-pointer"
          >
            <div className="flex items-center justify-center w-6 h-6 rounded bg-[#5E6AD2] text-white font-bold text-[11px] shadow-sm">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <ChevronDown size={12} className="text-zinc-500" />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-1.5 w-48 rounded-lg glass-panel shadow-2xl p-1 z-50 animate-scale-in bg-[#141418] border border-white/[0.08]">
              <div className="px-2.5 py-1.5 border-b border-white/[0.06] mb-1">
                <p className="text-xs font-semibold text-zinc-100 truncate">{user.displayName}</p>
                <p className="text-[10px] text-zinc-500 capitalize">{user.role}</p>
              </div>
              <button
                onClick={() => {
                  toggleTheme();
                }}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  {isDark ? <Sun size={13} /> : <Moon size={13} />}
                  <span>{isDark ? "Modo Claro" : "Modo Escuro"}</span>
                </div>
              </button>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate("/settings");
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] transition-colors cursor-pointer"
              >
                <UserCheck size={13} />
                <span>Perfil & Ajustes</span>
              </button>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  logout();
                  navigate("/login");
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer mt-1 border-t border-white/[0.06]"
              >
                <LogOut size={13} />
                <span>Sair</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
