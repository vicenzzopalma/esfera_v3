// ============================================================
// Esfera v3 — Componente Toggle
// Toggle switch animado para booleanos
// ============================================================

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
}: ToggleProps) {
  const trackSize = size === "sm" ? "w-9 h-5" : "w-11 h-6";
  const thumbSize = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const thumbTranslate = size === "sm"
    ? (checked ? "translate-x-4.5" : "translate-x-0.5")
    : (checked ? "translate-x-5.5" : "translate-x-0.5");

  return (
    <label className={`inline-flex items-center gap-2.5 ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
      <button
        role="switch"
        type="button"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex items-center shrink-0 rounded-full
          transition-colors duration-300 ease-in-out focus:outline-none
          ${trackSize}
          ${checked
            ? "bg-gradient-to-r from-violet-600 to-indigo-600"
            : "bg-slate-600"
          }`}
      >
        <span
          className={`inline-block rounded-full bg-white shadow-lg
            transform transition-transform duration-300 ease-in-out
            ${thumbSize} ${thumbTranslate}`}
        />
      </button>
      {label && (
        <span className="text-sm text-secondary select-none">{label}</span>
      )}
    </label>
  );
}
