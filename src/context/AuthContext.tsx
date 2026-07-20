// ============================================================
// Esfera v3 — Contexto de Autenticação (Tauri IPC + Fallback)
// Gerencia login nativo em Rust via SQLite, controle de roles
// e permissões granulares por usuário
// ============================================================

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import type { User, SessionState, Permission, SectorPermission } from "../types";
import { MOCK_CREDENTIALS, MOCK_USERS } from "../mock-data";
import { invoke } from "@tauri-apps/api/core";

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
  { userId: 0, sector: "pa_fixa_1", canView: true, canConfigure: true },
  { userId: 0, sector: "pa_fixa_2", canView: true, canConfigure: true },
  { userId: 0, sector: "comercial", canView: true, canConfigure: true },
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
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
        invoke<Permission[]>("get_user_permissions", { userId }),
        invoke<SectorPermission[]>("get_sector_permissions", { userId }),
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
      const resUser = await invoke<User>("login", { username, password });
      setUser(resUser);
      if (resUser.role !== "master" && resUser.companyId) {
        setSelectedCompanyId(resUser.companyId);
      }
      await loadPermissions(resUser.id, resUser.role);
      return true;
    } catch (err: unknown) {
      console.warn("Tauri invoke login não disponível ou erro, fallback para dados locais:", err);
      
      const credential = MOCK_CREDENTIALS.find(
        (c) => c.username === username && c.password === password
      );

      if (!credential) {
        setError("Usuário ou senha inválidos");
        return false;
      }

      const foundUser = MOCK_USERS.find((u) => u.id === credential.userId);
      if (!foundUser) {
        setError("Usuário não encontrado no sistema");
        return false;
      }

      setUser(foundUser);
      if (foundUser.role !== "master" && foundUser.companyId) {
        setSelectedCompanyId(foundUser.companyId);
      }
      await loadPermissions(foundUser.id, foundUser.role);
      return true;
    }
  }, [loadPermissions]);

  const logout = useCallback(() => {
    setUser(null);
    setSelectedCompanyId(null);
    setError(null);
    setPermissions([]);
    setSectorPermissions([]);
  }, []);

  const enterCompany = useCallback((companyId: number) => {
    setSelectedCompanyId(companyId);
  }, []);

  const leaveCompany = useCallback(() => {
    setSelectedCompanyId(null);
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
