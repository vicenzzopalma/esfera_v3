// ============================================================
// Esfera v3 — Definições de Tipos
// Fase 1: Novos tipos para chips, contatos, permissões, IA
// ============================================================

export type Role = "master" | "gestor" | "supervisor" | "colaborador";
export type SectorType = "junior" | "senior" | "pa_fixa" | "pesquisa";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  companyId: number | null;
  avatar?: string;
}

export interface DeviceAssignment {
  assignmentId: number;
  adbDeviceId: string;
  userId: number;
  createdAt: string;
}

export type PermissionRequestStatus = "pending" | "approved" | "rejected" | "active" | "ended";

export interface DevicePermissionRequest {
  requestId: number;
  adbDeviceId: string;
  userId: number;
  userName?: string;
  userDisplayName?: string;
  status: PermissionRequestStatus;
  requestedReason?: string;
  requestedAt: string;
  approvedBy?: number;
  approvedByName?: string;
  approvedAt?: string;
  endedAt?: string;
}

export interface DeviceWithActiveUser extends Device {
  activeUserId?: number;
  activeUserName?: string;
  activeUserDisplayName?: string;
  permissionRequestId?: number;
  assignedUserId?: number;
  assignedUserName?: string;
  responsibleUserId?: number;
  responsibleUserName?: string;
}

export interface Company {
  id: number;
  name: string;
  deviceLimit: number;
  userLimit: number;
  deviceCount: number;
  userCount: number;
  status: "active" | "inactive";
  createdAt: string;
}

export type DeviceStatus = "online" | "offline" | "connecting" | "error" | "online_agent";

export interface Device {
  id: number;
  serial: string;
  name?: string;
  model: string;
  brand: string;
  status: DeviceStatus;
  battery: number;
  companyId: number;
  ip?: string;
  port?: number;
  lastSeen?: string;
  deviceNumber: number;
  sector: string;
  esferaDeviceId?: string | null;
  currentAdbAddress?: string | null;
  lastSeenUtc?: string | null;
  /// true quando o device está acessível via Túnel Reverso (conexão iniciada pelo celular),
  /// e não por endpoint ADB direto (IP:porta volátil).
  viaTunnel?: boolean;
}

export type CampaignStatus = "running" | "paused" | "completed" | "draft" | "error";

export interface Campaign {
  id: number;
  name: string;
  greeting: string;
  message: string;
  closing: string;
  delayMin: number;
  delayMax: number;
  status: CampaignStatus;
  contactsCount: number;
  sentCount: number;
  failedCount: number;
  deviceIds?: number[];
  companyId: number;
  useSpintax: boolean;
  useAI: boolean;
  aiModel?: string;
  aiTemperature?: number;
  aiPrompt?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface Automation {
  id: number;
  name: string;
  keyword: string;
  response: string;
  active: boolean;
  companyId: number;
  triggeredCount: number;
  createdAt: string;
  // Extended trigger/action fields
  triggerType: AutomationTriggerType;
  actionType: AutomationActionType;
  triggerConfig: string; // JSON config for trigger
  actionConfig: string;  // JSON config for action
  sector?: string;
}

export type AutomationTriggerType =
  | "keyword"
  | "ban_detected"
  | "device_offline"
  | "schedule"
  | "message_received";

export type AutomationActionType =
  | "send_response"
  | "move_chip"
  | "notify"
  | "toggle_campaign"
  | "set_chip_status"
  | "send_to_sector";

export const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  keyword: "Palavra-chave",
  ban_detected: "Ban Detectado",
  device_offline: "Dispositivo Offline",
  schedule: "Agendamento",
  message_received: "Mensagem Recebida",
};

export const ACTION_LABELS: Record<AutomationActionType, string> = {
  send_response: "Enviar Resposta",
  move_chip: "Mover Chip",
  notify: "Notificar Gestor",
  toggle_campaign: "Pausar/Iniciar Campanha",
  set_chip_status: "Alterar Status do Chip",
  send_to_sector: "Encaminhar para Setor",
};

// --- Novos tipos Fase 1 ---

export type ChipStatus =
  | "livre"
  | "em_uso"
  | "banido"
  | "restrito_24h"
  | "restrito_7d"
  | "restrito_custom";

export interface Chip {
  id: number;
  deviceId: number;
  phoneNumber: string;
  chipName: string;
  status: ChipStatus;
  holder?: string;
  isReserve?: boolean;
  linkedChipId?: number;
  restrictedUntil?: string;
  createdAt: string;
}

export type ContactStatus = "pending" | "sent" | "failed" | "replied" | "processing";

export interface Contact {
  id: number;
  contactName?: string;
  name?: string;
  phone: string;
  status: ContactStatus;
  campaignId: number;
  deviceId?: string;
  retryCount?: number;
  customMessage?: string;
  sentAt?: string;
}

export type LogType = "info" | "warning" | "error" | "success" | "dispatch" | "ban" | "ai" | "system" | "device";

