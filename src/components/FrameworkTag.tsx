export default function FrameworkTag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-surface-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-slate-300">
      {label}
    </span>
  );
}
