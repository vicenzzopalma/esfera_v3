// ============================================================
// Esfera v3 — StatusBar
// Barra inferior com status de conexão e info da empresa
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { Company, Device } from "../types";
import { Wifi, WifiOff, Building2, Smartphone } from "lucide-react";

export default function StatusBar() {
  const { selectedCompanyId } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    if (!selectedCompanyId) {
      if (mounted) { setCompany(null); setOnlineCount(0); setTotalCount(0); }
      return;
    }

    api<Company[]>("get_companies")
      .then((data) => {
        if (!mounted) return;
        const found = (data || []).find((c) => c.id === selectedCompanyId);
        setCompany(found || null);
      })
      .catch(() => { if (mounted) setCompany(null); });

    api<Device[]>("get_devices", { companyId: selectedCompanyId })
      .then((data) => {
        if (!mounted) return;
        const devices = data || [];
        setTotalCount(devices.length);
        setOnlineCount(devices.filter((d) => d.status === "online").length);
      })
      .catch(() => { if (mounted) { setOnlineCount(0); setTotalCount(0); } });
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  return (
    <footer style={{ left: "256px" }} className="fixed bottom-0 right-0 h-8 z-30 bg-sidebar border-t border-border flex items-center justify-between px-4 text-xs text-tertiary">

      <div className="flex items-center gap-4">
        {/* Status de conexão */}
        <div className="flex items-center gap-1.5">
          {onlineCount > 0 ? (
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
            <span>{onlineCount}/{totalCount} online</span>
          </div>
        )}

        {/* Versão */}
        <span className="opacity-50">Esfera v3.0</span>
      </div>
    </footer>
  );
}
