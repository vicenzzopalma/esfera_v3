// Card de métrica (KPI): rótulo, valor, ícone opcional e dica.
import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneIcon: Record<Tone, string> = {
  neutral: "text-secondary bg-secondary",
  accent: "text-[var(--color-accent-light)] bg-[var(--color-accent-glow)]",
  success: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  warning: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  danger: "text-red-600 dark:text-red-400 bg-red-500/10",
  info: "text-sky-600 dark:text-sky-400 bg-sky-500/10",
};

interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
  onClick?: () => void;
  /** Mostra um esqueleto no lugar do valor enquanto carrega. */
  loading?: boolean;
  title?: string;
}

export default function StatCard({ label, value, icon, hint, tone = "neutral", className = "", onClick, loading = false, title }: StatCardProps) {
  const clickable = Boolean(onClick);
  return (
    <div
      onClick={onClick}
      // Clicável também pelo teclado (Tab + Enter/Espaço).
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      title={title}
      className={`rounded-xl border border-border bg-card p-4 transition-colors ${
        clickable
          ? "cursor-pointer hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          : ""
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[0.75rem] font-medium text-secondary">{label}</span>
        {icon && <span className={`flex h-7 w-7 items-center justify-center rounded-md ${toneIcon[tone]}`}>{icon}</span>}
      </div>
      {loading ? (
        <div className="skeleton mt-2 h-6 w-16" aria-label="Carregando" />
      ) : (
        <div className="mt-2 text-[1.5rem] font-semibold leading-none tracking-tight text-primary tabular-nums">{value}</div>
      )}
      {hint && <div className="mt-1.5 text-[0.75rem] text-tertiary">{hint}</div>}
    </div>
  );
}
