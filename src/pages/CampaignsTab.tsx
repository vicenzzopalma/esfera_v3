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
import type { Campaign, CampaignStatus, Contact, AiConfig } from "../types";
import { api } from "../tauri";
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
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [aiGlobalModalOpen, setAiGlobalModalOpen] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);

  // Import State
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [rawContactsInput, setRawContactsInput] = useState("");
  const [parsedContacts, setParsedContacts] = useState<{ name: string; phone: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;
    if (!selectedCompanyId) { if (mounted) setCampaignsList([]); return; }
    api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => { if (mounted) setCampaignsList(data); })
      .catch(() => { if (mounted) setCampaignsList(MOCK_CAMPAIGNS.filter((c) => c.companyId === selectedCompanyId)); });
    return () => { mounted = false; };
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

  const openExecutionModal = (campaign: Campaign) => {
    setSelectedCampaign(campaign);
    setExecutionModalOpen(true);
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
      await api("import_campaign_contacts", {
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
          <h2 className="text-xl font-bold text-primary tracking-tight">Central de Campanhas & Disparos</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Crie disparos em massa, programe automações e gerencie IA e hierarquias de celulares por campanha.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Brain size={16} />} onClick={() => setAiGlobalModalOpen(true)}>
            🤖 IA & Envio Globais
          </Button>
          <Button icon={<Plus size={16} />} onClick={() => openEditModal()}>
            Criar Nova Campanha
          </Button>
        </div>
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
            onOpenExecution={() => openExecutionModal(campaign)}
            onEdit={() => openEditModal(campaign)}
            onContacts={() => openContactsModal(campaign)}
            onImport={() => {
              setSelectedCampaign(campaign);
              setImportModalOpen(true);
            }}
          />
        ))}
      </div>

      {/* Janela Modal de Execução de Campanha Independente */}
      {executionModalOpen && (
        <CampaignExecutionModal
          isOpen={executionModalOpen}
          onClose={() => setExecutionModalOpen(false)}
          campaign={selectedCampaign}
          onUpdateCampaign={(updatedCamp) => {
            setCampaignsList((prev) =>
              prev.map((c) => (c.id === updatedCamp.id ? updatedCamp : c))
            );
          }}
        />
      )}

      {/* Modal de Configurações Globais de IA & Disparo */}
      {aiGlobalModalOpen && (
        <GlobalAiConfigModal
          isOpen={aiGlobalModalOpen}
          onClose={() => setAiGlobalModalOpen(false)}
        />
      )}

      {/* Edit/Create Campaign Modal */}
      {editModalOpen && (
        <CampaignEditModal
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          campaign={selectedCampaign}
          onSaved={(savedCamp) => {
            setCampaignsList((prev) => {
              const idx = prev.findIndex((c) => c.id === savedCamp.id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = savedCamp;
                return updated;
              }
              return [savedCamp, ...prev];
            });
            if (selectedCompanyId) {
              api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
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
  onOpenExecution,
  onEdit,
  onContacts,
  onImport,
}: {
  campaign: Campaign;
  onOpenExecution: () => void;
  onEdit: () => void;
  onContacts: () => void;
  onImport: () => void;
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

      <div className="flex items-center gap-1.5 pt-2 flex-wrap">
        <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={onOpenExecution}>
          ⚡ Janela Independente
        </Button>
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
  onSaved: (campaign: Campaign) => void;
}) {
  const { selectedCompanyId } = useAuth();
  const [useSpintax, setUseSpintax] = useState(campaign?.useSpintax ?? true);
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

  useEffect(() => {
    if (isOpen) {
      setNameText(campaign?.name || "");
      setGreetingText(campaign?.greeting || "{Olá|Oi|Bom dia} {nome}, tudo bem?");
      setBodyText(campaign?.message || "Temos uma condição especial disponível para você hoje!");
      setClosingText(campaign?.closing || "Atenciosamente, {Equipe REALESS|Setor Financeiro}");
      setDelayMinVal(campaign?.delayMin || 30);
      setDelayMaxVal(campaign?.delayMax || 90);
      setUseSpintax(campaign?.useSpintax ?? true);
      setUseAI(campaign?.useAI ?? false);
      setAiModelVal(campaign?.aiModel || "gpt-4o-mini");
      setAiPromptVal(campaign?.aiPrompt || "");
      setSpintaxPreview("");
    }
  }, [isOpen, campaign]);

  const handleSaveCampaign = async () => {
    if (!selectedCompanyId) return;
    const finalName = nameText.trim() || `Campanha ${new Date().toLocaleDateString("pt-BR")} ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    const payload = {
      id: campaign?.id || 0,
      name: finalName,
      greeting: greetingText,
      message: bodyText,
      closing: closingText,
      delayMin: parseInt(String(delayMinVal), 10) || 30,
      delayMax: parseInt(String(delayMaxVal), 10) || 90,
      useSpintax,
      useAi: useAI,
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
      if (campaign?.id) {
        await api("update_campaign", { campaign: payload });
      } else {
        const newId = await api<number>("create_campaign", { campaign: payload });
        if (newId) payload.id = newId;
      }
      onSaved(payload as unknown as Campaign);
      onClose();
    } catch (err) {
      console.warn("Criando/atualizando campanha no estado local:", err);
      const fallbackCamp: Campaign = {
        id: campaign?.id || Date.now(),
        name: finalName,
        greeting: greetingText,
        message: bodyText,
        closing: closingText,
        delayMin: parseInt(String(delayMinVal), 10) || 30,
        delayMax: parseInt(String(delayMaxVal), 10) || 90,
        useSpintax,
        useAI,
        aiModel: aiModelVal,
        aiPrompt: aiPromptVal,
        status: (campaign?.status || "draft") as CampaignStatus,
        contactsCount: campaign?.contactsCount || 0,
        sentCount: campaign?.sentCount || 0,
        failedCount: campaign?.failedCount || 0,
        companyId: selectedCompanyId,
        updatedAt: new Date().toISOString().split("T")[0],
      };
      onSaved(fallbackCamp);
      onClose();
    }
  };

  const handleTestSpintax = () => {
    const resolveSpintax = (text: string) => {
      let resolved = text;
      const spintaxRegex = /\{([^{}]+)\}/g;
      let match;
      let maxIterations = 100;
      while ((match = spintaxRegex.exec(resolved)) !== null && maxIterations-- > 0) {
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
      const rewritten = await api<string>("rewrite_message_ai", { message: msg, contactName: "Maria" });
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
    let mounted = true;
    if (!isOpen || !campaign) { if (mounted) setContacts([]); return; }
    api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
      .then((data) => { if (mounted) setContacts(data); })
      .catch(() => {
        if (mounted) {
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
        }
      });
    return () => { mounted = false; };
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
                  <td className="py-2.5 font-medium text-primary">{contact.contactName}</td>
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

// ============================================================
// JANELA MODAL DE EXECUÇÃO INDEPENDENTE DE CAMPANHA & HIERARQUIA
// ============================================================
function CampaignExecutionModal({
  isOpen,
  onClose,
  campaign,
  onUpdateCampaign,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onUpdateCampaign: (updated: Campaign) => void;
}) {
  const [activeSubTab, setActiveSubTab] = useState<"execution" | "hierarchy" | "settings">("execution");
  const [selectedSector, setSelectedSector] = useState<string>("all");
  const [delayMin, setDelayMin] = useState<number>(campaign?.delayMin || 30);
  const [delayMax, setDelayMax] = useState<number>(campaign?.delayMax || 90);
  const [useAI, setUseAI] = useState<boolean>(campaign?.useAI || false);
  const [aiPrompt, setAiPrompt] = useState<string>(campaign?.aiPrompt || "");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [sendingBatch, setSendingBatch] = useState(false);
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen && campaign) {
      setDelayMin(campaign.delayMin || 30);
      setDelayMax(campaign.delayMax || 90);
      setUseAI(campaign.useAI || false);
      setAiPrompt(campaign.aiPrompt || "");
      api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
        .then((data) => setContacts(data))
        .catch(() => {});
    }
  }, [isOpen, campaign]);

  if (!campaign) return null;

  const total = contacts.length || campaign.contactsCount || 0;
  const sent = contacts.filter((c) => c.status === "sent").length || campaign.sentCount || 0;
  const failed = contacts.filter((c) => c.status === "failed").length || campaign.failedCount || 0;
  const pending = total - sent - failed;
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;

  const handleRunBatch = async () => {
    setSendingBatch(true);
    const ts = new Date().toLocaleTimeString("pt-BR");
    setExecutionLogs((prev) => [
      `[${ts}] 🚀 Iniciando disparo do lote para setor '${selectedSector.toUpperCase()}' (Delay: ${delayMin}-${delayMax}s, IA: ${useAI ? "Ativada" : "Desativada"})...`,
      ...prev,
    ]);

    try {
      const res = await api<{ sent_in_batch: number; remaining: number; campaign_complete: boolean }>(
        "send_campaign",
        { campaignId: campaign.id }
      );
      const updatedCamp: Campaign = {
        ...campaign,
        sentCount: (campaign.sentCount || 0) + res.sent_in_batch,
        status: res.campaign_complete ? "completed" : "running",
      };
      onUpdateCampaign(updatedCamp);
      setExecutionLogs((prev) => [
        `[${new Date().toLocaleTimeString("pt-BR")}] ✅ Lote enviado com sucesso (+${res.sent_in_batch} mensagens). Restantes na fila: ${res.remaining}`,
        ...prev,
      ]);

      // Atualiza lista de contatos local
      const refreshed = await api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id });
      setContacts(refreshed);
    } catch (e: any) {
      setExecutionLogs((prev) => [
        `[${new Date().toLocaleTimeString("pt-BR")}] ❌ Erro na execução: ${typeof e === "string" ? e : e?.message || "Erro desconhecido"}`,
        ...prev,
      ]);
    } finally {
      setSendingBatch(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`🚀 Janela Independente: ${campaign.name}`}
      size="xl"
      footer={
        <div className="flex items-center justify-between w-full">
          <Badge variant={campaign.status === "running" ? "success" : "warning"}>
            Status: {campaign.status.toUpperCase()}
          </Badge>
          <Button variant="secondary" onClick={onClose}>
            Fechar Janela
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-xs">
        {/* Navegação da Janela Independente */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          {[
            { id: "execution", label: "⚡ Execução Ao Vivo", icon: <Play size={14} /> },
            { id: "hierarchy", label: "📱 Hierarquia de Celulares", icon: <Smartphone size={14} /> },
            { id: "settings", label: "🤖 IA & Delays Exclusivos", icon: <Brain size={14} /> },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl font-bold transition-all cursor-pointer ${
                activeSubTab === tab.id
                  ? "bg-violet-600 text-white shadow-md shadow-violet-600/30"
                  : "bg-white/5 text-slate-400 hover:text-white"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* SUBTAB 1: EXECUÇÃO AO VIVO */}
        {activeSubTab === "execution" && (
          <div className="space-y-4 animate-fade-in">
            <div className="grid grid-cols-4 gap-3">
              <div className="p-3 bg-white/[0.02] border border-border rounded-xl text-center">
                <span className="text-[10px] text-tertiary uppercase block">Total Fila</span>
                <span className="text-lg font-bold text-white font-mono">{total}</span>
              </div>
              <div className="p-3 bg-emerald-950/30 border border-emerald-500/30 rounded-xl text-center">
                <span className="text-[10px] text-emerald-400 uppercase block">Enviados</span>
                <span className="text-lg font-bold text-emerald-300 font-mono">{sent}</span>
              </div>
              <div className="p-3 bg-amber-950/30 border border-amber-500/30 rounded-xl text-center">
                <span className="text-[10px] text-amber-400 uppercase block">Pendentes</span>
                <span className="text-lg font-bold text-amber-300 font-mono">{pending}</span>
              </div>
              <div className="p-3 bg-red-950/30 border border-red-500/30 rounded-xl text-center">
                <span className="text-[10px] text-red-400 uppercase block">Falhas</span>
                <span className="text-lg font-bold text-red-300 font-mono">{failed}</span>
              </div>
            </div>

            {/* Progresso */}
            <div className="space-y-1">
              <div className="flex justify-between font-bold text-slate-300 text-xs">
                <span>Progresso Independente</span>
                <span>{progress}%</span>
              </div>
              <div className="h-3 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                <div className="h-full bg-gradient-to-r from-violet-600 to-emerald-400 transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {/* Ações de Controle Independente */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="success"
                onClick={handleRunBatch}
                disabled={sendingBatch || pending === 0}
                icon={<Send size={15} />}
                className="flex-1 py-2.5 font-bold shadow-lg shadow-emerald-600/30"
              >
                {sendingBatch ? "Disparando Lote..." : `Disparar Próximo Lote (${selectedSector.toUpperCase()})`}
              </Button>
            </div>

            {/* Logs de Envio ao Vivo */}
            <div className="space-y-1.5 pt-2">
              <label className="font-bold text-slate-300 text-xs">Log de Envio em Tempo Real (Janela Isolada):</label>
              <div className="h-36 bg-[#090d16] border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-emerald-400 overflow-y-auto space-y-1 custom-scrollbar">
                {executionLogs.length === 0 ? (
                  <p className="text-slate-600 italic">Nenhum log gravado nesta sessão de disparo.</p>
                ) : (
                  executionLogs.map((log, idx) => <p key={idx}>{log}</p>)
                )}
              </div>
            </div>
          </div>
        )}

        {/* SUBTAB 2: HIERARQUIA DE CELULARES */}
        {activeSubTab === "hierarchy" && (
          <div className="space-y-4 animate-fade-in">
            <div className="p-4 bg-violet-950/30 border border-violet-500/30 rounded-xl space-y-2">
              <h4 className="font-bold text-violet-300 text-sm">Respeito à Hierarquia de Setores de Celulares</h4>
              <p className="text-slate-400 text-xs">
                Selecione qual setor de celulares será alocado para os disparos desta campanha específica. Cada campanha executa em sua fila isolada.
              </p>
            </div>

            <div>
              <label className="block font-bold text-slate-300 mb-2">Setor de Destino dos Celulares:</label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {[
                  { id: "all", label: "Todos os Setores" },
                  { id: "junior", label: "Junior" },
                  { id: "senior", label: "Senior" },
                  { id: "pa_fixa", label: "PA FIXA" },
                  { id: "pesquisa", label: "Pesquisa" },
                ].map((sec) => (
                  <button
                    key={sec.id}
                    onClick={() => setSelectedSector(sec.id)}
                    className={`p-3 rounded-xl border font-bold text-xs transition-all cursor-pointer text-center ${
                      selectedSector === sec.id
                        ? "bg-violet-600 text-white border-violet-400 shadow-lg shadow-violet-600/40"
                        : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                    }`}
                  >
                    {sec.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* SUBTAB 3: IA & DELAYS EXCLUSIVOS */}
        {activeSubTab === "settings" && (
          <div className="space-y-4 animate-fade-in">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-bold text-slate-300 mb-1">Delay Mínimo (segundos)</label>
                <input
                  type="number"
                  value={delayMin}
                  onChange={(e) => setDelayMin(parseInt(e.target.value) || 10)}
                  className="w-full input-setting text-center font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-300 mb-1">Delay Máximo (segundos)</label>
                <input
                  type="number"
                  value={delayMax}
                  onChange={(e) => setDelayMax(parseInt(e.target.value) || 60)}
                  className="w-full input-setting text-center font-mono"
                />
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <Toggle checked={useAI} onChange={setUseAI} label="Ativar Personalização de Mensagens via IA nesta Campanha" />
              {useAI && (
                <div>
                  <label className="block font-bold text-slate-300 mb-1">System Prompt / Instrução da IA para esta Campanha:</label>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    rows={3}
                    placeholder="Ex: Reescreva a mensagem mantendo o tom amigável e oferecendo 10% de desconto adicional."
                    className="w-full input-setting resize-none"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================
// MODAL DE CONFIGURAÇÕES GLOBAIS DE IA & DISPARO (NA ABA DE DISPARO)
// ============================================================
function GlobalAiConfigModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { selectedCompanyId } = useAuth();
  const [provider, setProvider] = useState("ollama_local");
  const [endpoint, setEndpoint] = useState("http://localhost:11434");
  const [model, setModel] = useState("llama3.2");
  const [temperature, setTemperature] = useState(0.7);
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("Você é um assistente de cobrança. Seja profissional e gentil.");
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    if (isOpen && selectedCompanyId) {
      api<AiConfig>("get_ai_config", { companyId: selectedCompanyId })
        .then((cfg) => {
          if (!cfg) return;
          setProvider(cfg.provider || "ollama_local");
          setEndpoint(cfg.endpoint || "http://localhost:11434");
          setModel(cfg.model || "llama3.2");
          setTemperature(cfg.temperature || 0.7);
          setApiKey(cfg.apiKey || "");
          setSystemPrompt(cfg.systemPrompt || "");
        })
        .catch(() => {});
    }
  }, [isOpen, selectedCompanyId]);

  const handleSave = async () => {
    if (!selectedCompanyId) return;
    try {
      await api("save_ai_config", {
        companyId: selectedCompanyId,
        config: { provider, model, temperature, systemPrompt, apiKey, endpoint },
      });
      setStatusMsg("✅ Parâmetros globais de IA e Envio salvos com sucesso!");
      setTimeout(() => onClose(), 1200);
    } catch {
      setStatusMsg("❌ Erro ao salvar parâmetros de IA.");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="🤖 Parâmetros Globais de Inteligência Artificial & Disparo"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSave}>Salvar Parâmetros</Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold text-secondary mb-1">Provedor de IA</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full input-setting">
              <option value="ollama_local">Ollama Local (Offline / High Speed)</option>
              <option value="openai">OpenAI ChatGPT (Nuvem)</option>
              <option value="anthropic">Anthropic Claude</option>
            </select>
          </div>
          <div>
            <label className="block font-semibold text-secondary mb-1">Modelo de IA</label>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.2 ou gpt-4o-mini" className="w-full input-setting" />
          </div>
        </div>

        <div>
          <label className="block font-semibold text-secondary mb-1">Endpoint de Conexão IA</label>
          <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:11434" className="w-full input-setting font-mono" />
        </div>

        <div>
          <label className="block font-semibold text-secondary mb-1">System Prompt Padrão da Empresa</label>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4} className="w-full input-setting resize-none" />
        </div>

        {statusMsg && (
          <div className="p-3 bg-violet-600/20 border border-violet-500/30 text-violet-300 rounded-xl font-bold">
            {statusMsg}
          </div>
        )}
      </div>
    </Modal>
  );
}
