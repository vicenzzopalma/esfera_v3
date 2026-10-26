// Campo de formulário: rótulo, dica, erro e o controle (input/select/textarea) como filho.
import type { ReactNode } from "react";

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function Field({ label, hint, error, required, htmlFor, aside, children, className = "" }: FieldProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || aside) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="!mb-0 text-[0.8125rem] font-medium text-primary">
              {label}
              {required && <span className="ml-0.5 text-red-500">*</span>}
            </label>
          )}
          {aside && <div className="text-[0.75rem] text-tertiary">{aside}</div>}
        </div>
      )}
      {children}
      {error ? (
        <p className="text-[0.75rem] text-red-500">{error}</p>
      ) : hint ? (
        <p className="text-[0.75rem] text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

// Seção de formulário com título e descrição, para agrupar campos.
export function FormSection({ title, description, children, className = "" }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`space-y-4 ${className}`}>
      <div>
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        {description && <p className="mt-0.5 text-[0.8125rem] text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
