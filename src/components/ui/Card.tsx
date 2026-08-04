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
  xs: "p-2.5",
  sm: "p-3.5",
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
      className={`rounded-xl bg-[#141418] border border-white/[0.07] relative overflow-hidden transition-all duration-150 ${
        hover
          ? "hover:border-white/[0.15] hover:bg-[#18181d] cursor-pointer"
          : ""
      } ${glow ? "border-[#5E6AD2]/40 shadow-md shadow-[#5E6AD2]/10" : ""} ${
        paddingClasses[padding]
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
