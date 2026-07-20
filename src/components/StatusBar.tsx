// ============================================================
// Esfera v3 — StatusBar
// Barra inferior com status de conexão e info da empresa
// ============================================================

import { useAuth } from "../context/AuthContext";
import { MOCK_COMPANIES, MOCK_DEVICES } from "../mock-data";
import { Wifi, WifiOff, Building2, Smartphone } from "lucide-react";

export default function StatusBar() {
  const { selectedCompanyId } = useAuth();

  const company = MOCK_COMPANIES.find((c) => c.id === selectedCompanyId);
  const companyDevices = MOCK_DEVICES.filter((d) => d.companyId === selectedCompanyId);
  const onlineDevices = companyDevices.filter((d) => d.status === "online");

  return (
    <footer className="fixed bottom-0 left-64 right-0 h-8 z-30
      bg-sidebar border-t border-border
      flex items-center justify-between px-4 text-xs text-tertiary">

      <div className="flex items-center gap-4">
        {/* Status de conexão */}
        <div className="flex items-center gap-1.5">
          {onlineDevices.length > 0 ? (
            <>
              <Wifi size={12} className="text-emerald-400" />
              <span className="text-emerald-400">Conectado</span>
            </>
          ) : (
            <>
              <WifiOff size={12} className="text-slate-500" />
              <span>Desconectado</span>
            </>
          )}
        </div>

        {/* Empresa atual */}
        {company && (
          <div className="flex items-center gap-1.5">
            <Building2 size={12} />
            <span>{company.name}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Dispositivos online */}
        {selectedCompanyId && (
          <div className="flex items-center gap-1.5">
            <Smartphone size={12} />
            <span>{onlineDevices.length}/{companyDevices.length} online</span>
          </div>
        )}

        {/* Versão */}
        <span className="opacity-50">Esfera v3.0</span>
      </div>
    </footer>
  );
}
