import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

let _token: string | null = null;
let _mode: "local" | "empresa" | "master" = "local";
let _configLoaded = false;

// Carrega config uma vez para saber o mode
async function ensureConfig(): Promise<void> {
  if (_configLoaded) return;
  try {
    const cfg = await invoke<AppConfig>("get_app_config");
    _mode = cfg.mode;
  } catch { /* fallback: local */ }
  _configLoaded = true;
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
]);

export async function api<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureConfig();

  // Executa comandos diretamente via IPC nativo local para máxima velocidade (0ms)
  try {
    return await invoke<T>(cmd, { token: _token || "default-token", ...args });
  } catch (err) {
    // Se o comando falhar no IPC local e for modo master configurado, tenta rotear via Hub (exceto comandos estritamente locais)
    if (_mode === "master" && !LOCAL_ONLY_COMMANDS.has(cmd)) {
      const companyId = (args.companyId ?? args.company_id ?? 1) as number;
      return await invoke<T>("hub_invoke", {
        token: _token || "default-token",
        cmd,
        args: { ...args },
        companyId,
      });
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