export interface LogEntry {
  id: number;
  timestamp: string;
  type: LogType;
  message: string;
  source: string;
  companyId: number;
  deviceSerial?: string;
  campaignId?: number;
}

export interface SessionState {
  loggedIn: boolean;
  user: User | null;
  selectedCompanyId: number | null;
}

export interface TabItem {
  id: string;
  label: string;
  icon: string;
  requiredRoles: Role[];
  requiresCompany: boolean;
}

export interface DevicePackage {
  deviceId: number;
  packageName: string;
  status: "active" | "banned";
  updatedAt: string;
}

export interface SentHistory {
  phone: string;
  campaignId: number;
  sentAt: string;
}

export interface DeviceStatusEntry {
  deviceId: string;
  packageName: string;
  campaignId: number;
  status: string;
}

export interface DevicePrefs {
  deviceId: string;
  campaignId: number;
  preferredPackage: string;
  unlockPin: string;
}

export interface AiConfig {
  companyId: number;
  provider: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  apiKey: string;
  endpoint: string;
}

export interface Permission {
  userId: number;
  permissionKey: string;
  enabled: boolean;
}

export interface SectorPermission {
  userId: number;
  sector: string;
  canView: boolean;
  canConfigure: boolean;
}

export interface AppConfig {
  hub_enabled: boolean;
  hub_address: string;
  hub_token: string;
  empresa_server_enabled: boolean;
  empresa_server_port: number;
  checkin_server_enabled: boolean;
  checkin_server_port: number;
  tunnel_server_enabled: boolean;
  tunnel_server_port: number;
  mode: "local" | "empresa" | "master";
}

export interface DashboardKpis {
  blockedChips: number;
  configChangesToday: number;
  sentToday: number;
  pendingContacts: number;
}

export interface AdbDeviceInfo {
  serial: string;
  state: string;
  model: string;
}

// --- Helper para status de chip ---
export const CHIP_STATUS_CONFIG: Record<ChipStatus, { label: string; color: string; bgColor: string; borderColor: string }> = {
  livre: { label: "Livre", color: "text-emerald-400", bgColor: "bg-emerald-500/15", borderColor: "border-emerald-500/30" },
  em_uso: { label: "Em Uso", color: "text-blue-400", bgColor: "bg-blue-500/15", borderColor: "border-blue-500/30" },
  banido: { label: "Banido", color: "text-red-400", bgColor: "bg-red-500/15", borderColor: "border-red-500/30" },
  restrito_24h: { label: "Restrito 24h", color: "text-orange-400", bgColor: "bg-orange-500/15", borderColor: "border-orange-500/30" },
  restrito_7d: { label: "Restrito 7d", color: "text-purple-400", bgColor: "bg-purple-500/15", borderColor: "border-purple-500/30" },
  restrito_custom: { label: "Restrito", color: "text-pink-400", bgColor: "bg-pink-500/15", borderColor: "border-pink-500/30" },
};

// --- Helper para badges de origem de conexão ---
export type ConnectionOrigin = "vps" | "usb" | "wifi";

export const CONNECTION_BADGE_CONFIG: Record<
  ConnectionOrigin,
  { label: string; icon: string; badgeVariant: "purple" | "info" | "success" }
> = {
  vps: { label: "VPS Núvem", icon: "☁️", badgeVariant: "purple" },
  usb: { label: "ADB USB", icon: "🔌", badgeVariant: "info" },
  wifi: { label: "Wi-Fi Direct", icon: "📡", badgeVariant: "success" },
};

export function getConnectionOrigin(device: Device): ConnectionOrigin {
  if (device.viaTunnel) return "vps";
  if (device.serial.includes(":")) return "wifi";
  return "usb";
}

// --- Helper para setores ---
export const SECTOR_CONFIG: Record<string, { label: string; color: string; headerColor: string; bgLight: string; borderLight: string }> = {
  junior: { label: "Júnior", color: "text-green-400", headerColor: "from-green-600 to-green-500", bgLight: "bg-green-50", borderLight: "border-green-200" },
  senior: { label: "Sênior", color: "text-blue-400", headerColor: "from-blue-600 to-blue-500", bgLight: "bg-blue-50", borderLight: "border-blue-200" },
  comercial: { label: "Comercial", color: "text-orange-400", headerColor: "from-orange-600 to-orange-500", bgLight: "bg-orange-50", borderLight: "border-orange-200" },
  pesquisa: { label: "Pesquisa", color: "text-purple-400", headerColor: "from-purple-600 to-purple-500", bgLight: "bg-purple-50", borderLight: "border-purple-200" },
  pa_fixa_1: { label: "PA Fixa 1", color: "text-cyan-400", headerColor: "from-cyan-600 to-cyan-500", bgLight: "bg-cyan-50", borderLight: "border-cyan-200" },
  pa_fixa_2: { label: "PA Fixa 2", color: "text-yellow-400", headerColor: "from-yellow-600 to-yellow-500", bgLight: "bg-yellow-50", borderLight: "border-yellow-200" },
};
