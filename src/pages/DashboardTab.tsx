// ============================================================
// Esfera v3 — Dashboard
// O que importa para a operação de disparo: envios do dia, falhas,
// descadastros, janela de envio, ritmo da rede, chips em freio,
// aparelhos fora do ar e campanhas em andamento.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import {
  useDashboardKpis,
  useDevices,
  useCampaigns,
  useNetworkStatus,
  useOptOuts,
  parseDbDate,
  isSameLocalDay,
  sendWindowState,
  type NetworkChipStatus,
} from "../hooks/useQueries";
import type { Campaign, Device, DeviceStatus } from "../types";
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
  ShieldAlert,
  Ban,
  Gauge,
  Megaphone,
  XCircle,
} from "lucide-react";

const ONLINE_STATUSES: DeviceStatus[] = ["online", "online_agent"];
const ATTENTION_STATUSES: DeviceStatus[] = ["degraded", "connecting", "error"];

const DEVICE_STATUS_LABEL: Partial<Record<DeviceStatus, string>> = {
  degraded: "Sem comunicação",
  connecting: "Conectando",
  error: "Com erro",
  offline: "Offline",
};

const CHIP_STATE: Record<string, { label: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
  pausado: { label: "Em freio", variant: "danger" },
  reduzido: { label: "Ritmo reduzido", variant: "warning" },
  indisponivel: { label: "Sem leitura de respostas", variant: "neutral" },
  normal: { label: "Normal", variant: "success" },
};

