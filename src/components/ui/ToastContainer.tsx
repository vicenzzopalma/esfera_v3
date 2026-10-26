// ============================================================
// Esfera v3 — ToastContainer
// Pilha de notificações no canto inferior direito
// ============================================================

import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: "success" | "warning" | "danger" | "info";
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

const ICONS = {
  success: { Icon: CheckCircle2, color: "text-emerald-500" },
  warning: { Icon: AlertTriangle, color: "text-amber-500" },
  danger: { Icon: XCircle, color: "text-red-500" },
  info: { Icon: Info, color: "text-sky-500" },
} as const;

export default function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-10 right-5 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none"
      role="region"
      aria-live="polite"
      aria-label="Notificações"
    >
      {toasts.map((t) => {
        const { Icon, color } = ICONS[t.variant] ?? ICONS.info;
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start justify-between gap-3 p-3 rounded-xl border border-border-strong bg-card shadow-[var(--shadow-pop)] animate-fade-in"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <Icon size={16} className={`mt-0.5 shrink-0 ${color}`} />
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium text-primary leading-snug">{t.title}</p>
                {t.description && <p className="text-xs text-secondary mt-0.5 leading-snug">{t.description}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dispensar notificação"
              className="p-1 rounded-md text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
