// ============================================================
// Esfera v3 — Settings Tab
// Configurações da empresa agrupadas em seções
// ============================================================

import { useState } from "react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import {
  Settings,
  Save,
  Globe,
  Bell,
  Shield,
  Smartphone,
  Clock,
  Database,
} from "lucide-react";

export default function SettingsTab() {
  const [notifications, setNotifications] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [batteryAlert, setBatteryAlert] = useState(true);
  const [autoBackup, setAutoBackup] = useState(false);
  const [logRetention, setLogRetention] = useState("30");

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Configurações</h1>
          <p className="text-sm text-secondary mt-1">
            Ajustes gerais da empresa
          </p>
        </div>
        <Button icon={<Save size={16} />}>Salvar Alterações</Button>
      </div>

      <div className="max-w-3xl space-y-6">
        {/* General Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl
              bg-violet-600/20 border border-violet-500/20">
              <Globe size={18} className="text-violet-400" />
            </div>
            <div>
              <h2 className="font-semibold text-primary">Geral</h2>
              <p className="text-xs text-tertiary">Configurações básicas da empresa</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">Nome da Empresa</label>
              <input
                type="text"
                defaultValue="TechCorp Solutions"
                className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                  focus:outline-none focus:border-violet-500/50 transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">Fuso Horário</label>
              <select className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                focus:outline-none focus:border-violet-500/50 transition-all">
                <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
                <option value="America/Manaus">América/Manaus (GMT-4)</option>
                <option value="America/Fortaleza">América/Fortaleza (GMT-3)</option>
              </select>
            </div>
          </div>
        </Card>

        {/* Notifications */}
        <Card>
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl
              bg-blue-600/20 border border-blue-500/20">
              <Bell size={18} className="text-blue-400" />
            </div>
            <div>
              <h2 className="font-semibold text-primary">Notificações</h2>
              <p className="text-xs text-tertiary">Alertas e avisos do sistema</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm text-primary">Notificações do sistema</p>
                <p className="text-xs text-tertiary">Receber alertas sobre status dos dispositivos</p>
              </div>
              <Toggle checked={notifications} onChange={setNotifications} />
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm text-primary">Alerta de bateria baixa</p>
                <p className="text-xs text-tertiary">Avisar quando a bateria estiver abaixo de 20%</p>
              </div>
              <Toggle checked={batteryAlert} onChange={setBatteryAlert} />
            </div>
          </div>
        </Card>

        {/* Device Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl
              bg-emerald-600/20 border border-emerald-500/20">
              <Smartphone size={18} className="text-emerald-400" />
            </div>
            <div>
              <h2 className="font-semibold text-primary">Dispositivos</h2>
              <p className="text-xs text-tertiary">Configurações de conexão ADB</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm text-primary">Reconexão automática</p>
                <p className="text-xs text-tertiary">Tentar reconectar dispositivos offline automaticamente</p>
              </div>
              <Toggle checked={autoReconnect} onChange={setAutoReconnect} />
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">
                Intervalo de verificação (segundos)
              </label>
              <input
                type="number"
                defaultValue={30}
                min={5}
                max={300}
                className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                  focus:outline-none focus:border-violet-500/50 transition-all"
              />
            </div>
          </div>
        </Card>

        {/* Data & Security */}
        <Card>
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl
              bg-amber-600/20 border border-amber-500/20">
              <Shield size={18} className="text-amber-400" />
            </div>
            <div>
              <h2 className="font-semibold text-primary">Dados & Segurança</h2>
              <p className="text-xs text-tertiary">Backup e retenção de dados</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm text-primary">Backup automático</p>
                <p className="text-xs text-tertiary">Realizar backup diário do banco de dados</p>
              </div>
              <Toggle checked={autoBackup} onChange={setAutoBackup} />
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">
                <div className="flex items-center gap-1.5">
                  <Clock size={14} />
                  <span>Retenção de logs (dias)</span>
                </div>
              </label>
              <select
                value={logRetention}
                onChange={(e) => setLogRetention(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl text-sm bg-white/5 border border-border text-primary
                  focus:outline-none focus:border-violet-500/50 transition-all"
              >
                <option value="7">7 dias</option>
                <option value="15">15 dias</option>
                <option value="30">30 dias</option>
                <option value="60">60 dias</option>
                <option value="90">90 dias</option>
              </select>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="secondary" size="sm" icon={<Database size={14} />}>
                Exportar Dados
              </Button>
              <Button variant="danger" size="sm" icon={<Settings size={14} />}>
                Resetar Configurações
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
