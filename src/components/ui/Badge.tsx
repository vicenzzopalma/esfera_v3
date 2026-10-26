// ============================================================
// Esfera v3 — Badge
// Etiqueta de status legível (11px), com ponto opcional
// ============================================================

import type { ReactNode } from "react";

type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral" | "purple";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  danger: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  neutral: "bg-hover text-secondary border-border",
  purple: "bg-[var(--color-accent-glow)] text-[var(--color-accent-light)] border-[var(--color-border-accent)]",
};

const dotColors: Record<BadgeVariant, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-zinc-400",
  purple: "bg-[var(--color-accent-light)]",
};

export default function Badge({
  variant = "neutral",
  children,
  dot = false,
  pulse = false,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] leading-4
        font-medium border whitespace-nowrap shrink-0 ${variantClasses[variant]} ${className}`}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && (
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-60
                animate-ping ${dotColors[variant]}`}
            />
          )}
          <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColors[variant]}`} />
        </span>
      )}
      {children}
    </span>
  );
}
