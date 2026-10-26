// Indicador de etapas do assistente de campanha.
import { Check } from "lucide-react";

export interface StepDef<T extends string> {
  id: T;
  label: string;
  optional?: boolean;
}

export default function Stepper<T extends string>({
  steps,
  current,
  reachable,
  onSelect,
  invalid = [],
}: {
  steps: StepDef<T>[];
  current: T;
  reachable: (id: T, index: number) => boolean;
  onSelect: (id: T) => void;
  invalid?: T[];
}) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Etapas">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const active = s.id === current;
        const canGo = reachable(s.id, i);
        const hasError = invalid.includes(s.id);
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              disabled={!canGo}
              onClick={() => onSelect(s.id)}
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-[var(--color-bg-hover)] disabled:cursor-default cursor-pointer`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.75rem] font-semibold tabular-nums ${
                  hasError
                    ? "border-red-500/50 bg-red-500/10 text-red-500 dark:text-red-400"
                    : active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                    : done
                    ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                    : "border-border bg-secondary text-tertiary"
                }`}
              >
                {done && !hasError ? <Check size={13} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-[0.8125rem] font-medium ${active ? "text-primary" : "text-secondary"}`}>{s.label}</span>
                {s.optional && <span className="block text-[0.6875rem] text-tertiary">Opcional</span>}
              </span>
            </button>
            {i < steps.length - 1 && <span className={`h-px min-w-3 flex-1 ${done ? "bg-[var(--color-border-accent)]" : "bg-[var(--color-border)]"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
