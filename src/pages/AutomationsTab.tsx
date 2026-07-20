// ============================================================
// Esfera v3 — Automations Tab
// Regras de automação com keyword triggers
// ============================================================

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_AUTOMATIONS } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import type { Automation } from "../types";
import {
  Bot,
  Plus,
  Pencil,
  Trash2,
  Search,
  MessageSquare,
  Hash,
  Zap,
} from "lucide-react";

export default function AutomationsTab() {
  const { selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);
  const [automations, setAutomations] = useState(
    MOCK_AUTOMATIONS.filter((a) => a.companyId === selectedCompanyId)
  );

  const filteredAutomations = automations.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.keyword.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const openEditModal = (automation?: Automation) => {
    setSelectedAutomation(automation || null);
    setEditModalOpen(true);
  };

  const toggleActive = (id: number) => {
    setAutomations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, active: !a.active } : a))
    );
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Automações</h1>
          <p className="text-sm text-secondary mt-1">
            {automations.length} regras • {automations.filter((a) => a.active).length} ativas
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => openEditModal()}>
          Nova Automação
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
        <input
          type="text"
          placeholder="Buscar por nome ou palavra-chave..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
            bg-white/5 border border-border text-primary
            placeholder:text-tertiary
            focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
            transition-all"
        />
      </div>

      {/* Automations List */}
      <div className="space-y-3">
        {filteredAutomations.map((automation) => (
          <Card key={automation.id} padding="none">
            <div className="flex items-center gap-4 p-5">
              {/* Icon */}
              <div className={`flex items-center justify-center w-11 h-11 rounded-xl
                ${automation.active
                  ? "bg-gradient-to-br from-violet-600/20 to-indigo-600/20 border border-violet-500/20"
                  : "bg-white/5 border border-border"
                }`}>
                <Bot size={20} className={automation.active ? "text-violet-400" : "text-tertiary"} />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-primary">{automation.name}</h3>
                  <Badge variant={automation.active ? "success" : "neutral"} dot>
                    {automation.active ? "Ativa" : "Inativa"}
                  </Badge>
                </div>

                <div className="flex items-center gap-4 text-xs text-secondary">
                  <div className="flex items-center gap-1">
                    <Hash size={12} className="text-violet-400" />
                    <span>Palavra-chave: <span className="font-mono text-violet-400">"{automation.keyword}"</span></span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Zap size={12} />
                    <span>{automation.triggeredCount} disparos</span>
                  </div>
                </div>

                <div className="flex items-start gap-1 mt-2">
                  <MessageSquare size={12} className="text-tertiary mt-0.5 shrink-0" />
                  <p className="text-xs text-tertiary line-clamp-1">{automation.response}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Toggle
                  checked={automation.active}
                  onChange={() => toggleActive(automation.id)}
                  size="sm"
                />
                <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={() => openEditModal(automation)}>
                  Editar
                </Button>
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} className="text-red-400 hover:text-red-300">
                  {""}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {filteredAutomations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-secondary">
          <Bot size={48} className="mb-3 opacity-30" />
          <p>Nenhuma automação encontrada</p>
        </div>
      )}

      {/* Edit/Create Automation Modal */}
      <Modal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={selectedAutomation ? `Editar: ${selectedAutomation.name}` : "Nova Automação"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>Cancelar</Button>
            <Button onClick={() => setEditModalOpen(false)}>Salvar</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Nome</label>
            <input
              type="text"
              defaultValue={selectedAutomation?.name || ""}
              placeholder="Ex: Resposta Preço"
              className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Palavra-chave</label>
            <input
              type="text"
              defaultValue={selectedAutomation?.keyword || ""}
              placeholder="Ex: preço"
              className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all"
            />
            <p className="text-xs text-tertiary mt-1">Quando o cliente enviar uma mensagem contendo esta palavra, a resposta automática será enviada.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Resposta</label>
            <textarea
              defaultValue={selectedAutomation?.response || ""}
              placeholder="Digite a resposta automática..."
              rows={4}
              className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                placeholder:text-tertiary focus:outline-none focus:border-violet-500/50 transition-all resize-none"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
