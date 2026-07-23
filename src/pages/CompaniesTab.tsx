// ============================================================
// Esfera v3 — Companies Tab (Layout Grid de Cards + Edição)
// Visão geral das empresas com botões de Gerenciar e Editar Empresa
// ============================================================

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { MOCK_COMPANIES } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import { api } from "../tauri";
import type { Company } from "../types";
import {
  Building2,
  Smartphone,
  Users,
  ArrowRight,
  Plus,
  CheckCircle2,
  Search,
  Pencil,
} from "lucide-react";

export default function CompaniesTab() {
  const { enterCompany } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [companiesList, setCompaniesList] = useState<Company[]>([]);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [editName, setEditName] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState(50);
  const [editUserLimit, setEditUserLimit] = useState(20);
  const [editActive, setEditActive] = useState(true);

  useEffect(() => {
    api<Company[]>("get_companies")
      .then((data) => {
        if (data && data.length > 0) {
          setCompaniesList(data);
        } else {
          setCompaniesList(MOCK_COMPANIES);
        }
      })
      .catch(() => setCompaniesList(MOCK_COMPANIES));
  }, []);

  const filteredCompanies = companiesList.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isCompanyActive = (c: any) => c.status === "active" || c.isActive === true || c.is_active === true || c.is_active === 1;

  const activeCompaniesCount = companiesList.filter(isCompanyActive).length;
  const totalDevicesAllocated = companiesList.reduce((acc, c) => acc + (c.deviceCount || 0), 0);
  const totalUsersAllocated = companiesList.reduce((acc, c) => acc + (c.userCount || 0), 0);

  const handleEnterCompany = (companyId: number) => {
    enterCompany(companyId);
    navigate("/devices");
  };

  const handleOpenEditModal = (company?: Company) => {
    if (company) {
      setEditingCompany(company);
      setEditName(company.name);
      setEditDeviceLimit(company.deviceLimit);
      setEditUserLimit(company.userLimit);
      setEditActive(company.status === "active");
    } else {
      setEditingCompany(null);
      setEditName("");
      setEditDeviceLimit(50);
      setEditUserLimit(20);
      setEditActive(true);
    }
    setModalOpen(true);
  };

  const handleSaveCompany = () => {
    if (!editName.trim()) return;

    if (editingCompany) {
      // Atualiza localmente
      setCompaniesList((prev) =>
        prev.map((c) =>
          c.id === editingCompany.id
            ? {
                ...c,
                name: editName,
                deviceLimit: editDeviceLimit,
                userLimit: editUserLimit,
                status: editActive ? "active" : "inactive",
              }
            : c
        )
      );
    } else {
      // Cria nova
      const newCompany: Company = {
        id: Date.now(),
        name: editName,
        deviceLimit: editDeviceLimit,
        userLimit: editUserLimit,
        deviceCount: 0,
        userCount: 1,
        status: editActive ? "active" : "inactive",
        createdAt: new Date().toISOString().split("T")[0],
      };
      setCompaniesList((prev) => [...prev, newCompany]);
    }

    setModalOpen(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header & Quick Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Gestão de Empresas</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Gerencie permissões, cotas e instâncias de clientes no Esfera v3.
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => handleOpenEditModal()}>
          Nova Empresa
        </Button>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-400">
            <CheckCircle2 size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{activeCompaniesCount}</p>
            <p className="text-xs text-tertiary font-medium">Empresas Ativas</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/15 border border-blue-500/20 text-blue-400">
            <Smartphone size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{totalDevicesAllocated}</p>
            <p className="text-xs text-tertiary font-medium">Dispositivos Alocados</p>
          </div>
        </Card>

        <Card padding="sm" className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-400">
            <Users size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{totalUsersAllocated}</p>
            <p className="text-xs text-tertiary font-medium">Usuários Totais</p>
          </div>
        </Card>
      </div>

      {/* Search Input */}
      <div className="relative max-w-md flex items-center">
        <Search size={17} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
        <input
          type="text"
          placeholder="Buscar empresa por nome..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full input-with-icon-left"
        />
      </div>

      {/* Grid de Cards de Empresas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredCompanies.map((company) => {
          const devicePct = Math.round(((company.deviceCount || 0) / company.deviceLimit) * 100);
          return (
            <Card key={company.id} padding="md" hover className="flex flex-col justify-between">
              <div>
                {/* Header Card */}
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-11 h-11 rounded-2xl bg-violet-600/15 border border-violet-500/20 text-violet-400">
                      <Building2 size={22} />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-primary leading-tight">{company.name}</h3>
                      <p className="text-[11px] text-tertiary mt-0.5">Criada em {company.createdAt}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Badge variant={isCompanyActive(company) ? "success" : "neutral"} dot>
                      {isCompanyActive(company) ? "Ativa" : "Inativa"}
                    </Badge>
                    <button
                      onClick={() => handleOpenEditModal(company)}
                      className="p-1.5 rounded-lg text-tertiary hover:text-violet-300 hover:bg-white/10 transition-colors cursor-pointer"
                      title="Editar Empresa"
                    >
                      <Pencil size={15} />
                    </button>
                  </div>
                </div>

                {/* Cotas & Uso */}
                <div className="space-y-3 my-4">
                  <div className="grid grid-cols-2 gap-2 text-xs p-2.5 rounded-xl bg-white/[0.02] border border-border">
                    <div>
                      <span className="text-[11px] text-tertiary flex items-center gap-1">
                        <Smartphone size={12} className="text-violet-400" /> Dispositivos
                      </span>
                      <p className="font-bold text-primary text-xs mt-0.5">
                        {company.deviceCount || 0}<span className="text-tertiary font-normal">/{company.deviceLimit}</span>
                      </p>
                    </div>

                    <div>
                      <span className="text-[11px] text-tertiary flex items-center gap-1">
                        <Users size={12} className="text-emerald-400" /> Usuários
                      </span>
                      <p className="font-bold text-primary text-xs mt-0.5">
                        {company.userCount || 0}<span className="text-tertiary font-normal">/{company.userLimit}</span>
                      </p>
                    </div>
                  </div>

                  {/* Barra de Progresso de Ocupação */}
                  <div>
                    <div className="flex justify-between text-[11px] text-tertiary mb-1">
                      <span>Ocupação da Cota</span>
                      <span className="font-semibold text-secondary">{devicePct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-all duration-300"
                        style={{ width: `${devicePct}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Ações Inferiores */}
              <div className="pt-2 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  icon={<ArrowRight size={14} />}
                  onClick={() => handleEnterCompany(company.id)}
                >
                  Gerenciar Empresa
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Pencil size={14} />}
                  onClick={() => handleOpenEditModal(company)}
                >
                  Editar
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Modal Editar / Criar Empresa */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingCompany ? `Editar Empresa: ${editingCompany.name}` : "Nova Empresa"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveCompany}>Salvar Alterações</Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-secondary mb-1">Nome da Empresa</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Ex: REALESS RM COBRANÇAS"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-secondary mb-1">Limite de Dispositivos</label>
              <input
                type="number"
                value={editDeviceLimit}
                onChange={(e) => setEditDeviceLimit(parseInt(e.target.value, 10) || 0)}
              />
            </div>

            <div>
              <label className="block font-semibold text-secondary mb-1">Limite de Usuários</label>
              <input
                type="number"
                value={editUserLimit}
                onChange={(e) => setEditUserLimit(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div>
              <span className="font-semibold text-primary block">Status da Empresa</span>
              <span className="text-[11px] text-tertiary">Ativar ou suspender acesso desta instância</span>
            </div>
            <Toggle checked={editActive} onChange={setEditActive} size="sm" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
