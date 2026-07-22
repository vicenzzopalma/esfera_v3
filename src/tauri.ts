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

export async function api<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureConfig();

  // Master mode: roteia comandos via Hub (exceto login/logout/config)
  if (_mode === "master" && !["login", "logout", "get_app_config", "save_app_config", "hub_invoke"].includes(cmd)) {
    const companyId = (args.companyId ?? args.company_id ?? 0) as number;
    return invoke<T>("hub_invoke", {
      token: _token,
      cmd,
      args: { ...args },
      companyId,
    });
  }

  // Modo normal: chama comando local com token
  return invoke<T>(cmd, { token: _token, ...args });
}
