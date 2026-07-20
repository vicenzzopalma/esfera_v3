// ============================================================
// Esfera v3 — Dados Mock
// Dados falsos realistas para desenvolvimento do front-end
// ============================================================

import type {
  User,
  Company,
  Device,
  Campaign,
  Automation,
  Contact,
  LogEntry,
} from "./types";

// ---- Credenciais de Teste ----
export const MOCK_CREDENTIALS = [
  { username: "vicenzzo.master", password: "root123", userId: 10 },
  { username: "vicenzzo.mastronikolis", password: "Ope@2025", userId: 11 },
  { username: "admin", password: "admin", userId: 1 },
  { username: "gestor", password: "gestor", userId: 2 },
  { username: "colab", password: "colab", userId: 3 },
];

// ---- Usuários ----
export const MOCK_USERS: User[] = [
  {
    id: 10,
    username: "vicenzzo.master",
    displayName: "Vicenzzo Master",
    role: "master",
    companyId: null,
  },
  {
    id: 11,
    username: "vicenzzo.mastronikolis",
    displayName: "Vicenzzo Mastronikolis",
    role: "gestor",
    companyId: 1,
  },
  {
    id: 1,
    username: "admin",
    displayName: "Administrador",
    role: "master",
    companyId: null,
  },
  {
    id: 2,
    username: "gestor",
    displayName: "Ana Gestora",
    role: "gestor",
    companyId: 1,
  },
  {
    id: 3,
    username: "colab",
    displayName: "Pedro Colaborador",
    role: "colaborador",
    companyId: 1,
  },
];

// ---- Empresas ----
export const MOCK_COMPANIES: Company[] = [
  {
    id: 1,
    name: "REALESS RM COBRANÇAS",
    deviceLimit: 50,
    userLimit: 20,
    deviceCount: 8,
    userCount: 12,
    status: "active",
    createdAt: "2026-01-10",
  },
];

// ---- Dispositivos ----
export const MOCK_DEVICES: Device[] = [];

// ---- Campanhas ----
export const MOCK_CAMPAIGNS: Campaign[] = [];

// ---- Automações ----
export const MOCK_AUTOMATIONS: Automation[] = [];

// ---- Contatos ----
export const MOCK_CONTACTS: Contact[] = [];

// ---- Logs ----
export const MOCK_LOGS: LogEntry[] = [];
