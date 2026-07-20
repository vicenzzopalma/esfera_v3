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
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: `bg-gradient-to-r from-violet-600 to-indigo-600 text-white
    hover:from-violet-500 hover:to-indigo-500 shadow-lg shadow-violet-500/25
    active:shadow-sm`,
  secondary: `bg-white/5 text-secondary border border-border
    hover:bg-white/10 hover:text-primary`,
  danger: `bg-red-500/15 text-red-400 border border-red-500/30
    hover:bg-red-500/25`,
  ghost: `text-secondary hover:text-primary hover:bg-white/5`,
  success: `bg-emerald-500/15 text-emerald-400 border border-emerald-500/30
    hover:bg-emerald-500/25`,
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-6 py-2.5 text-base gap-2",
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
      className={`inline-flex items-center justify-center font-medium rounded-xl
        transition-all duration-200 cursor-pointer
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 size={size === "sm" ? 14 : 16} className="animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
