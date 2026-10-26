// Card e linha de aparelho: nome em destaque, status, bateria, serial discreto,
// ações primárias visíveis e secundárias em menu.
import { memo, useState } from "react";
import type { Device, DevicePermissionRequest } from "../../types";
import { getConnectionOrigin } from "../../types";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import { Monitor, Camera, Zap, Copy, Check, Info, Settings2, Bell, User } from "lucide-react";
import { RowMenu } from "./RowMenu";
import { StatusDot, BatteryMeter, ORIGIN_LABEL, sectorLabel, deviceDisplayName } from "./deviceUi";

export interface DeviceItemProps {
  device: Device;
  activeUserDisplayName?: string;
  pendingRequest?: DevicePermissionRequest;
  onApproveRequest?: (requestId: number) => void;
  onRejectRequest?: (requestId: number) => void;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpenMirror: () => void;
  onOpenConfig: () => void;
  onOpenRegion: () => void;
  onForceWireless: () => void;
  onOpenDiagnostic: () => void;
}

const checkboxCls = "h-4 w-4 shrink-0 rounded border-border-strong bg-secondary accent-[var(--color-accent)] cursor-pointer";

function useDeviceInfo(device: Device) {
  const isWireless =
    (device.serial && device.serial.includes(":")) || (device.currentAdbAddress && device.currentAdbAddress.includes(":"));
  const isUsbOnly = device.status === "online" && !isWireless && !device.viaTunnel;
  const origin = getConnectionOrigin(device);
  const displayName = deviceDisplayName(device);
  const model =
    device.model && device.model !== "Smartphone" && device.model !== "Android"
      ? device.model
      : device.brand && device.brand !== "Android"
      ? device.brand
      : "Android";
  const address = device.currentAdbAddress || device.ip || device.serial;
  return { isUsbOnly, origin, displayName, model, address };
}

