// ============================================================
// Esfera v3 — Componente Card (Refatorado)
// Container com glassmorphism, suporte a hover glow e transições
// ============================================================

import type { ReactNode, HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hover?: boolean;
  glow?: boolean;
  padding?: "none" | "xs" | "sm" | "md" | "lg";
}

const paddingClasses: Record<string, string> = {
  none: "",
  xs: "p-3",
  sm: "p-4",
  md: "p-5 sm:p-6",
  lg: "p-6 sm:p-8",
};

export default function Card({
  children,
  hover = false,
  glow = false,
  padding = "md",
  className = "",
  ...props
}: CardProps) {
  return (
    <div
      className={`rounded-2xl glass-panel relative overflow-hidden transition-all duration-300 ${
        hover
          ? "hover:border-violet-500/40 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-500/10 cursor-pointer"
          : ""
      } ${glow ? "border-violet-500/30 shadow-lg shadow-violet-500/15" : ""} ${
        paddingClasses[padding]
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
