// ============================================================
// Esfera v3 — Componente Button
// Botão com variantes, loading state e ícones
// ============================================================

import { type ReactNode, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "success";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: `bg-[#5E6AD2] text-white hover:bg-[#4C57C6] shadow-sm shadow-[#5E6AD2]/20 active:scale-[0.98] font-medium`,
  secondary: `bg-white/[0.04] text-zinc-200 border border-white/[0.08] hover:bg-white/[0.08] hover:text-white active:scale-[0.98]`,
  danger: `bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 active:scale-[0.98]`,
  ghost: `text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] active:scale-[0.98]`,
  success: `bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 active:scale-[0.98]`,
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1.5 rounded-md font-medium",
  md: "px-3.5 py-1.5 text-xs font-medium gap-2 rounded-md",
  lg: "px-4.5 py-2 text-sm font-semibold gap-2 rounded-md",
};

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  disabled,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-md
        transition-all duration-150 cursor-pointer select-none
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 size={size === "sm" ? 13 : 15} className="animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
