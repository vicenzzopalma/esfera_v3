import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../tauri";
import type {
  Company, Device, Campaign, Automation, LogEntry,
  DashboardKpis, AiConfig, AppConfig,
  Permission, SectorPermission, Contact, AdbDeviceInfo,
} from "../types";

// ── Utilitários compartilhados pelas telas ──

/**
 * O SQLite grava datas em UTC sem fuso ("2026-10-30 12:00:00"). O WebView lê esse formato
 * como hora LOCAL, o que adianta tudo em 3 horas. Aqui a data sem fuso é tratada como UTC;
 * data pura ("2026-10-30") é um dia do calendário local.
 */
export function parseDbDate(value?: string | null): Date | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(v);
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v);
  const d = new Date(naive && !hasZone ? `${v.replace(" ", "T")}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDbDate(value?: string | null, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDbDate(value);
  if (!d) return value ? String(value) : "—";
  return d.toLocaleString("pt-BR", opts ?? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function isSameLocalDay(a: Date, b: Date = new Date()): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Texto de erro legível vindo do backend (string, Error ou objeto). */
export function apiErrorText(err: unknown, fallback = "Não foi possível concluir a operação."): string {
  if (typeof err === "string") return err.trim() || fallback;
  if (err && typeof err === "object" && "message" in err) {
    const msg = String((err as { message?: unknown }).message ?? "").trim();
    if (msg) return msg;
  }
  return fallback;
}

/**
 * Janela de envio do motor (mesma regra do dispatcher, no horário local do PC):
 * seg–sex 8h–20h, sábado 8h–14h, domingo fechado.
 */
export function sendWindowState(now: Date = new Date()): { open: boolean; text: string } {
  const day = now.getDay();
  const hour = now.getHours();
  const closesAt = day === 6 ? 14 : 20;
  if (day !== 0 && hour >= 8 && hour < closesAt) return { open: true, text: `Aberta até ${closesAt}h` };
  for (let i = 0; i < 8; i++) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 8, 0, 0, 0);
    if (next.getDay() === 0 || next <= now) continue;
    const label = i === 0 ? "hoje" : i === 1 ? "amanhã" : next.toLocaleDateString("pt-BR", { weekday: "long" });
    return { open: false, text: `Fechada · abre ${label} às 8h` };
  }
  return { open: false, text: "Fechada" };
}

// ── Query keys ──
export const keys = {
  companies: ["companies"] as const,
  devices: (cid: number) => ["devices", cid] as const,
  campaigns: (cid: number) => ["campaigns", cid] as const,
  automations: (cid: number) => ["automations", cid] as const,
  logs: (cid: number) => ["logs", cid] as const,
  dashboard: (cid: number) => ["dashboard", cid] as const,
  aiConfig: (cid: number) => ["aiConfig", cid] as const,
  appConfig: ["appConfig"] as const,
  permissions: (uid: number) => ["permissions", uid] as const,
  sectorPermissions: (uid: number) => ["sectorPermissions", uid] as const,
  contacts: (campId: number) => ["contacts", campId] as const,
  usbDevices: ["usbDevices"] as const,
  pendingContact: (campId: number) => ["pendingContact", campId] as const,
  networkStatus: ["networkStatus"] as const,
  optOuts: (cid: number) => ["optOuts", cid] as const,
};

// ── Tipos de respostas que não estão em types.ts ──

/** Estado de cada chip no freio por taxa de resposta (get_network_status). */
export interface NetworkChipStatus {
  chipId: number;
  deviceId: number;
  deviceName: string;
  replyRate: number | null;
  sample: number;
  /** normal | reduzido | pausado | indisponivel */
  state: string;
  reason: string;
}

/** Ritmo da rede inteira deste computador (limites compartilhados por todas as empresas). */
export interface NetworkStatus {
  hourly: number;
  daily: number;
  sentLastHour: number;
  sentToday: number;
  waitSeconds: number;
  chips: NetworkChipStatus[];
}

export interface OptOutEntry {
  phone: string;
  reason: string;
  createdAt: string;
  addedBy?: string | null;
  removedBy?: string | null;
  removedAt?: string | null;
}

// get_dashboard_kpis devolve as chaves em snake_case (serde_json::json! no db.rs).
// Lê os dois formatos para os indicadores não ficarem zerados.
type RawKpis = Partial<DashboardKpis> & {
  blocked_chips?: number;
  config_changes_today?: number;
  sent_today?: number;
  pending_contacts?: number;
};

function normalizeKpis(raw: RawKpis | null | undefined): DashboardKpis {
  const r = raw ?? {};
  const num = (a?: number, b?: number) => Number(a ?? b ?? 0) || 0;
  return {
    sentToday: num(r.sentToday, r.sent_today),
    pendingContacts: num(r.pendingContacts, r.pending_contacts),
    blockedChips: num(r.blockedChips, r.blocked_chips),
    configChangesToday: num(r.configChangesToday, r.config_changes_today),
  };
}

// ── Queries ──
export function useCompanies() {
  return useQuery({
    queryKey: keys.companies,
    queryFn: () => api<Company[]>("get_companies"),
    staleTime: 60_000,
  });
}

export function useDevices(companyId: number | null) {
  return useQuery({
    queryKey: keys.devices(companyId ?? 0),
    queryFn: () => api<Device[]>("get_devices", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useCampaigns(companyId: number | null, opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: keys.campaigns(companyId ?? 0),
    queryFn: () => api<Campaign[]>("get_campaigns", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 15_000,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useAutomations(companyId: number | null) {
  return useQuery({
    queryKey: keys.automations(companyId ?? 0),
    queryFn: () => api<Automation[]>("get_automations", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 15_000,
  });
}

export function useLogs(companyId: number | null, autoRefresh: boolean) {
  return useQuery({
    queryKey: keys.logs(companyId ?? 0),
    queryFn: () => api<LogEntry[]>("get_logs", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 5_000,
    refetchInterval: autoRefresh ? 5_000 : undefined,
  });
}

export function useDashboardKpis(companyId: number | null) {
  return useQuery({
    queryKey: keys.dashboard(companyId ?? 0),
    queryFn: async () => normalizeKpis(await api<RawKpis>("get_dashboard_kpis", { companyId: companyId ?? 0 })),
    enabled: companyId != null,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

/** Ritmo da rede e freio por respostas. Leve: só contagens e o estado de cada chip. */
export function useNetworkStatus(enabled = true) {
  return useQuery({
    queryKey: keys.networkStatus,
    queryFn: () => api<NetworkStatus>("get_network_status"),
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/**
 * Lista completa de descadastros da empresa. Pode ter milhares de números, então só é relida
 * a cada 5 minutos (ou no botão Atualizar). O ideal é um comando de contagem leve (hoje/total).
 */
export function useOptOuts(companyId: number | null) {
  return useQuery({
    queryKey: keys.optOuts(companyId ?? 0),
    queryFn: () => api<OptOutEntry[]>("list_opt_outs", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 120_000,
    refetchInterval: 300_000,
  });
}

export function useAiConfig(companyId: number | null) {
  return useQuery({
    queryKey: keys.aiConfig(companyId ?? 0),
    queryFn: () => api<AiConfig>("get_ai_config", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 600_000,
  });
}

export function useAppConfig() {
  return useQuery({
    queryKey: keys.appConfig,
    queryFn: () => api<AppConfig>("get_app_config"),
    staleTime: 600_000,
  });
}

export function usePermissions(userId: number | null) {
  return useQuery({
    queryKey: keys.permissions(userId ?? 0),
    queryFn: () => api<Permission[]>("get_user_permissions", { userId }),
    enabled: userId != null,
    staleTime: 300_000,
  });
}

export function useSectorPermissions(userId: number | null) {
  return useQuery({
    queryKey: keys.sectorPermissions(userId ?? 0),
    queryFn: () => api<SectorPermission[]>("get_sector_permissions", { userId }),
    enabled: userId != null,
    staleTime: 300_000,
  });
}

export function useCampaignContacts(campaignId: number | null) {
  return useQuery({
    queryKey: keys.contacts(campaignId ?? 0),
    queryFn: () => api<Contact[]>("get_campaign_contacts", { campaignId }),
    enabled: campaignId != null,
    staleTime: 15_000,
  });
}

export function useUsbDevices() {
  return useQuery({
    queryKey: keys.usbDevices,
    queryFn: () => api<AdbDeviceInfo[]>("list_usb_devices"),
    staleTime: 5_000,
  });
}

// ── Mutations ──
// Os argumentos seguem a assinatura dos comandos em src-tauri/src/commands.rs.

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; deviceLimit: number }) =>
      api<Company>("create_company", args),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.companies }),
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; name: string; deviceLimit: number; userLimit: number; isActive: boolean }) =>
      api("update_company", args),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.companies }),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (campaign: Record<string, unknown> & { companyId: number }) =>
      api<number>("create_campaign", { campaign }),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: keys.campaigns(campaign.companyId) });
    },
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (campaign: Record<string, unknown> & { companyId: number }) =>
      api("update_campaign", { campaign }),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: keys.campaigns(campaign.companyId) });
    },
  });
}

export function useSetCampaignStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { campaignId: number; status: string; companyId: number }) =>
      api("set_campaign_status", { campaignId: args.campaignId, status: args.status }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.campaigns(vars.companyId) });
    },
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { serial: string; companyId: number }) =>
      api("delete_device", { serial: args.serial }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.devices(vars.companyId) });
    },
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { device: Device }) =>
      api("update_device", { device: args.device }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.devices(vars.device.companyId) });
    },
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (automation: Omit<Automation, "createdAt"> & { createdAt?: string }) =>
      api<number>("create_automation", { automation }),
    onSuccess: (_, automation) => {
      qc.invalidateQueries({ queryKey: keys.automations(automation.companyId) });
    },
  });
}

export function useUpdateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (automation: Omit<Automation, "createdAt"> & { createdAt?: string }) =>
      api("update_automation", { automation }),
    onSuccess: (_, automation) => {
      qc.invalidateQueries({ queryKey: keys.automations(automation.companyId) });
    },
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; companyId: number }) =>
      api("soft_delete_automation", { automationId: args.id }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.automations(vars.companyId) });
    },
  });
}

export function useImportContacts() {
  const qc = useQueryClient();
  return useMutation({
    // O backend recebe tuplas (nome, telefone).
    mutationFn: (args: { campaignId: number; contacts: { phone: string; name?: string }[] }) =>
      api("import_campaign_contacts", {
        campaignId: args.campaignId,
        contacts: args.contacts.map((c) => [c.name ?? "", c.phone]),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.contacts(vars.campaignId) });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export function useSaveAiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: AiConfig) => api("save_ai_config", { config: args, ...args }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.aiConfig(vars.companyId) });
    },
  });
}

export function useSaveAppConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: AppConfig) => api("save_app_config", { config: args, ...args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.appConfig }),
  });
}

export function useClearLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { companyId: number }) => api("clear_logs", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.logs(vars.companyId) });
    },
  });
}
