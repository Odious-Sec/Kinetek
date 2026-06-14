/**
 * A tiny in-memory pub/sub log store so the UI can show errors and activity in
 * real time. It's deliberately framework-free (callable from anywhere, incl.
 * non-React modules); React subscribes via `useSyncExternalStore`.
 *
 * Writing an entry is synchronous — it appears in the console instantly — while
 * any slower side effect (the on-disk file write) happens separately/async.
 */
export type LogLevel = "info" | "error";

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  context: string;
  message: string;
}

const MAX_ENTRIES = 500;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Subscribe to changes (returns an unsubscribe fn). For useSyncExternalStore. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Stable snapshot — same reference until the next change. */
export function getSnapshot(): LogEntry[] {
  return entries;
}

/** Append an entry and notify subscribers synchronously. */
export function record(level: LogLevel, context: string, message: string): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    ts: new Date().toISOString(),
    level,
    context,
    message,
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  emit();
  return entry;
}

export function clearLog(): void {
  entries = [];
  emit();
}
