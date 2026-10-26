// Lista densa de campanhas (linhas clicáveis com progresso e ações).
import { Pencil, Play, Settings2, Smartphone, Upload, Users } from "lucide-react";
import Badge from "../../components/ui/Badge";
import type { Campaign } from "../../types";
import ActionMenu from "./ActionMenu";
import { ProgressBar, campaignUsesAi, countsFromCampaign, formatDate, formatNumber, statusInfo } from "./shared";
import type { DetailTab } from "./CampaignDetail";

const GRID = "lg:grid lg:grid-cols-[minmax(0,2.4fr)_8rem_minmax(0,1.7fr)_6rem_7rem_4.5rem] lg:items-center lg:gap-4";

export function CampaignListSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-4 last:border-b-0">
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-1/3 rounded" />
            <div className="skeleton h-3 w-1/2 rounded" />
          </div>
          <div className="skeleton hidden h-2 w-48 rounded-full md:block" />
        </div>
      ))}
    </div>
  );
}

export default function CampaignList({
  campaigns,
  onOpen,
  onEdit,
  onImport,
}: {
  campaigns: Campaign[];
  onOpen: (c: Campaign, tab?: DetailTab) => void;
  onEdit: (c: Campaign) => void;
  onImport: (c: Campaign) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className={`hidden rounded-t-xl border-b border-border bg-secondary px-4 py-2.5 text-[0.75rem] font-medium text-secondary ${GRID}`}>
        <span>Campanha</span>
        <span>Status</span>
        <span>Progresso</span>
        <span>Aparelhos</span>
        <span>Atualizada</span>
        <span className="sr-only">Ações</span>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {campaigns.map((c) => {
          const st = statusInfo(c.status);
          const { total, sent, failed, progress } = countsFromCampaign(c);
          const deviceCount = (c.deviceIds || []).length;
          const preview = [c.greeting, c.message].filter(Boolean).join(" ");
          return (
            <li
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpen(c);
              }}
              className={`group cursor-pointer px-4 py-3.5 last:rounded-b-xl max-lg:first:rounded-t-xl transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)] ${GRID}`}
            >
              {/* Nome */}
              <div className="flex min-w-0 items-start justify-between gap-3 lg:block">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-primary">{c.name}</p>
                    {campaignUsesAi(c) && <Badge variant="purple">IA</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[0.75rem] text-tertiary">{preview || "Sem mensagem"}</p>
                </div>
                <div className="lg:hidden">
                  <Badge variant={st.variant} dot pulse={c.status === "running"}>
                    {st.label}
                  </Badge>
                </div>
              </div>

              {/* Status */}
              <div className="hidden lg:block">
                <Badge variant={st.variant} dot pulse={c.status === "running"}>
                  {st.label}
                </Badge>
              </div>

              {/* Progresso */}
              <div className="mt-3 min-w-0 lg:mt-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.75rem]">
                  <span className="tabular-nums text-secondary">
                    <span className="text-primary">{formatNumber(sent)}</span> / {formatNumber(total)}
                    {failed > 0 && <span className="ml-1.5 text-red-600 dark:text-red-400">· {formatNumber(failed)} falhas</span>}
                  </span>
                  <span className="tabular-nums text-tertiary">{progress}%</span>
                </div>
                <ProgressBar total={total} sent={sent} failed={failed} completed={c.status === "completed"} />
              </div>

              {/* Aparelhos + data (no mobile ficam numa linha) */}
              <div className="mt-2.5 flex items-center gap-4 text-[0.75rem] text-secondary lg:contents">
                <span className={`inline-flex items-center gap-1.5 tabular-nums ${deviceCount === 0 ? "text-amber-700 dark:text-amber-300" : ""}`}>
                  <Smartphone size={13} className="text-tertiary" />
                  {deviceCount === 0 ? "Nenhum" : deviceCount}
                </span>
                <span className="tabular-nums text-tertiary">{formatDate(c.updatedAt)}</span>
              </div>

              {/* Ações */}
              <div className="mt-2 flex items-center justify-end gap-0.5 lg:mt-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  aria-label={`Editar ${c.name}`}
                  title="Editar"
                  onClick={() => onEdit(c)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <Pencil size={14} />
                </button>
                <ActionMenu
                  label={`Mais ações para ${c.name}`}
                  actions={[
                    { label: "Abrir campanha", icon: <Play size={14} />, onSelect: () => onOpen(c) },
                    { label: "Importar contatos", icon: <Upload size={14} />, onSelect: () => onImport(c) },
                    { label: "Ver contatos", icon: <Users size={14} />, onSelect: () => onOpen(c, "contacts") },
                    { label: "Escolher aparelhos", icon: <Smartphone size={14} />, onSelect: () => onOpen(c, "devices") },
                    { label: "Configurações", icon: <Settings2 size={14} />, onSelect: () => onOpen(c, "settings") },
                    { label: "Editar", icon: <Pencil size={14} />, onSelect: () => onEdit(c) },
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
