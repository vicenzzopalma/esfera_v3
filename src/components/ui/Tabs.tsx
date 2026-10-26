// Abas horizontais (sublinhado) e controle segmentado (pílulas).
import type { ReactNode } from "react";

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
}

export function Tabs<T extends string>({ items, value, onChange, className = "" }: TabsProps<T>) {
  return (
    <div role="tablist" className={`flex items-center gap-1 overflow-x-auto border-b border-border ${className}`}>
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
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

export function SegmentedControl<T extends string>({ items, value, onChange, className = "" }: TabsProps<T>) {
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-lg border border-border bg-secondary p-0.5 ${className}`}>
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[0.75rem] font-medium transition-colors cursor-pointer disabled:opacity-40 ${
              active ? "bg-card text-primary shadow-sm" : "text-secondary hover:text-primary"
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
