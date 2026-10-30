// ============================================================
// Esfera v3 — Automações
// Regras de gatilho e ação: lista com status e edição em modal
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import Field, { FormSection } from "../components/ui/Field";
import type { Automation, AutomationTriggerType, AutomationActionType } from "../types";
import { api } from "../tauri";
import { apiErrorText, useCampaigns } from "../hooks/useQueries";
import { SECTOR_OPTIONS, sectorLabel } from "../components/devices/deviceUi";
import { moneyError } from "./CampaignsTab";
import {
  Bot,
  Plus,
  Pencil,
  Trash2,
  Search,
  MessageSquare,
  Hash,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Smartphone,
  ArrowRight,
  Bell,
  Users,
  Play,
  Shield,
  Info,
  RefreshCw,
} from "lucide-react";

const TRIGGER_ICONS: Record<AutomationTriggerType, React.ReactNode> = {
  keyword: <Hash size={16} />,
  ban_detected: <AlertTriangle size={16} />,
  device_offline: <Smartphone size={16} />,
  schedule: <Clock size={16} />,
  message_received: <MessageSquare size={16} />,
};
const ACTION_ICONS: Record<AutomationActionType, React.ReactNode> = {
  send_response: <MessageSquare size={16} />,
  move_chip: <ArrowRight size={16} />,
  notify: <Bell size={16} />,
  toggle_campaign: <Play size={16} />,
  set_chip_status: <Shield size={16} />,
  send_to_sector: <Users size={16} />,
};

// Rótulos desta tela (frases curtas em português, no lugar dos rótulos em Title Case de types.ts).
const TRIGGER_TEXT: Record<AutomationTriggerType, string> = {
  keyword: "Palavra-chave",
  message_received: "Mensagem recebida",
  ban_detected: "Chip bloqueado",
  device_offline: "Aparelho offline",
  schedule: "Agendamento",
};
const ACTION_TEXT: Record<AutomationActionType, string> = {
  send_response: "Responder",
  notify: "Avisar o gestor",
  send_to_sector: "Encaminhar ao setor",
  move_chip: "Mover chip",
  set_chip_status: "Mudar status do chip",
  toggle_campaign: "Pausar ou retomar campanha",
};
const TRIGGER_ORDER: AutomationTriggerType[] = ["keyword", "message_received", "ban_detected", "device_offline", "schedule"];
const ACTION_ORDER: AutomationActionType[] = ["send_response", "notify", "send_to_sector", "move_chip", "set_chip_status", "toggle_campaign"];

const CHIP_STATUS_OPTIONS = [
  { id: "livre", label: "Livre" },
  { id: "restrito_24h", label: "Restrito por 24 h" },
  { id: "restrito_7d", label: "Restrito por 7 dias" },
  { id: "banido", label: "Banido" },
];

// Dias no formato salvo pelo backend: 1 = segunda ... 7 = domingo.
const DAY_CHIPS = [
  { n: 1, label: "Seg" },
  { n: 2, label: "Ter" },
  { n: 3, label: "Qua" },
  { n: 4, label: "Qui" },
  { n: 5, label: "Sex" },
  { n: 6, label: "Sáb" },
  { n: 7, label: "Dom" },
];

function parseDays(value: string): number[] {
  return Array.from(new Set(String(value || "").split(/[,\s;]+/).map(Number).filter((n) => n >= 1 && n <= 7))).sort((a, b) => a - b);
}

/** Dias selecionados em que o horário cai fora da janela de envio (seg–sex 8h–20h, sáb 8h–14h). */
function daysOutsideWindow(days: number[], time: string): string[] {
  const [h, m] = time.split(":").map(Number);
  const minutes = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return days
    .filter((d) => {
      if (d === 7) return true;
      const end = d === 6 ? 14 * 60 : 20 * 60;
      return minutes < 8 * 60 || minutes >= end;
    })
    .map((d) => DAY_CHIPS.find((c) => c.n === d)?.label ?? String(d));
}

