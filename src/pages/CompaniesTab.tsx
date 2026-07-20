// ============================================================
// Esfera v3 — Companies Tab
// Grid de cards de empresas (visível apenas para Master)
// ============================================================

import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { MOCK_COMPANIES } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import {
  Building2,
  Smartphone,
  Users,
  ArrowRight,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";

export default function CompaniesTab() {
  const { enterCompany } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredCompanies = MOCK_COMPANIES.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEnterCompany = (companyId: number) => {
    enterCompany(companyId);
    navigate("/devices");
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Empresas</h1>
          <p className="text-sm text-secondary mt-1">
            Gerencie as empresas do sistema
          </p>
        </div>
        <Button icon={<Plus size={16} />}>Nova Empresa</Button>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
        <input
          type="text"
          placeholder="Buscar empresa..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
            bg-white/5 border border-border text-primary
            placeholder:text-tertiary
            focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
            transition-all"
        />
      </div>

      {/* Company Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredCompanies.map((company) => (
          <Card key={company.id} hover>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-11 h-11 rounded-xl
                  bg-gradient-to-br from-violet-600/20 to-indigo-600/20 border border-violet-500/20">
                  <Building2 size={20} className="text-violet-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-primary">{company.name}</h3>
                  <p className="text-xs text-tertiary">Criada em {company.createdAt}</p>
                </div>
              </div>
              <Badge variant={company.status === "active" ? "success" : "neutral"} dot pulse={company.status === "active"}>
                {company.status === "active" ? "Ativa" : "Inativa"}
              </Badge>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-white/[0.03] border border-border">
                <Smartphone size={16} className="text-blue-400" />
                <div>
                  <p className="text-xs text-tertiary">Dispositivos</p>
                  <p className="text-sm font-semibold text-primary">
                    {company.deviceCount}
                    <span className="text-tertiary font-normal">/{company.deviceLimit}</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-white/[0.03] border border-border">
                <Users size={16} className="text-emerald-400" />
                <div>
                  <p className="text-xs text-tertiary">Usuários</p>
                  <p className="text-sm font-semibold text-primary">
                    {company.userCount}
                    <span className="text-tertiary font-normal">/{company.userLimit}</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Device Usage Bar */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-tertiary mb-1">
                <span>Uso de dispositivos</span>
                <span>{Math.round((company.deviceCount / company.deviceLimit) * 100)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500
                    transition-all duration-500"
                  style={{ width: `${(company.deviceCount / company.deviceLimit) * 100}%` }}
                />
              </div>
            </div>

            {/* Enter Button */}
            <Button
              variant="secondary"
              className="w-full"
              icon={<ArrowRight size={16} />}
              onClick={() => handleEnterCompany(company.id)}
            >
              Entrar
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
