// ============================================================
// Esfera v3 — Configurações do aparelho
// Abas: Geral, Tela, Rede, Desempenho e Sistema (ver ./config)
// ============================================================

import { useState, useEffect } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { Tabs } from "../ui/Tabs";
import type { Device, SectorType } from "../../types";
import { getConnectionOrigin } from "../../types";
import { Smartphone } from "lucide-react";
import { GeneralTab } from "./config/GeneralTab";
import { DisplayTab } from "./config/DisplayTab";
import { NetworkTab } from "./config/NetworkTab";
import { PerformanceTab } from "./config/PerformanceTab";
import { SystemTab } from "./config/SystemTab";
import { ORIGIN_LABEL } from "./deviceUi";

interface DeviceConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onSave: (device: Device) => void;
  onRemove?: (device: Device) => void;
}

type ConfigTab = "general" | "display" | "network" | "performance" | "system";

export function DeviceConfigModal({ isOpen, onClose, device, onSave, onRemove }: DeviceConfigModalProps) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("general");

  const [nameInput, setNameInput] = useState(device.name || device.model || "Aparelho");
  const [modelInput, setModelInput] = useState(device.model || "");
  const [sectorInput, setSectorInput] = useState<SectorType>((device.sector as SectorType) || "junior");
  const [vpsUrl, setVpsUrl] = useState("http://127.0.0.1:8080");

  useEffect(() => {
    if (isOpen) {
      setNameInput(device.name || device.model || "Aparelho");
      setModelInput(device.model || "");
      setSectorInput((device.sector as SectorType) || "junior");
    }
  }, [isOpen, device]);

  const serial = device.status === "online" && device.currentAdbAddress ? device.currentAdbAddress : device.serial;
  const origin = getConnectionOrigin(device);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Configurações do aparelho"
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave({
                ...device,
                name: nameInput.trim() || device.name || device.model || "Aparelho",
                model: modelInput || device.model,
                sector: sectorInput,
              });
            }}
          >
            Salvar alterações
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">{nameInput || device.name}</h3>
            <p className="truncate text-[0.75rem] text-secondary">
              {modelInput || device.model} · {ORIGIN_LABEL[origin]} · Bateria {device.battery}%
            </p>
          </div>
        </div>

        <Tabs<ConfigTab>
          items={[
            { id: "general", label: "Geral" },
            { id: "display", label: "Tela" },
            { id: "network", label: "Rede" },
            { id: "performance", label: "Desempenho" },
            { id: "system", label: "Sistema" },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

        <div className={activeTab === "general" ? "" : "hidden"}>
          <GeneralTab
            device={device}
            nameInput={nameInput}
            setNameInput={setNameInput}
            modelInput={modelInput}
            setModelInput={setModelInput}
            sectorInput={sectorInput}
            setSectorInput={setSectorInput}
          />
        </div>
        <div className={activeTab === "display" ? "" : "hidden"}>
          <DisplayTab serial={serial} />
        </div>
        <div className={activeTab === "network" ? "" : "hidden"}>
          <NetworkTab serial={serial} vpsUrl={vpsUrl} setVpsUrl={setVpsUrl} />
        </div>
        <div className={activeTab === "performance" ? "" : "hidden"}>
          <PerformanceTab serial={serial} />
        </div>
        <div className={activeTab === "system" ? "" : "hidden"}>
          <SystemTab device={device} serial={serial} vpsUrl={vpsUrl} displayName={nameInput || device.name || "aparelho"} onRemove={onRemove} onClose={onClose} />
        </div>
      </div>
    </Modal>
  );
}