function deviceName(d: Device) {
  const name = d.name && d.name.trim() ? d.name.trim() : d.model || d.serial;
  return d.deviceNumber ? `${name} · #${d.deviceNumber}` : name;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function formatWait(seconds: number) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min`;
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-[var(--color-accent)]";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[0.75rem]">
        <span className="text-secondary">{label}</span>
        <span className="tabular-nums text-primary">
          {value.toLocaleString("pt-BR")}
          <span className="text-tertiary"> / {max > 0 ? max.toLocaleString("pt-BR") : "—"}</span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SectionTitle({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
        <span className="shrink-0 text-tertiary">{icon}</span>
        {children}
      </h2>
      {action}
    </div>
  );
}

function SkeletonLines() {
  return (
    <div className="space-y-3">
      <div className="skeleton h-2 w-full" />
      <div className="skeleton h-5 w-40" />
      <div className="skeleton h-5 w-32" />
    </div>
  );
}

export default function DashboardTab() {
  const { user, selectedCompanyId } = useAuth();
  const { canAccessDashboard } = usePermissions();
  const navigate = useNavigate();
  const now = useNow(30_000);

  // Sem permissão, nenhuma consulta é feita.
  const cid = canAccessDashboard ? selectedCompanyId : null;
  const kpisQ = useDashboardKpis(cid);
  const devicesQ = useDevices(cid);
  const campaignsQ = useCampaigns(cid, { refetchInterval: 30_000 });
  const networkQ = useNetworkStatus(cid != null);
  const optOutsQ = useOptOuts(cid);

  const canOpenCampaigns = user?.role === "master" || user?.role === "gestor";

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

  const queries = [kpisQ, devicesQ, campaignsQ, networkQ, optOutsQ];
  const refreshing = queries.some((q) => q.isFetching);
  const hasError = kpisQ.isError || devicesQ.isError || campaignsQ.isError;
  const lastUpdate = Math.max(...queries.map((q) => q.dataUpdatedAt || 0));
  const handleRefresh = () => queries.forEach((q) => q.refetch());

  // ── Aparelhos ──
  const devices = devicesQ.data ?? [];
  const onlineDevices = devices.filter((d) => ONLINE_STATUSES.includes(d.status));
  const attentionDevices = devices.filter((d) => ATTENTION_STATUSES.includes(d.status));
  const offlineDevices = devices.filter((d) => !ONLINE_STATUSES.includes(d.status) && !ATTENTION_STATUSES.includes(d.status));
  const problemDevices = [...attentionDevices, ...offlineDevices];

  // ── Campanhas ──
  const campaigns = campaignsQ.data ?? [];
  const activeCampaigns = campaigns
    .filter((c) => c.status === "running" || c.status === "paused")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "running" ? -1 : 1));
  const runningCount = activeCampaigns.filter((c) => c.status === "running").length;
  const activeFailures = activeCampaigns.reduce((acc, c) => acc + (c.failedCount || 0), 0);

  // ── Descadastros ──
  const optOuts = optOutsQ.data ?? [];
  const optOutsToday = optOuts.filter((o) => {
    const d = parseDbDate(o.createdAt);
    return d ? isSameLocalDay(d, now) : false;
  }).length;

  // ── Rede ──
  const network = networkQ.data;
  // Master vê os chips de todas as empresas; aqui ficam só os desta empresa.
  const companyDeviceIds = new Set(devices.map((d) => d.id));
  const chips: NetworkChipStatus[] = (network?.chips ?? []).filter(
    (c) => !devicesQ.data || companyDeviceIds.has(c.deviceId)
  );
  const chipsByState = (state: string) => chips.filter((c) => c.state === state);
  const brakedChips = [...chipsByState("pausado"), ...chipsByState("reduzido")];
  // Taxa de resposta da empresa: média dos chips com leitura, ponderada pelo tamanho da amostra.
  const ratedChips = chips.filter((c) => c.replyRate != null && c.sample > 0);
  const replySample = ratedChips.reduce((acc, c) => acc + c.sample, 0);
  const replyRate = replySample > 0 ? ratedChips.reduce((acc, c) => acc + (c.replyRate ?? 0) * c.sample, 0) / replySample : null;
  const sendWindow = sendWindowState(now);
  const kpis = kpisQ.data;

  const kpiValue = (loading: boolean, value: number) =>
    loading ? <span className="skeleton inline-block h-6 w-14 align-middle" /> : value.toLocaleString("pt-BR");

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Dashboard"
        description={
          lastUpdate > 0
            ? `Atualizado às ${new Date(lastUpdate).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · atualiza sozinho`
            : "Carregando indicadores..."
        }
        icon={<BarChart3 size={16} />}
        actions={
          <Button variant="secondary" size="sm" onClick={handleRefresh} loading={refreshing} icon={<RefreshCw size={13} />}>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Enviadas hoje"
          icon={<MessageSquare size={14} />}
          tone="accent"
          value={kpiValue(kpisQ.isLoading, kpis?.sentToday ?? 0)}
          hint="mensagens desta empresa"
        />
        <StatCard
          label="Falhas"
          icon={<XCircle size={14} />}
          tone={activeFailures > 0 ? "danger" : "neutral"}
          value={kpiValue(campaignsQ.isLoading, activeFailures)}
          hint={activeCampaigns.length > 0 ? `nas ${activeCampaigns.length} campanhas ativas` : "nenhuma campanha ativa"}
        />
        <StatCard
          label="Na fila de envio"
          icon={<Clock size={14} />}
          tone="warning"
          value={kpiValue(kpisQ.isLoading, kpis?.pendingContacts ?? 0)}
          hint="contatos pendentes"
        />
        <StatCard
          label="Descadastros hoje"
          icon={<Ban size={14} />}
          tone="info"
          value={kpiValue(optOutsQ.isLoading, optOutsToday)}
          hint={optOutsQ.isError ? "não foi possível ler a lista" : `${optOuts.length.toLocaleString("pt-BR")} no total`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Rede de envio */}
        <Card padding="md">
          <SectionTitle
            icon={<Gauge size={15} />}
            action={
              <Badge variant={sendWindow.open ? "success" : "neutral"} dot>
                Janela {sendWindow.text.charAt(0).toLowerCase() + sendWindow.text.slice(1)}
              </Badge>
            }
          >
            Rede de envio
          </SectionTitle>

          {networkQ.isLoading ? (
            <SkeletonLines />
          ) : networkQ.isError || !network ? (
            <p className="text-[0.8125rem] text-secondary">Não foi possível ler o ritmo da rede agora.</p>
          ) : (
            <div className="space-y-4">
              {network.waitSeconds > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.75rem] text-amber-700 dark:text-amber-400">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Teto da rede atingido. Os envios voltam em cerca de {formatWait(network.waitSeconds)}.
                  </span>
                </div>
              )}
              <div className="space-y-3">
                <Meter label="Última hora" value={network.sentLastHour} max={network.hourly} />
                <Meter label="Hoje" value={network.sentToday} max={network.daily} />
              </div>
              <p className="text-[0.75rem] text-tertiary">
                Limites compartilhados por todos os aparelhos deste computador.
              </p>

              <div className="border-t border-border pt-3">
                {replyRate !== null && (
                  <p className="mb-2 text-[0.75rem] text-secondary">
                    Taxa de resposta:{" "}
                    <span className="font-semibold tabular-nums text-primary">
                      {replyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                    </span>{" "}
                    <span className="text-tertiary">em {replySample.toLocaleString("pt-BR")} envios avaliados</span>
                  </p>
                )}
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[0.75rem]">
                  <span className="mr-1 text-secondary">Chips:</span>
                  <Badge variant="success">{chipsByState("normal").length} normais</Badge>
                  {chipsByState("reduzido").length > 0 && <Badge variant="warning">{chipsByState("reduzido").length} com ritmo reduzido</Badge>}
                  {chipsByState("pausado").length > 0 && <Badge variant="danger">{chipsByState("pausado").length} em freio</Badge>}
                  {(kpis?.blockedChips ?? 0) > 0 && <Badge variant="danger">{kpis?.blockedChips} bloqueados ou restritos</Badge>}
                  {chipsByState("indisponivel").length > 0 && (
                    <Badge variant="neutral">{chipsByState("indisponivel").length} sem leitura de respostas</Badge>
                  )}
                </div>
                {brakedChips.length > 0 ? (
                  <ul className="space-y-1.5">
                    {brakedChips.slice(0, 5).map((c) => {
                      const st = CHIP_STATE[c.state] ?? CHIP_STATE.normal;
                      return (
                        <li key={c.chipId} className="flex items-start justify-between gap-3 text-[0.75rem]">
                          <span className="min-w-0">
                            <span className="font-medium text-primary">{c.deviceName || `Aparelho ${c.deviceId}`}</span>
                            {c.reason && <span className="block truncate text-tertiary">{c.reason}</span>}
                          </span>
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </li>
                      );
                    })}
                    {brakedChips.length > 5 && (
                      <li className="text-[0.75rem] text-tertiary">e mais {brakedChips.length - 5}.</li>
                    )}
                  </ul>
                ) : (
                  chips.length > 0 && <p className="text-[0.75rem] text-tertiary">Nenhum chip em freio por falta de respostas.</p>
                )}
              </div>
            </div>
          )}
        </Card>

        {/* Aparelhos */}
        <Card padding="md">
          <SectionTitle
            icon={<Smartphone size={15} />}
            action={
              !devicesQ.isLoading && devices.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => navigate("/devices")}>
                  Ver aparelhos
                </Button>
              ) : undefined
            }
          >
            Aparelhos
          </SectionTitle>

          {devicesQ.isLoading ? (
            <SkeletonLines />
          ) : devices.length === 0 ? (
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
            <div className="space-y-4">
              <div
                className="flex h-2 overflow-hidden rounded-full bg-secondary"
                role="img"
                aria-label={`${onlineDevices.length} de ${devices.length} aparelhos online`}
              >
                <div className="bg-emerald-500" style={{ width: `${(onlineDevices.length / devices.length) * 100}%` }} />
                <div className="bg-amber-500" style={{ width: `${(attentionDevices.length / devices.length) * 100}%` }} />
                <div className="bg-red-500/70" style={{ width: `${(offlineDevices.length / devices.length) * 100}%` }} />
              </div>

              <div className="grid grid-cols-3 gap-2 text-[0.75rem]">
                <div className="rounded-lg border border-border px-3 py-2">
                  <span className="flex items-center gap-1.5 text-secondary">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" /> Online
                  </span>
                  <p className="mt-0.5 text-base font-semibold tabular-nums text-primary">{onlineDevices.length}</p>
                </div>
                <div className="rounded-lg border border-border px-3 py-2">
                  <span className="flex items-center gap-1.5 text-secondary">
                    <span className="h-2 w-2 rounded-full bg-amber-500" /> Atenção
                  </span>
                  <p className="mt-0.5 text-base font-semibold tabular-nums text-primary">{attentionDevices.length}</p>
                </div>
                <div className="rounded-lg border border-border px-3 py-2">
                  <span className="flex items-center gap-1.5 text-secondary">
                    <span className="h-2 w-2 rounded-full bg-red-500" /> Offline
                  </span>
                  <p className="mt-0.5 text-base font-semibold tabular-nums text-primary">{offlineDevices.length}</p>
                </div>
              </div>

              {problemDevices.length > 0 ? (
                <ul className="space-y-1.5 border-t border-border pt-3">
                  {problemDevices.slice(0, 5).map((d) => (
                    <li key={d.serial} className="flex items-center justify-between gap-3 text-[0.75rem]">
                      <span className="truncate font-medium text-primary">{deviceName(d)}</span>
                      <Badge variant={ATTENTION_STATUSES.includes(d.status) ? "warning" : "danger"} dot>
                        {DEVICE_STATUS_LABEL[d.status] ?? "Offline"}
                      </Badge>
                    </li>
                  ))}
                  {problemDevices.length > 5 && (
                    <li className="text-[0.75rem] text-tertiary">e mais {problemDevices.length - 5}.</li>
                  )}
                </ul>
              ) : (
                <p className="border-t border-border pt-3 text-[0.75rem] text-tertiary">Todos os aparelhos estão online.</p>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Campanhas ativas */}
      <Card padding="md">
        <SectionTitle
          icon={<Megaphone size={15} />}
          action={
            canOpenCampaigns ? (
              <Button variant="ghost" size="sm" onClick={() => navigate("/campaigns")}>
                Ver campanhas
              </Button>
            ) : undefined
          }
        >
          Campanhas ativas
          {!campaignsQ.isLoading && activeCampaigns.length > 0 && (
            <span className="text-xs font-normal text-tertiary">
              {runningCount} em andamento · {activeCampaigns.length - runningCount} pausadas
            </span>
          )}
        </SectionTitle>

        {campaignsQ.isLoading ? (
          <SkeletonLines />
        ) : activeCampaigns.length === 0 ? (
          <p className="text-[0.8125rem] text-secondary">Nenhuma campanha em andamento ou pausada.</p>
        ) : (
          <ul className="divide-y divide-border">
            {activeCampaigns.slice(0, 6).map((c) => (
              <CampaignRow key={c.id} campaign={c} />
            ))}
            {activeCampaigns.length > 6 && (
              <li className="pt-2 text-[0.75rem] text-tertiary">e mais {activeCampaigns.length - 6}.</li>
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const total = c.contactsCount || 0;
  const done = (c.sentCount || 0) + (c.failedCount || 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const remaining = Math.max(0, total - done);
  const running = c.status === "running";
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 sm:w-1/3">
        <p className="truncate text-[0.8125rem] font-medium text-primary" title={c.name}>
          {c.name}
        </p>
        <Badge variant={running ? "success" : "warning"} dot pulse={running}>
          {running ? "Em andamento" : "Pausada"}
        </Badge>
      </div>
      <div className="min-w-0 flex-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label={`Progresso de ${c.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${running ? "bg-[var(--color-accent)]" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-[0.75rem] tabular-nums text-tertiary">
          {(c.sentCount || 0).toLocaleString("pt-BR")} enviadas
          {(c.failedCount || 0) > 0 && <span className="text-red-600 dark:text-red-400"> · {c.failedCount.toLocaleString("pt-BR")} falhas</span>}
          {" · "}
          {remaining.toLocaleString("pt-BR")} restantes de {total.toLocaleString("pt-BR")}
        </p>
      </div>
      <span className="text-sm font-semibold tabular-nums text-primary sm:w-12 sm:text-right">{pct}%</span>
    </li>
  );
}
