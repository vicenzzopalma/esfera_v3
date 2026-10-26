// Console de eventos do disparo, legível e com rolagem automática.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Terminal } from "lucide-react";

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogLine {
  id: number;
  time: string;
  level: LogLevel;
  text: string;
  delayMs?: number;
}

const levelStyle: Record<LogLevel, { dot: string; label: string }> = {
  info: { dot: "bg-sky-500", label: "Info" },
  success: { dot: "bg-emerald-500", label: "OK" },
  warning: { dot: "bg-amber-500", label: "Aviso" },
  error: { dot: "bg-red-500", label: "Erro" },
};

export interface ProgressPayload {
  campaign_id: number;
  campaign_name?: string;
  sent_count?: number;
  total_contacts?: number;
  last_contact_phone?: string;
  delay_used_ms?: number;
  status: string;
}

// Traduz o evento do motor de disparo para uma linha legível.
export function describeProgress(p: ProgressPayload): { level: LogLevel; text: string } {
  const phone = p.last_contact_phone ? ` ${p.last_contact_phone}` : "";
  const next = p.delay_used_ms ? ` · próximo envio em ~${Math.round(p.delay_used_ms / 1000)}s` : "";
  switch (p.status) {
    case "running":
      return { level: "success", text: `Contato processado${phone}${next}` };
    case "send_error":
      return { level: "error", text: `Falha ao enviar para${phone || " o contato"}${next}` };
    case "waiting_device":
      return { level: "warning", text: "Nenhum aparelho selecionado está online. Aguardando conexão." };
    case "completed":
      return { level: "info", text: "Campanha concluída: não há mais contatos pendentes." };
    default:
      if (p.status.startsWith("IA aviso")) return { level: "warning", text: `${p.status}${phone ? ` (${phone.trim()})` : ""}` };
      return { level: "info", text: p.status };
  }
}

export default function LogConsole({ lines, onClear }: { lines: LogLine[]; onClear?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-tertiary" />
          <h3 className="text-sm font-semibold text-primary">Atividade ao vivo</h3>
          <span className="text-[0.75rem] text-tertiary">{lines.length ? `${lines.length} eventos` : ""}</span>
        </div>
        <div className="flex items-center gap-1">
          {!follow && lines.length > 0 && (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.75rem] text-secondary hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
            >
              <ArrowDown size={12} /> Ir para o fim
            </button>
          )}
          {onClear && lines.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-2 py-1 text-[0.75rem] text-secondary hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
            >
              Limpar
            </button>
          )}
        </div>
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        className="h-64 overflow-y-auto bg-secondary px-4 py-3 font-mono text-[0.75rem] leading-6 custom-scrollbar"
      >
        {lines.length === 0 ? (
          <p className="font-sans text-[0.8125rem] text-tertiary">
            Nenhum evento nesta sessão. Ao iniciar o disparo, cada envio aparece aqui em tempo real.
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="flex items-start gap-3">
              <span className="shrink-0 tabular-nums text-tertiary">{l.time}</span>
              <span className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${levelStyle[l.level].dot}`} aria-label={levelStyle[l.level].label} />
              <span
                className={`min-w-0 break-words ${
                  l.level === "error" ? "text-red-600 dark:text-red-400" : l.level === "warning" ? "text-amber-700 dark:text-amber-300" : "text-primary"
                }`}
              >
                {l.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
