// ============================================================
// Esfera v3 — StatusBar
// Barra inferior discreta: conexão, empresa, aparelhos online e versão
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
    <footer
      style={{ left: "240px" }}
      className="statusbar-panel fixed bottom-0 right-0 h-7 z-30 bg-sidebar border-t border-border flex items-center justify-between px-4 text-xs text-tertiary select-none"
    >
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${onlineCount > 0 ? "bg-emerald-500" : "bg-zinc-500"}`} />
          <span>{onlineCount > 0 ? "Conectado" : "Pronto"}</span>
        </div>

        {company && (
          <div className="flex items-center gap-1.5 min-w-0">
            <Building2 size={12} className="shrink-0" />
            <span className="truncate max-w-[200px]">{company.name}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {selectedCompanyId && (
          <div className="flex items-center gap-1.5 tabular-nums">
            <Smartphone size={12} />
            <span>{onlineCount}/{totalCount} online</span>
          </div>
        )}
        <span className="font-mono">v3.19.0</span>
      </div>
    </footer>
  );
}
