import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../tauri";
import type {
  Company, Device, Campaign, Automation, LogEntry,
  DashboardKpis, AiConfig, AppConfig,
  Permission, SectorPermission, Contact, AdbDeviceInfo,
} from "../types";

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
};

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
    staleTime: 7_000,
    refetchInterval: 7_000,
  });
}

export function useCampaigns(companyId: number | null) {
  return useQuery({
    queryKey: keys.campaigns(companyId ?? 0),
    queryFn: () => api<Campaign[]>("get_campaigns", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 15_000,
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
    queryFn: () => api<DashboardKpis>("get_dashboard_kpis", { companyId: companyId ?? 0 }),
    enabled: companyId != null,
    staleTime: 30_000,
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
export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; deviceLimit: number; userLimit: number }) =>
      api<Company>("create_company", args),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.companies }),
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; name?: string; deviceLimit?: number; userLimit?: number }) =>
      api<Company>("update_company", args),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.companies }),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api<Campaign>("create_campaign", args),
    onSuccess: (_, vars) => {
      const cid = (vars as { companyId?: number }).companyId ?? 0;
      qc.invalidateQueries({ queryKey: keys.campaigns(cid) });
    },
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api<Campaign>("update_campaign", args),
    onSuccess: (_, vars) => {
      const cid = (vars as { companyId?: number }).companyId ?? 0;
      qc.invalidateQueries({ queryKey: keys.campaigns(cid) });
    },
  });
}

export function useSetCampaignStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; status: string; companyId: number }) =>
      api("set_campaign_status", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.campaigns(vars.companyId) });
    },
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { deviceId: number; companyId: number }) =>
      api("delete_device", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.devices(vars.companyId) });
    },
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { deviceId: number; companyId: number } & Record<string, unknown>) =>
      api("update_device", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.devices(vars.companyId) });
    },
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api<Automation>("create_automation", args),
    onSuccess: (_, vars) => {
      const cid = (vars as { companyId?: number }).companyId ?? 0;
      qc.invalidateQueries({ queryKey: keys.automations(cid) });
    },
  });
}

export function useUpdateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api<Automation>("update_automation", args),
    onSuccess: (_, vars) => {
      const cid = (vars as { companyId?: number }).companyId ?? 0;
      qc.invalidateQueries({ queryKey: keys.automations(cid) });
    },
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; companyId: number }) =>
      api("soft_delete_automation", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.automations(vars.companyId) });
    },
  });
}

export function useImportContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { campaignId: number; contacts: { phone: string; name?: string }[] }) =>
      api("import_campaign_contacts", args),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: keys.contacts(vars.campaignId) });
      qc.invalidateQueries({ queryKey: keys.campaigns(0) });
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