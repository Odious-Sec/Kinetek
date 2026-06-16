import type { Template } from "../../types";
import { API_FRAMEWORKS, DATABASES } from "../../lib/catalog";

/**
 * Shared step after the app is chosen: optionally add an API (pick a framework)
 * and/or a database (pick an engine). Both default to "None".
 */
export default function StackStep({
  apiTemplate,
  setApiTemplate,
  dbEngine,
  setDbEngine,
}: {
  apiTemplate: Template | null;
  setApiTemplate: (t: Template | null) => void;
  dbEngine: string | null;
  setDbEngine: (e: string | null) => void;
}) {
  return (
    <div className="space-y-5 pt-2">
      {/* API */}
      <section>
        <h3 className="text-sm font-semibold text-slate-100">Add an API?</h3>
        <p className="mb-2 text-xs text-slate-500">
          A backend service for your app. It lands in <span className="font-mono">api/</span>.
        </p>
        <div className="flex flex-wrap gap-2">
          <Choice active={apiTemplate === null} glyph="🚫" label="No API" onClick={() => setApiTemplate(null)} />
          {API_FRAMEWORKS.map((t) => (
            <Choice
              key={t.id}
              active={apiTemplate?.id === t.id}
              glyph={t.glyph}
              label={t.name}
              onClick={() => setApiTemplate(t)}
            />
          ))}
        </div>
      </section>

      {/* Database */}
      <section>
        <h3 className="text-sm font-semibold text-slate-100">Add a database?</h3>
        <p className="mb-2 text-xs text-slate-500">
          Scaffolds <span className="font-mono">database/</span> (schema + setup). An in-app
          data viewer is coming later.
        </p>
        <div className="flex flex-wrap gap-2">
          <Choice active={dbEngine === null} glyph="🚫" label="No database" onClick={() => setDbEngine(null)} />
          {DATABASES.map((d) => (
            <Choice
              key={d.id}
              active={dbEngine === d.id}
              glyph={d.glyph}
              label={d.name}
              sub={d.family}
              onClick={() => setDbEngine(d.id)}
            />
          ))}
        </div>
      </section>

      <p className="text-[11px] text-slate-500">
        Add either and your project becomes a folder with{" "}
        <span className="font-mono">app/</span>
        {apiTemplate && (
          <>
            , <span className="font-mono">api/</span>
          </>
        )}
        {dbEngine && (
          <>
            , <span className="font-mono">database/</span>
          </>
        )}{" "}
        inside it. Pick neither to keep it a single app.
      </p>
    </div>
  );
}

function Choice({
  active,
  glyph,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  glyph: string;
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-accent/60 bg-accent/15 text-accent-soft"
          : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
      }`}
    >
      {glyph && <span className="text-base leading-none">{glyph}</span>}
      {label}
      {sub && <span className="rounded bg-surface-base px-1 py-0.5 text-[10px] text-slate-500">{sub}</span>}
    </button>
  );
}
