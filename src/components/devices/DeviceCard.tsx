// Card e linha de aparelho: nome em destaque, status, bateria, chip, serial discreto,
// ações primárias visíveis e secundárias em menu.
// Os callbacks recebem o aparelho: o pai passa funções estáveis e o memo evita
// redesenhar todos os cards a cada clique ou atualização.
import { memo, useState } from "react";
import type { Device, DevicePermissionRequest } from "../../types";
import { getConnectionOrigin } from "../../types";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import { Monitor, Camera, Zap, Copy, Check, Info, Settings2, Bell, User, Hand, CardSim } from "lucide-react";
import { RowMenu } from "./RowMenu";
import { StatusDot, BatteryMeter, ORIGIN_LABEL, sectorLabel, deviceDisplayName, chipSummary, type DeviceChip } from "./deviceUi";
import type { ConfigTab } from "./DeviceConfigModal";

export interface AgentUpdateStatus {
  deviceId: string;
  companyId: number;
  versionCode: number | null;
  versionName: string;
  expectedCode: number;
  status: string;
  detail: string;
}

export interface DeviceItemProps {
  device: Device;
  agentStatus?: AgentUpdateStatus;
  activeUserDisplayName?: string;
  pendingRequest?: DevicePermissionRequest;
  chips?: DeviceChip[];
  linking?: boolean;
  isSelected: boolean;
  onApproveRequest: (requestId: number) => void;
  onRejectRequest: (requestId: number) => void;
  onToggleSelect: (device: Device) => void;
  onOpenMirror: (device: Device) => void;
  onOpenConfig: (device: Device, tab?: ConfigTab) => void;
  onOpenRegion: (device: Device) => void;
  onForceWireless: (device: Device) => void;
  onOpenDiagnostic: (device: Device) => void;
}

const checkboxCls = "h-4 w-4 shrink-0 rounded border-border-strong bg-secondary accent-[var(--color-accent)] cursor-pointer";

// Compara o que o card mostra. A lista volta do backend a cada 7 s com "último sinal"
// novo e status do agente recriado; sem isto, todos os cards redesenhavam sempre.
function sameShallow<T extends object>(a: T | undefined, b: T | undefined, ignore: string[] = []) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a).filter((k) => !ignore.includes(k));
  const kb = Object.keys(b).filter((k) => !ignore.includes(k));
  if (ka.length !== kb.length) return false;
  return kb.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

