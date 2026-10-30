// ============================================================
// Esfera v3 — Modal
// Overlay, header/rodapé discretos, Esc, foco preso e restaurado.
// Renderiza no <body> (portal) e empilha: só o modal do topo reage a Esc e Tab.
// Também exporta ConfirmDialog e confirmDialog() — substitutos do window.confirm.
// ============================================================

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import Button from "./Button";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  description?: ReactNode;
  /** Fecha ao clicar fora do diálogo (padrão: sim). Desligue em formulários longos. */
  closeOnOverlayClick?: boolean;
  /** Fecha com a tecla Esc (padrão: sim). */
  closeOnEsc?: boolean;
}

const sizeClasses: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
  full: "max-w-[calc(100vw-3rem)] h-[calc(100vh-3rem)]",
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
  "[contenteditable='true']",
]
  .map((s) => `${s}:not([tabindex='-1'])`)
  .join(", ");

// Elementos dentro de abas ocultas (display: none) não recebem foco: ficam fora do ciclo do Tab.
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

// Pilha de modais abertos: com um diálogo de confirmação por cima de outro modal,
// só o do topo trata Esc/Tab, e a rolagem da página só volta quando todos fecham.
const openModals: number[] = [];
let nextModalId = 1;
let savedBodyOverflow = "";

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  description,
  closeOnOverlayClick = true,
  closeOnEsc = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscRef = useRef(closeOnEsc);
  closeOnEscRef.current = closeOnEsc;
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const id = nextModalId++;
    openModals.push(id);
    if (openModals.length === 1) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const isTop = () => openModals[openModals.length - 1] === id;

    const handleKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      const dlg = dialogRef.current;
      if (!dlg) return;
      if (e.key === "Escape") {
        // Um campo ou menu dentro do modal pode tratar o Esc primeiro (preventDefault).
        if (e.defaultPrevented || e.isComposing || !closeOnEscRef.current) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusableIn(dlg);
      if (nodes.length === 0) {
        e.preventDefault();
        dlg.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dlg || !dlg.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dlg.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKey);

    // Foco inicial: só move se o foco ainda não estiver dentro do diálogo.
    // Ordem: [data-autofocus] visível → primeiro campo visível → o próprio diálogo.
    const t = window.setTimeout(() => {
      const dlg = dialogRef.current;
      if (!dlg || dlg.contains(document.activeElement)) return;
      const preferred = dlg.querySelector<HTMLElement>("[data-autofocus]");
      const target =
        (preferred && isVisible(preferred) ? preferred : null) ??
        Array.from(
          dlg.querySelectorAll<HTMLElement>(
            "input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled])",
          ),
        ).find(isVisible) ??
        dlg;
      target.focus();
    }, 0);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", handleKey);
      const idx = openModals.indexOf(id);
      if (idx >= 0) openModals.splice(idx, 1);
      if (openModals.length === 0) document.body.style.overflow = savedBodyOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const dialog = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in"
      onMouseDown={(e) => {
        if (closeOnOverlayClick && e.target === overlayRef.current) onClose();
      }}
    >
      <div className="absolute inset-0 bg-[var(--color-bg-overlay)] pointer-events-none" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col rounded-xl border
          bg-card border-border-strong shadow-[var(--shadow-pop)] animate-scale-in overflow-hidden outline-none`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[0.9375rem] font-semibold text-primary leading-tight">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[0.8125rem] text-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            title="Fechar (Esc)"
            className="-mr-1.5 -mt-1 p-1.5 rounded-lg text-tertiary hover:text-primary hover:bg-hover transition-colors cursor-pointer shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 custom-scrollbar min-h-0">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // Portal no <body>: o modal não fica preso ao empilhamento (z-index/transform) da página que o abriu.
  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}

// ============================================================
// ConfirmDialog — confirmação explícita (ações perigosas usam danger)
// ============================================================

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Ação destrutiva: botão vermelho e foco inicial em "Cancelar". */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const close = () => {
    if (!loading) onClose();
  };
  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={title}
      size="sm"
      closeOnOverlayClick={!loading}
      closeOnEsc={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={loading} data-autofocus={danger ? true : undefined}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
            data-autofocus={danger ? undefined : true}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children && <div className="text-[0.8125rem] leading-relaxed text-secondary">{children}</div>}
    </Modal>
  );
}

// ============================================================
// confirmDialog() — versão em promessa, para trocar `if (!confirm(...)) return;` por
// `if (!(await confirmDialog({ title, message, confirmLabel, danger: true }))) return;`
// Precisa do <ConfirmHost /> montado (App.tsx); sem ele, cai no window.confirm.
// ============================================================

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const confirmQueue: ConfirmRequest[] = [];
let confirmSeq = 0;
let notifyConfirmHost: (() => void) | null = null;

export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === "string" ? { title: "Confirmar", message: options } : options;
  if (!notifyConfirmHost) {
    const text = [opts.title, typeof opts.message === "string" ? opts.message : ""].filter(Boolean).join("\n\n");
    return Promise.resolve(window.confirm(text));
  }
  return new Promise<boolean>((resolve) => {
    confirmQueue.push({ ...opts, id: ++confirmSeq, resolve });
    notifyConfirmHost?.();
  });
}

export function ConfirmHost() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    notifyConfirmHost = () => setVersion((v) => v + 1);
    if (confirmQueue.length > 0) setVersion((v) => v + 1);
    return () => {
      notifyConfirmHost = null;
    };
  }, []);

  const current = confirmQueue[0];
  if (!current) return null;

  const settle = (ok: boolean) => {
    const req = confirmQueue.shift();
    req?.resolve(ok);
    setVersion((v) => v + 1);
  };

  return (
    <ConfirmDialog
      key={current.id}
      isOpen
      title={current.title}
      confirmLabel={current.confirmLabel}
      cancelLabel={current.cancelLabel}
      danger={current.danger}
      onConfirm={() => settle(true)}
      onClose={() => settle(false)}
    >
      {current.message}
    </ConfirmDialog>
  );
}
