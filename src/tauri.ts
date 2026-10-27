import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

let _token: string | null = null;
let _mode: "local" | "empresa" | "master" = "local";
let _configLoaded = false;

// Carrega config uma vez para saber o mode
async function ensureConfig(): Promise<void> {
  if (_configLoaded) return;
  try {
    const cfg = await invoke<AppConfig>("get_app_config", { token: _token || "default-token" });
    if (cfg?.mode) {
      _mode = cfg.mode;
    }
  } catch { /* fallback: local */ }
  _configLoaded = true;
}

export function setAppMode(m: "local" | "empresa" | "master") {
  _mode = m;
  _configLoaded = true;
}

export function reloadConfig(): void {
  _configLoaded = false;
}

export function setToken(t: string | null) {
  _token = t;
}

export function getToken(): string | null {
  return _token;
}

const LOCAL_ONLY_COMMANDS = new Set([
  "connect_adb_device",
  "force_enable_wireless_adb",
  "pair_and_connect_adb_device",
  "link_usb_to_wireless",
  "get_devices",
  "restart_adb_server",
  "run_adb_diagnostic",
  "start_campaign",
  "pause_campaign",
  "stop_campaign",
  "update_campaign",
  "get_campaigns",
  "get_campaign_contacts",
  "retry_failed_campaign_contacts",
  "reset_campaign_contacts",
  "rewrite_message_ai",
  "get_ai_config",
  "save_ai_config",
]);

export async function api<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureConfig();

  // Proteção contra duplicação de campos que usam alias no Serde (ex: useAi e useAI)
  if (args && typeof args === "object") {
    if ("campaign" in args && args.campaign && typeof args.campaign === "object") {
      const camp = { ...(args.campaign as Record<string, unknown>) };
      if ("useAI" in camp || "useAi" in camp) {
        camp.useAi = Boolean(camp.useAi ?? camp.useAI);
        delete camp.useAI;
      }
      args.campaign = camp;
    }
    if ("config" in args && args.config && typeof args.config === "object") {
      const cfg = { ...(args.config as Record<string, unknown>) };
      if ("api_key" in cfg && "apiKey" in cfg) delete cfg.api_key;
      if ("system_prompt" in cfg && "systemPrompt" in cfg) delete cfg.system_prompt;
      if ("company_id" in cfg && "companyId" in cfg) delete cfg.company_id;
      args.config = cfg;
    }
  }

  // Executa comandos diretamente via IPC nativo local para máxima velocidade (0ms)
  try {
    return await invoke<T>(cmd, { token: _token || "default-token", ...args });
  } catch (err: any) {
    const errMsg = typeof err === "string" ? err : err?.message || "";
    if (cmd !== "login" && errMsg.includes("token de sessão inválido")) {
      window.dispatchEvent(new Event("esfera:session-expired"));
    }
    const isCommandNotFound = errMsg.toLowerCase().includes("command") && errMsg.toLowerCase().includes("not found");

    // Apenas tenta rotear via Hub se for modo master E o comando não foi encontrado no binário local
    if (_mode === "master" && isCommandNotFound && !LOCAL_ONLY_COMMANDS.has(cmd)) {
      const companyId = (args.companyId ?? args.company_id ?? 1) as number;
      try {
        return await invoke<T>("hub_invoke", {
          token: _token || "default-token",
          cmd,
          args: { ...args },
          companyId,
        });
      } catch (hubErr) {
        throw err;
      }
    }
    throw err;
  }
}

export interface HubCredentials {
  hubAddress: string;
  hubToken: string;
  companyId: number;
  companyName: string;
  role: string;
}

export async function getHubCredentials(): Promise<HubCredentials> {
  return await invoke<HubCredentials>("get_hub_credentials", { token: _token || "default-token" });
}

export async function connectHub(): Promise<void> {
  await invoke("connect_hub", { token: _token || "default-token" });
}
