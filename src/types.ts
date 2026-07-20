// ============================================================
// Esfera v3 — Definições de Tipos
// ============================================================

export type Role = "master" | "gestor" | "colaborador";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  companyId: number | null; // null para master (multi-empresa)
  avatar?: string;
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

export type DeviceStatus = "online" | "offline" | "connecting" | "error";

export interface Device {
  id: number;
  serial: string;
  model: string;
  brand: string;
  status: DeviceStatus;
  battery: number; // 0-100
  companyId: number;
  ip?: string;
  port?: number;
  lastSeen: string;
}

export type CampaignStatus = "running" | "paused" | "completed" | "draft" | "error";

export interface Campaign {
  id: number;
  name: string;
  greeting: string;
  message: string;
  closing: string;
  delayMin: number; // delay mínimo entre envios (segundos)
  delayMax: number; // delay máximo entre envios (segundos)
  status: CampaignStatus;
  contactsCount: number;
  sentCount: number;
  failedCount: number;
  deviceIds: number[];
  companyId: number;
  useSpintax: boolean;
  useAI: boolean;
  aiModel?: string;
  aiTemperature?: number;
  aiPrompt?: string;
  createdAt: string;
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
}

export type ContactStatus = "pending" | "sent" | "failed" | "replied";

export interface Contact {
  id: number;
  name: string;
  phone: string;
  status: ContactStatus;
  campaignId: number;
  sentAt?: string;
}

export type LogType = "info" | "warning" | "error" | "success";

export interface LogEntry {
  id: number;
  timestamp: string;
  type: LogType;
  message: string;
  source: string;
  companyId: number;
}

export interface SessionState {
  loggedIn: boolean;
  user: User | null;
  selectedCompanyId: number | null;
}

// Tipos auxiliares para a UI
export interface TabItem {
  id: string;
  label: string;
  icon: string;
  requiredRoles: Role[];
  requiresCompany: boolean;
}
