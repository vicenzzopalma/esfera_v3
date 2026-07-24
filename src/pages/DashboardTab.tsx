// ============================================================
// Esfera v3 — Dashboard Tab
// Painel de indicadores com KPIs, atividade recente e status
// ============================================================

import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import { useDashboardKpis, useDevices } from "../hooks/useQueries";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import {
  BarChart3,
  Smartphone,
  MessageSquare,
  Clock,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Activity,
  Shield,
  Zap,
} from "lucide-react";

export default function DashboardTab() {
  const { selectedCompanyId } = useAuth();
  const { canAccessDashboard } = usePermissions();
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const { data: kpis, isLoading: kpisLoading, refetch: refetchKpis } = useDashboardKpis(selectedCompanyId);
  const { data: devices, isLoading: devsLoading, refetch: refetchDevs } = useDevices(selectedCompanyId);
  const loading = kpisLoading || devsLoading;

  useEffect(() => {
    if (!loading) setLastRefresh(new Date());
  }, [kpisLoading, devsLoading]);

  const online = devices?.filter((d) => d.status === "online").length ?? 0;
  const total = devices?.length ?? 0;
  const deviceStatus = { online, offline: total - online, total };

  const handleRefresh = () => { refetchKpis(); refetchDevs(); };

  if (!canAccessDashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20">
          <BarChart3 size={32} className="text-red-400" />
        </div>
        <h2 className="text-lg font-bold text-primary">Acesso Restrito</h2>
        <p className="text-sm text-tertiary text-center max-w-sm">
          Você não tem permissão para acessar o dashboard de indicadores.
        </p>
      </div>
    );
  }

  const kpiCards = [
    {
      label: "Mensagens Enviadas Hoje",
      value: kpis?.sentToday ?? 0,
      icon: <MessageSquare size={22} />,
      color: "from-emerald-600 to-green-500",
      shadowColor: "shadow-emerald-500/20",
      trend: "+12%",
      trendUp: true,
    },
    {
      label: "Contatos Pendentes",
      value: kpis?.pendingContacts ?? 0,
      icon: <Clock size={22} />,
      color: "from-amber-600 to-orange-500",
      shadowColor: "shadow-amber-500/20",
      trend: "-5%",
      trendUp: false,
    },
    {
      label: "Chips Bloqueados",
      value: kpis?.blockedChips ?? 0,
      icon: <AlertTriangle size={22} />,
      color: "from-red-600 to-rose-500",
      shadowColor: "shadow-red-500/20",
      trend: "+2",
      trendUp: true,
    },
    {
      label: "Alterações Hoje",
      value: kpis?.configChangesToday ?? 0,
      icon: <Activity size={22} />,
      color: "from-violet-600 to-indigo-500",
      shadowColor: "shadow-violet-500/20",
      trend: "Normal",
      trendUp: true,
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-primary tracking-tight">
            Dashboard
          </h2>
          <p className="text-sm text-tertiary mt-1">
            Visão geral do sistema — Indicadores em tempo real
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-tertiary font-mono">
            Atualizado: {lastRefresh.toLocaleTimeString("pt-BR")}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={loading}
          >
            <RefreshCw size={14} />
            Atualizar
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((kpi) => (
          <Card key={kpi.label} hover glow padding="md">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-tertiary font-medium uppercase tracking-wider mb-2">
                  {kpi.label}
                </p>
                <p className="text-3xl font-extrabold text-primary tracking-tight">
                  {loading ? (
                    <span className="inline-block w-12 h-8 bg-white/5 rounded animate-pulse" />
                  ) : (
                    kpi.value.toLocaleString("pt-BR")
                  )}
                </p>
              </div>
              <div className={`flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${kpi.color} ${kpi.shadowColor} shadow-lg`}>
                <span className="text-white">{kpi.icon}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-3">
              {kpi.trendUp ? (
                <TrendingUp size={12} className="text-emerald-400" />
              ) : (
                <TrendingDown size={12} className="text-red-400" />
              )}
              <span className={`text-xs font-semibold ${kpi.trendUp ? "text-emerald-400" : "text-red-400"}`}>
                {kpi.trend}
              </span>
              <span className="text-[10px] text-tertiary">vs. ontem</span>
            </div>
          </Card>
        ))}
      </div>

      {/* Status dos Dispositivos + Atividade Recente */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Status dos Dispositivos */}
        <Card padding="md" className="lg:col-span-1">
          <h3 className="text-sm font-semibold text-primary flex items-center gap-2 mb-4">
            <Smartphone size={16} className="text-violet-400" />
            Status dos Dispositivos
          </h3>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 bg-white/5 rounded animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Barra de status */}
              <div className="flex gap-1 h-3 rounded-full overflow-hidden bg-white/5">
                {deviceStatus.total > 0 && (
                  <>
                    <div
                      className="bg-gradient-to-r from-emerald-500 to-green-400 rounded-full"
                      style={{ width: `${(deviceStatus.online / deviceStatus.total) * 100}%` }}
                    />
                    <div
                      className="bg-gradient-to-r from-red-500 to-rose-400 rounded-full"
                      style={{ width: `${(deviceStatus.offline / deviceStatus.total) * 100}%` }}
                    />
                  </>
                )}
              </div>

              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-xs text-secondary">Online</span>
                  </div>
                  <Badge variant="success">{deviceStatus.online}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                    <span className="text-xs text-secondary">Offline</span>
                  </div>
                  <Badge variant="danger">{deviceStatus.offline}</Badge>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-xs font-semibold text-primary">Total</span>
                  <Badge variant="purple">{deviceStatus.total}</Badge>
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Atividade Recente */}
        <Card padding="md" className="lg:col-span-2">
          <h3 className="text-sm font-semibold text-primary flex items-center gap-2 mb-4">
            <Zap size={16} className="text-violet-400" />
            Atividade Recente
          </h3>

          <div className="space-y-3">
            {[
              { time: "14:32", event: "Dispositivo Galaxy A54 conectado", type: "success" as const },
              { time: "14:28", event: "Campanha 'Cobrança Junior' iniciada — 45 contatos", type: "info" as const },
              { time: "14:15", event: "Chip +5511999887766 marcado como restrito 24h", type: "warning" as const },
              { time: "13:50", event: "Automação 'Follow-up Senior' executada — 12 mensagens", type: "info" as const },
              { time: "13:22", event: "Configurações da empresa REALESS atualizadas", type: "neutral" as const },
              { time: "12:45", event: "Chip +5511988776655 banido por wa-ban", type: "danger" as const },
            ].map((item, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-border hover:bg-white/[0.04] transition-colors"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.05] shrink-0 mt-0.5">
                  <span className="text-[10px] font-mono text-tertiary">{item.time}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-primary">{item.event}</p>
                </div>
                <Badge
                  variant={
                    item.type === "success" ? "success" :
                    item.type === "danger" ? "danger" :
                    item.type === "warning" ? "warning" :
                    item.type === "info" ? "info" : "neutral"
                  }
                  className="shrink-0"
                >
                  {item.type === "success" ? "OK" :
                   item.type === "danger" ? "Ban" :
                   item.type === "warning" ? "Alert" :
                   item.type === "info" ? "Info" : "Cfg"}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Telemetria de Hardware & Licenciamento C++ HPC */}
      <Card padding="md" glow>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 shadow-lg shadow-violet-500/20">
                <Shield size={20} className="text-white" />
              </div>
              <div>
                <p className="text-sm font-semibold text-primary">Telemetria & Licenciamento C++ HPC</p>
                <p className="text-xs text-tertiary">
                  Engine Nativa Windows · Monitoramento de Kernel e Barramento USB
                </p>
              </div>
            </div>
            <Badge variant="purple" className="gap-1">
              <Activity size={12} />
              C++ HPC Active
            </Badge>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border">
            <div className="p-3 rounded-xl bg-white/5 border border-border">
              <p className="text-[10px] text-tertiary uppercase font-mono">Assinatura Hardware UUID (SHA-256)</p>
              <p className="text-xs font-mono font-bold text-violet-300 mt-1 truncate">ESFERA-HWID-8F9A-4B2C-1D3E</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-border">
              <p className="text-[10px] text-tertiary uppercase font-mono">Instruções CPU Utilizadas</p>
              <p className="text-xs font-mono font-bold text-emerald-300 mt-1">AVX2 + SSE4.2 + Multi-core</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-border">
              <p className="text-[10px] text-tertiary uppercase font-mono">Taxa Média de Vazão</p>
              <p className="text-xs font-mono font-bold text-amber-300 mt-1">12.4 msgs/min (Delay Gaussiano)</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
