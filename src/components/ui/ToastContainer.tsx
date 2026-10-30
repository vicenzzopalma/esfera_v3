// ============================================================
// Esfera v3 — ToastContainer
// Pilha de notificações no canto inferior direito.
// Uso em qualquer tela (o container já está montado no App.tsx):
//   import { toast } from "../components/ui/ToastContainer";
//   toast.success("Configuração salva");
//   toast.error("Não foi possível salvar", "Detalhe opcional");
// Substitui window.alert: não trava a janela e segue o tema.
// ============================================================

import { useSyncExternalStore } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

export type ToastVariant = "success" | "warning" | "danger" | "info";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export interface ToastOptions {
  description?: string;
  /** Tempo na tela em ms; 0 = só some ao clicar no X. */
  duration?: number;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

// ---- Fila global de notificações ----

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  danger: 9000,
};
const MAX_VISIBLE = 4;

let toastList: ToastMessage[] = [];
let toastSeq = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, number>();

function emit() {
  listeners.forEach((l) => l());
}

function schedule(id: string, ms: number) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  if (ms > 0) timers.set(id, window.setTimeout(() => dismissToast(id), ms));
}

export function dismissToast(id: string) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  const next = toastList.filter((t) => t.id !== id);
  if (next.length !== toastList.length) {
    toastList = next;
    emit();
  }
}

export function showToast(variant: ToastVariant, title: string, options?: ToastOptions | string): string {
  const opts: ToastOptions = typeof options === "string" ? { description: options } : options ?? {};
  const description = opts.description?.trim() || undefined;
  const duration = opts.duration ?? DEFAULT_DURATION[variant];

  // A mesma mensagem já visível (ex.: erro de uma atualização periódica) só renova o tempo.
  const same = toastList.find((t) => t.variant === variant && t.title === title && t.description === description);
  if (same) {
    schedule(same.id, duration);
    return same.id;
  }

  const id = `toast-${++toastSeq}`;
  let next = [...toastList, { id, title, description, variant }];
  while (next.length > MAX_VISIBLE) {
    const [oldest, ...rest] = next;
    window.clearTimeout(timers.get(oldest.id));
    timers.delete(oldest.id);
    next = rest;
  }
  toastList = next;
  emit();
  schedule(id, duration);
  return id;
}

export const toast = {
  success: (title: string, options?: ToastOptions | string) => showToast("success", title, options),
  error: (title: string, options?: ToastOptions | string) => showToast("danger", title, options),
  warning: (title: string, options?: ToastOptions | string) => showToast("warning", title, options),
  info: (title: string, options?: ToastOptions | string) => showToast("info", title, options),
  dismiss: dismissToast,
};

/** Atalho para componentes: const t = useToast(); t.success("..."). */
export function useToast() {
  return toast;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return toastList;
}

// ---- Container ----

const ICONS = {
  success: { Icon: CheckCircle2, color: "text-emerald-500" },
  warning: { Icon: AlertTriangle, color: "text-amber-500" },
  danger: { Icon: XCircle, color: "text-red-500" },
  info: { Icon: Info, color: "text-sky-500" },
} as const;

/** Sem props mostra a fila global (toast.*); com props funciona como antes (lista controlada). */
export default function ToastContainer({ toasts, onDismiss }: Partial<ToastContainerProps> = {}) {
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const list = toasts ?? live;
  const dismiss = onDismiss ?? dismissToast;

  if (list.length === 0) return null;

  return (
    <div
      className="fixed bottom-10 right-5 z-[60] flex flex-col gap-2 max-w-sm w-[calc(100vw-2.5rem)] pointer-events-none"
      role="region"
      aria-live="polite"
      aria-label="Notificações"
    >
      {list.map((t) => {
        const { Icon, color } = ICONS[t.variant] ?? ICONS.info;
        return (
          <div
            key={t.id}
            role={t.variant === "danger" || t.variant === "warning" ? "alert" : "status"}
            className="pointer-events-auto flex items-start justify-between gap-3 p-3 rounded-xl border border-border-strong bg-card shadow-[var(--shadow-pop)] animate-fade-in"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <Icon size={16} className={`mt-0.5 shrink-0 ${color}`} />
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium text-primary leading-snug break-words">{t.title}</p>
                {t.description && (
                  <p className="text-xs text-secondary mt-0.5 leading-snug break-words whitespace-pre-line">
                    {t.description}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
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
