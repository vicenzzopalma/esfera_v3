// ============================================================
// Esfera v3 — Campaigns Tab
// Gerenciamento de campanhas de disparo
// ============================================================

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_CAMPAIGNS, MOCK_CONTACTS, MOCK_DEVICES } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import type { Campaign, CampaignStatus } from "../types";
import {
  Megaphone,
  Plus,
  Play,
  Pause,
  Pencil,
  Users,
  Send,
  AlertCircle,
  CheckCircle2,
  FileText,
  Search,
  Clock,
  Smartphone,
  Brain,
} from "lucide-react";

const statusConfig: Record<CampaignStatus, { variant: "success" | "warning" | "danger" | "info" | "neutral" | "purple"; label: string; icon: React.ReactNode }> = {
  running: { variant: "success", label: "Rodando", icon: <Play size={12} /> },
  paused: { variant: "warning", label: "Pausada", icon: <Pause size={12} /> },
  completed: { variant: "info", label: "Concluída", icon: <CheckCircle2 size={12} /> },
  draft: { variant: "neutral", label: "Rascunho", icon: <FileText size={12} /> },
  error: { variant: "danger", label: "Erro", icon: <AlertCircle size={12} /> },
};

export default function CampaignsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [contactsModalOpen, setContactsModalOpen] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);

  const campaigns = MOCK_CAMPAIGNS.filter((c) => c.companyId === selectedCompanyId);
  const filteredCampaigns = campaigns.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const openEditModal = (campaign?: Campaign) => {
    setSelectedCampaign(campaign || null);
    setEditModalOpen(true);
  };

  const openContactsModal = (campaign: Campaign) => {
    setSelectedCampaign(campaign);
    setContactsModalOpen(true);
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Campanhas</h1>
          <p className="text-sm text-secondary mt-1">
            {campaigns.length} campanhas • {campaigns.filter((c) => c.status === "running").length} rodando
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => openEditModal()}>
          Nova Campanha
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
        <input
          type="text"
          placeholder="Buscar campanha..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
            bg-white/5 border border-border text-primary
            placeholder:text-tertiary
            focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
            transition-all"
        />
      </div>

      {/* Campaign Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filteredCampaigns.map((campaign) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            onEdit={() => openEditModal(campaign)}
            onContacts={() => openContactsModal(campaign)}
          />
        ))}
      </div>

      {filteredCampaigns.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-secondary">
          <Megaphone size={48} className="mb-3 opacity-30" />
          <p>Nenhuma campanha encontrada</p>
        </div>
      )}

      {/* Edit/Create Campaign Modal */}
      <CampaignEditModal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        campaign={selectedCampaign}
      />

      {/* Contacts Modal */}
      <ContactsModal
        isOpen={contactsModalOpen}
        onClose={() => setContactsModalOpen(false)}
        campaign={selectedCampaign}
      />
    </div>
  );
}

