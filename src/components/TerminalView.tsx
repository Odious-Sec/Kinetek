import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import {
  homeDir,
  isTauri,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
} from "../lib/tauri";

/**
 * A real interactive terminal inside Kinetek, backed by a PTY (portable-pty) on
 * the Rust side and rendered with xterm.js. Runs your actual shell locally, so
 * you can install/set up tools (e.g. the Claude Code CLI) without leaving the
 * app. Lazy-loaded so xterm isn't in the startup bundle.
 */
export default function TerminalView({ cwd }: { cwd: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current || !isTauri()) return;

    const id = `term-${Date.now().toString(36)}`;
    const term = new Terminal({
      fontFamily: "SFMono-Regular, ui-monospace, Menlo, Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0b0d12",
        foreground: "#cbd5e1",
        cursor: "#818cf8",
        cursorAccent: "#0b0d12",
        selectionBackground: "#334155",
        black: "#0b0d12",
        brightBlack: "#475569",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try {
      fit.fit();
    } catch {
      /* container not sized yet — ResizeObserver will correct */
    }

    let disposed = false;
    const unlistens: Array<() => void> = [];
    const onData = term.onData((d) => {
      void terminalWrite(id, d);
    });

    (async () => {
      const onOut = await listen<{ id: string; bytes: number[] }>("terminal-output", (e) => {
        if (e.payload.id === id && !disposed) term.write(new Uint8Array(e.payload.bytes));
      });
      const onExit = await listen<string>("terminal-exit", (e) => {
        if (e.payload === id && !disposed) {
          term.write("\r\n\x1b[2m[process exited — reopen the Terminal tab to start a new shell]\x1b[0m\r\n");
        }
      });
      unlistens.push(onOut, onExit);
      if (disposed) {
        onOut();
        onExit();
        return;
      }
      const dir = cwd || (await homeDir().catch(() => ""));
      await terminalOpen(id, dir, term.cols || 80, term.rows || 24).catch((err) => {
        term.write(`\r\n\x1b[31m${typeof err === "string" ? err : String(err)}\x1b[0m\r\n`);
      });
      term.focus();
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void terminalResize(id, term.cols, term.rows);
      } catch {
        /* ignore transient sizing errors */
      }
    });
    ro.observe(ref.current);

    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      unlistens.forEach((u) => u());
      void terminalClose(id);
      term.dispose();
    };
  }, [cwd]);

  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-600">
        The terminal is only available in the desktop app.
      </div>
    );
  }

  return <div ref={ref} className="h-full w-full overflow-hidden bg-surface-base p-2" />;
}
