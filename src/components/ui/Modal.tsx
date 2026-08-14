// ============================================================
// Esfera v3 — Componente Modal
// Modal base com overlay, animações e suporte a Save/Cancel
// ============================================================

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeClasses: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export default function Modal({ isOpen, onClose, title, children, footer, size = "md" }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.addEventListener("keydown", handleEsc);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />

      {/* Modal Content Card */}
      <div
        className={`relative w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col rounded-xl border
          bg-[#121216] border-white/[0.08] shadow-2xl shadow-black/80 animate-scale-in overflow-hidden`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-[#141419] shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100 tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100
              hover:bg-white/[0.06] transition-all cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body (Scrollable) */}
        <div className="px-5 py-4 overflow-y-auto flex-1 custom-scrollbar min-h-0">
          {children}
        </div>

        {/* Footer (Fixed at Bottom of Modal) */}
        {footer && (
          <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-white/[0.06] bg-[#141419] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
