// ============================================================
// Esfera v3 — Logs Tab
// Tabela de logs do sistema com filtros
// ============================================================

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_LOGS } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import type { LogType } from "../types";
import {
  ScrollText,
  Search,
  Filter,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Trash2,
} from "lucide-react";

const logTypeConfig: Record<LogType, { variant: "info" | "warning" | "danger" | "success"; label: string; icon: React.ReactNode; textColor: string }> = {
  info: { variant: "info", label: "Info", icon: <Info size={14} />, textColor: "text-blue-400" },
  warning: { variant: "warning", label: "Aviso", icon: <AlertTriangle size={14} />, textColor: "text-amber-400" },
  error: { variant: "danger", label: "Erro", icon: <XCircle size={14} />, textColor: "text-red-400" },
  success: { variant: "success", label: "Sucesso", icon: <CheckCircle size={14} />, textColor: "text-emerald-400" },
};

export default function LogsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<LogType | "all">("all");

  const logs = MOCK_LOGS.filter((l) => l.companyId === selectedCompanyId);

  const filteredLogs = logs
    .filter((l) => typeFilter === "all" || l.type === typeFilter)
    .filter(
      (l) =>
        l.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        l.source.toLowerCase().includes(searchQuery.toLowerCase())
    );

  const logCounts = {
    all: logs.length,
    info: logs.filter((l) => l.type === "info").length,
    warning: logs.filter((l) => l.type === "warning").length,
    error: logs.filter((l) => l.type === "error").length,
    success: logs.filter((l) => l.type === "success").length,
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Logs</h1>
          <p className="text-sm text-secondary mt-1">
            {logs.length} registros do sistema
          </p>
        </div>
        <Button variant="danger" size="sm" icon={<Trash2 size={14} />}>
          Limpar Logs
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            type="text"
            placeholder="Buscar nos logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
              bg-white/5 border border-border text-primary
              placeholder:text-tertiary
              focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
              transition-all"
          />
        </div>

        {/* Type Filters */}
        <div className="flex items-center gap-1.5">
          <Filter size={16} className="text-tertiary mr-1" />
          {(["all", "info", "warning", "error", "success"] as const).map((type) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer
                ${typeFilter === type
                  ? "bg-violet-600/20 text-violet-400 border border-violet-500/30"
                  : "bg-white/5 text-secondary border border-border hover:bg-white/10"
                }`}
            >
              {type === "all" ? "Todos" : logTypeConfig[type].label}
              <span className="ml-1 opacity-60">({logCounts[type]})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Logs Table */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider w-44">
                  Timestamp
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider w-24">
                  Tipo
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider w-28">
                  Fonte
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">
                  Mensagem
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredLogs.map((log) => {
                const config = logTypeConfig[log.type];
                return (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-3">
                      <span className="text-xs text-tertiary font-mono">
                        {new Date(log.timestamp).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant={config.variant} dot>
                        {config.label}
                      </Badge>
                    </td>
                    <td className="px-6 py-3">
                      <span className="text-xs text-secondary font-medium">{log.source}</span>
                    </td>
                    <td className="px-6 py-3">
                      <span className={`text-sm ${config.textColor}`}>{log.message}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {filteredLogs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-secondary">
              <ScrollText size={48} className="mb-3 opacity-30" />
              <p>Nenhum log encontrado</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
