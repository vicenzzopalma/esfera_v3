// ============================================================
// Esfera v3 — Logs Tab Avançado
// Console de logs com filtros avançados, exportação CSV e auto-refresh
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import type { LogType, LogEntry } from "../types";
import { api } from "../tauri";
import {
  Search,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Trash2,
  Download,
  Terminal,
  RefreshCw,
  Smartphone,
  Megaphone,
  Bot,
  Shield,
  Settings,
  Clock,
} from "lucide-react";

const logTypeConfig: Record<
  LogType,
  { variant: "info" | "warning" | "danger" | "success"; label: string; icon: React.ReactNode; textColor: string }
> = {
  info: { variant: "info", label: "Info", icon: <Info size={14} />, textColor: "text-blue-400" },
  warning: { variant: "warning", label: "Aviso", icon: <AlertTriangle size={14} />, textColor: "text-amber-400" },
  error: { variant: "danger", label: "Erro", icon: <XCircle size={14} />, textColor: "text-red-400" },
  success: { variant: "success", label: "Sucesso", icon: <CheckCircle size={14} />, textColor: "text-emerald-400" },
  dispatch: { variant: "success", label: "Disparo", icon: <Megaphone size={14} />, textColor: "text-emerald-400" },
  ban: { variant: "danger", label: "Ban", icon: <Shield size={14} />, textColor: "text-red-400" },
  ai: { variant: "info", label: "IA", icon: <Bot size={14} />, textColor: "text-violet-400" },
  system: { variant: "info", label: "Sistema", icon: <Settings size={14} />, textColor: "text-slate-400" },
  device: { variant: "warning", label: "Device", icon: <Smartphone size={14} />, textColor: "text-amber-400" },
};

const ALL_LOG_TYPES: LogType[] = ["info", "warning", "error", "success", "dispatch", "ban", "ai", "system", "device"];

