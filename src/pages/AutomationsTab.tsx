// ============================================================
// Esfera v3 — Automations Tab com Triggers & Actions
// Motor de regras com gatilhos avançados e ações multi-destino
// ============================================================

import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_AUTOMATIONS } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
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

const TRIGGER_COLORS: Record<AutomationTriggerType, string> = {
  keyword: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  ban_detected: "bg-red-500/20 text-red-400 border-red-500/30",
  device_offline: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  schedule: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  message_received: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
};

const ACTION_ICONS: Record<AutomationActionType, React.ReactNode> = {
  send_response: <MessageSquare size={16} />,
  move_chip: <ArrowRight size={16} />,
  notify: <Bell size={16} />,
  toggle_campaign: <Play size={16} />,
  set_chip_status: <Shield size={16} />,
  send_to_sector: <Users size={16} />,
};

const ACTION_COLORS: Record<AutomationActionType, string> = {
  send_response: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  move_chip: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  notify: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  toggle_campaign: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  set_chip_status: "bg-red-500/20 text-red-400 border-red-500/30",
  send_to_sector: "bg-pink-500/20 text-pink-400 border-pink-500/30",
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
    if (!selectedCompanyId) { if (mounted) setAutomationsList([]); return; }
    api<Automation[]>("get_automations", { companyId: selectedCompanyId })
      .then((data) => { if (mounted) setAutomationsList(data); })
      .catch(() => { if (mounted) setAutomationsList(MOCK_AUTOMATIONS.filter((a) => a.companyId === selectedCompanyId)); });
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
    const newActive = !currentActive;
    setAutomationsList((prev) =>
      prev.map((a) => (a.id === id ? { ...a, active: newActive } : a))
    );
    try {
      const automation = automationsList.find((a) => a.id === id);
      if (!automation) return;
      await api("update_automation", {
        automation,
      });
    } catch { /* noop */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await api("soft_delete_automation", { automationId: id });
    } catch { /* noop */ }
    setAutomationsList((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Automações Avançadas</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Triggers inteligentes com ações automáticas — detections, agendamentos e respostas.
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => openEditModal()}>
          Nova Automação
        </Button>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-400">
            <Bot size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{automationsList.length}</p>
            <p className="text-xs text-tertiary font-medium">Total de Regras</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{activeRulesCount}</p>
            <p className="text-xs text-tertiary font-medium">Regras Ativas</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/20 text-amber-400">
            <Zap size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{totalTriggers.toLocaleString()}</p>
            <p className="text-xs text-tertiary font-medium">Total de Disparos</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/15 border border-blue-500/20 text-blue-400">
            <AlertTriangle size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">
              {automationsList.filter((a) => a.triggerType === "ban_detected").length}
            </p>
            <p className="text-xs text-tertiary font-medium">Watchdogs Ban</p>
          </div>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-md flex items-center">
        <Search size={16} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
        <input
          type="text"
          placeholder="Buscar por regra ou palavra-chave..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full input-with-icon-left"
        />
      </div>

      {/* Automations List */}
      <div className="space-y-3">
        {filteredAutomations.map((automation, idx) => (
          <Card key={automation.id || idx} padding="none" hover>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-4">
              <div className="flex items-start sm:items-center gap-3.5">
                <div
                  className={`flex items-center justify-center w-10 h-10 rounded-2xl border ${
                    automation.active
                      ? "bg-violet-600/20 text-violet-400 border-violet-500/30"
                      : "bg-white/5 text-tertiary border-border"
                  }`}
                >
                  {TRIGGER_ICONS[automation.triggerType || "keyword"]}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-bold text-sm text-primary">{automation.name}</h3>
                    <Badge variant={automation.active ? "success" : "neutral"} dot>
                      {automation.active ? "Ativa" : "Inativa"}
                    </Badge>
                    <Badge variant="purple" className="text-[10px] gap-1">
                      {TRIGGER_ICONS[automation.triggerType || "keyword"]}
                      {TRIGGER_LABELS[automation.triggerType || "keyword"]}
                    </Badge>
                    <Badge variant="info" className="text-[10px] gap-1">
                      {ACTION_ICONS[automation.actionType || "send_response"]}
                      {ACTION_LABELS[automation.actionType || "send_response"]}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-secondary flex-wrap">
                    {automation.keyword && (
                      <span className="inline-flex items-center gap-1 font-mono text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-md border border-violet-500/20">
                        <Hash size={12} />
                        "{automation.keyword}"
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-tertiary">
                      <Zap size={12} className="text-amber-400" />
                      {automation.triggeredCount || 0} execuções
                    </span>
                  </div>

                  <p className="text-xs text-tertiary mt-1.5 line-clamp-1 flex items-center gap-1">
                    <ArrowRight size={12} className="shrink-0 text-secondary" />
                    <span>
                      {automation.actionType === "send_response" && automation.response}
                      {automation.actionType === "move_chip" && `Mover chip → ${SECTOR_LABELS[automation.sector || "junior"]}`}
                      {automation.actionType === "notify" && "Notificar gestor via sistema"}
                      {automation.actionType === "toggle_campaign" && "Pausar/iniciar campanha vinculada"}
                      {automation.actionType === "set_chip_status" && "Alterar status do chip automaticamente"}
                      {automation.actionType === "send_to_sector" && `Encaminhar → ${SECTOR_LABELS[automation.sector || "junior"]}`}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 border-t sm:border-t-0 border-border pt-3 sm:pt-0 shrink-0">
                <Toggle
                  checked={automation.active}
                  onChange={() => toggleActive(automation.id, automation.active)}
                  size="sm"
                />
                <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={() => openEditModal(automation)}>
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  className="text-red-400 hover:text-red-300"
                  onClick={() => handleDelete(automation.id)}
                >
                  Excluir
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {filteredAutomations.length === 0 && (
        <Card className="flex flex-col items-center justify-center py-16 text-center text-tertiary">
          <Bot size={40} className="mb-2 opacity-30" />
          <p className="text-sm font-medium text-secondary">Nenhuma automação encontrada</p>
          <p className="text-xs">Crie uma nova regra com triggers e ações automáticas.</p>
        </Card>
      )}

      {/* Modal Criar/Editar */}
      <Modal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={selectedAutomation ? `Editar: ${selectedAutomation.name}` : "Nova Automação"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveAutomation}>Salvar Automação</Button>
          </>
        }
      >
        <div className="space-y-5 text-xs">
          {/* Nome */}
          <div>
            <label className="block font-semibold text-secondary mb-1">Nome da Automação</label>
            <input
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="Ex: Auto-resposta Orçamento"
              className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary placeholder:text-tertiary focus:border-violet-500/40 transition-all"
            />
          </div>

          {/* TRIGGER */}
          <div className="p-4 rounded-xl bg-white/[0.02] border border-border space-y-4">
            <h4 className="font-bold text-primary flex items-center gap-2">
              <Zap size={16} className="text-violet-400" />
              Gatilho (Trigger)
            </h4>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(TRIGGER_LABELS) as AutomationTriggerType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTriggerType(t)}
                  className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer border ${
                    triggerType === t
                      ? `${TRIGGER_COLORS[t]} border-current`
                      : "bg-white/[0.02] text-secondary border-border hover:bg-white/[0.04]"
                  }`}
                >
                  {TRIGGER_ICONS[t]}
                  {TRIGGER_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Trigger-specific config */}
            {triggerType === "keyword" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">Palavra-chave</label>
                <input
                  type="text"
                  value={ruleKeyword}
                  onChange={(e) => setRuleKeyword(e.target.value)}
                  placeholder="Ex: orcamento, preco, valor"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono placeholder:text-tertiary focus:border-violet-500/40 transition-all"
                />
              </div>
            )}

            {triggerType === "schedule" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-secondary mb-1">Horário</label>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-secondary mb-1">Dias (1=Seg...7=Dom)</label>
                  <input
                    type="text"
                    value={scheduleDays}
                    onChange={(e) => setScheduleDays(e.target.value)}
                    placeholder="1,2,3,4,5"
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono placeholder:text-tertiary focus:border-violet-500/40 transition-all"
                  />
                </div>
              </div>
            )}

            {triggerType === "ban_detected" && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
                Esta automação será executada sempre que um chip for marcado como banido pelo WhatsApp.
              </div>
            )}

            {triggerType === "device_offline" && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                Esta automação será executada quando um dispositivo ficar offline por mais de 5 minutos.
              </div>
            )}

            {triggerType === "message_received" && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs">
                Esta automação será executada ao receber qualquer mensagem de cliente.
              </div>
            )}
          </div>

          {/* ACTION */}
          <div className="p-4 rounded-xl bg-white/[0.02] border border-border space-y-4">
            <h4 className="font-bold text-primary flex items-center gap-2">
              <ArrowRight size={16} className="text-violet-400" />
              Ação
            </h4>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(ACTION_LABELS) as AutomationActionType[]).map((a) => (
                <button
                  key={a}
                  onClick={() => setActionType(a)}
                  className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer border ${
                    actionType === a
                      ? `${ACTION_COLORS[a]} border-current`
                      : "bg-white/[0.02] text-secondary border-border hover:bg-white/[0.04]"
                  }`}
                >
                  {ACTION_ICONS[a]}
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>

            {/* Action-specific config */}
            {actionType === "send_response" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">Mensagem de Resposta</label>
                <textarea
                  value={ruleResponse}
                  onChange={(e) => setRuleResponse(e.target.value)}
                  placeholder="Digite a resposta automática..."
                  rows={4}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary placeholder:text-tertiary focus:border-violet-500/40 transition-all resize-none"
                />
              </div>
            )}

            {actionType === "move_chip" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">Mover para Setor</label>
                <select
                  value={ruleSector}
                  onChange={(e) => setRuleSector(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
                >
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>{SECTOR_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            )}

            {actionType === "notify" && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                O gestor responsável receberá uma notificação no painel de alertas do sistema.
              </div>
            )}

            {actionType === "toggle_campaign" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">ID da Campanha</label>
                <input
                  type="number"
                  value={targetCampaignId}
                  onChange={(e) => setTargetCampaignId(e.target.value)}
                  placeholder="ID da campanha"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono placeholder:text-tertiary focus:border-violet-500/40 transition-all"
                />
              </div>
            )}

            {actionType === "set_chip_status" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">Novo Status do Chip</label>
                <select
                  value={chipTargetStatus}
                  onChange={(e) => setChipTargetStatus(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
                >
                  <option value="livre">Livre</option>
                  <option value="restrito_24h">Restrito 24h</option>
                  <option value="restrito_7d">Restrito 7d</option>
                  <option value="banido">Banido</option>
                </select>
              </div>
            )}

            {actionType === "send_to_sector" && (
              <div>
                <label className="block font-semibold text-secondary mb-1">Encaminhar para Setor</label>
                <select
                  value={ruleSector}
                  onChange={(e) => setRuleSector(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
                >
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>{SECTOR_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
