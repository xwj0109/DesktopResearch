import type { ReactNode } from "react";
import katex from "katex";

/** TeX to safe KaTeX HTML (no trusted commands, never throws). */
function tex(source: string, display: boolean, key: string) {
  const html = katex.renderToString(source, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", output: "html" });
  return display ? (
    <div key={key} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span key={key} className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** Minimal, injection-free Markdown subset for assistant text: fenced code,
 * headings, lists, quotes, rules, inline code and bold. Links render as text
 * because navigation is denied by the desktop shell. Unclosed fences (while
 * streaming) run to the end of the text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Inline math: \(…\) or $…$ (Pandoc rule: no space inside the delimiters,
  // no digit right after the closing $, so "$5 and $10" stays text).
  const pattern = /(`[^`\n]+`|\\\([\s\S]+?\\\)|\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0,
    i = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0],
      at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    if (token.startsWith("`")) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("\\(")) out.push(tex(token.slice(2, -2), false, k));
    else if (token.startsWith("$")) out.push(tex(token.slice(1, -1), false, k));
    else if (token.startsWith("**"))
      out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      out.push(
        <span key={k}>
          {label} <span className="dim">‹{url}›</span>
        </span>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Prose({ text, className = "prose" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Display math: $$ … $$ or \[ … \] (single line or spanning lines).
    const mathOpen = /^\s*(\$\$|\\\[)/.exec(line);
    if (mathOpen) {
      const close = mathOpen[1] === "$$" ? "$$" : "\\]";
      const first = line.trim().slice(2);
      const body: string[] = [];
      if (first.endsWith(close) && first.length >= close.length) {
        body.push(first.slice(0, -close.length));
        i++;
      } else {
        if (first) body.push(first);
        i++;
        while (i < lines.length && !lines[i].trim().endsWith(close)) body.push(lines[i++]);
        if (i < lines.length) body.push(lines[i++].trim().slice(0, -close.length));
      }
      blocks.push(tex(body.join("\n"), true, key));
      continue;
    }
    // GFM table: header row, separator row, body rows.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="table-wrap">
          <table>
            <thead>
              <tr>{head.map((c, n) => <th key={n}>{inline(c, `${key}-h${n}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, m) => (
                <tr key={m}>{r.map((c, n) => <td key={n}>{inline(c, `${key}-${m}-${n}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={key}>{inline(heading[2], key)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(body.join("\n"), key)}</blockquote>);
      continue;
    }
    const bullet = /^\s*[-*+]\s+/,
      ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line),
        marker = isOrdered ? ordered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i]))
        items.push(lines[i++].replace(marker, ""));
      const children = items.map((item, n) => (
        <li key={n}>{inline(item, `${key}-${n}`)}</li>
      ));
      blocks.push(
        isOrdered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // Always consume the first line so an unmatched block marker cannot stall.
    const body: string[] = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\$\$|\\\[)/.test(lines[i])
    )
      body.push(lines[i++]);
    blocks.push(<p key={key}>{inline(body.join("\n"), key)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}
