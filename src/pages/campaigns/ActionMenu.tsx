// Menu de "mais ações" (popover simples, fecha ao clicar fora ou Esc).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export default function ActionMenu({ actions, label = "Mais ações" }: { actions: MenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] cursor-pointer"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg animate-fade-in"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              type="button"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.8125rem] transition-colors disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer ${
                a.danger ? "text-red-500 hover:bg-red-500/10 dark:text-red-400" : "text-primary hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              {a.icon && <span className={a.danger ? "" : "text-tertiary"}>{a.icon}</span>}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
