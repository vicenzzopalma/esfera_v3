// ============================================================
// Esfera v3 — Detalhes e identidade do aparelho (somente leitura)
// ============================================================

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import { FormSection } from "../ui/Field";
import type { Device } from "../../types";
import { getConnectionOrigin } from "../../types";
import { Smartphone, Copy, Check } from "lucide-react";
import { StatusDot, BatteryMeter, ORIGIN_LABEL, sectorLabel } from "./deviceUi";

interface DeviceIdentityModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device | null;
}

function Row({ label, value, mono = false, copy = false }: { label: string; value: React.ReactNode; mono?: boolean; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = typeof value === "string" ? value : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-0">
      <span className="shrink-0 text-[0.8125rem] text-secondary">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate text-[0.8125rem] text-primary ${mono ? "font-mono text-[0.75rem]" : ""}`} title={text}>
          {value}
        </span>
        {copy && text && (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={`Copiar ${label}`}
            title="Copiar"
            className="shrink-0 rounded p-1 text-tertiary hover:bg-secondary hover:text-primary cursor-pointer"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function DeviceIdentityModal({ isOpen, onClose, device }: DeviceIdentityModalProps) {
  if (!device) return null;

  const origin = getConnectionOrigin(device);
  const displayName = device.name || device.model || device.serial;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Detalhes do aparelho"
      size="md"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-primary">{displayName}</h3>
            <p className="truncate text-[0.75rem] text-secondary">{device.model}</p>
          </div>
          <StatusDot status={device.status} />
        </div>

        <FormSection title="Identificação" description="O nome só muda por edição manual nas configurações do aparelho.">
          <div className="rounded-xl border border-border px-4">
            <Row label="Serial ADB" value={device.serial} mono copy />
            <Row label="ID do Esfera" value={device.esferaDeviceId || "Não provisionado"} mono copy={!!device.esferaDeviceId} />
            <Row label="Endereço" value={device.currentAdbAddress || device.ip || "Não informado"} mono copy={!!(device.currentAdbAddress || device.ip)} />
            <Row label="Empresa (ID)" value={String(device.companyId)} mono />
          </div>
        </FormSection>

        <FormSection title="Estado">
          <div className="rounded-xl border border-border px-4">
            <Row label="Bateria" value={<BatteryMeter level={device.battery} />} />
            <Row
              label="Conexão"
              value={
                <span className="inline-flex items-center gap-2">
                  {ORIGIN_LABEL[origin]}
                  {device.viaTunnel && <Badge variant="neutral">Túnel reverso</Badge>}
                </span>
              }
            />
            <Row label="Setor" value={sectorLabel(device.sector)} />
            <Row label="Número" value={`#${device.deviceNumber}`} mono />
            <Row label="Último sinal (UTC)" value={device.lastSeenUtc || device.lastSeen || "Sem registro"} mono />
          </div>
        </FormSection>
      </div>
    </Modal>
  );
}
