// ============================================================
// Esfera v3 — Campaigns Tab (com Importador, Spintax & IA)
// Central de Campanhas, Importador de Contatos CSV e Editor
// ============================================================

import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_CAMPAIGNS } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import type { Campaign, CampaignStatus, Contact } from "../types";
import { invoke } from "@tauri-apps/api/core";
import {
  Megaphone,
  Plus,
  Play,
  Pause,
  Pencil,
  Users,
  AlertCircle,
  CheckCircle2,
  FileText,
  Clock,
  Smartphone,
  Brain,
  Upload,
  Sparkles,
  Send,
  Search,
  FileUp,
} from "lucide-react";

const statusConfig: Record<
  CampaignStatus,
  { variant: "success" | "warning" | "danger" | "info" | "neutral" | "purple"; label: string; icon: React.ReactNode }
> = {
  running: { variant: "success", label: "Rodando", icon: <Play size={12} /> },
  paused: { variant: "warning", label: "Pausada", icon: <Pause size={12} /> },
  completed: { variant: "info", label: "Concluída", icon: <CheckCircle2 size={12} /> },
  draft: { variant: "neutral", label: "Rascunho", icon: <FileText size={12} /> },
  error: { variant: "danger", label: "Erro", icon: <AlertCircle size={12} /> },
};

