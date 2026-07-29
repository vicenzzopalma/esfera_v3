// ============================================================
// Esfera v3 — Componente Badge
// Badges de status com cores e dot animado
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
  success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  danger: "bg-red-500/15 text-red-400 border-red-500/30",
  info: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  neutral: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  purple: "bg-violet-500/15 text-violet-400 border-violet-500/30",
};

const dotColors: Record<BadgeVariant, string> = {
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
  info: "bg-blue-400",
  neutral: "bg-slate-400",
  purple: "bg-violet-400",
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs
        font-medium border whitespace-nowrap shrink-0 ${variantClasses[variant]} ${className}`}
    >
      {dot && (
        <span className="relative flex h-2 w-2">
          {pulse && (
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-75
                animate-ping ${dotColors[variant]}`}
            />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColors[variant]}`} />
        </span>
      )}
      {children}
    </span>
  );
}
