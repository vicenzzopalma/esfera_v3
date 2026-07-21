// ============================================================
// Esfera v3 — Componente de Notificações Toast (ToastContainer.tsx)
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

export default function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col space-y-2.5 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => {
        let border = "border-violet-500/30 bg-slate-900/90 text-violet-300";
        let Icon = Info;

        if (t.variant === "success") {
          border = "border-emerald-500/40 bg-emerald-950/90 text-emerald-300";
          Icon = CheckCircle2;
        } else if (t.variant === "warning") {
          border = "border-amber-500/40 bg-amber-950/90 text-amber-300";
          Icon = AlertTriangle;
        } else if (t.variant === "danger") {
          border = "border-red-500/40 bg-red-950/90 text-red-300";
          Icon = XCircle;
        }

        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start justify-between p-3.5 rounded-2xl border backdrop-blur-md shadow-2xl animate-fade-in ${border}`}
          >
            <div className="flex items-start gap-3">
              <Icon size={18} className="mt-0.5 shrink-0" />
              <div>
                <h5 className="font-bold text-xs text-white">{t.title}</h5>
                {t.description && <p className="text-[11px] opacity-90 mt-0.5 leading-tight">{t.description}</p>}
              </div>
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="p-1 rounded-lg hover:bg-white/10 text-tertiary hover:text-white transition-colors cursor-pointer shrink-0 ml-2"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
