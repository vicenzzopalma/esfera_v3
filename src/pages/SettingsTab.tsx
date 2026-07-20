// ============================================================
// Esfera v3 — Settings Tab (Refatorada)
// Configurações da Empresa, Preferências ADB e Retenção
// ============================================================

import { useState } from "react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import {
  Save,
  Globe,
  Bell,
  Shield,
  Smartphone,
  Database,
  RefreshCw,
} from "lucide-react";

export default function SettingsTab() {
  const [notifications, setNotifications] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [batteryAlert, setBatteryAlert] = useState(true);
  const [autoBackup, setAutoBackup] = useState(false);
  const [logRetention, setLogRetention] = useState("30");

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      {/* Top Header & Save Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-tight">Configurações da Empresa</h2>
          <p className="text-xs text-tertiary mt-0.5">
            Ajuste preferências operacionais, limites de conexão e alertas.
          </p>
        </div>
        <Button icon={<Save size={16} />}>Salvar Preferências</Button>
      </div>

      <div className="space-y-5">
        {/* General Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-5 border-b border-border pb-4">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30">
              <Globe size={18} className="text-violet-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-primary">Informações Gerais</h3>
              <p className="text-xs text-tertiary">Identificação da empresa e fuso horário</p>
            </div>
          </div>

          <div className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-secondary mb-1">Nome Fantasia da Empresa</label>
              <input
                type="text"
                defaultValue="TechCorp Solutions"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
              />
            </div>
            <div>
              <label className="block font-semibold text-secondary mb-1">Fuso Horário Principal</label>
              <select className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all">
                <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
                <option value="America/Manaus">América/Manaus (GMT-4)</option>
                <option value="America/Fortaleza">América/Fortaleza (GMT-3)</option>
              </select>
            </div>
          </div>
        </Card>

        {/* Notifications */}
        <Card>
          <div className="flex items-center gap-3 mb-5 border-b border-border pb-4">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30">
              <Bell size={18} className="text-blue-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-primary">Notificações & Alertas</h3>
              <p className="text-xs text-tertiary">Alertas em tempo real do sistema</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-semibold text-primary">Alertas do Sistema</p>
                <p className="text-[11px] text-tertiary">Receber avisos imediatos quando um dispositivo desconectar</p>
              </div>
              <Toggle checked={notifications} onChange={setNotifications} />
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-semibold text-primary">Alerta de Bateria Baixa</p>
                <p className="text-[11px] text-tertiary">Avisar no painel se a bateria do celular cair para menos de 20%</p>
              </div>
              <Toggle checked={batteryAlert} onChange={setBatteryAlert} />
            </div>
          </div>
        </Card>

        {/* ADB Devices Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-5 border-b border-border pb-4">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-600/20 border border-emerald-500/30">
              <Smartphone size={18} className="text-emerald-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-primary">Conexão ADB & Redes</h3>
              <p className="text-xs text-tertiary">Parâmetros de comunicação wireless</p>
            </div>
          </div>

          <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-semibold text-primary">Reconexão Automática</p>
                <p className="text-[11px] text-tertiary">Tentar reconectar aparelhos offline automaticamente</p>
              </div>
              <Toggle checked={autoReconnect} onChange={setAutoReconnect} />
            </div>

            <div>
              <label className="block font-semibold text-secondary mb-1">
                Intervalo de Ping do Engine (segundos)
              </label>
              <input
                type="number"
                defaultValue={30}
                min={5}
                max={300}
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all font-mono"
              />
            </div>
          </div>
        </Card>

        {/* Security & Data Retention */}
        <Card>
          <div className="flex items-center gap-3 mb-5 border-b border-border pb-4">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-amber-600/20 border border-amber-500/30">
              <Shield size={18} className="text-amber-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-primary">Segurança & Retenção de Dados</h3>
              <p className="text-xs text-tertiary">Políticas de limpeza de log e cópias de segurança</p>
            </div>
          </div>

          <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-semibold text-primary">Backup Automático Diário</p>
                <p className="text-[11px] text-tertiary">Salvar snapshot local das campanhas e contatos</p>
              </div>
              <Toggle checked={autoBackup} onChange={setAutoBackup} />
            </div>

            <div>
              <label className="block font-semibold text-secondary mb-1">Período de Retenção de Logs</label>
              <select
                value={logRetention}
                onChange={(e) => setLogRetention(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-border text-primary focus:border-violet-500/40 transition-all"
              >
                <option value="7">7 dias</option>
                <option value="15">15 dias</option>
                <option value="30">30 dias (Recomendado)</option>
                <option value="60">60 dias</option>
              </select>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button variant="secondary" size="sm" icon={<Database size={14} />}>
                Exportar Snapshot
              </Button>
              <Button variant="danger" size="sm" icon={<RefreshCw size={14} />}>
                Restaurar Padrão
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
