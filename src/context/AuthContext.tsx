// ============================================================
// Esfera v3 — Contexto de Autenticação (Tauri IPC + Fallback)
// Gerencia login nativo em Rust via SQLite, controle de roles
// e permissões granulares por usuário
// ============================================================

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { User, SessionState, Permission, SectorPermission } from "../types";
import { api, setToken, getToken, connectHub, errorMessage, isTauri } from "../tauri";

interface AuthContextType extends SessionState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  enterCompany: (companyId: number) => void;
  leaveCompany: () => void;
  error: string | null;
  /** Aviso para a tela de login (ex.: sessão expirada). Some no próximo login. */
  sessionNotice: string | null;
  permissions: Permission[];
  sectorPermissions: SectorPermission[];
  hasPermission: (key: string) => boolean;
  hasSectorPermission: (sector: string, type: "view" | "configure") => boolean;
  refreshPermissions: () => Promise<void>;
  hubConnected: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Permissões padrão para master (acesso total)
const MASTER_DEFAULT_PERMISSIONS: Permission[] = [
  { userId: 0, permissionKey: "allow_all_tabs", enabled: true },
  { userId: 0, permissionKey: "allow_edit_devices", enabled: true },
  { userId: 0, permissionKey: "allow_manage_users", enabled: true },
  { userId: 0, permissionKey: "allow_dashboard", enabled: true },
  { userId: 0, permissionKey: "is_active", enabled: true },
];

const MASTER_DEFAULT_SECTOR_PERMISSIONS: SectorPermission[] = [
  { userId: 0, sector: "junior", canView: true, canConfigure: true },
  { userId: 0, sector: "senior", canView: true, canConfigure: true },
  { userId: 0, sector: "pesquisa", canView: true, canConfigure: true },
  { userId: 0, sector: "pa_fixa", canView: true, canConfigure: true },
  { userId: 0, sector: "comercial", canView: true, canConfigure: true },
];

// Helpers para persistência em localStorage
const STORAGE_KEY_USER = "esfera_v3_user";
const STORAGE_KEY_COMPANY = "esfera_v3_company";
const STORAGE_KEY_TOKEN = "esfera_v3_token";
const STORAGE_KEY_LAST_USERNAME = "esfera_v3_last_username";

const SESSION_EXPIRED_NOTICE = "Sua sessão expirou. Entre de novo para continuar.";

function loadFromStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveToStorage(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* localStorage indisponível */ }
}

// As sessões do backend ficam só na memória: um token salvo de uma execução anterior
// nunca vale. O app sempre começa na tela de login, então não guardamos token nem usuário.
saveToStorage(STORAGE_KEY_TOKEN, null);
saveToStorage(STORAGE_KEY_USER, null);

function loginErrorMessage(err: unknown): string {
  if (!isTauri()) return "Abra o Esfera pelo aplicativo da área de trabalho para entrar.";
  return errorMessage(err, "Não foi possível entrar. Tente de novo.");
}