function safeJson(text: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default function AutomationsTab() {
  const { selectedCompanyId } = useAuth();
  const { data: campaigns = [] } = useCampaigns(selectedCompanyId);
  const [searchQuery, setSearchQuery] = useState("");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);
  const [automationsList, setAutomationsList] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const seqRef = useRef(0);

  // Form states
  const [ruleName, setRuleName] = useState("");
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>("keyword");
  const [actionType, setActionType] = useState<AutomationActionType>("send_response");
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleResponse, setRuleResponse] = useState("");
  const [ruleSector, setRuleSector] = useState("junior");
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleDays, setScheduleDays] = useState("1,2,3,4,5");
  const [targetCampaignId, setTargetCampaignId] = useState("");
  const [chipTargetStatus, setChipTargetStatus] = useState("restrito_24h");

  const loadAutomations = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!selectedCompanyId) {
      setAutomationsList([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api<Automation[]>("get_automations", { companyId: selectedCompanyId });
      if (seq !== seqRef.current) return;
      setAutomationsList(data || []);
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoadError(apiErrorText(err, "Não foi possível carregar as automações."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [selectedCompanyId]);

  useEffect(() => {
    setAutomationsList([]);
    loadAutomations();
    return () => { seqRef.current++; };
  }, [loadAutomations]);

  const resetForm = () => {
    setRuleName("");
    setTriggerType("keyword");
    setActionType("send_response");
    setRuleKeyword("");
    setRuleResponse("");
    setRuleSector("junior");
    setScheduleTime("09:00");
    setScheduleDays("1,2,3,4,5");
    setTargetCampaignId("");
    setChipTargetStatus("restrito_24h");
  };

  // Preenche o formulário ao abrir: sempre parte do padrão, para não herdar valores da regra anterior.
  const openEditModal = (automation?: Automation) => {
    resetForm();
    setSaveError(null);
    setSubmitted(false);
    if (automation) {
      setRuleName(automation.name);
      setTriggerType(automation.triggerType || "keyword");
      setActionType(automation.actionType || "send_response");
      setRuleKeyword(automation.keyword || "");
      setRuleResponse(automation.response || "");
      setRuleSector(automation.sector || "junior");
      const tc = safeJson(automation.triggerConfig);
      if (typeof tc.time === "string") setScheduleTime(tc.time);
      if (tc.days != null) setScheduleDays(String(tc.days));
      const ac = safeJson(automation.actionConfig);
      if (ac.campaignId != null) setTargetCampaignId(String(ac.campaignId));
      if (typeof ac.chipStatus === "string") setChipTargetStatus(ac.chipStatus);
    }
    setSelectedAutomation(automation || null);
    setEditModalOpen(true);
  };

  const selectedDays = parseDays(scheduleDays);
  const toggleDay = (n: number) => {
    const set = new Set(selectedDays);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    setScheduleDays(Array.from(set).sort((a, b) => a - b).join(","));
  };

  // Validação: um erro por campo, mostrado depois da primeira tentativa de salvar.
  const responseMoneyError = actionType === "send_response" ? moneyError(ruleResponse) : undefined;
  const fieldErrors = {
    name: !ruleName.trim() ? "Dê um nome à automação." : undefined,
    keyword: triggerType === "keyword" && !ruleKeyword.trim() ? "Informe ao menos uma palavra-chave." : undefined,
    days: triggerType === "schedule" && selectedDays.length === 0 ? "Escolha ao menos um dia." : undefined,
    response:
      actionType === "send_response"
        ? !ruleResponse.trim()
          ? "Escreva a resposta que será enviada."
          : responseMoneyError
        : undefined,
    campaign: actionType === "toggle_campaign" && !targetCampaignId ? "Escolha a campanha." : undefined,
  };
  const hasFieldErrors = Object.values(fieldErrors).some(Boolean);
  // Valores na resposta aparecem na hora; campos vazios só depois de tentar salvar.
  const shownError = (key: keyof typeof fieldErrors) =>
    key === "response" && responseMoneyError ? responseMoneyError : submitted ? fieldErrors[key] : undefined;
  const outsideWindow = triggerType === "schedule" ? daysOutsideWindow(selectedDays, scheduleTime) : [];

  const handleSaveAutomation = async () => {
    if (!selectedCompanyId || saving) return;
    setSubmitted(true);
    if (hasFieldErrors) return;

    const triggerConfig = triggerType === "schedule"
      ? JSON.stringify({ time: scheduleTime, days: selectedDays.join(",") })
      : "{}";
    const actionConfig = actionType === "toggle_campaign"
      ? JSON.stringify({ campaignId: targetCampaignId })
      : actionType === "set_chip_status"
      ? JSON.stringify({ chipStatus: chipTargetStatus })
      : "{}";

    // Todos os campos de AutomationRule são obrigatórios no backend.
    const payload = {
      id: selectedAutomation?.id || 0,
      name: ruleName.trim(),
      keyword: triggerType === "keyword" ? ruleKeyword.trim() : "",
      response: actionType === "send_response" ? ruleResponse.trim() : "",
      active: selectedAutomation?.active ?? true,
      triggeredCount: selectedAutomation?.triggeredCount || 0,
      companyId: selectedCompanyId,
      triggerType,
      actionType,
      triggerConfig,
      actionConfig,
      sector: ruleSector || "junior",
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (selectedAutomation) await api("update_automation", { automation: payload });
      else await api("create_automation", { automation: payload });
      setEditModalOpen(false);
      await loadAutomations();
    } catch (err) {
      setSaveError(apiErrorText(err, "Não foi possível salvar a automação."));
    } finally {
      setSaving(false);
    }
  };

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredAutomations = automationsList.filter(
    (a) =>
      !normalizedSearch ||
      a.name.toLowerCase().includes(normalizedSearch) ||
      (a.keyword || "").toLowerCase().includes(normalizedSearch)
  );

  const activeRulesCount = automationsList.filter((a) => a.active).length;
  const totalTriggers = automationsList.reduce((acc, a) => acc + (a.triggeredCount || 0), 0);

  const toggleActive = async (automation: Automation) => {
    if (togglingId !== null) return;
    const newActive = !automation.active;
    setTogglingId(automation.id);
    setPageError(null);
    setAutomationsList((prev) => prev.map((a) => (a.id === automation.id ? { ...a, active: newActive } : a)));
    try {
      await api("update_automation", { automation: { ...automation, active: newActive } });
    } catch (err) {
      // Volta ao valor anterior e mostra o motivo.
      setAutomationsList((prev) => prev.map((a) => (a.id === automation.id ? { ...a, active: automation.active } : a)));
      setPageError(apiErrorText(err, `Não foi possível ${newActive ? "ativar" : "desativar"} a automação.`));
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api("soft_delete_automation", { automationId: deleteTarget.id });
      setAutomationsList((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(apiErrorText(err, "Não foi possível excluir a automação."));
    } finally {
      setDeleting(false);
    }
  };

  const campaignName = (id: unknown) => campaigns.find((c) => String(c.id) === String(id))?.name;

  const actionSummary = (a: Automation) => {
    switch (a.actionType) {
      case "send_response": return a.response ? `Responde: ${a.response}` : "Envia uma resposta automática";
      case "move_chip": return `Move o chip para o setor ${sectorLabel(a.sector)}`;
      case "notify": return "Avisa o gestor no sistema";
      case "toggle_campaign": {
        const id = safeJson(a.actionConfig).campaignId;
        const name = campaignName(id);
        return name ? `Pausa ou retoma a campanha ${name}` : id ? `Pausa ou retoma a campanha nº ${id}` : "Pausa ou retoma a campanha vinculada";
      }
      case "set_chip_status": {
        const st = String(safeJson(a.actionConfig).chipStatus || "");
        const label = CHIP_STATUS_OPTIONS.find((o) => o.id === st)?.label;
        return label ? `Muda o status do chip para ${label}` : "Muda o status do chip";
      }
      case "send_to_sector": return `Encaminha para o setor ${sectorLabel(a.sector)}`;
      default: return "";
    }
  };

  const triggerSummary = (a: Automation) => {
    if (a.triggerType === "schedule") {
      const tc = safeJson(a.triggerConfig);
      const days = parseDays(String(tc.days ?? "")).map((d) => DAY_CHIPS.find((c) => c.n === d)?.label).filter(Boolean).join(", ");
      return `Agendamento${tc.time ? ` às ${tc.time}` : ""}${days ? ` (${days})` : ""}`;
    }
    return TRIGGER_TEXT[a.triggerType || "keyword"] ?? a.triggerType;
  };

  // Setor salvo por versões antigas (ex.: pa_fixa_1) continua aparecendo no seletor.
  const sectorOptions = SECTOR_OPTIONS.some((o) => o.id === ruleSector)
    ? SECTOR_OPTIONS
    : [...SECTOR_OPTIONS, { id: ruleSector, label: sectorLabel(ruleSector) }];

  const optionButton = (selected: boolean) =>
    `flex items-center gap-2 rounded-lg border px-3 py-2 text-[0.8125rem] font-medium transition-colors cursor-pointer text-left ${
      selected
        ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)] text-primary"
        : "border-border text-secondary hover:border-border-strong hover:text-primary"
    }`;

  const infoBox = "rounded-lg border border-border bg-secondary px-3 py-2 text-xs text-secondary";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Automações"
        description="Regras de gatilho e ação para respostas, avisos e chips."
        icon={<Bot size={18} />}
        actions={
          <Button icon={<Plus size={15} />} onClick={() => openEditModal()}>
            Nova automação
          </Button>
        }
      />

      <div role="note" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[0.8125rem] text-amber-800 dark:text-amber-300">
        <Info size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">A execução automática ainda não está ligada nesta versão.</p>
          <p className="mt-0.5 text-amber-700 dark:text-amber-300/90">
            As regras ficam salvas e prontas, mas o Esfera ainda não as executa: nenhuma resposta é enviada e
            nenhum chip ou campanha é alterado por elas. Acompanhe chips e aparelhos pelo Dashboard.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Regras" value={automationsList.length} icon={<Bot size={14} />} tone="accent" />
        <StatCard label="Ativas" value={activeRulesCount} icon={<CheckCircle2 size={14} />} tone="success" />
        <StatCard label="Execuções" value={totalTriggers.toLocaleString("pt-BR")} icon={<Zap size={14} />} tone="warning" />
        <StatCard
          label="Regras de chip bloqueado"
          value={automationsList.filter((a) => a.triggerType === "ban_detected").length}
          icon={<AlertTriangle size={14} />}
          tone="danger"
        />
      </div>

      <div className="relative max-w-md flex items-center">
        <Search size={16} className="input-icon-left text-tertiary" />
        <input
          type="text"
          aria-label="Buscar automação"
          placeholder="Buscar por nome ou palavra-chave"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full input-with-icon-left"
        />
      </div>

      {(loadError || pageError) && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-red-600 dark:text-red-400">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="break-words">{pageError || loadError}</span>
          </span>
          {pageError ? (
            <Button variant="ghost" size="sm" onClick={() => setPageError(null)}>Fechar</Button>
          ) : (
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={loadAutomations}>Tentar de novo</Button>
          )}
        </div>
      )}

      {loading && automationsList.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredAutomations.length === 0 ? (
        !(loadError && automationsList.length === 0) && (
          <EmptyState
            icon={<Bot size={18} />}
            title={normalizedSearch ? "Nenhuma automação encontrada" : "Nenhuma automação criada"}
            description={normalizedSearch ? "Revise o termo buscado." : "Crie uma regra com gatilho e ação para deixar respostas e avisos prontos."}
            action={
              normalizedSearch ? (
                <Button variant="secondary" onClick={() => setSearchQuery("")}>Limpar busca</Button>
              ) : (
                <Button icon={<Plus size={15} />} onClick={() => openEditModal()}>Nova automação</Button>
              )
            }
          />
        )
      ) : (
        <div className="space-y-3">
          {filteredAutomations.map((automation) => (
            <Card key={automation.id} padding="none">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                      automation.active
                        ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-[var(--color-accent-light)]"
                        : "border-border bg-secondary text-tertiary"
                    }`}
                  >
                    {TRIGGER_ICONS[automation.triggerType || "keyword"]}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-primary">{automation.name}</h3>
                      <Badge variant={automation.active ? "success" : "neutral"} dot>
                        {automation.active ? "Ativa" : "Inativa"}
                      </Badge>
                    </div>

                    <p className="mt-1 flex items-center gap-1.5 text-xs text-secondary flex-wrap">
                      <span>{triggerSummary(automation)}</span>
                      {automation.triggerType === "keyword" && automation.keyword && (
                        <span className="font-mono rounded bg-secondary px-1.5 py-0.5 text-primary">"{automation.keyword}"</span>
                      )}
                      <ArrowRight size={12} className="text-tertiary" />
                      <span>{ACTION_TEXT[automation.actionType || "send_response"] ?? automation.actionType}</span>
                    </p>

                    <p className="mt-1 text-xs text-tertiary line-clamp-1">{actionSummary(automation)}</p>
                    <p className="mt-1 text-xs text-tertiary tabular-nums">{automation.triggeredCount || 0} execuções</p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 border-t sm:border-t-0 border-border pt-3 sm:pt-0 shrink-0">
                  <Toggle
                    checked={automation.active}
                    onChange={() => toggleActive(automation)}
                    disabled={togglingId === automation.id}
                    size="sm"
                  />
                  <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => openEditModal(automation)}>
                    Editar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    aria-label={`Excluir ${automation.name}`}
                    title="Excluir"
                    onClick={() => { setDeleteError(null); setDeleteTarget(automation); }}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Criar / editar */}
      <Modal
        isOpen={editModalOpen}
        onClose={() => { if (!saving) setEditModalOpen(false); }}
        title={selectedAutomation ? "Editar automação" : "Nova automação"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleSaveAutomation} loading={saving}>
              {selectedAutomation ? "Salvar" : "Criar automação"}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          {saveError && (
            <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400 break-words">
              {saveError}
            </p>
          )}

          <Field label="Nome" required htmlFor="auto-name" error={shownError("name")}>
            <input
              id="auto-name"
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="Ex.: Encaminhar pedido de acordo"
            />
          </Field>

          <FormSection title="Quando" description="O evento que dispara esta regra.">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TRIGGER_ORDER.map((t) => (
                <button key={t} type="button" onClick={() => setTriggerType(t)} aria-pressed={triggerType === t} className={optionButton(triggerType === t)}>
                  {TRIGGER_ICONS[t]}
                  {TRIGGER_TEXT[t]}
                </button>
              ))}
            </div>

            {triggerType === "keyword" && (
              <Field label="Palavras-chave" hint="Separe várias palavras por vírgula." htmlFor="auto-keyword" error={shownError("keyword")}>
                <input
                  id="auto-keyword"
                  type="text"
                  value={ruleKeyword}
                  onChange={(e) => setRuleKeyword(e.target.value)}
                  placeholder="acordo, negociação, atendente"
                  className="font-mono"
                />
              </Field>
            )}

            {triggerType === "schedule" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-3">
                  <Field label="Horário" htmlFor="auto-time">
                    <input id="auto-time" type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
                  </Field>
                  <Field label="Dias da semana" error={shownError("days")}>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dias da semana">
                      {DAY_CHIPS.map((d) => {
                        const on = selectedDays.includes(d.n);
                        return (
                          <button
                            key={d.n}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleDay(d.n)}
                            className={`h-8 min-w-11 rounded-lg border px-2.5 text-[0.8125rem] font-medium transition-colors cursor-pointer ${
                              on
                                ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)] text-primary"
                                : "border-border text-secondary hover:border-border-strong hover:text-primary"
                            }`}
                          >
                            {d.label}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                </div>
                {outsideWindow.length > 0 && (
                  <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>
                      Fora da janela de envio em: {outsideWindow.join(", ")}. Mensagens só saem de seg a sex das 8h às 20h e
                      aos sábados das 8h às 14h.
                    </span>
                  </p>
                )}
              </div>
            )}

            {triggerType === "ban_detected" && <div className={infoBox}>Executa quando um chip for marcado como bloqueado pelo WhatsApp.</div>}
            {triggerType === "device_offline" && <div className={infoBox}>Executa quando um aparelho ficar offline por mais de 5 minutos.</div>}
            {triggerType === "message_received" && <div className={infoBox}>Executa ao receber qualquer mensagem de cliente.</div>}
          </FormSection>

          <FormSection title="Então" description="O que o sistema faz quando o evento acontece.">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ACTION_ORDER.map((a) => (
                <button key={a} type="button" onClick={() => setActionType(a)} aria-pressed={actionType === a} className={optionButton(actionType === a)}>
                  {ACTION_ICONS[a]}
                  {ACTION_TEXT[a]}
                </button>
              ))}
            </div>

            {actionType === "send_response" && (
              <Field
                label="Mensagem de resposta"
                htmlFor="auto-response"
                hint="Sem valores (R$, reais ou quantias): direcione o cliente ao canal de negociação."
                error={shownError("response")}
              >
                <textarea
                  id="auto-response"
                  value={ruleResponse}
                  onChange={(e) => setRuleResponse(e.target.value)}
                  placeholder="Ex.: Recebemos sua mensagem. Um atendente vai falar com você em breve."
                  rows={4}
                  className="resize-none"
                />
              </Field>
            )}

            {actionType === "move_chip" && (
              <Field label="Mover para o setor" htmlFor="auto-sector-move">
                <select id="auto-sector-move" value={ruleSector} onChange={(e) => setRuleSector(e.target.value)}>
                  {sectorOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </Field>
            )}

            {actionType === "notify" && <div className={infoBox}>O gestor responsável receberá um aviso no sistema.</div>}

            {actionType === "toggle_campaign" && (
              <Field
                label="Campanha"
                htmlFor="auto-campaign"
                error={shownError("campaign")}
                hint={campaigns.length === 0 ? "Nenhuma campanha cadastrada nesta empresa." : undefined}
              >
                <select id="auto-campaign" value={targetCampaignId} onChange={(e) => setTargetCampaignId(e.target.value)}>
                  <option value="">Selecione a campanha</option>
                  {targetCampaignId && !campaigns.some((c) => String(c.id) === targetCampaignId) && (
                    <option value={targetCampaignId}>Campanha nº {targetCampaignId} (não encontrada)</option>
                  )}
                  {campaigns.map((c) => (
                    <option key={c.id} value={String(c.id)}>{c.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {actionType === "set_chip_status" && (
              <Field label="Novo status do chip" htmlFor="auto-chip-status">
                <select id="auto-chip-status" value={chipTargetStatus} onChange={(e) => setChipTargetStatus(e.target.value)}>
                  {CHIP_STATUS_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
            )}

            {actionType === "send_to_sector" && (
              <Field label="Encaminhar para o setor" htmlFor="auto-sector-send">
                <select id="auto-sector-send" value={ruleSector} onChange={(e) => setRuleSector(e.target.value)}>
                  {sectorOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </Field>
            )}
          </FormSection>
        </div>
      </Modal>

      {/* Confirmação de exclusão */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        title="Excluir automação"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancelar</Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={handleDelete} loading={deleting}>
              Excluir
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[0.8125rem] text-secondary">
            A automação <span className="font-medium text-primary">{deleteTarget?.name}</span> será removida da lista.
          </p>
          {deleteError && (
            <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400">
              {deleteError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
