// ============================================================
// Esfera v3 — Empresas
// Lista de empresas com cotas, entrada rápida e edição em modal
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
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import EmptyState from "../components/ui/EmptyState";
import Field from "../components/ui/Field";
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
  RefreshCw,
} from "lucide-react";

export default function CompaniesTab() {
  const { enterCompany } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [companiesList, setCompaniesList] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [editName, setEditName] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState(50);
  const [editUserLimit, setEditUserLimit] = useState(20);
  const [editActive, setEditActive] = useState(true);

  useEffect(() => {
    let mounted = true;
    api<Company[]>("get_companies")
      .then((data) => {
        if (!mounted) return;
        if (data && data.length > 0) {
          setCompaniesList(data);
        } else {
          setCompaniesList(MOCK_COMPANIES);
        }
      })
      .catch(() => { if (mounted) setCompaniesList(MOCK_COMPANIES); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
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
    navigate("/dashboard");
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
      <PageHeader
        title="Empresas"
        description="Cotas, acesso e instâncias de cada cliente."
        icon={<Building2 size={18} />}
        actions={
          <Button icon={<Plus size={15} />} onClick={() => handleOpenEditModal()}>
            Nova empresa
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Empresas ativas" value={activeCompaniesCount} icon={<CheckCircle2 size={14} />} tone="success" hint={`de ${companiesList.length} cadastradas`} />
        <StatCard label="Aparelhos alocados" value={totalDevicesAllocated} icon={<Smartphone size={14} />} tone="info" />
        <StatCard label="Usuários" value={totalUsersAllocated} icon={<Users size={14} />} tone="accent" />
      </div>

      <div className="relative max-w-md flex items-center">
        <Search size={16} className="input-icon-left text-tertiary" />
        <input
          type="text"
          aria-label="Buscar empresa"
          placeholder="Buscar empresa"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full input-with-icon-left"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 rounded-xl border border-border bg-card skeleton" />
          ))}
        </div>
      ) : filteredCompanies.length === 0 ? (
        <EmptyState
          icon={<Building2 size={18} />}
          title={searchQuery ? "Nenhuma empresa encontrada" : "Nenhuma empresa cadastrada"}
          description={searchQuery ? "Revise o termo buscado." : "Crie a primeira empresa para começar."}
          action={
            searchQuery ? (
              <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setSearchQuery("")}>
                Limpar busca
              </Button>
            ) : (
              <Button icon={<Plus size={15} />} onClick={() => handleOpenEditModal()}>
                Nova empresa
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredCompanies.map((company) => {
            const devicePct = company.deviceLimit
              ? Math.min(100, Math.round(((company.deviceCount || 0) / company.deviceLimit) * 100))
              : 0;
            const active = isCompanyActive(company);
            const barTone = devicePct >= 90 ? "bg-red-400" : devicePct >= 70 ? "bg-amber-400" : "bg-[var(--color-accent)]";
            return (
              <Card key={company.id} padding="md" className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
                      <Building2 size={17} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-primary truncate">{company.name}</h3>
                      <p className="text-xs text-tertiary">Criada em {company.createdAt}</p>
                    </div>
                  </div>
                  <Badge variant={active ? "success" : "neutral"} dot>
                    {active ? "Ativa" : "Inativa"}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="flex items-center gap-1.5 text-xs text-secondary">
                      <Smartphone size={13} /> Aparelhos
                    </span>
                    <p className="mt-0.5 text-sm font-semibold text-primary tabular-nums">
                      {company.deviceCount || 0}<span className="font-normal text-tertiary"> / {company.deviceLimit}</span>
                    </p>
                  </div>
                  <div>
                    <span className="flex items-center gap-1.5 text-xs text-secondary">
                      <Users size={13} /> Usuários
                    </span>
                    <p className="mt-0.5 text-sm font-semibold text-primary tabular-nums">
                      {company.userCount || 0}<span className="font-normal text-tertiary"> / {company.userLimit}</span>
                    </p>
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex justify-between text-xs text-tertiary">
                    <span>Uso da cota de aparelhos</span>
                    <span className="tabular-nums text-secondary">{devicePct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${barTone}`} style={{ width: `${devicePct}%` }} />
                  </div>
                </div>

                <div className="mt-auto flex items-center gap-2">
                  <Button size="sm" className="flex-1" icon={<ArrowRight size={14} />} onClick={() => handleEnterCompany(company.id)}>
                    Entrar
                  </Button>
                  <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => handleOpenEditModal(company)} aria-label={`Editar ${company.name}`}>
                    Editar
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingCompany ? "Editar empresa" : "Nova empresa"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveCompany} disabled={!editName.trim()}>
              {editingCompany ? "Salvar" : "Criar empresa"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nome" required htmlFor="company-name">
            <input
              id="company-name"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Nome da empresa"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Limite de aparelhos" htmlFor="company-dev-limit">
              <input
                id="company-dev-limit"
                type="number"
                min={0}
                value={editDeviceLimit}
                onChange={(e) => setEditDeviceLimit(parseInt(e.target.value, 10) || 0)}
              />
            </Field>
            <Field label="Limite de usuários" htmlFor="company-user-limit">
              <input
                id="company-user-limit"
                type="number"
                min={0}
                value={editUserLimit}
                onChange={(e) => setEditUserLimit(parseInt(e.target.value, 10) || 0)}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <span className="block text-[0.8125rem] font-medium text-primary">Empresa ativa</span>
              <span className="text-xs text-tertiary">Desative para suspender o acesso.</span>
            </div>
            <Toggle checked={editActive} onChange={setEditActive} size="sm" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
