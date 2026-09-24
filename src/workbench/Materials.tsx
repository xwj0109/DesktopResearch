import { useState } from "react";
import type { ReactNode } from "react";
import type { Material } from "./model";
import { paneBlurbs, paneLabels, type PaneKind } from "./layouts";
import { GraphCanvas } from "./panes/GraphPane";

const keywords = new Set(
  "def return import from as for in if elif else while None True False lambda class with try except raise and or not pass const let function export type interface".split(
    " ",
  ),
);
/** Tiny highlighter for Python/TypeScript-ish source. */
export function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(#.*$|\/\/.*$)|("[^"]*"|'[^']*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)/g;
  let last = 0,
    k = 0,
    afterDef = false;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const [token, comment, string, number, word] = match;
    const cls = comment
      ? "cm"
      : string
        ? "str"
        : number
          ? "numl"
          : word && keywords.has(word)
            ? "kw"
            : afterDef
              ? "fn"
              : "";
    afterDef = word === "def" || word === "function";
    out.push(
      cls ? (
        <span className={cls} key={k++}>
          {token}
        </span>
      ) : (
        token
      ),
    );
    last = at + token.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** Native window without a research client: explain the pane, show nothing fake. */
export function EmptyPane({ kind }: { kind: PaneKind }) {
  return (
    <div className="empty">
      <h2>{`No ${paneLabels[kind].toLowerCase()} loaded`}</h2>
      <p>{paneBlurbs[kind]}</p>
      <p className="note">Research records are not available in this window. No sample evidence is shown.</p>
    </div>
  );
}

/** Explicitly synthetic design-preview content for each pane kind. */
export function PreviewPane({
  kind,
  material,
  portfolio,
}: {
  kind: PaneKind;
  material: Material;
  portfolio: boolean;
}) {
  const [zoom, setZoom] = useState(100);
  const [node, setNode] = useState<string | undefined>(material.nodes[0].id);
  if (kind === "sources")
    return (
      <div className="pane-col">
        <div className="doc-tabs">
          <div className="doc-tab active pinned">
            <button role="tab" aria-selected="true">
              <span className="g">◆</span>
              <span className="name">{material.filename}</span>
            </button>
          </div>
          <span className="spacer" />
          <span className="tag warn" style={{ alignSelf: "center", marginRight: 8 }}>
            {portfolio ? "frozen sample" : "fixture"}
          </span>
        </div>
        <div className="pane-body">
          <article className="paper" style={{ ["--paper-size" as string]: `${(12.5 * zoom) / 100}px`, padding: "16px 18px" }}>
            <div className="eyebrow">{material.eyebrow}</div>
            <h2>{material.title}</h2>
            <p className="byline">{material.author}</p>
            <p className="abstract">{material.abstract}</p>
            {material.sections.map((section, index) => (
              <section className={index === 1 ? "cited" : ""} key={section.title}>
                <h3>{section.title}</h3>
                <p>{section.body}</p>
                {index === 1 && <blockquote>{material.quote}</blockquote>}
              </section>
            ))}
            <footer>
              <span>design fixture · not an empirical paper</span>
              <span>01</span>
            </footer>
          </article>
        </div>
        <div className="pane-status">
          <span>CC0 note · 1 page</span>
          <span className="zoom">
            <button className="icon-btn" onClick={() => setZoom((z) => Math.max(80, z - 10))} disabled={zoom <= 80} aria-label="Decrease note text size">
              −
            </button>
            <span>{zoom}%</span>
            <button className="icon-btn" onClick={() => setZoom((z) => Math.min(140, z + 10))} disabled={zoom >= 140} aria-label="Increase note text size">
              +
            </button>
          </span>
        </div>
      </div>
    );
  if (kind === "graph") {
    const stages = ["data", "feature", "signal", "evaluation"];
    const content = {
      nodes: material.nodes.map((n, i) => ({ id: n.id, label: n.title, stage: stages[i] ?? "evaluation", code: [] })),
      edges: material.nodes.slice(1).map((n, i) => ({ from: material.nodes[i].id, to: n.id, label: "" })),
    };
    const active = material.nodes.find((n) => n.id === node);
    return (
      <div className="pane-body">
        <div className="pane-inner" style={{ gap: 10 }}>
          <p className="notice warn">Concept map fixture · not an execution graph</p>
          <GraphCanvas content={content} positions={{}} selected={node} onSelect={setNode} />
          {active && (
            <section className="block">
              <h3 className="section-title">selected node</h3>
              <strong className="accent">{active.title}</strong>
              <span className="dim">{active.subtitle}</span>
              <p className="note">{active.detail}</p>
            </section>
          )}
        </div>
      </div>
    );
  }
  if (kind === "code")
    return (
      <div className="pane-col">
        <div className="pane-toolbar">
          <span className="title">signal_sketch.py</span>
          <span className="tag warn">illustrative · never executed</span>
        </div>
        <div className="pane-body">
          <pre className="code">
            {material.code.split("\n").map((line, index) => (
              <span className={`ln ${line.trim().startsWith("#") ? "comment" : ""}`} key={index}>
                {line.trim().startsWith("#") ? line : highlight(line)}
                {line ? "" : " "}
              </span>
            ))}
          </pre>
        </div>
      </div>
    );
  return (
    <div className="pane-body">
      <div className="pane-inner">
        <div className="empty" style={{ padding: "8px 0" }}>
          <h2>{paneLabels[kind]}</h2>
          <p>{paneBlurbs[kind]}</p>
          <p className="note">Design preview · no records are connected.</p>
        </div>
        {(kind === "results" || kind === "portfolio" || kind === "conclusion") && (
          <>
            <h3 className="section-title">fixture provenance</h3>
            <dl className="kv">
              {material.evidence.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
