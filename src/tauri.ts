import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

let _token: string | null = null;
let _mode: "local" | "empresa" | "master" = "local";
let _configLoaded = false;
let _configLoading: Promise<void> | null = null;

/** true dentro do aplicativo desktop (Tauri); false no navegador comum (prévia do Vite). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Texto legível de um erro vindo do backend (string), de um Error ou de um objeto com message.
 * Uso: toast.error("Não foi possível salvar", errorMessage(err)).
 */
export function errorMessage(err: unknown, fallback = "Não foi possível concluir a operação. Tente de novo."): string {
  if (typeof err === "string") return err.trim() || fallback;
  if (err instanceof Error) return err.message.trim() || fallback;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

// Carrega a config (modo local/empresa/master) uma vez por sessão.
// get_app_config exige sessão válida: antes do login não adianta tentar — antes o app tentava
// com o token vazio, falhava e ficava preso no modo "local" até reiniciar.
async function ensureConfig(): Promise<void> {
  if (_configLoaded || !_token) return;
  if (!_configLoading) {
    const tokenAtStart = _token;
    _configLoading = invoke<AppConfig>("get_app_config", { token: tokenAtStart })
      .then((cfg) => {
        if (cfg?.mode) _mode = cfg.mode;
      })
      .catch(() => {
        /* mantém o modo atual */
      })
      .finally(() => {
        if (_token === tokenAtStart) _configLoaded = true;
        _configLoading = null;
      });
  }
  await _configLoading;
}

export function setAppMode(m: "local" | "empresa" | "master") {
  _mode = m;
  _configLoaded = true;
}

export function reloadConfig(): void {
  _configLoaded = false;
}

export function setToken(t: string | null) {
  // Sessão nova: a config passa a ser lida com o token novo.
  if (t !== _token) _configLoaded = false;
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

// Comandos que não devem disparar "sessão expirada" (o próprio login/logout tratam o erro).
const NO_SESSION_EVENT = new Set(["login", "logout"]);

export async function api<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureConfig();

  // Cópia: não altera o objeto de quem chamou.
  const payload: Record<string, unknown> = { ...args };

  // Proteção contra duplicação de campos que usam alias no Serde (ex: useAi e useAI)
  if (payload.campaign && typeof payload.campaign === "object") {
    const camp = { ...(payload.campaign as Record<string, unknown>) };
    if ("useAI" in camp || "useAi" in camp) {
      camp.useAi = Boolean(camp.useAi ?? camp.useAI);
      delete camp.useAI;
    }
    payload.campaign = camp;
  }
  if (payload.config && typeof payload.config === "object") {
    const cfg = { ...(payload.config as Record<string, unknown>) };
    if ("api_key" in cfg && "apiKey" in cfg) delete cfg.api_key;
    if ("system_prompt" in cfg && "systemPrompt" in cfg) delete cfg.system_prompt;
    if ("company_id" in cfg && "companyId" in cfg) delete cfg.company_id;
    payload.config = cfg;
  }

  // Executa comandos diretamente via IPC nativo local para máxima velocidade (0ms)
  try {
    return await invoke<T>(cmd, { token: _token || "default-token", ...payload });
  } catch (err: unknown) {
    const errMsg = errorMessage(err, "");
    if (!NO_SESSION_EVENT.has(cmd) && errMsg.includes("token de sessão inválido")) {
      window.dispatchEvent(new Event("esfera:session-expired"));
    }
    const lower = errMsg.toLowerCase();
    const isCommandNotFound = lower.includes("command") && lower.includes("not found");

    // Apenas tenta rotear via Hub se for modo master E o comando não foi encontrado no binário local
    if (_mode === "master" && isCommandNotFound && !LOCAL_ONLY_COMMANDS.has(cmd)) {
      const companyId = (payload.companyId ?? payload.company_id ?? 1) as number;
      try {
        return await invoke<T>("hub_invoke", {
          token: _token || "default-token",
          cmd,
          args: { ...payload },
          companyId,
        });
      } catch {
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