export default function CampaignsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [contactsModalOpen, setContactsModalOpen] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);

  // Import State
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [rawContactsInput, setRawContactsInput] = useState("");
  const [parsedContacts, setParsedContacts] = useState<{ name: string; phone: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedCompanyId) return;
    invoke<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => setCampaignsList(data))
      .catch(() => setCampaignsList(MOCK_CAMPAIGNS.filter((c) => c.companyId === selectedCompanyId)));
  }, [selectedCompanyId]);

  const filteredCampaigns = campaignsList.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const runningCount = campaignsList.filter((c) => c.status === "running").length;
  const totalSent = campaignsList.reduce((acc, c) => acc + (c.sentCount || 0), 0);
  const totalContacts = campaignsList.reduce((acc, c) => acc + (c.contactsCount || 0), 0);

  const openEditModal = (campaign?: Campaign) => {
    setSelectedCampaign(campaign || null);
    setEditModalOpen(true);
  };

  const openContactsModal = (campaign: Campaign) => {
    setSelectedCampaign(campaign);
    setContactsModalOpen(true);
  };

  // Higieniza números no padrão REALESS / Esfera v3
  const sanitizePhoneNumber = (raw: string) => {
    let clean = raw.replace(/\D/g, "");
    if (clean.length === 11 && clean.startsWith("9")) {
      clean = "55" + clean;
    } else if (clean.length === 9) {
      clean = "5511" + clean;
    }
    if (clean.length > 0 && !clean.startsWith("+")) {
      clean = "+" + clean;
    }
    return clean;
  };

  const handleParseContacts = () => {
    const lines = rawContactsInput.split("\n");
    const list: { name: string; phone: string }[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(/[,;\t]/);
      let name = "Cliente";
      let rawPhone = line;
      if (parts.length >= 2) {
        name = parts[0].trim();
        rawPhone = parts[1].trim();
      }
      const phone = sanitizePhoneNumber(rawPhone);
      if (phone.length > 5) {
        list.push({ name, phone });
      }
    }
    setParsedContacts(list);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setRawContactsInput(text);
      // Auto-parse after load
      const lines = text.split("\n");
      const list: { name: string; phone: string }[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split(/[,;\t]/);
        let name = "Cliente";
        let rawPhone = line;
        if (parts.length >= 2) {
          name = parts[0].trim();
          rawPhone = parts[1].trim();
        }
        const phone = sanitizePhoneNumber(rawPhone);
        if (phone.length > 5) {
          list.push({ name, phone });
        }
      }
      setParsedContacts(list);
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const handleConfirmImport = async () => {
    if (!selectedCampaign || parsedContacts.length === 0) return;
    try {
      await invoke("import_campaign_contacts", {
        campaignId: selectedCampaign.id,
        contacts: parsedContacts.map((c) => [c.name, c.phone]),
      });
    } catch {
      console.warn("Importação persistida em lote (Offline/Mock)");
    }

    setCampaignsList((prev) =>
      prev.map((c) =>
        c.id === selectedCampaign.id
          ? { ...c, contactsCount: c.contactsCount + parsedContacts.length }
          : c
      )
    );

    setImportModalOpen(false);
    setRawContactsInput("");
    setParsedContacts([]);
  };

  // Campaign dispatch controls
  const handleStartCampaign = async (campaign: Campaign) => {
    try {
      await invoke("start_campaign", { campaignId: campaign.id });
    } catch { /* noop */ }
    setCampaignsList((prev) =>
      prev.map((c) => (c.id === campaign.id ? { ...c, status: "running" as const } : c))
    );
  };

  const handlePauseCampaign = async (campaign: Campaign) => {
    try {
      await invoke("pause_campaign", { campaignId: campaign.id });
    } catch { /* noop */ }
    setCampaignsList((prev) =>
      prev.map((c) => (c.id === campaign.id ? { ...c, status: "paused" as const } : c))
    );
  };

  const handleSendBatch = async (campaign: Campaign) => {
    try {
      const result = await invoke<{ sent_in_batch: number; remaining: number; campaign_complete: boolean }>(
        "send_campaign",
        { campaignId: campaign.id }
      );
      setCampaignsList((prev) =>
        prev.map((c) =>
          c.id === campaign.id
            ? {
                ...c,
                sentCount: (c.sentCount || 0) + result.sent_in_batch,
                status: result.campaign_complete ? "completed" as const : c.status,
              }
            : c
        )
      );
    } catch { /* noop */ }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Hidden CSV file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.txt,.tsv"
        className="hidden"
        onChange={handleFileUpload}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Central de Campanhas</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Crie disparos em massa, programe automações e personalize mensagens com IA.
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => openEditModal()}>
          Criar Nova Campanha
        </Button>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-400">
            <Megaphone size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{campaignsList.length}</p>
            <p className="text-xs text-tertiary font-medium">Total de Campanhas</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-400">
            <Play size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{runningCount}</p>
            <p className="text-xs text-tertiary font-medium">Campanhas Rodando</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/15 border border-blue-500/20 text-blue-400">
            <Send size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{totalSent.toLocaleString()}</p>
            <p className="text-xs text-tertiary font-medium">Disparos Concluídos</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/15 border border-indigo-500/20 text-indigo-400">
            <Users size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{totalContacts.toLocaleString()}</p>
            <p className="text-xs text-tertiary font-medium">Fila de Contatos</p>
          </div>
        </Card>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80 flex items-center">
          <Search size={16} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
          <input
            type="text"
            placeholder="Buscar campanha por nome..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full input-with-icon-left"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto">
          {["all", "running", "paused", "completed", "draft"].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                statusFilter === status
                  ? "bg-violet-600/20 text-violet-300 border border-violet-500/30"
                  : "bg-white/5 text-secondary border border-border hover:bg-white/10"
              }`}
            >
              {status === "all" ? "Todas" : statusConfig[status as CampaignStatus]?.label || status}
            </button>
          ))}
        </div>
      </div>

      {/* Grid de Campanhas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredCampaigns.map((campaign) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            onEdit={() => openEditModal(campaign)}
            onContacts={() => openContactsModal(campaign)}
            onImport={() => {
              setSelectedCampaign(campaign);
              setImportModalOpen(true);
            }}
            onStart={() => handleStartCampaign(campaign)}
            onPause={() => handlePauseCampaign(campaign)}
            onSendBatch={() => handleSendBatch(campaign)}
          />
        ))}
      </div>

      {/* Edit/Create Campaign Modal */}
      {editModalOpen && (
        <CampaignEditModal
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          campaign={selectedCampaign}
          onSaved={() => {
            if (selectedCompanyId) {
              invoke<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
                .then((data) => setCampaignsList(data))
                .catch(() => {});
            }
          }}
        />
      )}

      {/* Contacts List Modal */}
      {contactsModalOpen && (
        <ContactsModal
          isOpen={contactsModalOpen}
          onClose={() => setContactsModalOpen(false)}
          campaign={selectedCampaign}
          onOpenImport={() => setImportModalOpen(true)}
        />
      )}

      {/* Contact Import Modal */}
      <Modal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        title={selectedCampaign ? `Importar Lista: ${selectedCampaign.name}` : "Importar Contatos"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setImportModalOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmImport}
              disabled={parsedContacts.length === 0}
              icon={<Upload size={14} />}
            >
              Confirmar ({parsedContacts.length})
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          {/* CSV File Upload */}
          <div className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.02] border border-border border-dashed">
            <div className="p-2.5 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-400">
              <FileUp size={20} />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-primary mb-0.5">Upload de arquivo CSV/TXT</p>
              <p className="text-[10px] text-tertiary">
                Formato: Nome, Telefone (um por linha). Separadores: vírgula, ponto e vírgula ou tab.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Upload size={13} />}
              onClick={() => fileInputRef.current?.click()}
            >
              Selecionar Arquivo
            </Button>
          </div>

          <div className="text-center text-[10px] text-tertiary font-semibold uppercase tracking-wider">— ou cole manualmente —</div>

          <div>
            <label className="block font-semibold text-secondary mb-1">
              Cole os contatos (Formato: Nome, Telefone)
            </label>
            <textarea
              rows={6}
              value={rawContactsInput}
              onChange={(e) => setRawContactsInput(e.target.value)}
              placeholder="Maria Silva, 11999991111&#10;João Souza, 5511988882222&#10;5511977773333"
              className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary font-mono placeholder:text-tertiary focus:border-violet-500/40 transition-all resize-none"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-tertiary">
              O importador limpa formatação e insere DDI +55 automaticamente.
            </span>
            <Button size="sm" variant="secondary" onClick={handleParseContacts}>
              Processar Prévia
            </Button>
          </div>

          {parsedContacts.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-border">
              <span className="font-bold text-primary block mb-2">Prévia ({parsedContacts.length} contatos):</span>
              <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                {parsedContacts.map((c, i) => (
                  <div key={i} className="flex justify-between items-center text-[11px] py-1 border-b border-border last:border-b-0">
                    <span className="font-semibold text-secondary">{c.name}</span>
                    <span className="font-mono text-violet-300">{c.phone}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---- Campaign Card Component ----
function CampaignCard({
  campaign,
  onEdit,
  onContacts,
  onImport,
  onStart,
  onPause,
  onSendBatch,
}: {
  campaign: Campaign;
  onEdit: () => void;
  onContacts: () => void;
  onImport: () => void;
  onStart: () => void;
  onPause: () => void;
  onSendBatch: () => void;
}) {
  const status = statusConfig[campaign.status as CampaignStatus] || statusConfig.draft;
  const contactsCount = campaign.contactsCount || 0;
  const sentCount = campaign.sentCount || 0;
  const failedCount = campaign.failedCount || 0;
  const progress = contactsCount > 0 ? Math.round((sentCount / contactsCount) * 100) : 0;
  const devices = campaign.deviceIds || [];

  return (
    <Card padding="md" hover className="flex flex-col justify-between h-[340px]">
      <div>
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="font-bold text-sm text-primary leading-tight line-clamp-1">{campaign.name}</h3>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>

        <div className="p-3 rounded-xl bg-white/[0.02] border border-border mb-4">
          <p className="text-xs text-secondary line-clamp-2">
            {campaign.greeting && <span className="text-violet-400 font-medium">{campaign.greeting} </span>}
            {campaign.message}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="text-center p-2 rounded-xl bg-white/[0.02] border border-border">
            <p className="text-[11px] text-tertiary mb-0.5">Contatos</p>
            <p className="text-xs font-bold text-primary">{contactsCount.toLocaleString()}</p>
          </div>
          <div className="text-center p-2 rounded-xl bg-white/[0.02] border border-border">
            <p className="text-[11px] text-tertiary mb-0.5">Enviados</p>
            <p className="text-xs font-bold text-emerald-400">{sentCount.toLocaleString()}</p>
          </div>
          <div className="text-center p-2 rounded-xl bg-white/[0.02] border border-border">
            <p className="text-[11px] text-tertiary mb-0.5">Falhas</p>
            <p className="text-xs font-bold text-red-400">{failedCount}</p>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-xs text-tertiary mb-1">
            <span>Progresso</span>
            <span className="font-semibold text-primary">{progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                campaign.status === "completed"
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                  : "bg-gradient-to-r from-violet-600 to-indigo-500"
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="inline-flex items-center gap-1 text-xs text-tertiary">
            <Smartphone size={13} />
            {devices.length || 1} cel.
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-tertiary">
            <Clock size={13} />
            {campaign.delayMin || 30}-{campaign.delayMax || 90}s
          </span>
          {campaign.useSpintax && (
            <Badge variant="purple" className="text-[10px]">Spintax</Badge>
          )}
          {campaign.useAI && (
            <Badge variant="info" className="text-[10px]">
              <Brain size={11} className="mr-0.5" /> IA
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 pt-2">
        {campaign.status === "running" ? (
          <>
            <Button variant="danger" size="sm" icon={<Pause size={13} />} onClick={onPause}>
              Pausar
            </Button>
            <Button variant="success" size="sm" icon={<Send size={13} />} onClick={onSendBatch}>
              Enviar
            </Button>
          </>
        ) : campaign.status === "paused" ? (
          <>
            <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={onStart}>
              Retomar
            </Button>
            <Button variant="success" size="sm" icon={<Send size={13} />} onClick={onSendBatch}>
              Enviar
            </Button>
          </>
        ) : campaign.status === "completed" ? (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 size={12} /> Concluída
          </Badge>
        ) : (
          <>
            <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={onStart}>
              Iniciar
            </Button>
            <Button variant="success" size="sm" icon={<Send size={13} />} onClick={onSendBatch}>
              Enviar
            </Button>
          </>
        )}
        <Button variant="secondary" size="sm" icon={<Upload size={13} />} onClick={onImport}>
          Importar
        </Button>
        <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={onEdit}>
          Editar
        </Button>
        <Button variant="secondary" size="sm" icon={<Users size={13} />} onClick={onContacts}>
          Fila
        </Button>
      </div>
    </Card>
  );
}

// ---- Campaign Edit Modal ----
function CampaignEditModal({
  isOpen,
  onClose,
  campaign,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onSaved: () => void;
}) {
  const { selectedCompanyId } = useAuth();
  const [useSpintax, setUseSpintax] = useState(campaign?.useSpintax ?? false);
  const [useAI, setUseAI] = useState(campaign?.useAI ?? false);

  const [nameText, setNameText] = useState(campaign?.name || "");
  const [greetingText, setGreetingText] = useState(campaign?.greeting || "");
  const [bodyText, setBodyText] = useState(campaign?.message || "");
  const [closingText, setClosingText] = useState(campaign?.closing || "");
  const [delayMinVal, setDelayMinVal] = useState(campaign?.delayMin || 30);
  const [delayMaxVal, setDelayMaxVal] = useState(campaign?.delayMax || 90);
  const [aiModelVal, setAiModelVal] = useState(campaign?.aiModel || "gpt-4o-mini");
  const [aiPromptVal, setAiPromptVal] = useState(campaign?.aiPrompt || "");

  const [spintaxPreview, setSpintaxPreview] = useState("");

  const handleSaveCampaign = async () => {
    if (!selectedCompanyId) return;
    const payload = {
      id: campaign?.id || 0,
      name: nameText,
      greeting: greetingText,
      message: bodyText,
      closing: closingText,
      delayMin: parseInt(String(delayMinVal), 10) || 30,
      delayMax: parseInt(String(delayMaxVal), 10) || 90,
      useSpintax,
      useAI,
      aiModel: aiModelVal,
      aiPrompt: aiPromptVal,
      status: campaign?.status || "draft",
      contactsCount: campaign?.contactsCount || 0,
      sentCount: campaign?.sentCount || 0,
      failedCount: campaign?.failedCount || 0,
      companyId: selectedCompanyId,
      updatedAt: new Date().toISOString().split("T")[0],
    };

    try {
      await invoke("create_campaign", { campaign: payload });
      onSaved();
      onClose();
    } catch (err) {
      console.error("Falha ao salvar campanha:", err);
    }
  };

  const handleTestSpintax = () => {
    const resolveSpintax = (text: string) => {
      let resolved = text;
      const spintaxRegex = /\{([^{}]+)\}/g;
      let match;
      while ((match = spintaxRegex.exec(resolved)) !== null) {
        const options = match[1].split("|");
        const chosen = options[Math.floor(Math.random() * options.length)];
        resolved = resolved.replace(match[0], chosen);
        spintaxRegex.lastIndex = 0;
      }
      return resolved;
    };
    const resolvedGreeting = resolveSpintax(greetingText);
    const resolvedBody = resolveSpintax(bodyText);
    const resolvedClosing = resolveSpintax(closingText);
    setSpintaxPreview(`${resolvedGreeting} ${resolvedBody} ${resolvedClosing}`.trim());
  };

  const handleTestAI = async () => {
    const msg = `${greetingText} ${bodyText} ${closingText}`.trim();
    try {
      const rewritten = await invoke<string>("rewrite_message_ai", { message: msg, contactName: "Maria" });
      setSpintaxPreview(rewritten);
    } catch {
      setSpintaxPreview("[IA Mock] " + msg.replace("{nome}", "Maria"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={campaign ? `Editar Campanha: ${campaign.name}` : "Criar Nova Campanha"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSaveCampaign}>Salvar Campanha</Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div>
          <label className="block font-semibold text-secondary mb-1">Nome da Campanha</label>
          <input
            type="text"
            value={nameText}
            onChange={(e) => setNameText(e.target.value)}
            placeholder="Ex: Disparo Promocional Julho 2026"
          />
        </div>

        <div>
          <label className="block font-semibold text-secondary mb-1">Saudação (Spintax Suportado)</label>
          <input
            type="text"
            value={greetingText}
            onChange={(e) => setGreetingText(e.target.value)}
            placeholder="Ex: {Olá|Bom dia|Oi} {nome}, tudo bem?"
          />
        </div>

        <div>
          <label className="block font-semibold text-secondary mb-1">Corpo da Mensagem (Spintax Suportado)</label>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Ex: Identificamos um acordo {pendente|disponível} com {desconto|abatimento} de 50%."
            rows={4}
            className="resize-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-secondary mb-1">Assinatura / Fechamento</label>
          <input
            type="text"
            value={closingText}
            onChange={(e) => setClosingText(e.target.value)}
            placeholder="Ex: Atenciosamente, {Equipe REALESS|Setor Financeiro}"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold text-secondary mb-1">Delay Mínimo (seg)</label>
            <input
              type="number"
              value={delayMinVal}
              onChange={(e) => setDelayMinVal(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">Delay Máximo (seg)</label>
            <input
              type="number"
              value={delayMaxVal}
              onChange={(e) => setDelayMaxVal(parseInt(e.target.value, 10) || 0)}
            />
          </div>
        </div>

        <div className="space-y-3 p-4 rounded-xl bg-white/[0.02] border border-border">
          <Toggle checked={useSpintax} onChange={setUseSpintax} label="Habilitar Variação Spintax" />
          <Toggle checked={useAI} onChange={setUseAI} label="Personalização Inteligente via IA" />

          {useSpintax && (
            <div className="pt-2.5 space-y-2.5 animate-scale-in">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-primary block">Testador de Variação</span>
                <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} onClick={handleTestSpintax}>
                  Simular Spintax
                </Button>
              </div>
              {spintaxPreview && (
                <div className="p-3 rounded-xl bg-violet-600/10 border border-violet-500/25 text-violet-200 font-mono">
                  {spintaxPreview}
                </div>
              )}
            </div>
          )}

          {useAI && (
            <div className="space-y-3 pl-4 pt-2 border-l-2 border-violet-500/40 animate-fade-in">
              <div>
                <label className="block font-semibold text-secondary mb-1">Modelo de IA</label>
                <select
                  value={aiModelVal}
                  onChange={(e) => setAiModelVal(e.target.value)}
                  className="w-full px-4 py-2 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
                >
                  <option value="gpt-4o-mini">GPT-4o Mini</option>
                  <option value="gpt-4o">GPT-4o High Speed</option>
                  <option value="claude-3-haiku">Claude 3 Haiku</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold text-secondary mb-1">Prompt de Instrução</label>
                <textarea
                  value={aiPromptVal}
                  onChange={(e) => setAiPromptVal(e.target.value)}
                  placeholder="Instrua a IA sobre como reescrever a mensagem..."
                  rows={2}
                  className="w-full px-4 py-2 rounded-xl bg-white/5 border border-border text-primary placeholder:text-tertiary focus:border-violet-500/40 transition-all resize-none"
                />
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="font-semibold text-primary block">Testar Reescrita IA</span>
                <Button size="sm" variant="secondary" icon={<Brain size={13} />} onClick={handleTestAI}>
                  Gerar com IA
                </Button>
              </div>
              {spintaxPreview && (
                <div className="p-3 rounded-xl bg-blue-600/10 border border-blue-500/25 text-blue-200 font-mono">
                  {spintaxPreview}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---- Contacts List Modal ----
function ContactsModal({
  isOpen,
  onClose,
  campaign,
  onOpenImport,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onOpenImport: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    if (!isOpen || !campaign) return;
    invoke<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
      .then((data) => setContacts(data))
      .catch(() => {
        setContacts([
          {
            id: 1,
            name: "Maria Silva",
            phone: "+5511999991111",
            status: "pending" as any,
            campaignId: campaign.id,
          },
          {
            id: 2,
            name: "João Souza",
            phone: "+5511988882222",
            status: "sent" as any,
            campaignId: campaign.id,
          },
        ]);
      });
  }, [isOpen, campaign]);

  const pendingCount = contacts.filter((c) => c.status === "pending").length;
  const sentCount = contacts.filter((c) => c.status === "sent").length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={campaign ? `Fila de Disparos: ${campaign.name}` : "Fila de Contatos"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Fechar
          </Button>
          <Button variant="primary" icon={<Upload size={14} />} onClick={() => { onClose(); onOpenImport(); }}>
            Importar Contatos
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {contacts.length > 0 && (
          <div className="flex items-center gap-4 text-xs">
            <Badge variant="neutral">Pendentes: {pendingCount}</Badge>
            <Badge variant="success">Enviados: {sentCount}</Badge>
            <Badge variant="purple">Total: {contacts.length}</Badge>
          </div>
        )}
        {contacts.length === 0 ? (
          <div className="text-center py-10 text-tertiary">
            <Users size={36} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs font-medium">Nenhum contato cadastrado nesta campanha</p>
          </div>
        ) : (
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-border text-tertiary font-semibold uppercase tracking-wider">
                <th className="py-2.5">Nome</th>
                <th className="py-2.5">Telefone</th>
                <th className="py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((contact) => (
                <tr key={contact.id} className="hover:bg-white/[0.02]">
                  <td className="py-2.5 font-medium text-primary">{contact.name}</td>
                  <td className="py-2.5 font-mono text-secondary">{contact.phone}</td>
                  <td className="py-2.5">
                    {contact.status === "sent" ? (
                      <Badge variant="success">Enviado</Badge>
                    ) : contact.status === "failed" ? (
                      <Badge variant="danger">Falhou</Badge>
                    ) : (
                      <Badge variant="neutral">Pendente</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
