// ============================================================
// Esfera v3 — Header global
// Contexto (empresa / página), troca de empresa, tema e menu do usuário
// ============================================================

import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { api } from "../tauri";
import type { Company, Device } from "../types";
import { Building2, ChevronDown, ChevronRight, Check, Sun, Moon, LogOut, Settings } from "lucide-react";

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  "/companies": { title: "Empresas", subtitle: "Empresas, cotas e limites" },
  "/permissions": { title: "Usuários e permissões", subtitle: "Acessos, solicitações e vínculos de aparelhos" },
  "/dashboard": { title: "Dashboard", subtitle: "Indicadores de desempenho" },
  "/devices": { title: "Dispositivos", subtitle: "Conexões, espelhamento e status" },
  "/campaigns": { title: "Campanhas", subtitle: "Disparos e fluxo de contatos" },
  "/automations": { title: "Automações", subtitle: "Respostas automáticas por palavra-chave" },
  "/logs": { title: "Logs", subtitle: "Histórico de eventos e execuções" },
  "/settings": { title: "Configurações", subtitle: "Preferências e infraestrutura" },
};

const menuItem =
  "w-full flex items-center gap-2 px-2.5 h-8 rounded-md text-[0.8125rem] text-secondary hover:text-primary hover:bg-hover transition-colors cursor-pointer";

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

  // Fechar menus ao clicar fora ou com Esc
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (companyDropdownRef.current && !companyDropdownRef.current.contains(e.target as Node)) {
        setCompanyDropdownOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCompanyDropdownOpen(false);
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  if (!user) return null;

  const currentRoute = PAGE_TITLES[location.pathname] || {
    title: "Esfera",
    subtitle: "",
  };

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);
  const canSwitch = user.role === "master";

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
    <header className="sticky top-0 z-30 h-12 w-full glass-header flex items-center justify-between px-6 gap-4">
      {/* Contexto: empresa / página */}
      <div className="flex items-center gap-1.5 min-w-0 text-[0.8125rem]">
        {selectedCompany && (
          <>
            <div className="relative" ref={companyDropdownRef}>
              <button
                onClick={() => canSwitch && setCompanyDropdownOpen(!companyDropdownOpen)}
                aria-haspopup={canSwitch ? "menu" : undefined}
                aria-expanded={canSwitch ? companyDropdownOpen : undefined}
                className={`flex items-center gap-1.5 h-7 px-2 rounded-md text-secondary transition-colors ${
                  canSwitch ? "hover:text-primary hover:bg-hover cursor-pointer" : "cursor-default"
                }`}
              >
                <Building2 size={14} className="text-tertiary shrink-0" />
                <span className="truncate max-w-[160px]">{selectedCompany.name}</span>
                {canSwitch && <ChevronDown size={12} className="text-tertiary shrink-0" />}
              </button>

              {companyDropdownOpen && canSwitch && (
                <div className="absolute left-0 mt-1.5 w-60 rounded-xl glass-panel p-1.5 z-50 animate-scale-in" role="menu">
                  <div className="px-2.5 py-1.5 text-[11px] uppercase font-medium text-tertiary tracking-wider">
                    Trocar de empresa
                  </div>
                  {companies.length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-tertiary">Nenhuma empresa</div>
                  )}
                  <div className="max-h-64 overflow-y-auto custom-scrollbar">
                    {companies.map((c) => (
                      <button
                        key={c.id}
                        role="menuitem"
                        onClick={() => handleCompanySelect(c.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 h-8 rounded-md text-[0.8125rem] transition-colors cursor-pointer ${
                          selectedCompanyId === c.id
                            ? "bg-[var(--color-accent-glow)] text-primary font-medium"
                            : "text-secondary hover:text-primary hover:bg-hover"
                        }`}
                      >
                        <span className="truncate">{c.name}</span>
                        {selectedCompanyId === c.id && <Check size={14} className="text-[var(--color-accent-light)] shrink-0" />}
                      </button>
                    ))}
                  </div>
                  {selectedCompanyId !== null && (
                    <button
                      role="menuitem"
                      onClick={handleLeaveCompany}
                      className="w-full text-left px-2.5 h-8 mt-1 border-t border-border text-[0.8125rem] text-secondary hover:text-primary hover:bg-hover rounded-md transition-colors cursor-pointer"
                    >
                      Ver todas as empresas
                    </button>
                  )}
                </div>
              )}
            </div>
            <ChevronRight size={14} className="text-tertiary shrink-0" />
          </>
        )}
        <h1 className="font-semibold text-primary truncate" title={currentRoute.subtitle || undefined}>
          {currentRoute.title}
        </h1>
      </div>

      {/* Ações */}
      <div className="flex items-center gap-2">
        {selectedCompanyId !== null && (
          <div
            className="hidden sm:flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs text-secondary"
            title="Aparelhos online"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${onlineDevicesCount > 0 ? "bg-emerald-500" : "bg-zinc-500"}`}
            />
            <span className="tabular-nums">
              {onlineDevicesCount > 0 ? `${onlineDevicesCount} online` : "Nenhum online"}
            </span>
          </div>
        )}

        <button
          onClick={toggleTheme}
          aria-label={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
          title={isDark ? "Tema claro" : "Tema escuro"}
          className="flex items-center justify-center h-7 w-7 rounded-md text-secondary hover:text-primary hover:bg-hover transition-colors cursor-pointer"
        >
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            className="flex items-center gap-2 h-8 pl-1 pr-2 rounded-lg hover:bg-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-accent-glow)] text-[var(--color-accent-light)] font-semibold text-[11px]">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <span className="text-[0.8125rem] font-medium text-primary max-w-[110px] truncate hidden md:inline">
              {user.displayName}
            </span>
            <ChevronDown size={12} className="text-tertiary" />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-1.5 w-56 rounded-xl glass-panel p-1.5 z-50 animate-scale-in" role="menu">
              <div className="px-2.5 py-2 border-b border-border mb-1">
                <p className="text-[0.8125rem] font-medium text-primary truncate">{user.displayName}</p>
                <p className="text-xs text-tertiary capitalize">{user.role}</p>
              </div>
              <button role="menuitem" onClick={() => toggleTheme()} className={menuItem}>
                {isDark ? <Sun size={14} /> : <Moon size={14} />}
                <span>{isDark ? "Tema claro" : "Tema escuro"}</span>
              </button>
              {(user.role === "master" || user.role === "gestor") && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    navigate("/settings");
                  }}
                  className={menuItem}
                >
                  <Settings size={14} />
                  <span>Configurações</span>
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  logout();
                  navigate("/login");
                }}
                className="w-full flex items-center gap-2 px-2.5 h-8 mt-1 border-t border-border rounded-md text-[0.8125rem] text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
              >
                <LogOut size={14} />
                <span>Sair</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
