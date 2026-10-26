// ============================================================
// Esfera v3 — Card
// Container limpo: borda 1px, raio xl, sem sombra pesada
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
  md: "p-4 sm:p-5",
  lg: "p-5 sm:p-6",
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
      className={`rounded-xl bg-card border relative transition-colors duration-150 ${
        glow ? "border-accent" : "border-border"
      } ${hover ? "hover:border-border-strong hover:bg-[var(--color-bg-card-hover)] cursor-pointer" : ""} ${
        paddingClasses[padding]
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
