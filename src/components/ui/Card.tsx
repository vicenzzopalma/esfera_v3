// ============================================================
// Esfera v3 — Componente Card
// Container com glassmorphism e variantes
// ============================================================

import type { ReactNode, HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hover?: boolean;
  glow?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingClasses: Record<string, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
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
      className={`rounded-2xl border bg-card border-border
        ${hover ? "hover:border-violet-500/30 hover:-translate-y-1 hover:shadow-xl hover:shadow-violet-500/5 cursor-pointer" : ""}
        ${glow ? "shadow-lg shadow-violet-500/10" : ""}
        transition-all duration-300
        ${paddingClasses[padding]}
        ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
