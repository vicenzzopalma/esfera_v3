// ============================================================
// Esfera v3 — Devices Tab
// Tabela de dispositivos ADB com status, bateria e ações
// ============================================================

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { MOCK_DEVICES } from "../mock-data";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import type { Device, DeviceStatus } from "../types";
import {
  Smartphone,
  Wifi,
  WifiOff,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Plus,
  RefreshCw,
  Zap,
  Unplug,
  Search,
  Loader2,
} from "lucide-react";

const statusConfig: Record<DeviceStatus, { variant: "success" | "danger" | "warning" | "neutral"; label: string; pulse: boolean }> = {
  online: { variant: "success", label: "Online", pulse: true },
  offline: { variant: "danger", label: "Offline", pulse: false },
  connecting: { variant: "warning", label: "Conectando", pulse: true },
  error: { variant: "danger", label: "Erro", pulse: false },
};

function BatteryIcon({ level }: { level: number }) {
  if (level > 60) return <BatteryFull size={16} className="text-emerald-400" />;
  if (level > 30) return <BatteryMedium size={16} className="text-amber-400" />;
  if (level > 10) return <BatteryLow size={16} className="text-orange-400" />;
  return <BatteryWarning size={16} className="text-red-400" />;
}

function BatteryBar({ level }: { level: number }) {
  let color = "from-emerald-500 to-emerald-400";
  if (level <= 10) color = "from-red-500 to-red-400";
  else if (level <= 30) color = "from-orange-500 to-amber-400";
  else if (level <= 60) color = "from-amber-500 to-yellow-400";

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <BatteryIcon level={level} />
      <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${color} transition-all duration-500`}
          style={{ width: `${level}%` }}
        />
      </div>
      <span className="text-xs text-secondary w-8 text-right">{level}%</span>
    </div>
  );
}

export default function DevicesTab() {
  const { user, selectedCompanyId } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [connectIp, setConnectIp] = useState("");
  const [connectPort, setConnectPort] = useState("5555");

  const devices = MOCK_DEVICES.filter((d) => d.companyId === selectedCompanyId);
  const filteredDevices = devices.filter(
    (d) =>
      d.model.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.serial.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.brand.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const onlineCount = devices.filter((d) => d.status === "online").length;
  const canManageDevices = user?.role !== "colaborador";

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Dispositivos</h1>
          <p className="text-sm text-secondary mt-1">
            {onlineCount} de {devices.length} dispositivos online
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<RefreshCw size={16} />}>
            Atualizar
          </Button>
          <Button icon={<Plus size={16} />} onClick={() => setConnectModalOpen(true)}>
            Conectar
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
        <input
          type="text"
          placeholder="Buscar por modelo, serial ou marca..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
            bg-white/5 border border-border text-primary
            placeholder:text-tertiary
            focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
            transition-all"
        />
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total", value: devices.length, icon: <Smartphone size={18} />, color: "text-violet-400" },
          { label: "Online", value: onlineCount, icon: <Wifi size={18} />, color: "text-emerald-400" },
          { label: "Offline", value: devices.filter((d) => d.status === "offline").length, icon: <WifiOff size={18} />, color: "text-red-400" },
          { label: "Conectando", value: devices.filter((d) => d.status === "connecting").length, icon: <Loader2 size={18} />, color: "text-amber-400" },
        ].map((stat) => (
          <Card key={stat.label} padding="sm">
            <div className="flex items-center gap-3">
              <span className={stat.color}>{stat.icon}</span>
              <div>
                <p className="text-2xl font-bold text-primary">{stat.value}</p>
                <p className="text-xs text-tertiary">{stat.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Devices Table */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">Dispositivo</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">Serial</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">Bateria</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">IP</th>
                {canManageDevices && (
                  <th className="text-right px-6 py-3 text-xs font-medium text-tertiary uppercase tracking-wider">Ações</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredDevices.map((device) => (
                <DeviceRow key={device.id} device={device} canManage={canManageDevices} />
              ))}
            </tbody>
          </table>

          {filteredDevices.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-secondary">
              <Smartphone size={48} className="mb-3 opacity-30" />
              <p>Nenhum dispositivo encontrado</p>
            </div>
          )}
        </div>
      </Card>

      {/* Connect Device Modal */}
      <Modal
        isOpen={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        title="Conectar Dispositivo"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConnectModalOpen(false)}>
              Cancelar
            </Button>
            <Button icon={<Wifi size={16} />} onClick={() => setConnectModalOpen(false)}>
              Conectar
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="connect-ip" className="block text-sm font-medium text-secondary mb-1.5">
              Endereço IP
            </label>
            <input
              id="connect-ip"
              type="text"
              value={connectIp}
              onChange={(e) => setConnectIp(e.target.value)}
              placeholder="192.168.1.100"
              className="w-full px-4 py-2.5 rounded-xl text-sm
                bg-white/5 border border-border text-primary
                placeholder:text-tertiary
                focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
                transition-all"
            />
          </div>
          <div>
            <label htmlFor="connect-port" className="block text-sm font-medium text-secondary mb-1.5">
              Porta
            </label>
            <input
              id="connect-port"
              type="text"
              value={connectPort}
              onChange={(e) => setConnectPort(e.target.value)}
              placeholder="5555"
              className="w-full px-4 py-2.5 rounded-xl text-sm
                bg-white/5 border border-border text-primary
                placeholder:text-tertiary
                focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
                transition-all"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ---- Device Row Component ----
function DeviceRow({ device, canManage }: { device: Device; canManage: boolean }) {
  const status = statusConfig[device.status];

  return (
    <tr className="hover:bg-white/[0.02] transition-colors">
      {/* Model + Brand */}
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg
            bg-white/5 border border-border">
            <Smartphone size={18} className="text-secondary" />
          </div>
          <div>
            <p className="text-sm font-medium text-primary">{device.model}</p>
            <p className="text-xs text-tertiary">{device.brand}</p>
          </div>
        </div>
      </td>

      {/* Serial */}
      <td className="px-6 py-4">
        <span className="text-sm text-secondary font-mono">{device.serial}</span>
      </td>

      {/* Status */}
      <td className="px-6 py-4">
        <Badge variant={status.variant} dot pulse={status.pulse}>
          {status.label}
        </Badge>
      </td>

      {/* Battery */}
      <td className="px-6 py-4">
        <BatteryBar level={device.battery} />
      </td>

      {/* IP */}
      <td className="px-6 py-4">
        <span className="text-sm text-secondary font-mono">
          {device.ip ? `${device.ip}:${device.port}` : "—"}
        </span>
      </td>

      {/* Actions */}
      {canManage && (
        <td className="px-6 py-4">
          <div className="flex items-center justify-end gap-1">
            {device.status === "offline" ? (
              <Button variant="ghost" size="sm" icon={<Wifi size={14} />}>
                Conectar
              </Button>
            ) : (
              <Button variant="ghost" size="sm" icon={<Unplug size={14} />}>
                Desconectar
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<Zap size={14} />}>
              Otimizar
            </Button>
          </div>
        </td>
      )}
    </tr>
  );
}
