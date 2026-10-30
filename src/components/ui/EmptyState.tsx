// Estado vazio: ícone, título, descrição e ação principal.
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export default function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    // border-strong: a borda tracejada com a cor comum sumia no tema claro.
    <div className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong px-6 py-12 text-center ${className}`}>
      {icon && <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-tertiary">{icon}</div>}
      <p className="text-sm font-medium text-primary">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[0.8125rem] text-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
