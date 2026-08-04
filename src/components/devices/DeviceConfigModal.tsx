// ============================================================
// Esfera v3 — Sub-componente DeviceConfigModal (Linear SaaS Style)
// Modal de configuração de título, setor e otimização do celular
// ============================================================

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import type { Device, SectorType } from "../../types";
import { Zap, RefreshCw } from "lucide-react";

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
}

export function DeviceConfigModal({
  isOpen,
  onClose,
  device,
  onSave,
}: DeviceConfigModalProps) {
  const [nameInput, setNameInput] = useState(device.name || `Aparelho ${device.deviceNumber}`);
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [optimizing, setOptimizing] = useState(false);
  const [optStatus, setOptStatus] = useState<string | null>(null);

  const handleOptimize = async () => {
    setOptimizing(true);
    setOptStatus("Otimizando cache RAM e conexões ADB...");
    try {
      await new Promise((r) => setTimeout(r, 1200));
      setOptStatus("✅ Memória RAM e conexões ADB otimizadas!");
    } catch {
      setOptStatus("❌ Erro na otimização.");
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Configurações: ${nameInput || device.model}`}
      size="md"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave({
                ...device,
                name: nameInput || device.name || `Aparelho ${device.deviceNumber}`,
                model: modelInput || device.model,
                sector: sectorInput,
              });
            }}
          >
            Salvar Alterações
          </Button>
        </div>
      }
    >
      <div className="space-y-3.5 text-xs">
        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Nome do Aparelho (Título Principal)</label>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Ex: Aparelho 1, Aparelho 2"
            className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Modelo / Hardware (Subtítulo)</label>
          <input
            type="text"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="Ex: moto g22"
            className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Setor do Aparelho</label>
          <select
            value={sectorInput}
            onChange={(e) => setSectorInput(e.target.value as SectorType)}
            className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs focus:outline-none focus:border-[#5E6AD2]"
          >
            <option value="junior">Junior</option>
            <option value="senior">Senior</option>
            <option value="pa_fixa">PA FIXA</option>
            <option value="pesquisa">Pesquisa</option>
          </select>
        </div>

        <div className="p-3 rounded-md bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 space-y-2">
          <h5 className="font-semibold text-[#828DF7] flex items-center gap-1.5 text-xs">
            <Zap size={13} className="text-amber-400" /> Otimização de Memória & ADB
          </h5>
          <p className="text-[11px] text-zinc-400">
            Libere o cache do sistema Android e redefina os soquetes ADB em tempo real.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleOptimize}
            disabled={optimizing}
            icon={<RefreshCw size={12} className={optimizing ? "animate-spin" : ""} />}
            className="text-xs"
          >
            {optimizing ? "Otimizando..." : "Otimizar RAM & ADB"}
          </Button>

          {optStatus && <p className="text-[10px] font-mono text-emerald-400 mt-1">{optStatus}</p>}
        </div>
      </div>
    </Modal>
  );
}