export default function LogsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<LogType | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logsList, setLogsList] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  useEffect(() => {
    let mounted = true;
    const doFetch = async () => {
      if (!selectedCompanyId) return;
      try {
        const data = await api<LogEntry[]>("get_logs", { companyId: selectedCompanyId });
        if (!mounted) return;
        setLogsList(data);
      } catch {
        if (mounted) setLogsList([]);
      }
      if (mounted) setLastRefresh(new Date());
    };
    doFetch();
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  // Auto-refresh every 5s
  useEffect(() => {
    if (!autoRefresh) return;
    let mounted = true;
    const doFetch = async () => {
      if (!selectedCompanyId) return;
      try {
        const data = await api<LogEntry[]>("get_logs", { companyId: selectedCompanyId });
        if (mounted) setLogsList(data);
      } catch {
        if (mounted) setLogsList([]);
      }
      if (mounted) setLastRefresh(new Date());
    };
    const interval = setInterval(doFetch, 5000);
    return () => { mounted = false; clearInterval(interval); };
  }, [autoRefresh, selectedCompanyId]);

  const filteredLogs = logsList
    .filter((l) => typeFilter === "all" || l.type === typeFilter)
    .filter((l) => sourceFilter === "all" || l.source === sourceFilter)
    .filter((l) => {
      if (!dateFrom && !dateTo) return true;
      const logTs = new Date(l.timestamp).getTime();
      if (isNaN(logTs)) return true;
      if (dateFrom && logTs < new Date(dateFrom).getTime()) return false;
      if (dateTo && logTs > new Date(dateTo + "T23:59:59").getTime()) return false;
      return true;
    })
    .filter(
      (l) =>
        l.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        l.source.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (l.deviceSerial && l.deviceSerial.toLowerCase().includes(searchQuery.toLowerCase()))
    );

  const logCounts: Record<string, number> = {
    all: logsList.length,
  };
  ALL_LOG_TYPES.forEach((t) => {
    logCounts[t] = logsList.filter((l) => l.type === t).length;
  });

  const uniqueSources = [...new Set(logsList.map((l) => l.source))];

  const handleExportCSV = () => {
    const headers = ["Horário", "Nível", "Origem", "Dispositivo", "Mensagem"];
    const rows = filteredLogs.map((l) => [
      new Date(l.timestamp).toLocaleString("pt-BR"),
      logTypeConfig[l.type as LogType]?.label || l.type,
      l.source,
      l.deviceSerial || "",
      `"${l.message.replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `esfera_logs_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = async () => {
    try {
      await api("clear_logs", { companyId: selectedCompanyId });
    } catch { /* noop */ }
    setLogsList([]);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Console de Logs</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Histórico detalhado de eventos — disparos, bans, IA, dispositivos e sistema.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? "primary" : "secondary"}
            size="sm"
            icon={<RefreshCw size={14} className={autoRefresh ? "animate-spin" : ""} />}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? "Auto-ON" : "Auto-OFF"}
          </Button>
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={handleExportCSV}>
            Exportar CSV
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={handleClearLogs}>
            Limpar
          </Button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
        {ALL_LOG_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(typeFilter === t ? "all" : t)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-[11px] font-medium transition-all cursor-pointer border ${
              typeFilter === t
                ? `${logTypeConfig[t].textColor} bg-white/[0.06] border-current`
                : "text-secondary bg-white/[0.02] border-border hover:bg-white/[0.04]"
            }`}
          >
            {logTypeConfig[t].icon}
            <span className="truncate">{logTypeConfig[t].label}</span>
            <span className="opacity-60 ml-auto">({logCounts[t] || 0})</span>
          </button>
        ))}
      </div>

      {/* Advanced Filters */}
      <Card padding="sm">
        <div className="flex flex-col lg:flex-row items-end gap-3">
          {/* Search */}
          <div className="relative w-full lg:w-80 flex items-center">
            <Search size={14} className="input-icon-left text-tertiary" />
            <input
              type="text"
              placeholder="Pesquisar mensagem, origem ou device..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full input-with-icon-left pr-3 py-2 rounded-xl bg-white/5 border border-border text-xs font-mono text-primary placeholder:text-tertiary focus:border-violet-500/40 transition-all"
            />
          </div>

          {/* Source Filter */}
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-2 rounded-xl bg-white/5 border border-border text-xs text-primary focus:border-violet-500/40 transition-all"
          >
            <option value="all">Todas as Origens</option>
            {uniqueSources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          {/* Date From */}
          <div className="flex items-center gap-1.5">
            <Clock size={12} className="text-tertiary" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-2 py-2 rounded-xl bg-white/5 border border-border text-xs text-primary focus:border-violet-500/40 transition-all"
            />
            <span className="text-tertiary text-xs">até</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-2 py-2 rounded-xl bg-white/5 border border-border text-xs text-primary focus:border-violet-500/40 transition-all"
            />
          </div>

          <span className="text-[10px] text-tertiary font-mono ml-auto">
            {filteredLogs.length} registros · {lastRefresh.toLocaleTimeString("pt-BR")}
          </span>
        </div>
      </Card>

      {/* Logs Table */}
      <Card padding="none">
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto custom-scrollbar">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-[10px] font-bold text-tertiary uppercase tracking-wider">
                <th className="px-4 py-3 w-40">Horário</th>
                <th className="px-4 py-3 w-20">Nível</th>
                <th className="px-4 py-3 w-28">Origem</th>
                <th className="px-4 py-3 w-28">Device</th>
                <th className="px-4 py-3">Mensagem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-xs font-mono">
              {filteredLogs.map((log, idx) => {
                const config = logTypeConfig[log.type as LogType] || logTypeConfig.info;
                return (
                  <tr key={log.id || idx} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-2.5 text-tertiary whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString("pt-BR", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={config.variant} dot className="text-[10px]">
                        {config.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-secondary font-sans font-medium">{log.source}</td>
                    <td className="px-4 py-2.5 text-tertiary font-sans">
                      {log.deviceSerial ? (
                        <span className="inline-flex items-center gap-1">
                          <Smartphone size={10} />
                          {log.deviceSerial}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`px-4 py-2.5 ${config.textColor}`}>{log.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {filteredLogs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-tertiary">
              <Terminal size={40} className="mb-2 opacity-30" />
              <p className="text-sm font-medium text-secondary">Nenhum log encontrado</p>
              <p className="text-xs">Ajuste os filtros ou aguarde novos eventos.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
