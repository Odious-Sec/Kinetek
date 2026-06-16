import type { ReactNode } from "react";

/**
 * Shared chrome for a dashboard widget: a titled card with an optional header
 * action. Keeping the frame here means each widget only renders its own body.
 */
export default function Widget({
  title,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col rounded-2xl border border-surface-border bg-surface-card p-4 ${className}`}
    >
      <header className="mb-3 flex items-center gap-2">
        {icon && <span className="text-slate-500">{icon}</span>}
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
