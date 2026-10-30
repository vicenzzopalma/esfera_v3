// Menu suspenso simples para ações secundárias.
// Renderizado no <body> com posição fixa: não é cortado por tabelas com rolagem nem por
// cards, e abre para cima quando não cabe embaixo.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    // Rolar a página ou redimensionar fecha o menu (a posição fixa ficaria errada).
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Mede o menu antes da pintura e escolhe abrir para baixo ou para cima.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    const w = menu.offsetWidth;
    const below = window.innerHeight - r.bottom;
    const up = below < h + 8 && r.top > below;
    const top = up ? Math.max(8, r.top - h - 4) : Math.min(r.bottom + 4, Math.max(8, window.innerHeight - h - 8));
    const rawLeft = align === "right" ? r.right - w : r.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [open, align]);

  const visible = items.filter((i) => i === "sep" || !i.hidden);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={iconBtn}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
            className="z-[60] min-w-52 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-card p-1 shadow-[var(--shadow-pop)] animate-scale-in"
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
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                    item.danger ? "text-red-600 dark:text-red-400 hover:bg-red-500/10" : "text-primary hover:bg-hover"
                  }`}
                >
                  {item.icon && <span className={item.danger ? "" : "text-secondary"}>{item.icon}</span>}
                  {item.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
