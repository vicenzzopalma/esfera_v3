// Intervalo entre mensagens, com explicação em linguagem humana.
import { Clock } from "lucide-react";
import Field from "../../components/ui/Field";
import { formatDuration } from "./shared";

export function delayError(min: number, max: number): string | undefined {
  if (!min || min < 1) return "O intervalo mínimo precisa ser de pelo menos 1 segundo.";
  if (max < min) return "O intervalo máximo não pode ser menor que o mínimo.";
  return undefined;
}

const PRESETS = [
  { label: "Cauteloso", min: 60, max: 180 },
  { label: "Equilibrado", min: 30, max: 90 },
  { label: "Rápido", min: 15, max: 45 },
];

export default function DelayFields({
  min,
  max,
  onChange,
  pendingContacts,
}: {
  min: number;
  max: number;
  onChange: (patch: { delayMin?: number; delayMax?: number }) => void;
  pendingContacts?: number;
}) {
  const err = delayError(min, max);
  const avg = (min + max) / 2;
  const perHour = avg > 0 ? Math.round(3600 / avg) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = p.min === min && p.max === max;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ delayMin: p.min, delayMax: p.max })}
              className={`rounded-lg border px-3 py-1.5 text-[0.8125rem] transition-colors cursor-pointer ${
                active
                  ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                  : "border-border text-secondary hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {p.label} <span className="text-tertiary tabular-nums">{p.min}–{p.max}s</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Mínimo (segundos)" htmlFor="cmp-delay-min">
          <input
            id="cmp-delay-min"
            type="number"
            min={1}
            value={min}
            onChange={(e) => onChange({ delayMin: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
          />
        </Field>
        <Field label="Máximo (segundos)" htmlFor="cmp-delay-max">
          <input
            id="cmp-delay-max"
            type="number"
            min={1}
            value={max}
            onChange={(e) => onChange({ delayMax: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
          />
        </Field>
      </div>

      {err ? (
        <p className="text-[0.75rem] text-red-500 dark:text-red-400">{err}</p>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-[var(--color-bg-hover)] px-3.5 py-3 text-[0.8125rem] text-secondary">
          <Clock size={15} className="mt-0.5 shrink-0 text-tertiary" />
          <p>
            Cada mensagem sai {min === max ? <>a cada <strong className="text-primary">{min}s</strong></> : <>entre <strong className="text-primary">{min}s</strong> e <strong className="text-primary">{max}s</strong> depois da anterior</>}
            , em intervalos aleatórios. Isso dá cerca de <strong className="text-primary tabular-nums">{perHour}</strong> mensagens por hora
            {pendingContacts ? <>, ou aproximadamente <strong className="text-primary">{formatDuration(pendingContacts * avg)}</strong> para os {pendingContacts} contatos pendentes</> : null}.
          </p>
        </div>
      )}
    </div>
  );
}
