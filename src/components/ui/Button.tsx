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
  primary: `bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white
    hover:from-violet-500 hover:via-purple-500 hover:to-indigo-500 shadow-xl shadow-violet-600/30
    hover:shadow-violet-600/40 active:scale-[0.98]`,
  secondary: `bg-white/5 text-secondary border border-white/10
    hover:bg-white/10 hover:text-primary hover:border-white/20 active:scale-[0.98]`,
  danger: `bg-red-500/15 text-red-300 border border-red-500/30
    hover:bg-red-500/25 hover:border-red-500/50 active:scale-[0.98]`,
  ghost: `text-secondary hover:text-primary hover:bg-white/5 active:scale-[0.98]`,
  success: `bg-emerald-500/15 text-emerald-300 border border-emerald-500/30
    hover:bg-emerald-500/25 hover:border-emerald-500/50 active:scale-[0.98]`,
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5 rounded-xl font-semibold",
  md: "px-4 py-2 text-xs font-semibold gap-2 rounded-xl",
  lg: "px-6 py-2.5 text-sm font-bold gap-2 rounded-xl",
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
