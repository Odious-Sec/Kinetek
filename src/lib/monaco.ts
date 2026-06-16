/**
 * Monaco setup, imported only by the lazy `CodeEditor` chunk so the (heavy)
 * editor never lands in the startup bundle. We bundle Monaco + its language
 * workers (via Vite `?worker`) and point `@monaco-editor/react` at the bundled
 * copy with `loader.config`, so it works offline inside Tauri (no CDN fetch,
 * which the CSP would block anyway).
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// TS/JS language service config. Monaco only sees the ONE open file (no project,
// no node_modules), so accurate *type/semantic* checking is impossible — it would
// throw false "cannot find module" on every import and mis-parse JSX. We instead:
//   • enable JSX so `.tsx` parses correctly (no bogus "operator '<'" errors), and
//   • run **syntax-only** validation — real, never-false syntax errors, but no
//     semantic noise that needs the whole project. (JSON/CSS/HTML keep their own
//     validation since those are self-contained, and Python/Go are checked by the
//     backend on save.)
for (const langDefaults of [
  monaco.languages.typescript.typescriptDefaults,
  monaco.languages.typescript.javascriptDefaults,
]) {
  langDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    noEmit: true,
  });
  langDefaults.setDiagnosticsOptions({
    noSemanticValidation: true, // skip type/module checks (need the whole project)
    noSyntaxValidation: false, // keep real syntax errors
    onlyVisible: true,
  });
}

// A dark theme matching Kinetek's surface palette.
monaco.editor.defineTheme("kinetek", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0b0d12",
    "editorGutter.background": "#0b0d12",
    "editor.lineHighlightBackground": "#13161d",
    "editorLineNumber.foreground": "#3b4250",
  },
});

loader.config({ monaco });

export { monaco };
