// ============================================================
// Esfera v3 — Contexto de Autenticação
// Gerencia login, logout, roles e seleção de empresa
// ============================================================

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { User, SessionState } from "../types";
import { MOCK_CREDENTIALS, MOCK_USERS } from "../mock-data";

interface AuthContextType extends SessionState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  enterCompany: (companyId: number) => void;
  leaveCompany: () => void;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);

    // Simula delay de rede
    await new Promise((resolve) => setTimeout(resolve, 800));

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

    // Gestor e colaborador entram direto na empresa
    if (foundUser.role !== "master" && foundUser.companyId) {
      setSelectedCompanyId(foundUser.companyId);
    }

    return true;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setSelectedCompanyId(null);
    setError(null);
  }, []);

  const enterCompany = useCallback((companyId: number) => {
    setSelectedCompanyId(companyId);
  }, []);

  const leaveCompany = useCallback(() => {
    setSelectedCompanyId(null);
  }, []);

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
