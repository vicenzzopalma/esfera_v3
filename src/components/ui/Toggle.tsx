// ============================================================
// Esfera v3 — Toggle
// Switch sóbrio: accent sólido quando ativo
// ============================================================

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Nome para leitores de tela quando não há `label` visível (ex.: "Usar IA nesta campanha"). */
  ariaLabel?: string;
  /** id do texto que já descreve o switch na tela (alternativa ao ariaLabel). */
  ariaLabelledby?: string;
  id?: string;
  title?: string;
}

export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
  ariaLabel,
  ariaLabelledby,
  id,
  title,
}: ToggleProps) {
  const trackSize = size === "sm" ? "w-8 h-[18px]" : "w-10 h-[22px]";
  const thumbSize = size === "sm" ? "h-3.5 w-3.5" : "h-[18px] w-[18px]";
  const thumbTranslate =
    size === "sm"
      ? checked ? "translate-x-[16px]" : "translate-x-[2px]"
      : checked ? "translate-x-[20px]" : "translate-x-[2px]";

  return (
    <label className={`inline-flex items-center gap-2.5 !mb-0 ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`} title={title}>
      <button
        id={id}
        role="switch"
        type="button"
        aria-checked={checked}
        aria-label={ariaLabelledby ? undefined : label || ariaLabel || title}
        aria-labelledby={ariaLabelledby}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex items-center shrink-0 rounded-full transition-colors duration-150
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]
          ${trackSize}
          ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-strong)]"}`}
      >
        <span
          className={`inline-block rounded-full bg-white shadow-sm transform transition-transform duration-150 ${thumbSize} ${thumbTranslate}`}
        />
      </button>
      {label && <span className="text-[0.8125rem] text-secondary select-none">{label}</span>}
    </label>
  );
}
