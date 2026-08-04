// ============================================================
// Esfera v3 — StatusBar
// Barra inferior com status de conexão e info da empresa
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { Company, Device } from "../types";
import { Building2, Smartphone } from "lucide-react";

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
    <footer style={{ left: "240px" }} className="fixed bottom-0 right-0 h-6 z-30 bg-[#0b0b0e] border-t border-white/[0.07] flex items-center justify-between px-3 text-[10px] text-zinc-400 select-none">
      <div className="flex items-center gap-3">
        {/* Status de conexão */}
        <div className="flex items-center gap-1">
          {onlineCount > 0 ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400 font-medium">Conectado</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
              <span className="text-zinc-500 font-medium">Pronto</span>
            </>
          )}
        </div>

        {/* Empresa atual */}
        {company && (
          <div className="flex items-center gap-1 text-zinc-400">
            <Building2 size={11} className="text-zinc-500" />
            <span className="truncate max-w-[150px]">{company.name}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Dispositivos online */}
        {selectedCompanyId && (
          <div className="flex items-center gap-1 text-zinc-400 font-mono">
            <Smartphone size={11} className="text-zinc-500" />
            <span>{onlineCount}/{totalCount} online</span>
          </div>
        )}

        {/* Versão */}
        <span className="font-mono text-zinc-600">v3.0.0</span>
      </div>
    </footer>
  );
}
