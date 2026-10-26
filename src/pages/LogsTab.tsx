// ============================================================
// Esfera v3 — Logs
// Console de eventos com filtros, exportação CSV e atualização automática
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import EmptyState from "../components/ui/EmptyState";
import { SegmentedControl } from "../components/ui/Tabs";
import type { LogType, LogEntry } from "../types";
import { api } from "../tauri";
import {
  Search,
  Trash2,
  Download,
  Terminal,
  RefreshCw,
  Smartphone,
  AlertTriangle,
} from "lucide-react";

const logTypeConfig: Record<
  LogType,
  { variant: "info" | "warning" | "danger" | "success" | "purple" | "neutral"; label: string; textColor: string }
> = {
  info: { variant: "info", label: "Info", textColor: "text-sky-600 dark:text-sky-400" },
  warning: { variant: "warning", label: "Aviso", textColor: "text-amber-600 dark:text-amber-400" },
  error: { variant: "danger", label: "Erro", textColor: "text-red-600 dark:text-red-400" },
  success: { variant: "success", label: "Sucesso", textColor: "text-emerald-600 dark:text-emerald-400" },
  dispatch: { variant: "success", label: "Disparo", textColor: "text-emerald-600 dark:text-emerald-400" },
  ban: { variant: "danger", label: "Bloqueio", textColor: "text-red-600 dark:text-red-400" },
  ai: { variant: "purple", label: "IA", textColor: "text-[var(--color-accent-light)]" },
  system: { variant: "neutral", label: "Sistema", textColor: "text-secondary" },
  device: { variant: "warning", label: "Aparelho", textColor: "text-amber-600 dark:text-amber-400" },
};

const ALL_LOG_TYPES: LogType[] = ["info", "warning", "error", "success", "dispatch", "ban", "ai", "system", "device"];

type LevelGroup = "all" | "error" | "warning" | "info";

const levelGroups: Record<LevelGroup, LogType[] | null> = {
  all: null,
  error: ["error", "ban"],
  warning: ["warning", "device"],
  info: ["info", "success", "dispatch", "ai", "system"],
};

