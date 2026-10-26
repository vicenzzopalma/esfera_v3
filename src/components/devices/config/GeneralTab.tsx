import { useState } from "react";
import Badge from "../../ui/Badge";
import Field, { FormSection } from "../../ui/Field";
import type { Device, SectorType } from "../../../types";
import { Copy, Check } from "lucide-react";
import { inputCls, SECTOR_OPTIONS, StatusDot, BatteryMeter } from "../deviceUi";

interface Props {
  device: Device;
  nameInput: string;
  setNameInput: (v: string) => void;
  modelInput: string;
  setModelInput: (v: string) => void;
  sectorInput: SectorType;
  setSectorInput: (v: SectorType) => void;
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.75rem] text-tertiary">{label}</p>
      <div className="truncate font-mono text-[0.75rem] text-primary">{value}</div>
    </div>
  );
}

export function GeneralTab({ device, nameInput, setNameInput, modelInput, setModelInput, sectorInput, setSectorInput }: Props) {
  const [copied, setCopied] = useState(false);
  const id = device.esferaDeviceId || device.serial;

  return (
    <div className="space-y-6">
      <FormSection title="Identificação" description="O nome só é alterado aqui, manualmente. O sistema nunca renomeia o aparelho sozinho.">
        <Field label="Nome do aparelho" htmlFor="cfg-name" hint="Aparece como título nos cards e listas.">
          <input id="cfg-name" type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Ex.: Aparelho 1" className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Modelo" htmlFor="cfg-model">
            <input id="cfg-model" type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)} placeholder="Ex.: Samsung SM-G570M" className={inputCls} />
          </Field>
          <Field label="Setor" htmlFor="cfg-sector">
            <select id="cfg-sector" value={sectorInput} onChange={(e) => setSectorInput(e.target.value as SectorType)} className={inputCls}>
              {SECTOR_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormSection>

      <FormSection title="Identidade permanente" description="Gravada no aparelho e no banco de dados; não muda ao renomear.">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/50 p-3">
          <span className="truncate font-mono text-[0.8125rem] text-primary">{id}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="success">Ancorado</Badge>
            <button
              type="button"
              aria-label="Copiar identificador"
              title="Copiar"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(id);
                } catch {
                  /* ignore */
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="rounded p-1 text-tertiary hover:text-primary cursor-pointer"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </FormSection>

      <FormSection title="Estado atual">
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-border p-3">
          <Info label="Endereço ADB" value={device.currentAdbAddress || device.serial} />
          <Info label="Serial" value={device.serial} />
          <Info label="Conexão" value={<StatusDot status={device.status} />} />
          <Info label="Bateria" value={<BatteryMeter level={device.battery} />} />
        </div>
      </FormSection>
    </div>
  );
}
