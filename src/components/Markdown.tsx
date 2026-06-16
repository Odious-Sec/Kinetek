import { Fragment, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";
import { openUrl } from "../lib/tauri";

/**
 * A small, dependency-free Markdown renderer tuned for what Claude Code emits:
 * headings, lists, blockquotes, rules, fenced + inline code (syntax-highlighted
 * via highlight.js), bold, and links. Renders to real React nodes (no raw HTML
 * injection except hljs's own escaped output), so it's safe and on-theme.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

/** Inline formatting: `code`, **bold**, and [text](url). */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={`${keyBase}-${k}`} className="rounded bg-surface-base px-1 py-0.5 font-mono text-[0.85em] text-accent-soft">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={`${keyBase}-${k}`} className="font-semibold text-slate-100">
          {tok.slice(2, -2)}
        </strong>
      );
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(
        <button
          key={`${keyBase}-${k}`}
          onClick={() => openUrl(mm[2])}
          className="text-accent-soft underline decoration-accent/40 hover:decoration-accent-soft"
        >
          {mm[1]}
        </button>
      );
    }
    last = re.lastIndex;
    k++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (handles an unclosed fence while streaming).
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or past EOF)
      blocks.push(
        <pre
          key={key++}
          className="hljs overflow-auto rounded-lg border border-surface-border bg-surface-base p-3 font-mono text-[12px] leading-relaxed"
        >
          <code dangerouslySetInnerHTML={{ __html: highlight(body.join("\n"), lang) }} />
        </pre>
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="border-surface-border" />);
      i++;
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls =
        level <= 1
          ? "text-base font-semibold text-slate-100"
          : level === 2
          ? "text-sm font-semibold text-slate-100"
          : "text-sm font-medium text-slate-200";
      blocks.push(
        <div key={key++} className={`${cls} mt-1`}>
          {renderInline(h[2], `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="border-l-2 border-accent/40 pl-3 text-slate-400">
          {renderInline(quote.join(" "), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // List (consecutive -, *, or 1. items).
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: { ordered: boolean; text: string }[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const ordered = /^\s*\d+\.\s+/.test(lines[i]);
        items.push({ ordered, text: lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "") });
        i++;
      }
      const ordered = items[0].ordered;
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={key++}
          className={`ml-5 space-y-1 ${ordered ? "list-decimal" : "list-disc"} marker:text-slate-600`}
        >
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it.text, `li${key}-${idx}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Paragraph (gather consecutive plain lines).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="leading-relaxed text-slate-300">
        {para.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(l, `p${key}-${idx}`)}
          </Fragment>
        ))}
      </p>
    );
  }

  return <div className="space-y-2.5 text-sm">{blocks}</div>;
}