function menuItems(p: DeviceItemProps, isUsbOnly: boolean) {
  return [
    { label: "Detalhes e identidade", icon: <Info size={14} />, onClick: p.onOpenDiagnostic },
    { label: "Configurações", icon: <Settings2 size={14} />, onClick: p.onOpenConfig },
    { label: "Câmera virtual", icon: <Camera size={14} />, onClick: p.onOpenRegion },
    { label: "Ativar Wi-Fi ADB", icon: <Zap size={14} />, onClick: p.onForceWireless, hidden: !isUsbOnly },
  ];
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copiar identificador"
      aria-label="Copiar identificador do aparelho"
      onClick={(e) => {
        e.stopPropagation();
        try {
          navigator.clipboard.writeText(id);
        } catch {
          /* ignore */
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex min-w-0 items-center gap-1 text-tertiary hover:text-primary transition-colors cursor-pointer"
    >
      <span className="truncate font-mono text-[0.6875rem]">{id}</span>
      {copied ? <Check size={11} className="shrink-0 text-emerald-500" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

export const DeviceCard = memo(function DeviceCard(props: DeviceItemProps) {
  const { device, activeUserDisplayName, pendingRequest, onApproveRequest, onRejectRequest, isSelected, onToggleSelect, onOpenMirror } = props;
  const { isUsbOnly, origin, displayName, model, address } = useDeviceInfo(device);
  const idText = device.esferaDeviceId || device.serial;

  return (
    <div
      className={`flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors ${
        isSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)]" : "border-border hover:border-border-strong"
      }`}
    >
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={isSelected} onChange={onToggleSelect} aria-label={`Selecionar ${displayName}`} className={`${checkboxCls} mt-1`} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-primary" title={displayName}>
            {displayName}
          </h3>
          <p className="truncate text-[0.75rem] text-secondary" title={model}>
            {model} · {sectorLabel(device.sector)}
          </p>
        </div>
        <RowMenu items={menuItems(props, isUsbOnly)} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot status={device.status} />
        <BatteryMeter level={device.battery} />
        <Badge variant="neutral">{ORIGIN_LABEL[origin]}</Badge>
      </div>

      {activeUserDisplayName && (
        <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[0.75rem] text-emerald-600 dark:text-emerald-400">
          <User size={12} className="shrink-0" />
          <span className="truncate">Em uso por {activeUserDisplayName}</span>
        </div>
      )}

      {pendingRequest && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
          <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-amber-600 dark:text-amber-400">
            <Bell size={12} className="shrink-0" />
            <span className="truncate">{pendingRequest.userDisplayName || pendingRequest.userName} pediu acesso</span>
          </p>
          {pendingRequest.requestedReason && <p className="truncate text-[0.75rem] text-secondary">"{pendingRequest.requestedReason}"</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="success" onClick={() => onApproveRequest?.(pendingRequest.requestId)}>
              Aprovar
            </Button>
            <Button size="sm" variant="danger" onClick={() => onRejectRequest?.(pendingRequest.requestId)}>
              Recusar
            </Button>
          </div>
        </div>
      )}

      <div className="mt-auto space-y-3">
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <CopyId id={idText} />
          {address !== idText && (
            <span className="truncate font-mono text-[0.6875rem] text-tertiary" title={address}>
              {address}
            </span>
          )}
        </div>
        {isUsbOnly ? (
          <Button variant="secondary" size="sm" className="w-full" onClick={props.onForceWireless} icon={<Zap size={14} />}>
            Ativar Wi-Fi ADB
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" size="sm" onClick={onOpenMirror} icon={<Monitor size={14} />} title="Espelhar a tela em tempo real">
              Espelhar
            </Button>
            <Button variant="secondary" size="sm" onClick={props.onOpenRegion} icon={<Camera size={14} />} title="Câmera virtual para leitura de QR Code">
              Câmera
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

// Linha para a visão em lista (densa).
export const DeviceRow = memo(function DeviceRow(props: DeviceItemProps) {
  const { device, activeUserDisplayName, isSelected, onToggleSelect, onOpenMirror } = props;
  const { isUsbOnly, origin, displayName, model, address } = useDeviceInfo(device);

  return (
    <tr className={`transition-colors hover:bg-secondary/60 ${isSelected ? "bg-[var(--color-accent-glow)]" : ""}`}>
      <td className="w-10 px-4 py-2.5">
        <input type="checkbox" checked={isSelected} onChange={onToggleSelect} aria-label={`Selecionar ${displayName}`} className={checkboxCls} />
      </td>
      <td className="px-3 py-2.5">
        <p className="max-w-[16rem] truncate text-[0.8125rem] font-medium text-primary" title={displayName}>
          {displayName}
        </p>
        <p className="max-w-[16rem] truncate text-[0.75rem] text-secondary">{model}</p>
      </td>
      <td className="px-3 py-2.5">
        <StatusDot status={device.status} />
        {activeUserDisplayName && <p className="max-w-[10rem] truncate text-[0.6875rem] text-tertiary">Em uso: {activeUserDisplayName}</p>}
      </td>
      <td className="px-3 py-2.5">
        <BatteryMeter level={device.battery} />
      </td>
      <td className="px-3 py-2.5 text-[0.8125rem] text-secondary">{sectorLabel(device.sector)}</td>
      <td className="px-3 py-2.5">
        <p className="max-w-[14rem] truncate font-mono text-[0.75rem] text-secondary" title={address}>
          {address}
        </p>
        <p className="text-[0.6875rem] text-tertiary">{ORIGIN_LABEL[origin]}</p>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          {isUsbOnly ? (
            <Button variant="secondary" size="sm" onClick={props.onForceWireless} icon={<Zap size={13} />}>
              Wi-Fi ADB
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onOpenMirror} icon={<Monitor size={13} />}>
              Espelhar
            </Button>
          )}
          <RowMenu items={menuItems(props, isUsbOnly)} />
        </div>
      </td>
    </tr>
  );
});
