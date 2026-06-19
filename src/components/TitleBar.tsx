import { GearIcon, SparkIcon } from "./icons";
import { isMac } from "../lib/platform";

/**
 * A slim, draggable top bar. `data-tauri-drag-region` makes the bar move the
 * window on every platform (the canonical Tauri approach); the decorative
 * children are `pointer-events-none` so a drag started anywhere on the bar —
 * including over the logo/title — is captured by the drag region.
 *
 * On macOS it pairs with the "Overlay" titleBarStyle (the traffic lights float
 * over the content), so the logo is inset to clear them and the title is
 * centered. On Windows/Linux the native window controls live in the OS title
 * bar above, so this reads as a clean left-aligned header instead.
 */
export default function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div
      data-tauri-drag-region
      className="drag-region relative flex h-11 shrink-0 items-center border-b border-surface-border bg-surface-base/80 backdrop-blur"
    >
      {/* On macOS, inset past the traffic lights; elsewhere sit at the left. */}
      <div
        className={`pointer-events-none absolute flex items-center gap-2 text-slate-300 ${
          isMac ? "left-20" : "left-3"
        }`}
      >
        <span className="grid h-5 w-5 place-items-center rounded-md bg-accent/20 text-accent-soft">
          <SparkIcon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-slate-200">
          Kinetek
        </span>
      </div>
      {/* Center the tagline only on macOS; on Windows/Linux it sits beside the logo. */}
      <span
        className={`pointer-events-none text-[12px] font-medium text-slate-500 ${
          isMac ? "mx-auto" : "ml-32"
        }`}
      >
        Project Control Center
      </span>
      <button
        onClick={onOpenSettings}
        title="Settings"
        className="no-drag absolute right-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
      >
        <GearIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
