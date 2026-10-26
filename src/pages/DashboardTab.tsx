// ============================================================
// Esfera v3 — Dashboard
// KPIs reais da empresa e status dos aparelhos
// ============================================================

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import { useDashboardKpis, useDevices } from "../hooks/useQueries";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import {
  BarChart3,
  Smartphone,
  MessageSquare,
  Clock,
  AlertTriangle,
  RefreshCw,
  Activity,
  ShieldAlert,
} from "lucide-react";

export default function DashboardTab() {
  const { selectedCompanyId } = useAuth();
  const { canAccessDashboard } = usePermissions();
  const navigate = useNavigate();
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const { data: kpis, isLoading: kpisLoading, isError: kpisError, refetch: refetchKpis } = useDashboardKpis(selectedCompanyId);
  const { data: devices, isLoading: devsLoading, isError: devsError, refetch: refetchDevs } = useDevices(selectedCompanyId);
  const loading = kpisLoading || devsLoading;
  const hasError = kpisError || devsError;

  useEffect(() => {
    if (!loading) setLastRefresh(new Date());
  }, [kpisLoading, devsLoading]);

  const online = devices?.filter((d) => d.status === "online").length ?? 0;
  const total = devices?.length ?? 0;
  const offline = total - online;

  const handleRefresh = () => { refetchKpis(); refetchDevs(); };

  if (!canAccessDashboard) {
    return (
      <EmptyState
        className="mt-10"
        icon={<ShieldAlert size={18} />}
        title="Acesso restrito"
        description="Você não tem permissão para ver os indicadores desta empresa."
      />
    );
  }

  const kpiCards = [
    {
      label: "Mensagens enviadas hoje",
      value: kpis?.sentToday ?? 0,
      icon: <MessageSquare size={14} />,
      tone: "accent" as const,
    },
    {
      label: "Contatos pendentes",
      value: kpis?.pendingContacts ?? 0,
      icon: <Clock size={14} />,
      tone: "warning" as const,
    },
    {
      label: "Chips bloqueados",
      value: kpis?.blockedChips ?? 0,
      icon: <AlertTriangle size={14} />,
      tone: "danger" as const,
    },
    {
      label: "Alterações hoje",
      value: kpis?.configChangesToday ?? 0,
      icon: <Activity size={14} />,
      tone: "success" as const,
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Dashboard"
        description={`Atualizado às ${lastRefresh.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
        icon={<BarChart3 size={16} />}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={loading}
            icon={<RefreshCw size={13} />}
          >
            Atualizar
          </Button>
        }
      />

      {hasError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-[0.8125rem] text-red-600 dark:text-red-400"
        >
          <span>Não foi possível carregar alguns indicadores.</span>
          <Button variant="danger" size="sm" onClick={handleRefresh}>
            Tentar de novo
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((kpi) => (
          <StatCard
            key={kpi.label}
            label={kpi.label}
            icon={kpi.icon}
            tone={kpi.tone}
            value={
              loading ? (
                <span className="skeleton inline-block h-6 w-14 align-middle" />
              ) : (
                kpi.value.toLocaleString("pt-BR")
              )
            }
          />
        ))}
      </div>

      <Card padding="md">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-primary flex items-center gap-2">
            <Smartphone size={15} className="text-tertiary shrink-0" />
            Aparelhos
          </h2>
          {!loading && total > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate("/devices")}>
              Ver aparelhos
            </Button>
          )}
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="skeleton h-2 w-full" />
            <div className="skeleton h-5 w-40" />
            <div className="skeleton h-5 w-32" />
          </div>
        ) : total === 0 ? (
          <EmptyState
            icon={<Smartphone size={18} />}
            title="Nenhum aparelho cadastrado"
            description="Conecte um aparelho para acompanhar o status aqui."
            action={
              <Button size="sm" onClick={() => navigate("/devices")}>
                Ir para aparelhos
              </Button>
            }
          />
        ) : (
          <div className="space-y-4 max-w-xl">
            <div
              className="flex h-2 rounded-full overflow-hidden bg-secondary"
              role="img"
              aria-label={`${online} de ${total} aparelhos online`}
            >
              <div className="bg-emerald-500" style={{ width: `${(online / total) * 100}%` }} />
              <div className="bg-red-500/70" style={{ width: `${(offline / total) * 100}%` }} />
            </div>

            <div className="space-y-2.5 text-[0.8125rem]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-secondary">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  Online
                </span>
                <Badge variant="success">{online}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-secondary">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  Offline
                </span>
                <Badge variant="danger">{offline}</Badge>
              </div>
              <div className="flex items-center justify-between pt-2.5 border-t border-border">
                <span className="font-medium text-primary">Total</span>
                <Badge variant="neutral">{total}</Badge>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
