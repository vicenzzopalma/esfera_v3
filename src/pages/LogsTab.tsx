// ============================================================
// Esfera v3 — Logs
// Console de eventos com filtros, exportação CSV e atualização automática
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { parseDbDate, apiErrorText } from "../hooks/useQueries";
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

/** O backend (AuditLog) devolve o tipo em "logType" e o horário em UTC sem fuso. */
type RawLog = Partial<LogEntry> & { logType?: string };
type ViewLog = LogEntry & { time: Date | null };

/** get_logs devolve no máximo os 100 eventos mais recentes. */
const BACKEND_LOG_LIMIT = 100;

function normalizeLog(raw: RawLog, idx: number): ViewLog {
  const type = String(raw.type ?? raw.logType ?? "info").toLowerCase();
  return {
    id: raw.id ?? -(idx + 1),
    timestamp: raw.timestamp ?? "",
    type: (type in logTypeConfig ? type : "info") as LogType,
    message: raw.message ?? "",
    source: raw.source ?? "Sistema",
    companyId: raw.companyId ?? 0,
    deviceSerial: raw.deviceSerial,
    campaignId: raw.campaignId,
    time: parseDbDate(raw.timestamp),
  };
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export default function LogsTab() {
  const { user, selectedCompanyId } = useAuth();
  const canClear = user?.role === "master" || user?.role === "gestor";
  const [searchQuery, setSearchQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelGroup>("all");
  const [typeFilter, setTypeFilter] = useState<LogType | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logsList, setLogsList] = useState<ViewLog[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Cada leitura tem um número; resposta de leitura antiga (ou de outra empresa) é descartada.
  const seqRef = useRef(0);

  const fetchLogs = useCallback(async (showSpinner: boolean) => {
    const seq = ++seqRef.current;
    if (!selectedCompanyId) {
      setLogsList([]);
      setLoading(false);
      return;
    }
    if (showSpinner) setLoading(true);
    try {
      const data = await api<RawLog[]>("get_logs", { companyId: selectedCompanyId });
      if (seq !== seqRef.current) return;
      setLogsList((data || []).map(normalizeLog));
      setLoadError(null);
      setLastRefresh(new Date());
    } catch (err) {
      if (seq !== seqRef.current) return;
      // Mantém a última lista na tela; só avisa que a leitura falhou.
      setLoadError(apiErrorText(err, "Não foi possível carregar os logs."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [selectedCompanyId]);

  // Troca de empresa: limpa a lista anterior antes de ler a nova.
  useEffect(() => {
    setLogsList([]);
    setLastRefresh(null);
    setLoadError(null);
    fetchLogs(true);
    return () => { seqRef.current++; };
  }, [fetchLogs]);

  // Atualização automática a cada 5 s, pausada com a janela minimizada.
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (!document.hidden) fetchLogs(false);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const handleManualRefresh = () => fetchLogs(true);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const group = levelGroups[levelFilter];
    // Datas do filtro são dias do calendário local.
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return logsList.filter((l) => {
      if (group && !group.includes(l.type)) return false;
      if (typeFilter !== "all" && l.type !== typeFilter) return false;
      if (sourceFilter !== "all" && l.source !== sourceFilter) return false;
      if ((fromTs !== null || toTs !== null) && l.time) {
        const ts = l.time.getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      if (!q) return true;
      return (
        l.message.toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q) ||
        (!!l.deviceSerial && l.deviceSerial.toLowerCase().includes(q))
      );
    });
  }, [logsList, searchQuery, levelFilter, typeFilter, sourceFilter, dateFrom, dateTo]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll, filteredLogs.length]);

  const countFor = (g: LevelGroup) => {
    const group = levelGroups[g];
    return group ? logsList.filter((l) => group.includes(l.type)).length : logsList.length;
  };

  const uniqueSources = useMemo(() => [...new Set(logsList.map((l) => l.source))].sort((a, b) => a.localeCompare(b, "pt-BR")), [logsList]);
  const showDeviceColumn = logsList.some((l) => !!l.deviceSerial);
  const hasFilters = !!(searchQuery || levelFilter !== "all" || typeFilter !== "all" || sourceFilter !== "all" || dateFrom || dateTo);
  const atBackendLimit = logsList.length >= BACKEND_LOG_LIMIT;

  const clearFilters = () => {
    setSearchQuery("");
    setLevelFilter("all");
    setTypeFilter("all");
    setSourceFilter("all");
    setDateFrom("");
    setDateTo("");
  };

  // CSV para o Excel em português: separador ";" e BOM UTF-8 (acentos corretos).
  const handleExportCSV = () => {
    const headers = ["Horário", "Nível", "Origem", ...(showDeviceColumn ? ["Aparelho"] : []), "Mensagem"];
    const rows = filteredLogs.map((l) => [
      l.time ? l.time.toLocaleString("pt-BR") : l.timestamp,
      logTypeConfig[l.type]?.label || l.type,
      l.source,
      ...(showDeviceColumn ? [l.deviceSerial || ""] : []),
      l.message,
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(";")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    a.href = url;
    a.download = `esfera_logs_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleClearLogs = async () => {
    if (!selectedCompanyId) return;
    setClearing(true);
    setClearError(null);
    try {
      await api("clear_logs", { companyId: selectedCompanyId });
      seqRef.current++;
      setLogsList([]);
      setConfirmClear(false);
    } catch (err) {
      setClearError(apiErrorText(err, "Não foi possível limpar os logs."));
    } finally {
      setClearing(false);
    }
  };

  const formatTime = (l: ViewLog) =>
    l.time
      ? l.time.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : l.timestamp || "—";

  const thCls = "sticky top-0 z-10 border-b border-border bg-card px-4 py-2.5 font-medium";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Logs"
        description="Eventos da empresa: campanhas, aparelhos, automações e sistema."
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
            {canClear && (
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => { setClearError(null); setConfirmClear(true); }}
                disabled={logsList.length === 0}
              >
                Limpar logs
              </Button>
            )}
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
                placeholder="Buscar mensagem ou origem"
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
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-auto"
            />
            <span className="text-xs text-tertiary">até</span>
            <input
              type="date"
              aria-label="Data final"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-auto"
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Limpar filtros
              </Button>
            )}
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
              {filteredLogs.length} de {logsList.length} registros
              {lastRefresh && ` · atualizado às ${lastRefresh.toLocaleTimeString("pt-BR")}`}
            </span>
          </div>
          {atBackendLimit && (
            <p className="text-xs text-tertiary">Mostrando os {BACKEND_LOG_LIMIT} eventos mais recentes.</p>
          )}
        </div>
      </Card>

      {loadError && !loading && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-red-600 dark:text-red-400">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="break-words">
              {logsList.length > 0 ? "A última atualização falhou; mostrando os registros anteriores." : "Não foi possível carregar os logs."}
              <span className="block text-xs opacity-80">{loadError}</span>
            </span>
          </span>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={handleManualRefresh}>
            Tentar de novo
          </Button>
        </div>
      )}

      {loading && logsList.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 rounded-lg border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredLogs.length === 0 ? (
        !(loadError && logsList.length === 0) && (
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
            <table className="w-full text-left border-separate border-spacing-0">
              <thead>
                <tr className="text-xs font-medium text-tertiary">
                  <th className={`${thCls} w-36`}>Horário</th>
                  <th className={`${thCls} w-28`}>Nível</th>
                  <th className={`${thCls} w-36`}>Origem</th>
                  {showDeviceColumn && <th className={`${thCls} w-32`}>Aparelho</th>}
                  <th className={thCls}>Mensagem</th>
                </tr>
              </thead>
              <tbody className="text-[0.8125rem]">
                {filteredLogs.map((log) => {
                  const config = logTypeConfig[log.type] || logTypeConfig.info;
                  return (
                    <tr key={log.id} className="hover:bg-hover transition-colors align-top">
                      <td className="border-b border-border px-4 py-2 font-mono text-xs text-tertiary whitespace-nowrap tabular-nums">
                        {formatTime(log)}
                      </td>
                      <td className="border-b border-border px-4 py-2">
                        <Badge variant={config.variant} dot>
                          {config.label}
                        </Badge>
                      </td>
                      <td className="border-b border-border px-4 py-2 text-secondary">{log.source}</td>
                      {showDeviceColumn && (
                        <td className="border-b border-border px-4 py-2 text-tertiary">
                          {log.deviceSerial ? (
                            <span className="inline-flex items-center gap-1 font-mono text-xs">
                              <Smartphone size={11} />
                              {log.deviceSerial}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                      <td className={`border-b border-border px-4 py-2 font-mono text-xs leading-relaxed break-words ${log.type === "error" || log.type === "ban" ? config.textColor : "text-primary"}`}>
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
        onClose={() => { if (!clearing) setConfirmClear(false); }}
        title="Limpar logs"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)} disabled={clearing}>Cancelar</Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={handleClearLogs} loading={clearing}>Limpar logs</Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[0.8125rem] text-secondary">
            Todos os registros desta empresa serão removidos da lista. Esta ação não pode ser desfeita.
          </p>
          {clearError && (
            <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400">
              {clearError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
