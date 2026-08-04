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
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  danger: "bg-red-500/10 text-red-400 border-red-500/20",
  info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  neutral: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  purple: "bg-[#5E6AD2]/10 text-[#828DF7] border-[#5E6AD2]/20",
};

const dotColors: Record<BadgeVariant, string> = {
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
  info: "bg-blue-400",
  neutral: "bg-zinc-400",
  purple: "bg-[#828DF7]",
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
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px]
        font-medium border whitespace-nowrap shrink-0 ${variantClasses[variant]} ${className}`}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && (
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-75
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
