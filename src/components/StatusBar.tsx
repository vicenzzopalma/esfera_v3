// ============================================================
// Esfera v3 — StatusBar
// Barra inferior: janela de envio, empresa, campanhas em andamento,
// aparelhos online (ao vivo) e versão do aplicativo
// ============================================================

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { useAuth } from "../context/AuthContext";
import { api, isTauri } from "../tauri";
import type { Campaign, Company, Device } from "../types";
import { Building2, Clock, Megaphone, Smartphone } from "lucide-react";

// Mesmo critério da tela de Aparelhos e do Dashboard.
const ONLINE_STATUSES = new Set<string>(["online", "online_agent"]);

// Mesma regra do disparo (hora local deste computador): seg–sex 8h–20h, sáb 8h–14h, domingo fechado.
const DAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const WINDOW_TOOLTIP =
  "Janela de envio (horário deste computador): segunda a sexta das 8h às 20h e sábado das 8h às 14h. Fora dela as campanhas esperam e retomam sozinhas.";

function windowHours(day: number): [number, number] | null {
  if (day === 0) return null;
  if (day === 6) return [8, 14];
  return [8, 20];
}

function sendWindowState(now: Date): { open: boolean; label: string } {
  const day = now.getDay();
  const hour = now.getHours();
  const today = windowHours(day);
  if (today && hour >= today[0] && hour < today[1]) {
    return { open: true, label: `Janela de envio aberta até ${today[1]}h` };
  }
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    const hours = windowHours(d);
    if (!hours) continue;
    if (i === 0 && hour >= hours[0]) continue; // a janela de hoje já fechou
    const when = i === 0 ? "hoje" : i === 1 ? "amanhã" : DAY_NAMES[d];
    return { open: false, label: `Janela de envio fechada · abre ${when} às ${hours[0]}h` };
  }
  return { open: false, label: "Janela de envio fechada" };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Atualiza as consultas do rodapé quando o backend avisa (com intervalo mínimo entre recargas).
function useTauriRefresh(eventName: string, queryKey: readonly unknown[], minGapMs: number, enabled: boolean) {
  const queryClient = useQueryClient();
  const keyString = JSON.stringify(queryKey);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const key = JSON.parse(keyString) as unknown[];
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let last = 0;
    let timer: number | undefined;
    const refresh = () => {
      last = Date.now();
      queryClient.invalidateQueries({ queryKey: key });
    };
    listen(eventName, () => {
      const wait = minGapMs - (Date.now() - last);
      if (wait <= 0) refresh();
      else if (timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          refresh();
        }, wait);
      }
    })
      .then((fn) => {
        // Se o efeito já foi desfeito antes do listen resolver, remove na hora (sem ouvinte duplicado).
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [eventName, keyString, minGapMs, enabled, queryClient]);
}

export default function StatusBar() {
  const { user, selectedCompanyId } = useAuth();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [version, setVersion] = useState<string | null>(null);

  const companyId = selectedCompanyId ?? 0;
  const canSeeCampaigns = user?.role === "master" || user?.role === "gestor";

  // Mesmas chaves do useQueries.ts: o cache é compartilhado com as telas (sem chamadas repetidas).
  const companiesQuery = useQuery({
    queryKey: ["companies"],
    queryFn: () => api<Company[]>("get_companies"),
    staleTime: 60_000,
    enabled: selectedCompanyId !== null,
  });
  const devicesQuery = useQuery({
    queryKey: ["devices", companyId],
    queryFn: () => api<Device[]>("get_devices", { companyId }),
    enabled: selectedCompanyId !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const campaignsQuery = useQuery({
    queryKey: ["campaigns", companyId],
    queryFn: () => api<Campaign[]>("get_campaigns", { companyId }),
    enabled: selectedCompanyId !== null && canSeeCampaigns,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  useTauriRefresh("device-updated", ["devices"], 5_000, selectedCompanyId !== null);
  useTauriRefresh("campaign-progress", ["campaigns", companyId], 10_000, selectedCompanyId !== null && canSeeCampaigns);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const company = (companiesQuery.data || []).find((c) => c.id === selectedCompanyId) || null;
  const devices = devicesQuery.data || [];
  const onlineCount = devices.filter((d) => ONLINE_STATUSES.has(d.status)).length;
  const runningCount = (campaignsQuery.data || []).filter((c) => c.status === "running").length;
  const sendWindow = sendWindowState(now);

  return (
    <footer className="statusbar-panel fixed bottom-0 right-0 h-7 z-30 bg-sidebar border-t border-border flex items-center justify-between gap-4 px-4 text-xs text-tertiary select-none">
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0" title={WINDOW_TOOLTIP}>
          <Clock size={12} className={`shrink-0 ${sendWindow.open ? "text-emerald-500" : "text-amber-500"}`} />
          <span className={`truncate ${sendWindow.open ? "" : "text-amber-700 dark:text-amber-400"}`}>{sendWindow.label}</span>
        </div>

        {company && (
          <div className="hidden md:flex items-center gap-1.5 min-w-0">
            <Building2 size={12} className="shrink-0" />
            <span className="truncate max-w-[200px]">{company.name}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        {canSeeCampaigns && runningCount > 0 && (
          <button
            type="button"
            onClick={() => navigate("/campaigns")}
            title="Ver campanhas"
            className="flex items-center gap-1.5 tabular-nums hover:text-primary transition-colors cursor-pointer"
          >
            <Megaphone size={12} className="text-[var(--color-accent-light)]" />
            <span>
              {runningCount} {runningCount === 1 ? "campanha em andamento" : "campanhas em andamento"}
            </span>
          </button>
        )}
        {selectedCompanyId !== null && (
          <button
            type="button"
            onClick={() => navigate("/devices")}
            title={devicesQuery.isError ? "Não foi possível atualizar a lista de aparelhos" : "Ver aparelhos"}
            className="flex items-center gap-1.5 tabular-nums hover:text-primary transition-colors cursor-pointer"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                devicesQuery.isError ? "bg-amber-500" : onlineCount > 0 ? "bg-emerald-500" : "bg-zinc-500"
              }`}
            />
            <Smartphone size={12} className="shrink-0" />
            <span>
              {devicesQuery.isPending ? "Carregando aparelhos…" : `${onlineCount}/${devices.length} online`}
            </span>
          </button>
        )}
        {version && <span className="font-mono">v{version}</span>}
      </div>
    </footer>
  );
}
