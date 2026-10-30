// ============================================================
// Esfera v3 — Button
// Variantes sóbrias, alturas fixas (sm 28 / md 32 / lg 36), foco visível
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

// Hover só com o botão habilitado: desabilitado não "acende" ao passar o mouse.
// O secundário tem superfície própria (antes era igual ao fundo do Card e parecia texto solto).
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-accent-contrast)] border border-transparent enabled:hover:bg-[var(--color-accent-hover)]",
  secondary:
    "bg-[var(--color-bg-button)] text-primary border border-[var(--color-border-button)] enabled:hover:bg-[var(--color-bg-button-hover)] enabled:hover:border-border-strong",
  danger:
    "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/25 enabled:hover:bg-red-500/15 enabled:hover:border-red-500/40",
  ghost: "text-secondary border border-transparent enabled:hover:text-primary enabled:hover:bg-hover",
  success:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25 enabled:hover:bg-emerald-500/15 enabled:hover:border-emerald-500/40",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3 text-[0.8125rem] gap-1.5",
  lg: "h-9 px-4 text-sm gap-2",
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
      className={`inline-flex items-center justify-center font-medium rounded-lg whitespace-nowrap
        transition-colors duration-150 cursor-pointer select-none
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 size={size === "sm" ? 13 : 14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
