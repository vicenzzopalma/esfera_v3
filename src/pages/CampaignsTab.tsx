// ============================================================
// Esfera v3 — Campanhas
// Lista de campanhas, assistente de criação/edição, detalhe com
// execução ao vivo, contatos, aparelhos e configurações.
// Componentes em ./campaigns/
// ============================================================

import { useState, useEffect, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../context/AuthContext";
import { MOCK_CAMPAIGNS } from "../mock-data";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import { SegmentedControl } from "../components/ui/Tabs";
import type { Campaign } from "../types";
import { api } from "../tauri";
import { AlertCircle, Brain, Building2, Megaphone, Play, Plus, RefreshCw, Search, Send, Users } from "lucide-react";
import CampaignList, { CampaignListSkeleton } from "./campaigns/CampaignList";
import CampaignDetail, { type DetailTab } from "./campaigns/CampaignDetail";
import CampaignWizard from "./campaigns/CampaignWizard";
import ContactImportModal from "./campaigns/ContactImportModal";
import GlobalAiConfigModal from "./campaigns/GlobalAiConfigModal";
import { describeProgress, type LogLevel, type LogLine, type ProgressPayload } from "./campaigns/LogConsole";
import { SearchInput, formatNumber, nowTime } from "./campaigns/shared";

type StatusFilter = "all" | "running" | "paused" | "completed" | "draft" | "error";
const LOG_LIMIT = 300;
let logSeq = 0;

export default function CampaignsTab() {
  const { selectedCompanyId } = useAuth();
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Navegação interna: lista ou detalhe de uma campanha
  const [detail, setDetail] = useState<{ id: number; tab: DetailTab } | null>(null);
  const [wizard, setWizard] = useState<{ campaign: Campaign | null } | null>(null);
  const [importFor, setImportFor] = useState<Campaign | null>(null);
  const [aiGlobalModalOpen, setAiGlobalModalOpen] = useState(false);
  const [importRevision, setImportRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const [logs, setLogs] = useState<Record<number, LogLine[]>>({});

  const appendLog = useCallback((campaignId: number, level: LogLevel, text: string, delayMs?: number) => {
    setLogs((prev) => {
      const list = [...(prev[campaignId] || []), { id: ++logSeq, time: nowTime(), level, text, delayMs }];
      return { ...prev, [campaignId]: list.slice(-LOG_LIMIT) };
    });
  }, []);

  const loadCampaigns = useCallback(() => {
    let mounted = true;
    if (!selectedCompanyId) {
      setCampaignsList([]);
      setLoading(false);
      return () => {};
    }
    setLoading(true);
    setLoadError("");
    api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => {
        if (mounted) setCampaignsList(data);
      })
      .catch((err) => {
        if (mounted) {
          setCampaignsList(MOCK_CAMPAIGNS.filter((c) => c.companyId === selectedCompanyId));
          setLoadError(String(err));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [selectedCompanyId]);

  useEffect(() => {
    setDetail(null);
    return loadCampaigns();
  }, [loadCampaigns]);

  // Atualiza a lista ao vivo conforme o motor de disparos emite progresso (1x a cada 2s no máx)
  const refreshCampaigns = useCallback(() => {
    if (!selectedCompanyId) return;
    api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => {
        setCampaignsList(data);
        setLoadError("");
      })
      .catch(() => {
        /* mantém lista atual */
      });
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    let unlisten: (() => void) | undefined;
    let lastRefresh = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    listen<ProgressPayload>("campaign-progress", (event) => {
      const p = event.payload;
      if (p && typeof p.campaign_id === "number" && typeof p.status === "string") {
        const { level, text } = describeProgress(p);
        appendLog(p.campaign_id, level, text, p.delay_used_ms || undefined);
      }
      // Atualiza no máximo a cada 2s, mas nunca perde o último evento (ex.: "completed").
      const now = Date.now();
      if (trailing) clearTimeout(trailing);
      if (now - lastRefresh >= 2000) {
        lastRefresh = now;
        refreshCampaigns();
      } else {
        trailing = setTimeout(() => {
          lastRefresh = Date.now();
          refreshCampaigns();
        }, 2000 - (now - lastRefresh));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (trailing) clearTimeout(trailing);
      if (unlisten) unlisten();
    };
  }, [selectedCompanyId, refreshCampaigns, appendLog]);

  const upsertCampaign = (c: Campaign) =>
    setCampaignsList((prev) => {
      const idx = prev.findIndex((x) => x.id === c.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = c;
        return updated;
      }
      return [c, ...prev];
    });

  // ---- Métricas e filtros ----
  const counts = useMemo(() => {
    const by = (s: string[]) => campaignsList.filter((c) => s.includes(c.status)).length;
    return {
      all: campaignsList.length,
      running: by(["running"]),
      paused: by(["paused", "stopped"]),
      completed: by(["completed"]),
      draft: by(["draft"]),
      error: by(["error"]),
    };
  }, [campaignsList]);

  const totalSent = campaignsList.reduce((acc, c) => acc + (c.sentCount || 0), 0);
  const totalFailed = campaignsList.reduce((acc, c) => acc + (c.failedCount || 0), 0);
  const totalContacts = campaignsList.reduce((acc, c) => acc + (c.contactsCount || 0), 0);
  const totalPending = campaignsList.reduce((acc, c) => acc + Math.max(0, (c.contactsCount || 0) - (c.sentCount || 0) - (c.failedCount || 0)), 0);

  const filteredCampaigns = campaignsList.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase().trim());
    const matchesStatus =
      statusFilter === "all" || c.status === statusFilter || (statusFilter === "paused" && (c.status as string) === "stopped");
    return matchesSearch && matchesStatus;
  });

  const openDetail = (c: Campaign, tab: DetailTab = "overview") => setDetail({ id: c.id, tab });
  const detailCampaign = detail ? campaignsList.find((c) => c.id === detail.id) || null : null;

  // ---- Modais compartilhados (lista e detalhe) ----
  const modals = (
    <>
      {wizard && (
        <CampaignWizard
          isOpen
          onClose={() => setWizard(null)}
          campaign={wizard.campaign}
          onSaved={(saved, meta) => {
            upsertCampaign(saved);
            setSyncRevision((r) => r + 1);
            if (meta.openAfter) setDetail({ id: saved.id, tab: "contacts" });
            refreshCampaigns();
          }}
        />
      )}

      <ContactImportModal
        isOpen={importFor !== null}
        onClose={() => setImportFor(null)}
        campaign={importFor}
        onImported={() => {
          setImportRevision((r) => r + 1);
          refreshCampaigns();
          if (importFor) appendLog(importFor.id, "info", "Lista de contatos importada.");
        }}
      />

      {aiGlobalModalOpen && <GlobalAiConfigModal isOpen={aiGlobalModalOpen} onClose={() => setAiGlobalModalOpen(false)} />}
    </>
  );

  // ---- Detalhe da campanha ----
  if (detail && detailCampaign) {
    return (
      <>
        <CampaignDetail
          campaign={detailCampaign}
          syncRevision={syncRevision}
          importRevision={importRevision}
          initialTab={detail.tab}
          logs={logs[detailCampaign.id] || []}
          onLog={(level, text) => appendLog(detailCampaign.id, level, text)}
          onClearLogs={() => setLogs((prev) => ({ ...prev, [detailCampaign.id]: [] }))}
          onBack={() => setDetail(null)}
          onEdit={() => setWizard({ campaign: detailCampaign })}
          onImport={() => setImportFor(detailCampaign)}
          onUpdateCampaign={upsertCampaign}
        />
        {modals}
      </>
    );
  }

  // ---- Lista ----
  const statusItems: { id: StatusFilter; label: string; count: number }[] = [
    { id: "all", label: "Todas", count: counts.all },
    { id: "running", label: "Em andamento", count: counts.running },
    { id: "paused", label: "Pausadas", count: counts.paused },
    { id: "completed", label: "Concluídas", count: counts.completed },
    { id: "draft", label: "Rascunhos", count: counts.draft },
  ];
  if (counts.error > 0 || statusFilter === "error") statusItems.push({ id: "error", label: "Com erro", count: counts.error });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Campanhas"
        description="Crie, acompanhe e controle os disparos de WhatsApp da empresa."
        actions={
          <>
            <Button variant="secondary" icon={<Brain size={15} />} onClick={() => setAiGlobalModalOpen(true)} disabled={!selectedCompanyId}>
              Configurar IA
            </Button>
            <Button icon={<Plus size={15} />} onClick={() => setWizard({ campaign: null })} disabled={!selectedCompanyId}>
              Nova campanha
            </Button>
          </>
        }
      />

      {!selectedCompanyId ? (
        <EmptyState
          icon={<Building2 size={18} />}
          title="Nenhuma empresa selecionada"
          description="Escolha uma empresa para ver e criar campanhas."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Campanhas"
              value={loading ? "—" : formatNumber(campaignsList.length)}
              icon={<Megaphone size={14} />}
              tone="accent"
              hint={counts.draft ? `${counts.draft} em rascunho` : undefined}
            />
            <StatCard
              label="Em andamento"
              value={loading ? "—" : formatNumber(counts.running)}
              icon={<Play size={14} />}
              tone="success"
              onClick={counts.running ? () => setStatusFilter("running") : undefined}
            />
            <StatCard
              label="Mensagens enviadas"
              value={loading ? "—" : formatNumber(totalSent)}
              icon={<Send size={14} />}
              tone="info"
              hint={totalFailed ? `${formatNumber(totalFailed)} falhas` : undefined}
            />
            <StatCard
              label="Contatos"
              value={loading ? "—" : formatNumber(totalContacts)}
              icon={<Users size={14} />}
              hint={totalContacts ? `${formatNumber(totalPending)} aguardando envio` : undefined}
            />
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Buscar campanha" className="md:w-72" />
            <div className="overflow-x-auto">
              <SegmentedControl<StatusFilter> items={statusItems} value={statusFilter} onChange={setStatusFilter} />
            </div>
          </div>

          {loading && campaignsList.length === 0 ? (
            <CampaignListSkeleton />
          ) : loadError && campaignsList.length === 0 ? (
            <EmptyState
              icon={<AlertCircle size={18} />}
              title="Não foi possível carregar as campanhas"
              description={loadError}
              action={
                <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => loadCampaigns()}>
                  Tentar de novo
                </Button>
              }
            />
          ) : campaignsList.length === 0 ? (
            <EmptyState
              icon={<Megaphone size={18} />}
              title="Nenhuma campanha ainda"
              description="Crie a primeira campanha: escreva a mensagem, escolha os aparelhos e importe os contatos."
              action={
                <Button icon={<Plus size={15} />} onClick={() => setWizard({ campaign: null })}>
                  Nova campanha
                </Button>
              }
            />
          ) : filteredCampaigns.length === 0 ? (
            <EmptyState
              icon={<Search size={18} />}
              title="Nenhuma campanha encontrada"
              description="Nenhuma campanha corresponde à busca ou ao filtro de status."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                >
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <CampaignList
              campaigns={filteredCampaigns}
              onOpen={openDetail}
              onEdit={(c) => setWizard({ campaign: c })}
              onImport={(c) => setImportFor(c)}
            />
          )}
        </>
      )}

      {modals}
    </div>
  );
}
