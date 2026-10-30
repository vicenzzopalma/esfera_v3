// Abas horizontais (sublinhado) e controle segmentado (pílulas).
import type { KeyboardEvent, ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** Nome do grupo para leitores de tela (ex.: "Seções da campanha"). */
  ariaLabel?: string;
}

// Setas esquerda/direita, Home e End trocam de aba (pulando as desabilitadas).
function handleArrowKeys<T extends string>(e: KeyboardEvent<HTMLElement>, items: TabItem<T>[], value: T, onChange: (id: T) => void) {
  const enabled = items.filter((t) => !t.disabled);
  if (enabled.length === 0) return;
  const idx = enabled.findIndex((t) => t.id === value);
  let next: TabItem<T> | undefined;
  if (e.key === "ArrowRight") next = enabled[(idx + 1) % enabled.length];
  else if (e.key === "ArrowLeft") next = enabled[(idx - 1 + enabled.length) % enabled.length];
  else if (e.key === "Home") next = enabled[0];
  else if (e.key === "End") next = enabled[enabled.length - 1];
  if (!next) return;
  const targetId = next.id;
  e.preventDefault();
  onChange(targetId);
  const container = e.currentTarget;
  window.requestAnimationFrame(() => {
    container.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(targetId)}"]`)?.focus();
  });
}

export function Tabs<T extends string>({ items, value, onChange, className = "", ariaLabel }: TabsProps<T>) {
  // Só a aba ativa entra no Tab; se nenhuma estiver ativa, a primeira habilitada recebe o foco.
  const focusId = items.some((t) => t.id === value && !t.disabled) ? value : items.find((t) => !t.disabled)?.id;
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e) => handleArrowKeys(e, items, value, onChange)}
      className={`flex items-center gap-1 overflow-x-auto border-b border-border ${className}`}
    >
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab-id={t.id}
            aria-selected={active}
            tabIndex={t.id === focusId ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={`relative -mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? "border-[var(--color-accent)] text-primary" : "border-transparent text-secondary hover:text-primary"
            }`}
          >
            {t.icon}
            {t.label}
            {typeof t.count === "number" && (
              <span className={`rounded-full px-1.5 text-[0.6875rem] tabular-nums ${active ? "bg-[var(--color-accent-glow)] text-primary" : "bg-secondary text-tertiary"}`}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<T extends string>({ items, value, onChange, className = "", ariaLabel }: TabsProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      onKeyDown={(e) => handleArrowKeys(e, items, value, onChange)}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-border bg-secondary p-0.5 ${className}`}
    >
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            data-tab-id={t.id}
            aria-pressed={active}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[0.75rem] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? "bg-[var(--color-bg-elevated)] text-primary shadow-sm" : "text-secondary hover:text-primary"
            }`}
          >
            {t.icon}
            {t.label}
            {typeof t.count === "number" && <span className="tabular-nums text-tertiary">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