// ---- Campaign Card ----
function CampaignCard({
  campaign,
  onEdit,
  onContacts,
}: {
  campaign: Campaign;
  onEdit: () => void;
  onContacts: () => void;
}) {
  const status = statusConfig[campaign.status];
  const progress = campaign.contactsCount > 0
    ? Math.round((campaign.sentCount / campaign.contactsCount) * 100)
    : 0;
  const devices = MOCK_DEVICES.filter((d) => campaign.deviceIds.includes(d.id));

  return (
    <Card hover>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl
            bg-gradient-to-br from-violet-600/20 to-indigo-600/20 border border-violet-500/20">
            <Megaphone size={18} className="text-violet-400" />
          </div>
          <div>
            <h3 className="font-semibold text-primary">{campaign.name}</h3>
            <p className="text-xs text-tertiary">Atualizada em {campaign.updatedAt}</p>
          </div>
        </div>
        <Badge variant={status.variant} dot pulse={campaign.status === "running"}>
          {status.label}
        </Badge>
      </div>

      {/* Message Preview */}
      <div className="p-3 rounded-xl bg-white/[0.03] border border-border mb-3">
        <p className="text-xs text-secondary line-clamp-2">
          {campaign.greeting && <span className="text-violet-400">{campaign.greeting} </span>}
          {campaign.message}
        </p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="text-center p-2 rounded-lg bg-white/[0.02]">
          <div className="flex items-center justify-center gap-1 text-xs text-tertiary mb-0.5">
            <Users size={12} />
            <span>Contatos</span>
          </div>
          <p className="text-sm font-semibold text-primary">{campaign.contactsCount.toLocaleString()}</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-white/[0.02]">
          <div className="flex items-center justify-center gap-1 text-xs text-tertiary mb-0.5">
            <Send size={12} />
            <span>Enviados</span>
          </div>
          <p className="text-sm font-semibold text-emerald-400">{campaign.sentCount.toLocaleString()}</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-white/[0.02]">
          <div className="flex items-center justify-center gap-1 text-xs text-tertiary mb-0.5">
            <AlertCircle size={12} />
            <span>Falhas</span>
          </div>
          <p className="text-sm font-semibold text-red-400">{campaign.failedCount}</p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-tertiary mb-1">
          <span>Progresso</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500
              ${campaign.status === "completed"
                ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                : "bg-gradient-to-r from-violet-500 to-indigo-500"
              }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Indicators */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-tertiary">
          <Smartphone size={12} />
          <span>{devices.length} dispositivo{devices.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-tertiary">
          <Clock size={12} />
          <span>{campaign.delayMin}-{campaign.delayMax}s</span>
        </div>
        {campaign.useSpintax && (
          <Badge variant="purple" className="text-[10px]">Spintax</Badge>
        )}
        {campaign.useAI && (
          <Badge variant="info" className="text-[10px]">
            <Brain size={10} /> AI
          </Badge>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {campaign.status === "running" ? (
          <Button variant="secondary" size="sm" icon={<Pause size={14} />} className="flex-1">
            Pausar
          </Button>
        ) : campaign.status !== "completed" ? (
          <Button variant="success" size="sm" icon={<Play size={14} />} className="flex-1">
            Iniciar
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
          Editar
        </Button>
        <Button variant="ghost" size="sm" icon={<Users size={14} />} onClick={onContacts}>
          Contatos
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
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
}) {
  const [useSpintax, setUseSpintax] = useState(campaign?.useSpintax ?? false);
  const [useAI, setUseAI] = useState(campaign?.useAI ?? false);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={campaign ? `Editar: ${campaign.name}` : "Nova Campanha"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={onClose}>Salvar</Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-secondary mb-1.5">Nome da Campanha</label>
          <input
            type="text"
            defaultValue={campaign?.name || ""}
            placeholder="Ex: Black Friday 2026"
            className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
              placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all"
          />
        </div>

        {/* Greeting */}
        <div>
          <label className="block text-sm font-medium text-secondary mb-1.5">Saudação</label>
          <input
            type="text"
            defaultValue={campaign?.greeting || ""}
            placeholder="Ex: Olá {nome}! 👋"
            className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
              placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all"
          />
        </div>

        {/* Message */}
        <div>
          <label className="block text-sm font-medium text-secondary mb-1.5">Mensagem</label>
          <textarea
            defaultValue={campaign?.message || ""}
            placeholder="Digite a mensagem principal..."
            rows={4}
            className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
              placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all resize-none"
          />
        </div>

        {/* Closing */}
        <div>
          <label className="block text-sm font-medium text-secondary mb-1.5">Encerramento</label>
          <input
            type="text"
            defaultValue={campaign?.closing || ""}
            placeholder="Ex: Abraços, equipe TechCorp 🚀"
            className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
              placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all"
          />
        </div>

        {/* Delay */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Delay Mínimo (s)</label>
            <input
              type="number"
              defaultValue={campaign?.delayMin || 30}
              className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                focus:outline-none focus:border-violet-500/50 transition-all"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Delay Máximo (s)</label>
            <input
              type="number"
              defaultValue={campaign?.delayMax || 90}
              className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                focus:outline-none focus:border-violet-500/50 transition-all"
            />
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3 p-4 rounded-xl bg-white/[0.03] border border-border">
          <Toggle checked={useSpintax} onChange={setUseSpintax} label="Usar Spintax" />
          <Toggle checked={useAI} onChange={setUseAI} label="Usar IA para personalizar" />

          {useAI && (
            <div className="space-y-3 pl-6 pt-2 border-l-2 border-violet-500/30 animate-fade-in">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Modelo</label>
                <select className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                  focus:outline-none focus:border-violet-500/50 transition-all">
                  <option value="gpt-4o-mini">GPT-4o Mini</option>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="claude-3-haiku">Claude 3 Haiku</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Prompt de IA</label>
                <textarea
                  defaultValue={campaign?.aiPrompt || ""}
                  placeholder="Instrução para a IA personalizar a mensagem..."
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                    placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all resize-none"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---- Contacts Modal ----
function ContactsModal({
  isOpen,
  onClose,
  campaign,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
}) {
  const contacts = campaign ? MOCK_CONTACTS.filter((c) => c.campaignId === campaign.id) : [];

  const statusColors: Record<string, string> = {
    pending: "text-slate-400",
    sent: "text-emerald-400",
    failed: "text-red-400",
    replied: "text-blue-400",
  };

  const statusLabels: Record<string, string> = {
    pending: "Pendente",
    sent: "Enviado",
    failed: "Falhou",
    replied: "Respondeu",
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={campaign ? `Contatos: ${campaign.name}` : "Contatos"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
          <Button variant="secondary" icon={<FileText size={14} />}>Importar .txt</Button>
          <Button variant="secondary" icon={<FileText size={14} />}>Importar .csv</Button>
          <Button icon={<FileText size={14} />}>Importar .xlsx</Button>
        </>
      }
    >
      <div className="space-y-2">
        {contacts.length === 0 ? (
          <div className="text-center py-8 text-secondary">
            <Users size={32} className="mx-auto mb-2 opacity-30" />
            <p>Nenhum contato importado</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-xs font-medium text-tertiary">Nome</th>
                <th className="text-left py-2 text-xs font-medium text-tertiary">Telefone</th>
                <th className="text-left py-2 text-xs font-medium text-tertiary">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((contact) => (
                <tr key={contact.id} className="hover:bg-white/[0.02]">
                  <td className="py-2.5 text-sm text-primary">{contact.name}</td>
                  <td className="py-2.5 text-sm text-secondary font-mono">{contact.phone}</td>
                  <td className="py-2.5">
                    <span className={`text-xs font-medium ${statusColors[contact.status]}`}>
                      {statusLabels[contact.status]}
                    </span>
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
