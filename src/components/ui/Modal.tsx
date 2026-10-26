// ============================================================
// Esfera v3 — Modal
// Overlay, header/rodapé discretos, Esc, foco preso e restaurado
// ============================================================

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  description?: string;
}

const sizeClasses: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
  full: "max-w-[calc(100vw-3rem)] h-[calc(100vh-3rem)]",
};

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export default function Modal({ isOpen, onClose, title, children, footer, size = "md", description }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";

    // Foco inicial: só move se o foco ainda não estiver dentro do diálogo
    const t = window.setTimeout(() => {
      const dlg = dialogRef.current;
      if (dlg && !dlg.contains(document.activeElement)) {
        const target = dlg.querySelector<HTMLElement>("input, select, textarea") ?? dlg;
        target.focus();
      }
    }, 0);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
      previouslyFocused?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="absolute inset-0 bg-[var(--color-bg-overlay)] pointer-events-none" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col rounded-xl border
          bg-card border-border-strong shadow-[var(--shadow-pop)] animate-scale-in overflow-hidden outline-none`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-[0.9375rem] font-semibold text-primary leading-tight">{title}</h2>
            {description && <p className="mt-1 text-[0.8125rem] text-secondary">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="-mr-1.5 -mt-1 p-1.5 rounded-lg text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 custom-scrollbar min-h-0">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
