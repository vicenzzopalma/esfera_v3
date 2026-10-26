// Menu suspenso simples para ações secundárias.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { iconBtn } from "./deviceUi";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
  disabled?: boolean;
}

export function RowMenu({ items, label = "Mais ações", align = "right" }: { items: (MenuItem | "sep")[]; label?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = items.filter((i) => i === "sep" || !i.hidden);

  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={iconBtn}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full z-50 mt-1 min-w-52 rounded-xl border border-border bg-card p-1 shadow-lg animate-scale-in ${align === "right" ? "right-0" : "left-0"}`}
        >
          {visible.map((item, idx) =>
            item === "sep" ? (
              <div key={`s${idx}`} className="my-1 border-t border-border" />
            ) : (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors cursor-pointer disabled:opacity-50 ${
                  item.danger ? "text-red-500 hover:bg-red-500/10" : "text-primary hover:bg-secondary"
                }`}
              >
                {item.icon && <span className="text-secondary">{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