// Contas de teste: só na prévia de desenvolvimento no navegador (sem o backend Tauri).
// No build de produção este trecho é removido (import.meta.env.DEV é falso).
function devPreviewAccount(username: string, password: string): User | null {
  if (!import.meta.env.DEV || isTauri()) return null;
  const accounts: Record<string, { pass: string; user: User }> = {
    "vicenzzo.master": {
      pass: "root123",
      user: { id: 10, username: "vicenzzo.master", displayName: "Vicenzzo Master", role: "master", companyId: null },
    },
    "vicenzzo.mastronikolis": {
      pass: "Ope@2025",
      user: { id: 11, username: "vicenzzo.mastronikolis", displayName: "Vicenzzo Mastronikolis", role: "gestor", companyId: 1 },
    },
    admin: {
      pass: "admin",
      user: { id: 1, username: "admin", displayName: "Administrador", role: "master", companyId: null },
    },
    gestor: {
      pass: "gestor",
      user: { id: 2, username: "gestor", displayName: "Carlos Gestor", role: "gestor", companyId: 1 },
    },
    colab: {
      pass: "colab",
      user: { id: 3, username: "colab", displayName: "Ana Operadora", role: "colaborador", companyId: 1 },
    },
    supervisor: {
      pass: "sup123",
      user: { id: 4, username: "supervisor", displayName: "Supervisor Carlos", role: "supervisor", companyId: 1 },
    },
  };
  const account = accounts[username];
  return account && account.pass === password ? account.user : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Sempre inicia sem usuário logado para exigir a tela de login em todo startup do aplicativo
  const [user, setUser] = useState<User | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(() => loadFromStorage<number>(STORAGE_KEY_COMPANY) || 1);
  const [error, setError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [sectorPermissions, setSectorPermissions] = useState<SectorPermission[]>([]);
  const [hubConnected, setHubConnected] = useState<boolean>(false);

  const queryClient = useQueryClient();

  // Muda a cada login/logout: respostas atrasadas de uma sessão antiga são ignoradas.
  const sessionSeq = useRef(0);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const loadPermissions = useCallback(async (userId: number, role: string) => {
    // Master sempre tem todas as permissões
    if (role === "master") {
      setPermissions(MASTER_DEFAULT_PERMISSIONS);
      setSectorPermissions(MASTER_DEFAULT_SECTOR_PERMISSIONS);
      return;
    }

    const seq = sessionSeq.current;
    try {
      const [perms, sectorPerms] = await Promise.all([
        api<Permission[]>("get_user_permissions", { userId }),
        api<SectorPermission[]>("get_sector_permissions", { userId }),
      ]);
      if (seq !== sessionSeq.current) return;
      setPermissions(perms);
      setSectorPermissions(sectorPerms);
    } catch (e) {
      if (seq !== sessionSeq.current) return;
      // Falha fechada: sem linhas explícitas valem os padrões de cada função (usePermissions).
      // Antes qualquer função (até colaborador) recebia as permissões de gestor quando a leitura falhava.
      console.warn("Não foi possível carregar as permissões do usuário:", e);
      setPermissions([]);
      setSectorPermissions([]);
    }
  }, []);

  // Liga ao Hub VPS em segundo plano: o login não espera a VPS (até 5 s quando ela está fora).
  const startHubConnection = useCallback(() => {
    const seq = sessionSeq.current;
    setHubConnected(false);
    connectHub()
      .then(() => {
        if (seq === sessionSeq.current) setHubConnected(true);
      })
      .catch((e) => {
        console.warn("Conexão ao Hub VPS falhou (app ainda funciona localmente):", e);
        if (seq === sessionSeq.current) setHubConnected(false);
      });
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);
    setSessionNotice(null);
    const name = username.trim();

    let res: { token: string; user: User } | null = null;
    try {
      res = await api<{ token: string; user: User }>("login", { username: name, password });
    } catch (err: unknown) {
      const previewUser = devPreviewAccount(name, password);
      if (previewUser) {
        sessionSeq.current += 1;
        const mockToken = `mock-token-${previewUser.id}`;
        setToken(mockToken);
        setUser(previewUser);
        if (previewUser.role !== "master" && previewUser.companyId) {
          setSelectedCompanyId(previewUser.companyId);
          saveToStorage(STORAGE_KEY_COMPANY, previewUser.companyId);
        }
        await loadPermissions(previewUser.id, previewUser.role);
        setHubConnected(false); // modo prévia: sem hub real
        return true;
      }
      console.warn("Login recusado:", err);
      setError(loginErrorMessage(err));
      return false;
    }

    if (!res || !res.token || !res.user) {
      setError("O aplicativo respondeu de forma inesperada. Tente de novo.");
      return false;
    }

    sessionSeq.current += 1;
    setToken(res.token);
    setUser(res.user);
    try {
      localStorage.setItem(STORAGE_KEY_LAST_USERNAME, res.user.username || name);
    } catch { /* localStorage indisponível */ }
    const compId = res.user.companyId || 1;
    setSelectedCompanyId(compId);
    saveToStorage(STORAGE_KEY_COMPANY, compId);
    await loadPermissions(res.user.id, res.user.role);
    // Conexão ao Hub VPS APÓS o login: usa o company_id do usuário logado.
    // Sem login = sem hub. Falha de conexão não bloqueia o login local.
    startHubConnection();
    return true;
  }, [loadPermissions, startHubConnection]);

  const endSession = useCallback((notice: string | null) => {
    const token = getToken();
    sessionSeq.current += 1;
    // O token vai explícito: o api() é assíncrono e, sem isso, chegava ao backend
    // depois do setToken(null) como "default-token" — a sessão real não era encerrada.
    if (token && notice === null) {
      api("logout", { token }).catch(() => {});
    }
    userRef.current = null;
    setToken(null);
    setUser(null);
    // Dados em cache (aparelhos, empresas, campanhas) não passam para o próximo usuário.
    queryClient.clear();
    setSelectedCompanyId(null);
    setHubConnected(false);
    setError(null);
    setSessionNotice(notice);
    setPermissions([]);
    setSectorPermissions([]);
    saveToStorage(STORAGE_KEY_COMPANY, null);
  }, [queryClient]);

  const logout = useCallback(() => endSession(null), [endSession]);

  // Sessão expirada (ex.: 24 h sem sair): volta para o login com um aviso.
  useEffect(() => {
    const onExpired = () => {
      if (!userRef.current) return;
      endSession(SESSION_EXPIRED_NOTICE);
    };
    window.addEventListener("esfera:session-expired", onExpired);
    return () => window.removeEventListener("esfera:session-expired", onExpired);
  }, [endSession]);

  const enterCompany = useCallback((companyId: number) => {
    setSelectedCompanyId(companyId);
    saveToStorage(STORAGE_KEY_COMPANY, companyId);
  }, []);

  const leaveCompany = useCallback(() => {
    setSelectedCompanyId(null);
    saveToStorage(STORAGE_KEY_COMPANY, null);
  }, []);

  const hasPermission = useCallback((key: string): boolean => {
    if (!user) return false;
    if (user.role === "master") return true;
    const perm = permissions.find((p) => p.permissionKey === key);
    return perm?.enabled ?? false;
  }, [user, permissions]);

  const hasSectorPermission = useCallback((sector: string, type: "view" | "configure"): boolean => {
    if (!user) return false;
    if (user.role === "master") return true;
    const sp = sectorPermissions.find((s) => s.sector === sector);
    if (!sp) return false;
    return type === "view" ? sp.canView : sp.canConfigure;
  }, [user, sectorPermissions]);

  const refreshPermissions = useCallback(async () => {
    if (user) {
      await loadPermissions(user.id, user.role);
    }
  }, [user, loadPermissions]);

  return (
    <AuthContext.Provider
      value={{
        loggedIn: !!user,
        user,
        selectedCompanyId,
        login,
        logout,
        enterCompany,
        leaveCompany,
        error,
        sessionNotice,
        permissions,
        sectorPermissions,
        hasPermission,
        hasSectorPermission,
        refreshPermissions,
        hubConnected,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de um AuthProvider");
  }
  return context;
}
