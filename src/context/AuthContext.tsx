// ============================================================
// Esfera v3 — Contexto de Autenticação (Tauri IPC + Fallback)
// Gerencia login nativo em Rust via SQLite, controle de roles
// e permissões granulares por usuário
// ============================================================

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import type { User, SessionState, Permission, SectorPermission } from "../types";
import { api, setToken, getToken } from "../tauri";

interface AuthContextType extends SessionState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  enterCompany: (companyId: number) => void;
  leaveCompany: () => void;
  error: string | null;
  permissions: Permission[];
  sectorPermissions: SectorPermission[];
  hasPermission: (key: string) => boolean;
  hasSectorPermission: (sector: string, type: "view" | "configure") => boolean;
  refreshPermissions: () => Promise<void>;
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

// Helpers para persistência de sessão em localStorage
const STORAGE_KEY_USER = "esfera_v3_user";
const STORAGE_KEY_COMPANY = "esfera_v3_company";

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => loadFromStorage<User>(STORAGE_KEY_USER));
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(() => loadFromStorage<number>(STORAGE_KEY_COMPANY));
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [sectorPermissions, setSectorPermissions] = useState<SectorPermission[]>([]);

  const loadPermissions = useCallback(async (userId: number, role: string) => {
    // Master sempre tem todas as permissões
    if (role === "master") {
      setPermissions(MASTER_DEFAULT_PERMISSIONS);
      setSectorPermissions(MASTER_DEFAULT_SECTOR_PERMISSIONS);
      return;
    }

    try {
      const [perms, sectorPerms] = await Promise.all([
        api<Permission[]>("get_user_permissions", { userId }),
        api<SectorPermission[]>("get_sector_permissions", { userId }),
      ]);
      setPermissions(perms);
      setSectorPermissions(sectorPerms);
    } catch {
      // Fallback: permissões básicas para gestor
      setPermissions([
        { userId, permissionKey: "allow_all_tabs", enabled: true },
        { userId, permissionKey: "allow_edit_devices", enabled: true },
        { userId, permissionKey: "allow_manage_users", enabled: false },
        { userId, permissionKey: "allow_dashboard", enabled: true },
        { userId, permissionKey: "is_active", enabled: true },
      ]);
      setSectorPermissions(MASTER_DEFAULT_SECTOR_PERMISSIONS);
    }
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);

    try {
      const res = await api<{ token: string; user: User }>("login", { username, password });
      setToken(res.token);
      setUser(res.user);
      saveToStorage(STORAGE_KEY_USER, res.user);
      if (res.user.role !== "master" && res.user.companyId) {
        setSelectedCompanyId(res.user.companyId);
        saveToStorage(STORAGE_KEY_COMPANY, res.user.companyId);
      }
      await loadPermissions(res.user.id, res.user.role);
      return true;
    } catch (err: unknown) {
      console.warn("Tauri invoke login não disponível ou erro (modo navegador/preview):", err);
      
      const SYSTEM_USERS: Record<string, { pass: string; user: User }> = {
        "vicenzzo.master": {
          pass: "root123",
          user: { id: 10, username: "vicenzzo.master", displayName: "Vicenzzo Master", role: "master", companyId: null },
        },
        "vicenzzo.mastronikolis": {
          pass: "Ope@2025",
          user: { id: 11, username: "vicenzzo.mastronikolis", displayName: "Vicenzzo Mastronikolis", role: "gestor", companyId: 1 },
        },
        "admin": {
          pass: "admin",
          user: { id: 1, username: "admin", displayName: "Administrador", role: "master", companyId: null },
        },
        "gestor": {
          pass: "gestor",
          user: { id: 2, username: "gestor", displayName: "Carlos Gestor", role: "gestor", companyId: 1 },
        },
        "colab": {
          pass: "colab",
          user: { id: 3, username: "colab", displayName: "Ana Operadora", role: "colaborador", companyId: 1 },
        },
      };

      const account = SYSTEM_USERS[username];
      if (account && account.pass === password) {
        setUser(account.user);
        saveToStorage(STORAGE_KEY_USER, account.user);
        if (account.user.role !== "master" && account.user.companyId) {
          setSelectedCompanyId(account.user.companyId);
          saveToStorage(STORAGE_KEY_COMPANY, account.user.companyId);
        }
        await loadPermissions(account.user.id, account.user.role);
        return true;
      }

      setError("Usuário ou senha inválidos");
      return false;
    }
  }, [loadPermissions]);

  const logout = useCallback(() => {
    const token = getToken();
    if (token) {
      api("logout", {}).catch(() => {});
    }
    setToken(null);
    setUser(null);
    setSelectedCompanyId(null);
    setError(null);
    setPermissions([]);
    setSectorPermissions([]);
    saveToStorage(STORAGE_KEY_USER, null);
    saveToStorage(STORAGE_KEY_COMPANY, null);
  }, []);

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

  // Carrega permissões se já há user (ex: refresh da página)
  useEffect(() => {
    if (user) {
      loadPermissions(user.id, user.role);
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
        permissions,
        sectorPermissions,
        hasPermission,
        hasSectorPermission,
        refreshPermissions,
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