function itemPropsEqual(a: DeviceItemProps, b: DeviceItemProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof DeviceItemProps)[]);
  for (const k of keys) {
    if (k === "device") {
      if (!sameShallow(a.device, b.device, ["lastSeenUtc", "lastSeen"])) return false;
    } else if (k === "agentStatus") {
      if (!sameShallow(a.agentStatus, b.agentStatus)) return false;
    } else if (k === "pendingRequest") {
      if (a.pendingRequest?.requestId !== b.pendingRequest?.requestId) return false;
    } else if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

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
  const d = p.device;
  return [
    { label: "Detalhes e identidade", icon: <Info size={14} />, onClick: () => p.onOpenDiagnostic(d) },
    { label: "Configurações", icon: <Settings2 size={14} />, onClick: () => p.onOpenConfig(d) },
    { label: "Chip do aparelho", icon: <CardSim size={14} />, onClick: () => p.onOpenConfig(d, "chip") },
    { label: "Câmera virtual", icon: <Camera size={14} />, onClick: () => p.onOpenRegion(d) },
    { label: "Ativar Wi-Fi", icon: <Zap size={14} />, onClick: () => p.onForceWireless(d), hidden: !isUsbOnly, disabled: p.linking },
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
        navigator.clipboard
          .writeText(id)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            /* área de transferência indisponível */
          });
      }}
      className="inline-flex min-w-0 items-center gap-1 text-tertiary hover:text-primary transition-colors cursor-pointer"
    >
      <span className="truncate font-mono text-[0.6875rem]">{id}</span>
      {copied ? <Check size={11} className="shrink-0 text-emerald-500" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

// Traduz o status técnico do monitor do agente para o operador. O texto original
// continua disponível na dica (title) para o suporte.
export function describeAgent(status?: AgentUpdateStatus): { text: string; tone: "muted" | "warning" | "danger"; technical?: string } {
  if (!status) return { text: "Agente: aguardando verificação", tone: "muted" };
  const hasVersion = status.versionCode != null;
  const version = hasVersion ? ` (versão ${status.versionName || status.versionCode})` : "";
  const detail = String(status.detail || "");
  const d = detail.toLowerCase();
  switch (status.status) {
    case "current":
      return { text: `Agente em dia${version}`, tone: "muted", technical: detail };
    case "updating":
      return { text: "Atualizando o agente…", tone: "muted" };
    case "checking":
      return { text: "Verificando o agente…", tone: "muted" };
    case "waiting":
      return { text: "Agente: aguardando o aparelho terminar o envio", tone: "muted" };
    case "error":
      if (d.includes("notifica")) {
        return {
          text: "Leitura de notificações indisponível neste aparelho (comum no Android Go). Os envios continuam; respostas e pedidos de SAIR recebidos nele não são lidos automaticamente.",
          tone: "warning",
          technical: detail,
        };
      }
      if (d.includes("acessibilidade")) {
        return {
          text: "Acessibilidade do agente não confirmada: a digitação automática pode falhar. Provisione de novo ou ative o Esfera Agent em Acessibilidade no aparelho.",
          tone: "danger",
          technical: detail,
        };
      }
      if (d.includes("serviço não iniciou")) {
        return { text: "O serviço do agente não iniciou. Use Provisionar em Configurações > Sistema.", tone: "danger", technical: detail };
      }
      if (d.includes("não foi possível verificar") || d.includes("falha ao verificar")) {
        return { text: "Não foi possível verificar o agente agora: o aparelho não respondeu.", tone: "warning", technical: detail };
      }
      if (d.includes("túnel")) {
        return { text: "Atualização automática indisponível pelo túnel: conecte o aparelho por USB ou Wi-Fi para atualizar o agente.", tone: "warning", technical: detail };
      }
      if (d.includes("falha ao instalar") || d.includes("falha ao atualizar") || d.includes("versão instalada não corresponde")) {
        return {
          text: "A atualização do agente falhou. O Esfera tenta de novo sozinho; se continuar, use Reinstalar em Configurações > Sistema.",
          tone: "danger",
          technical: detail,
        };
      }
      return { text: `Agente: ${detail || "erro na última verificação"}`, tone: "danger", technical: detail };
    default:
      return { text: detail ? `Agente: ${detail}` : "Agente: sem informação", tone: "muted", technical: detail };
  }
}

const AGENT_TONE = {
  muted: "text-tertiary",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

function AgentStatus({ status }: { status?: AgentUpdateStatus }) {
  const view = describeAgent(status);
  return (
    <p className={`break-words text-[0.6875rem] leading-snug ${AGENT_TONE[view.tone]}`} title={view.technical || undefined} role={view.tone === "muted" ? undefined : "status"}>
      {view.text}
    </p>
  );
}

// compact: só a etiqueta (o número fica na dica), para a tabela não alargar.
function ChipBadge({ chips, onOpen, compact = false }: { chips?: DeviceChip[]; onOpen: () => void; compact?: boolean }) {
  const s = chipSummary(chips);
  if (!s) return null;
  const tip = `${s.phone ? `${s.phone}. ` : ""}${s.title} Clique para abrir.`;
  return (
    <button type="button" onClick={onOpen} title={tip} className="inline-flex max-w-full items-center gap-1.5 rounded-md cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
      <Badge variant={s.tone} dot>
        {s.label}
      </Badge>
      {!compact && s.phone && <span className="truncate font-mono text-[0.6875rem] text-secondary">{s.phone}</span>}
    </button>
  );
}

export const DeviceCard = memo(function DeviceCard(props: DeviceItemProps) {
  const { device, activeUserDisplayName, pendingRequest, onApproveRequest, onRejectRequest, isSelected, onToggleSelect, onOpenMirror, linking } = props;
  const { isUsbOnly, origin, displayName, model, address } = useDeviceInfo(device);
  const idText = device.esferaDeviceId || device.serial;

  return (
    <div
      className={`flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_15rem] ${
        isSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)]" : "border-border hover:border-border-strong"
      }`}
    >
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(device)} aria-label={`Selecionar ${displayName}`} className={`${checkboxCls} mt-1`} />
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

      {device.status === "connecting" && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[0.75rem] text-amber-700 dark:text-amber-400">
          <Hand size={12} className="mt-0.5 shrink-0" />
          <span>Desbloqueie o aparelho e toque em Permitir na janela de depuração USB (marque "Sempre permitir").</span>
        </p>
      )}

      <ChipBadge chips={props.chips} onOpen={() => props.onOpenConfig(device, "chip")} />

      <AgentStatus status={props.agentStatus} />

      {activeUserDisplayName && (
        <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[0.75rem] text-emerald-700 dark:text-emerald-400">
          <User size={12} className="shrink-0" />
          <span className="truncate">Em uso por {activeUserDisplayName}</span>
        </div>
      )}

      {pendingRequest && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
          <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-amber-700 dark:text-amber-400">
            <Bell size={12} className="shrink-0" />
            <span className="truncate">{pendingRequest.userDisplayName || pendingRequest.userName} pediu acesso</span>
          </p>
          {pendingRequest.requestedReason && <p className="truncate text-[0.75rem] text-secondary">"{pendingRequest.requestedReason}"</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="success" onClick={() => onApproveRequest(pendingRequest.requestId)}>
              Aprovar
            </Button>
            <Button size="sm" variant="danger" onClick={() => onRejectRequest(pendingRequest.requestId)}>
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
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => props.onForceWireless(device)}
            loading={linking}
            icon={<Zap size={14} />}
            title="Liga o controle por Wi-Fi para usar o aparelho sem o cabo USB"
          >
            {linking ? "Ativando Wi-Fi…" : "Ativar Wi-Fi"}
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" size="sm" onClick={() => onOpenMirror(device)} icon={<Monitor size={14} />} title="Ver e controlar a tela do aparelho">
              Espelhar
            </Button>
            <Button variant="secondary" size="sm" onClick={() => props.onOpenRegion(device)} icon={<Camera size={14} />} title="Câmera virtual para leitura de QR Code">
              Câmera
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}, itemPropsEqual);

// Linha para a visão em lista (densa).
export const DeviceRow = memo(function DeviceRow(props: DeviceItemProps) {
  const { device, activeUserDisplayName, isSelected, onToggleSelect, onOpenMirror, linking } = props;
  const { isUsbOnly, origin, displayName, model, address } = useDeviceInfo(device);

  return (
    <tr className={`transition-colors hover:bg-hover ${isSelected ? "bg-[var(--color-accent-glow)]" : ""}`}>
      <td className="w-10 px-4 py-2.5">
        <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(device)} aria-label={`Selecionar ${displayName}`} className={checkboxCls} />
      </td>
      <td className="px-3 py-2.5">
        <p className="max-w-[16rem] truncate text-[0.8125rem] font-medium text-primary" title={displayName}>
          {displayName}
        </p>
        <p className="max-w-[16rem] truncate text-[0.75rem] text-secondary">{model}</p>
        <div className="max-w-[16rem]">
          <AgentStatus status={props.agentStatus} />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <StatusDot status={device.status} />
        {activeUserDisplayName && <p className="max-w-[10rem] truncate text-[0.6875rem] text-tertiary">Em uso: {activeUserDisplayName}</p>}
        <div className="mt-1">
          <ChipBadge chips={props.chips} onOpen={() => props.onOpenConfig(device, "chip")} compact />
        </div>
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
            <Button variant="secondary" size="sm" onClick={() => props.onForceWireless(device)} loading={linking} icon={<Zap size={13} />} title="Liga o controle por Wi-Fi para usar o aparelho sem o cabo USB">
              Ativar Wi-Fi
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => onOpenMirror(device)} icon={<Monitor size={13} />}>
              Espelhar
            </Button>
          )}
          <RowMenu items={menuItems(props, isUsbOnly)} />
        </div>
      </td>
    </tr>
  );
}, itemPropsEqual);
