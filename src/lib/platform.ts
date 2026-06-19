/**
 * Tiny synchronous OS detection for the webview, so UI can adapt to the host
 * platform (title-bar chrome, modifier-key labels, "reveal in …" wording).
 *
 * We read `navigator.userAgent` rather than pulling in `@tauri-apps/plugin-os`
 * — it's synchronous (usable at render time) and reliable across the three
 * webviews Tauri uses (WKWebView/macOS, WebView2/Windows, WebKitGTK/Linux).
 */
export type OS = "macos" | "windows" | "linux" | "unknown";

function detect(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "unknown";
}

export const OS_NAME: OS = detect();
export const isMac = OS_NAME === "macos";
export const isWindows = OS_NAME === "windows";
export const isLinux = OS_NAME === "linux";

/** The platform's primary modifier-key label (for keyboard-shortcut hints). */
export const modLabel = isMac ? "⌘" : "Ctrl";

/** How to render a keyboard shortcut like Save (⌘S vs Ctrl+S). */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The platform's name for its file manager (for "reveal in …" actions). */
export const fileManagerName = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

/** Verb + target for revealing a path in the OS file manager. */
export const revealLabel = `Reveal in ${fileManagerName}`;
