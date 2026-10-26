// ============================================================
// Esfera v3 — Automações
// Regras de gatilho e ação: lista com status e edição em modal
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_AUTOMATIONS } from "../mock-data";
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
import { TRIGGER_LABELS, ACTION_LABELS } from "../types";
import { api } from "../tauri";
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
const SECTORS = ["junior", "senior", "pesquisa", "pa_fixa_1", "pa_fixa_2", "comercial"];
const SECTOR_LABELS: Record<string, string> = {
  junior: "Junior",
  senior: "Senior",
  pesquisa: "Pesquisa",
  pa_fixa_1: "PA Fixa 1",
  pa_fixa_2: "PA Fixa 2",
  comercial: "Comercial",
};

export default function AutomationsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);
  const [automationsList, setAutomationsList] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);

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

  useEffect(() => {
    let mounted = true;
    if (!selectedCompanyId) { if (mounted) { setAutomationsList([]); setLoading(false); } return; }
    setLoading(true);
    api<Automation[]>("get_automations", { companyId: selectedCompanyId })
      .then((data) => { if (mounted) setAutomationsList(data); })
      .catch(() => { if (mounted) setAutomationsList(MOCK_AUTOMATIONS.filter((a) => a.companyId === selectedCompanyId)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [selectedCompanyId]);

  useEffect(() => {
    let mounted = true;
    if (selectedAutomation) {
      if (mounted) {
        setRuleName(selectedAutomation.name);
        setTriggerType(selectedAutomation.triggerType || "keyword");
        setActionType(selectedAutomation.actionType || "send_response");
        setRuleKeyword(selectedAutomation.keyword);
        setRuleResponse(selectedAutomation.response);
        setRuleSector(selectedAutomation.sector || "junior");
      }
      try {
        const tc = JSON.parse(selectedAutomation.triggerConfig || "{}");
        if (mounted) {
          if (tc.time) setScheduleTime(tc.time);
          if (tc.days) setScheduleDays(tc.days);
        }
      } catch { /* noop */ }
      try {
        const ac = JSON.parse(selectedAutomation.actionConfig || "{}");
        if (mounted) {
          if (ac.campaignId) setTargetCampaignId(String(ac.campaignId));
          if (ac.chipStatus) setChipTargetStatus(ac.chipStatus);
        }
      } catch { /* noop */ }
    } else {
      if (mounted) resetForm();
    }
    return () => { mounted = false; };
  }, [selectedAutomation, editModalOpen]);

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

  const handleSaveAutomation = async () => {
    if (!selectedCompanyId) return;
    const triggerConfig = triggerType === "schedule"
      ? JSON.stringify({ time: scheduleTime, days: scheduleDays })
      : "{}";
    const actionConfig = actionType === "toggle_campaign"
      ? JSON.stringify({ campaignId: targetCampaignId })
      : actionType === "set_chip_status"
      ? JSON.stringify({ chipStatus: chipTargetStatus })
      : "{}";

    const payload = {
      id: selectedAutomation?.id || 0,
      name: ruleName,
      keyword: ruleKeyword,
      response: ruleResponse,
      active: selectedAutomation?.active ?? true,
      triggeredCount: selectedAutomation?.triggeredCount || 0,
      companyId: selectedCompanyId,
      createdAt: selectedAutomation?.createdAt || new Date().toISOString().split("T")[0],
      triggerType,
      actionType,
      triggerConfig,
      actionConfig,
      sector: ruleSector,
    };

    try {
      await api("create_automation", { automation: payload });
      const updated = await api<Automation[]>("get_automations", { companyId: selectedCompanyId });
      setAutomationsList(updated);
    } catch {
      if (!selectedAutomation) {
        setAutomationsList((prev) => [
          ...prev,
          {
            ...payload,
            id: Date.now(),
          } as Automation,
        ]);
      } else {
        setAutomationsList((prev) =>
          prev.map((a) =>
            a.id === selectedAutomation.id
              ? { ...a, ...payload } as Automation
              : a
          )
        );
      }
    }
    setEditModalOpen(false);
  };

  const filteredAutomations = automationsList.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.keyword.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeRulesCount = automationsList.filter((a) => a.active).length;
  const totalTriggers = automationsList.reduce((acc, a) => acc + (a.triggeredCount || 0), 0);

  const openEditModal = (automation?: Automation) => {
    setSelectedAutomation(automation || null);
    setEditModalOpen(true);
  };

  const toggleActive = async (id: number, currentActive: boolean) => {
    const previous = automationsList.find((a) => a.id === id);
    if (!previous) return;
    // Valor que está no servidor (currentActive vem do prop), não o optimistic.
    const newActive = !currentActive;
    setAutomationsList((prev) =>
      prev.map((a) => (a.id === id ? { ...a, active: newActive } : a))
    );
    try {
      await api("update_automation", {
        automation: { ...previous, active: newActive },
      });
    } catch (err) {
      // Reverte o optimistic update e propaga o erro (não engole).
      setAutomationsList((prev) =>
        prev.map((a) => (a.id === id ? { ...a, active: currentActive } : a))
      );
      console.error("Falha ao alternar automação:", err);
      throw err;
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api("soft_delete_automation", { automationId: id });
    } catch { /* noop */ }
    setAutomationsList((prev) => prev.filter((a) => a.id !== id));
  };


  const actionSummary = (a: Automation) => {
    switch (a.actionType) {
      case "send_response": return a.response || "Enviar resposta automática";
      case "move_chip": return `Mover chip para ${SECTOR_LABELS[a.sector || "junior"]}`;
      case "notify": return "Notificar o gestor no sistema";
      case "toggle_campaign": return "Pausar ou iniciar a campanha vinculada";
      case "set_chip_status": return "Alterar o status do chip";
      case "send_to_sector": return `Encaminhar para ${SECTOR_LABELS[a.sector || "junior"]}`;
      default: return "";
    }
  };

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
        description="Regras que reagem a eventos e executam ações sozinhas."
        icon={<Bot size={18} />}
        actions={
          <Button icon={<Plus size={15} />} onClick={() => openEditModal()}>
            Nova automação
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Regras" value={automationsList.length} icon={<Bot size={14} />} tone="accent" />
        <StatCard label="Ativas" value={activeRulesCount} icon={<CheckCircle2 size={14} />} tone="success" />
        <StatCard label="Execuções" value={totalTriggers.toLocaleString("pt-BR")} icon={<Zap size={14} />} tone="warning" />
        <StatCard
          label="Detecção de bloqueio"
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

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredAutomations.length === 0 ? (
        <EmptyState
          icon={<Bot size={18} />}
          title={searchQuery ? "Nenhuma automação encontrada" : "Nenhuma automação criada"}
          description={searchQuery ? "Revise o termo buscado." : "Crie uma regra com gatilho e ação para automatizar respostas e alertas."}
          action={
            searchQuery ? (
              <Button variant="secondary" onClick={() => setSearchQuery("")}>Limpar busca</Button>
            ) : (
              <Button icon={<Plus size={15} />} onClick={() => openEditModal()}>Nova automação</Button>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredAutomations.map((automation, idx) => (
            <Card key={automation.id || idx} padding="none">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                      automation.active
                        ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-glow)] text-[var(--color-accent-light)]"
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
                      <span>{TRIGGER_LABELS[automation.triggerType || "keyword"]}</span>
                      {automation.keyword && (
                        <span className="font-mono rounded bg-secondary px-1.5 py-0.5 text-primary">"{automation.keyword}"</span>
                      )}
                      <ArrowRight size={12} className="text-tertiary" />
                      <span>{ACTION_LABELS[automation.actionType || "send_response"]}</span>
                    </p>

                    <p className="mt-1 text-xs text-tertiary line-clamp-1">{actionSummary(automation)}</p>
                    <p className="mt-1 text-xs text-tertiary tabular-nums">{automation.triggeredCount || 0} execuções</p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 border-t sm:border-t-0 border-border pt-3 sm:pt-0 shrink-0">
                  <Toggle
                    checked={automation.active}
                    onChange={() => toggleActive(automation.id, automation.active)}
                    size="sm"
                  />
                  <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => openEditModal(automation)}>
                    Editar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    className="text-red-600 dark:text-red-400 hover:text-red-300"
                    aria-label={`Excluir ${automation.name}`}
                    onClick={() => setDeleteTarget(automation)}
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
        onClose={() => setEditModalOpen(false)}
        title={selectedAutomation ? "Editar automação" : "Nova automação"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveAutomation} disabled={!ruleName.trim()}>
              {selectedAutomation ? "Salvar" : "Criar automação"}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <Field label="Nome" required htmlFor="auto-name">
            <input
              id="auto-name"
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="Ex.: Resposta automática de orçamento"
            />
          </Field>

          <FormSection title="Quando" description="O evento que dispara esta regra.">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(TRIGGER_LABELS) as AutomationTriggerType[]).map((t) => (
                <button key={t} type="button" onClick={() => setTriggerType(t)} aria-pressed={triggerType === t} className={optionButton(triggerType === t)}>
                  {TRIGGER_ICONS[t]}
                  {TRIGGER_LABELS[t]}
                </button>
              ))}
            </div>

            {triggerType === "keyword" && (
              <Field label="Palavra-chave" hint="Separe várias palavras por vírgula." htmlFor="auto-keyword">
                <input
                  id="auto-keyword"
                  type="text"
                  value={ruleKeyword}
                  onChange={(e) => setRuleKeyword(e.target.value)}
                  placeholder="orcamento, preco, valor"
                  className="font-mono"
                />
              </Field>
            )}

            {triggerType === "schedule" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Horário" htmlFor="auto-time">
                  <input id="auto-time" type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
                </Field>
                <Field label="Dias da semana" hint="1 = segunda ... 7 = domingo" htmlFor="auto-days">
                  <input id="auto-days" type="text" value={scheduleDays} onChange={(e) => setScheduleDays(e.target.value)} placeholder="1,2,3,4,5" className="font-mono" />
                </Field>
              </div>
            )}

            {triggerType === "ban_detected" && <div className={infoBox}>Executa sempre que um chip for marcado como bloqueado pelo WhatsApp.</div>}
            {triggerType === "device_offline" && <div className={infoBox}>Executa quando um aparelho ficar offline por mais de 5 minutos.</div>}
            {triggerType === "message_received" && <div className={infoBox}>Executa ao receber qualquer mensagem de cliente.</div>}
          </FormSection>

          <FormSection title="Então" description="O que o sistema faz quando o evento acontece.">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(ACTION_LABELS) as AutomationActionType[]).map((a) => (
                <button key={a} type="button" onClick={() => setActionType(a)} aria-pressed={actionType === a} className={optionButton(actionType === a)}>
                  {ACTION_ICONS[a]}
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>

            {actionType === "send_response" && (
              <Field label="Mensagem de resposta" htmlFor="auto-response">
                <textarea
                  id="auto-response"
                  value={ruleResponse}
                  onChange={(e) => setRuleResponse(e.target.value)}
                  placeholder="Digite a resposta automática"
                  rows={4}
                  className="resize-none"
                />
              </Field>
            )}

            {actionType === "move_chip" && (
              <Field label="Mover para o setor" htmlFor="auto-sector-move">
                <select id="auto-sector-move" value={ruleSector} onChange={(e) => setRuleSector(e.target.value)}>
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>{SECTOR_LABELS[s]}</option>
                  ))}
                </select>
              </Field>
            )}

            {actionType === "notify" && <div className={infoBox}>O gestor responsável receberá um aviso no painel de alertas.</div>}

            {actionType === "toggle_campaign" && (
              <Field label="ID da campanha" htmlFor="auto-campaign">
                <input id="auto-campaign" type="number" value={targetCampaignId} onChange={(e) => setTargetCampaignId(e.target.value)} placeholder="ID da campanha" className="font-mono" />
              </Field>
            )}

            {actionType === "set_chip_status" && (
              <Field label="Novo status do chip" htmlFor="auto-chip-status">
                <select id="auto-chip-status" value={chipTargetStatus} onChange={(e) => setChipTargetStatus(e.target.value)}>
                  <option value="livre">Livre</option>
                  <option value="restrito_24h">Restrito 24h</option>
                  <option value="restrito_7d">Restrito 7d</option>
                  <option value="banido">Banido</option>
                </select>
              </Field>
            )}

            {actionType === "send_to_sector" && (
              <Field label="Encaminhar para o setor" htmlFor="auto-sector-send">
                <select id="auto-sector-send" value={ruleSector} onChange={(e) => setRuleSector(e.target.value)}>
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>{SECTOR_LABELS[s]}</option>
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
        onClose={() => setDeleteTarget(null)}
        title="Excluir automação"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={async () => {
                if (deleteTarget) await handleDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-[0.8125rem] text-secondary">
          A automação <span className="font-medium text-primary">{deleteTarget?.name}</span> será removida e deixará de executar.
        </p>
      </Modal>
    </div>
  );
}
