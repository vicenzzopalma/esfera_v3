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

  // Executa comandos diretamente via IPC nativo local para máxima velocidade (0ms)
  try {
    return await invoke<T>(cmd, { token: _token || "default-token", ...args });
  } catch (err) {
    // Se o comando falhar no IPC local e for modo master configurado, tenta rotear via Hub
    if (_mode === "master") {
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
