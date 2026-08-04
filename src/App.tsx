// ============================================================
// Esfera v3 — App Principal
// Roteamento com proteção por autenticação e role
// ============================================================

import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import CompaniesTab from "./pages/CompaniesTab";
import PermissionsTab from "./pages/PermissionsTab";
import DashboardTab from "./pages/DashboardTab";
import DevicesTab from "./pages/DevicesTab";
import CampaignsTab from "./pages/CampaignsTab";
import AutomationsTab from "./pages/AutomationsTab";
import LogsTab from "./pages/LogsTab";
import SettingsTab from "./pages/SettingsTab";
import type { ReactNode } from "react";

// ---- Protected Route ----
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loggedIn } = useAuth();
  const location = useLocation();

  if (!loggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

// ---- Role Gate ----
function RoleGate({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

// ---- Company Gate (requer empresa selecionada) ----
function CompanyGate({ children }: { children: ReactNode }) {
  const { user, selectedCompanyId } = useAuth();

  if (!user) return <Navigate to="/login" replace />;

  // Master sem empresa selecionada → vai para companies
  if (user.role === "master" && selectedCompanyId === null) {
    return <Navigate to="/companies" replace />;
  }

  // Gestor ou Colaborador sem empresa → tenta restaurar do user.companyId ou redireciona ao login
  if (user.role !== "master" && selectedCompanyId === null) {
    if (user.companyId) {
      // Auto-restaura a empresa do usuário (não deveria chegar aqui, mas é safety net)
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// ---- Root Redirect ----
function RootRedirect() {
  const { user, selectedCompanyId } = useAuth();

  if (!user) return <Navigate to="/login" replace />;

  // Master sem empresa → Selecionar Empresa (/companies)
  if (user.role === "master" && selectedCompanyId === null) {
    return <Navigate to="/companies" replace />;
  }

  // Master com empresa → Dashboard
  if (user.role === "master") {
    return <Navigate to="/dashboard" replace />;
  }

  // Gestor, Supervisor, Colaborador → Dispositivos
  return <Navigate to="/devices" replace />;
}

// ---- App ----
function AppRoutes() {
  return (
    <Routes>
      {/* Login */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected Routes */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Root Redirect */}
        <Route index element={<RootRedirect />} />

        {/* Companies (Master only) */}
        <Route
          path="/companies"
          element={
            <RoleGate roles={["master"]}>
              <CompaniesTab />
            </RoleGate>
          }
        />

        {/* Permissions (Master & Gestor) */}
        <Route
          path="/permissions"
          element={
            <RoleGate roles={["master", "gestor"]}>
              <PermissionsTab />
            </RoleGate>
          }
        />

        {/* Dashboard (requer empresa + master/gestor/supervisor) */}
        <Route
          path="/dashboard"
          element={
            <CompanyGate>
              <RoleGate roles={["master", "gestor", "supervisor"]}>
                <DashboardTab />
              </RoleGate>
            </CompanyGate>
          }
        />

        {/* Tabs que requerem empresa */}
        <Route
          path="/devices"
          element={
            <CompanyGate>
              <DevicesTab />
            </CompanyGate>
          }
        />
        <Route
          path="/campaigns"
          element={
            <CompanyGate>
              <RoleGate roles={["master", "gestor"]}>
                <CampaignsTab />
              </RoleGate>
            </CompanyGate>
          }
        />
        <Route
          path="/automations"
          element={
            <CompanyGate>
              <RoleGate roles={["master", "gestor"]}>
                <AutomationsTab />
              </RoleGate>
            </CompanyGate>
          }
        />
        <Route
          path="/logs"
          element={
            <CompanyGate>
              <LogsTab />
            </CompanyGate>
          }
        />
        <Route
          path="/settings"
          element={
            <CompanyGate>
              <RoleGate roles={["master", "gestor"]}>
                <SettingsTab />
              </RoleGate>
            </CompanyGate>
          }
        />
      </Route>

      {/* Catch all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