export default function LogsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelGroup>("all");
  const [typeFilter, setTypeFilter] = useState<LogType | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logsList, setLogsList] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async (isMounted: () => boolean) => {
    if (!selectedCompanyId) {
      if (isMounted()) setLoading(false);
      return;
    }
    try {
      const data = await api<LogEntry[]>("get_logs", { companyId: selectedCompanyId });
      if (!isMounted()) return;
      setLogsList(data);
      setLoadError(false);
    } catch {
      if (!isMounted()) return;
      setLogsList([]);
      setLoadError(true);
    }
    if (isMounted()) {
      setLastRefresh(new Date());
      setLoading(false);
    }
  }, [selectedCompanyId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchLogs(() => mounted);
    return () => { mounted = false; };
  }, [fetchLogs]);

  // Auto-refresh every 5s
  useEffect(() => {
    if (!autoRefresh) return;
    let mounted = true;
    const interval = setInterval(() => fetchLogs(() => mounted), 5000);
    return () => { mounted = false; clearInterval(interval); };
  }, [autoRefresh, fetchLogs]);

  const handleManualRefresh = () => {
    setLoading(true);
    fetchLogs(() => true);
  };

  const q = searchQuery.toLowerCase();
  const filteredLogs = logsList
    .filter((l) => {
      const group = levelGroups[levelFilter];
      return !group || group.includes(l.type as LogType);
    })
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
        l.message.toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q) ||
        (l.deviceSerial && l.deviceSerial.toLowerCase().includes(q))
    );

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll, filteredLogs.length]);

  const countFor = (g: LevelGroup) => {
    const group = levelGroups[g];
    return group ? logsList.filter((l) => group.includes(l.type as LogType)).length : logsList.length;
  };

  const uniqueSources = [...new Set(logsList.map((l) => l.source))];
  const hasFilters = searchQuery || levelFilter !== "all" || typeFilter !== "all" || sourceFilter !== "all" || dateFrom || dateTo;

  const clearFilters = () => {
    setSearchQuery("");
    setLevelFilter("all");
    setTypeFilter("all");
    setSourceFilter("all");
    setDateFrom("");
    setDateTo("");
  };

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
    setConfirmClear(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Logs"
        description="Eventos de disparos, aparelhos, IA e sistema."
        icon={<Terminal size={18} />}
        actions={
          <>
            <Button
              variant={autoRefresh ? "primary" : "secondary"}
              size="sm"
              icon={<RefreshCw size={14} className={autoRefresh ? "animate-spin" : ""} />}
              onClick={() => setAutoRefresh(!autoRefresh)}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? "Atualização automática ligada" : "Atualização automática"}
            </Button>
            <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={handleExportCSV} disabled={filteredLogs.length === 0}>
              Exportar CSV
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirmClear(true)} disabled={logsList.length === 0}>
              Limpar logs
            </Button>
          </>
        }
      />

      <Card padding="sm">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <SegmentedControl
              value={levelFilter}
              onChange={(v) => { setLevelFilter(v); setTypeFilter("all"); }}
              items={[
                { id: "all", label: "Todos", count: countFor("all") },
                { id: "error", label: "Erros", count: countFor("error") },
                { id: "warning", label: "Avisos", count: countFor("warning") },
                { id: "info", label: "Informativos", count: countFor("info") },
              ]}
            />
            <div className="relative flex items-center w-full lg:max-w-sm">
              <Search size={14} className="input-icon-left text-tertiary" />
              <input
                type="text"
                aria-label="Buscar nos logs"
                placeholder="Buscar mensagem, origem ou aparelho"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full input-with-icon-left"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Tipo de evento"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as LogType | "all")}
              className="w-auto"
            >
              <option value="all">Todos os tipos</option>
              {ALL_LOG_TYPES.map((t) => (
                <option key={t} value={t}>{logTypeConfig[t].label}</option>
              ))}
            </select>
            <select
              aria-label="Origem"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-auto"
            >
              <option value="all">Todas as origens</option>
              {uniqueSources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              type="date"
              aria-label="Data inicial"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-auto"
            />
            <span className="text-xs text-tertiary">até</span>
            <input
              type="date"
              aria-label="Data final"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-auto"
            />
            <label className="ml-1 inline-flex items-center gap-2 text-xs text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="w-auto"
              />
              Rolar até o fim
            </label>
            <span className="ml-auto text-xs text-tertiary tabular-nums">
              {filteredLogs.length} de {logsList.length} registros · atualizado às {lastRefresh.toLocaleTimeString("pt-BR")}
            </span>
          </div>
        </div>
      </Card>

      {loadError && !loading && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3">
          <span className="flex items-center gap-2 text-[0.8125rem] text-red-600 dark:text-red-400">
            <AlertTriangle size={15} /> Não foi possível carregar os logs.
          </span>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={handleManualRefresh}>
            Tentar de novo
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 rounded-lg border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredLogs.length === 0 ? (
        !loadError && (
          <EmptyState
            icon={<Terminal size={18} />}
            title={logsList.length === 0 ? "Nenhum log ainda" : "Nenhum log encontrado"}
            description={logsList.length === 0 ? "Os eventos aparecerão aqui assim que ocorrerem." : "Ajuste ou limpe os filtros."}
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clearFilters}>Limpar filtros</Button>
              ) : (
                <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={handleManualRefresh}>Atualizar</Button>
              )
            }
          />
        )
      ) : (
        <Card padding="none">
          <div ref={scrollRef} className="overflow-auto max-h-[60vh] custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-xs font-medium text-tertiary">
                  <th className="px-4 py-2.5 w-36 font-medium">Horário</th>
                  <th className="px-4 py-2.5 w-28 font-medium">Nível</th>
                  <th className="px-4 py-2.5 w-28 font-medium">Origem</th>
                  <th className="px-4 py-2.5 w-32 font-medium">Aparelho</th>
                  <th className="px-4 py-2.5 font-medium">Mensagem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-[0.8125rem]">
                {filteredLogs.map((log, idx) => {
                  const config = logTypeConfig[log.type as LogType] || logTypeConfig.info;
                  return (
                    <tr key={log.id || idx} className="hover:bg-hover transition-colors align-top">
                      <td className="px-4 py-2 font-mono text-xs text-tertiary whitespace-nowrap tabular-nums">
                        {new Date(log.timestamp).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={config.variant} dot>
                          {config.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-secondary">{log.source}</td>
                      <td className="px-4 py-2 text-tertiary">
                        {log.deviceSerial ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs">
                            <Smartphone size={11} />
                            {log.deviceSerial}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`px-4 py-2 font-mono text-xs leading-relaxed break-words ${log.type === "error" || log.type === "ban" ? config.textColor : "text-primary"}`}>
                        {log.message}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Limpar logs"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>Cancelar</Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={handleClearLogs}>Limpar logs</Button>
          </>
        }
      >
        <p className="text-[0.8125rem] text-secondary">
          Todos os {logsList.length} registros desta empresa serão removidos. Esta ação não pode ser desfeita.
        </p>
      </Modal>
    </div>
  );
}
