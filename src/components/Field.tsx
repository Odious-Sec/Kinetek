import type { ReactNode } from "react";

/** A labelled form field with an optional hint (shared across dialogs). */
export default function Field({
  label,
  hint,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && (
        <span
          className={`mt-1.5 block text-[11px] ${
            invalid ? "text-rose-400" : "text-slate-500"
          }`}
        >
          {hint}
        </span>
      )}
    </label>
  );
}
