// ============================================================
// Esfera v3 — Painel de Monitoramento do Supervisor (SupervisorView.tsx)
// Permite ao Supervisor visualizar TODOS os celulares em tempo real,
// interagir via controle ADB e identificar quem é o colaborador que
// está no momento utilizando cada celular.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../tauri";
import type { DeviceWithActiveUser } from "../types";
import {
  Eye,
  Smartphone,
  UserCheck,
  RefreshCw,
  ArrowLeft,
  Home,
  Activity,
  Layers,
} from "lucide-react";
import Button from "./ui/Button";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

export default function SupervisorView() {
  const { user, selectedCompanyId } = useAuth();
  const [devicesWithUsers, setDevicesWithUsers] = useState<DeviceWithActiveUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [screenImages, setScreenImages] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<Record<string, boolean>>({});

  const companyId = selectedCompanyId || user?.companyId || 1;

  const loadData = useCallback(async () => {
    try {
      const data = await api<DeviceWithActiveUser[]>("get_devices_with_active_user_map", {
        companyId,
      });
      setDevicesWithUsers(data || []);
    } catch (err) {
      console.error("Erro ao carregar aparelhos do supervisor:", err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, [loadData]);

  const captureScreen = async (serial: string) => {
    setCapturing((prev) => ({ ...prev, [serial]: true }));
    try {
      const base64 = await api<string>("capture_device_screen", { serial });
      if (base64) {
        setScreenImages((prev) => ({ ...prev, [serial]: `data:image/png;base64,${base64}` }));
      }
    } catch (err) {
      console.error(`Erro ao capturar tela de ${serial}:`, err);
    } finally {
      setCapturing((prev) => ({ ...prev, [serial]: false }));
    }
  };

  const handleAdbTap = async (serial: string, x: number, y: number) => {
    try {
      await api("send_adb_tap", { serial, x, y });
      setTimeout(() => captureScreen(serial), 300);
    } catch (err) {
      console.error("Erro ao enviar toque ADB:", err);
    }
  };

  const handleAdbKey = async (serial: string, keycode: number) => {
    try {
      await api("send_adb_keyevent", { serial, keycode });
      setTimeout(() => captureScreen(serial), 400);
    } catch (err) {
      console.error("Erro ao enviar keyevent:", err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho do Supervisor */}
      <div className="bg-gradient-to-r from-purple-900/40 via-indigo-900/30 to-slate-900 border border-purple-500/30 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/20 border border-purple-500/40 rounded-xl text-purple-400">
              <Eye size={32} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Painel de Supervisão e Controle
                </span>
                <span className="text-xs text-slate-400">| Supervisor: {user?.displayName}</span>
              </div>
              <h1 className="text-2xl font-bold text-white mt-1">Visão Geral dos Celulares Conectados</h1>
              <p className="text-slate-300 text-sm">
                Monitore em tempo real quem é o colaborador operando cada celular e interaja diretamente com qualquer aparelho via ADB.
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 text-slate-300 hover:text-white border border-slate-700"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Atualizar Mapeamento
          </Button>
        </div>
      </div>

      {/* Grid de Celulares para o Supervisor */}
      {loading && devicesWithUsers.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-slate-400">
          <RefreshCw size={32} className="animate-spin text-purple-400 mb-3" />
          <p>Mapeando celulares e colaboradores ativos...</p>
        </div>
      ) : devicesWithUsers.length === 0 ? (
        <Card className="p-8 text-center border border-slate-800 bg-slate-900/60">
          <Smartphone size={48} className="mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-semibold text-white">Nenhum dispositivo encontrado na empresa</h3>
          <p className="text-slate-400 text-sm mt-1">Conecte celulares via ADB USB ou Wi-Fi para iniciar o monitoramento.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {devicesWithUsers.map((dev) => {
            const hasActiveUser = !!dev.activeUserDisplayName;
            const screenImg = screenImages[dev.serial];

            return (
              <Card
                key={dev.serial}
                className={`relative overflow-hidden transition-all duration-300 border ${
                  hasActiveUser
                    ? "border-purple-500/50 bg-purple-950/20 shadow-lg shadow-purple-950/40"
                    : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                }`}
              >
                {/* Banner Destacado do Colaborador Ativo no Presente */}
                <div
                  className={`px-4 py-2.5 flex items-center justify-between text-xs font-bold ${
                    hasActiveUser
                      ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white"
                      : "bg-slate-800/80 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <UserCheck size={16} />
                    <span>
                      {hasActiveUser
                        ? `Em uso por: ${dev.activeUserDisplayName}`
                        : "Disponível (Sem Colaborador Ativo)"}
                    </span>
                  </div>
                  {hasActiveUser && (
                    <span className="bg-emerald-500 text-slate-950 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full animate-pulse">
                      Ao Vivo
                    </span>
                  )}
                </div>

                <div className="p-5 space-y-4">
                  {/* Informações do Aparelho */}
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                        Aparelho #{dev.deviceNumber || 1} • Setor: {dev.sector}
                      </span>
                      <h3 className="text-lg font-bold text-white mt-0.5">{dev.name || dev.model}</h3>
                      <p className="text-xs text-slate-400">{dev.brand} {dev.model} • {dev.serial}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={dev.status === "online" ? "success" : "neutral"}
                        className="capitalize"
                      >
                        {dev.status}
                      </Badge>
                      <span className="text-xs text-slate-400 flex items-center gap-1">
                        <Activity size={12} /> {dev.battery}%
                      </span>
                    </div>
                  </div>

                  {/* Informações de Atribuição de Responsável */}
                  {dev.assignedUserName && (
                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800 text-xs flex items-center justify-between">
                      <span className="text-slate-400">Responsável Vinculado:</span>
                      <span className="font-semibold text-indigo-300">{dev.assignedUserName}</span>
                    </div>
                  )}

                  {/* Tela / Preview do Celular */}
                  <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-800 aspect-[9/16] max-h-64 flex flex-col items-center justify-center">
                    {screenImg ? (
                      <img
                        src={screenImg}
                        alt={`Tela ${dev.serial}`}
                        className="w-full h-full object-contain cursor-crosshair"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = Math.round(((e.clientX - rect.left) / rect.width) * 1080);
                          const y = Math.round(((e.clientY - rect.top) / rect.height) * 2340);
                          handleAdbTap(dev.serial, x, y);
                        }}
                      />
                    ) : (
                      <div className="text-center p-4 space-y-2">
                        <Smartphone size={36} className="mx-auto text-slate-700" />
                        <p className="text-xs text-slate-500">Preview de tela não carregado</p>
                      </div>
                    )}

                    <Button
                      variant="ghost"
                      onClick={() => captureScreen(dev.serial)}
                      disabled={capturing[dev.serial]}
                      className="absolute bottom-2 right-2 bg-slate-900/80 hover:bg-slate-800 text-xs px-2.5 py-1 text-slate-200 border border-slate-700 backdrop-blur-sm"
                    >
                      <RefreshCw size={12} className={capturing[dev.serial] ? "animate-spin" : ""} />
                      Capturar Tela
                    </Button>
                  </div>

                  {/* Controles Rápido do Supervisor */}
                  <div className="space-y-2 pt-1">
                    <span className="text-xs font-semibold text-slate-400 block uppercase">
                      Ações do Supervisor:
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(dev.serial, 4)} // BACK
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <ArrowLeft size={12} /> Voltar
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(dev.serial, 3)} // HOME
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <Home size={12} /> Home
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleAdbKey(dev.serial, 187)} // APP_SWITCH
                        className="text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <Layers size={12} /> Apps
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
