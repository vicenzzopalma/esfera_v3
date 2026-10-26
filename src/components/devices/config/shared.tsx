// Peças compartilhadas das abas de configuração do aparelho.
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function isErrorMsg(text: string) {
  return /^(erro|falha)/i.test(text.trim());
}

// Mensagem de resultado/andamento de uma ação.
export function StatusNote({ text, busy = false }: { text: string | null; busy?: boolean }) {
  if (!text) return null;
  const err = isErrorMsg(text);
  return (
    <div
      role={err ? "alert" : "status"}
      className={`flex items-start gap-2 whitespace-pre-wrap rounded-lg border p-3 text-[0.8125rem] animate-fade-in ${
        err ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-border bg-secondary text-secondary"
      }`}
    >
      {busy && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

// Linha de ação: título + descrição à esquerda, controle à direita.
export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-primary">{title}</p>
        {description && <p className="mt-0.5 text-[0.75rem] text-secondary">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function errText(e: any, fallback: string) {
  return typeof e === "string" ? e : e?.message || fallback;
}
