// Cabeçalho padrão de página: título, descrição curta e ações à direita.
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({ title, description, icon, actions, className = "" }: PageHeaderProps) {
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-[1.25rem] font-semibold leading-tight tracking-tight text-primary">{title}</h1>
          {description && <p className="mt-1 text-[0.8125rem] leading-relaxed text-secondary">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
