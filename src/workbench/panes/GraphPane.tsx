import { useEffect, useRef, useState } from "react";
import { versionInput } from "../../platform";
import { fieldLabel } from "../ResearchForm";
import {
  ActionPanel,
  DecisionTag,
  PaneLoading,
  latestDecision,
  useAction,
  useResearch,
} from "../research";

export const graphStages = ["data", "feature", "signal", "risk", "execution", "evaluation"] as const;
const NODE_W = 156,
  NODE_H = 50,
  COL = 196,
  ROW = 84,
  PAD = 24;
export type Pos = Record<string, { x: number; y: number }>;

/** Column-per-stage default placement for nodes without a saved position. */
export function autoLayout(nodes: any[], saved: Pos): Pos {
  const rows: Record<string, number> = {};
  const out: Pos = {};
  for (const n of nodes) {
    if (saved[n.id]) {
      out[n.id] = saved[n.id];
      continue;
    }
    const col = Math.max(0, graphStages.indexOf(n.stage));
    const row = (rows[n.stage] = (rows[n.stage] ?? -1) + 1);
    out[n.id] = { x: PAD + col * COL, y: PAD + row * ROW };
  }
  return out;
}

/** Semantic comparison; positions are not part of the graph and never appear. */
export function graphDiff(base: any | undefined, next: any) {
  const changes: { kind: "added" | "removed" | "changed"; what: string }[] = [];
  if (!base) return changes;
  const bn = new Map<string, any>(base.nodes.map((n: any) => [n.id, n]));
  const nn = new Map<string, any>(next.nodes.map((n: any) => [n.id, n]));
  for (const [id, n] of nn)
    if (!bn.has(id)) changes.push({ kind: "added", what: `node ${n.label}` });
    else if (JSON.stringify(bn.get(id)) !== JSON.stringify(n)) {
      const fields = Object.keys(n).filter(
        (k) => JSON.stringify(n[k]) !== JSON.stringify(bn.get(id)[k]),
      );
      changes.push({ kind: "changed", what: `node ${n.label}: ${fields.map(fieldLabel).join(", ")}` });
    }
  for (const [id, n] of bn) if (!nn.has(id)) changes.push({ kind: "removed", what: `node ${n.label}` });
  const key = (e: any) => `${e.from}→${e.to}:${e.label}`;
  const label = (map: Map<string, any>, id: string) => map.get(id)?.label ?? id.slice(0, 6);
  const be = new Set(base.edges.map(key)),
    ne = new Set(next.edges.map(key));
  for (const e of next.edges)
    if (!be.has(key(e)))
      changes.push({ kind: "added", what: `edge ${label(nn, e.from)} → ${label(nn, e.to)}${e.label ? ` (${e.label})` : ""}` });
  for (const e of base.edges)
    if (!ne.has(key(e)))
      changes.push({ kind: "removed", what: `edge ${label(bn, e.from)} → ${label(bn, e.to)}${e.label ? ` (${e.label})` : ""}` });
  if (JSON.stringify(base.spec) !== JSON.stringify(next.spec))
    changes.push({ kind: "changed", what: "specification reference" });
  return changes;
}

/** SVG canvas. Dragging calls `onMove` (layout only); clicks select. */
export function GraphCanvas({
  content,
  positions,
  selected,
  onSelect,
  onMove,
  onMoveEnd,
  flags = {},
}: {
  content: { nodes: any[]; edges: any[] };
  positions: Pos;
  selected?: string;
  onSelect?: (id: string | undefined) => void;
  onMove?: (id: string, pos: { x: number; y: number }) => void;
  onMoveEnd?: () => void;
  flags?: Record<string, string>;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const pos = autoLayout(content.nodes, positions);
  const width = Math.max(560, ...Object.values(pos).map((p) => p.x + NODE_W + PAD));
  const height = Math.max(240, ...Object.values(pos).map((p) => p.y + NODE_H + PAD));
  const point = (e: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  return (
    <div className="graph canvas">
      <svg
        ref={svg}
        width={width}
        height={height}
        role="application"
        aria-label="Semantic research graph canvas"
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !onMove) return;
          const p = point(e);
          d.moved = true;
          onMove(d.id, {
            x: Math.max(4, Math.round((p.x - d.dx) / 4) * 4),
            y: Math.max(4, Math.round((p.y - d.dy) / 4) * 4),
          });
        }}
        onPointerUp={() => {
          if (drag.current?.moved) onMoveEnd?.();
          drag.current = null;
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect?.(undefined);
        }}
      >
        <defs>
          <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L7,3 z" fill="currentColor" />
          </marker>
        </defs>
        {graphStages.map((stage, i) => (
          <text key={stage} className="lane" x={PAD + i * COL} y={14}>
            {stage}
          </text>
        ))}
        {content.edges.map((e, i) => {
          const a = pos[e.from],
            b = pos[e.to];
          if (!a || !b) return null;
          const x1 = a.x + NODE_W,
            y1 = a.y + NODE_H / 2,
            x2 = b.x,
            y2 = b.y + NODE_H / 2;
          const back = x2 < x1;
          const d = back
            ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${a.y + NODE_H + 40} ${b.x + NODE_W / 2},${b.y + NODE_H + 40} ${b.x + NODE_W / 2},${b.y + NODE_H}`
            : `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2 - 2},${y2}`;
          return (
            <g className="edge" key={i}>
              <path d={d} fill="none" markerEnd="url(#graph-arrow)" />
              {e.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {content.nodes.map((n) => {
          const p = pos[n.id];
          return (
            <g
              key={n.id}
              className={`node ${selected === n.id ? "selected" : ""} ${onMove ? "movable" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              aria-label={`${n.label} · ${n.stage}`}
              aria-pressed={selected === n.id}
              tabIndex={0}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect?.(n.id);
                if (!onMove) return;
                const q = point(e);
                drag.current = { id: n.id, dx: q.x - p.x, dy: q.y - p.y, moved: false };
                svg.current?.setPointerCapture?.(e.pointerId);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect?.(n.id);
                const step = e.shiftKey ? 20 : 4;
                const delta: Record<string, [number, number]> = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                };
                if (onMove && delta[e.key]) {
                  e.preventDefault();
                  onMove(n.id, { x: Math.max(4, p.x + delta[e.key][0]), y: Math.max(4, p.y + delta[e.key][1]) });
                  onMoveEnd?.();
                }
              }}
            >
              <rect width={NODE_W} height={NODE_H} />
              <rect className={`stage-bar s-${n.stage}`} width={3} height={NODE_H} />
              <text x={12} y={20}>
                {String(n.label).slice(0, 20)}
              </text>
              <text className="sub" x={12} y={37}>
                {n.stage}
                {n.code?.length ? ` · λ${n.code.length}` : ""}
              </text>
              {flags[n.id] && (
                <text className="flag" x={NODE_W - 8} y={16} textAnchor="end">
                  {flags[n.id]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const lines = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Design & Code lower-left pane (§5.5). */
export function GraphPane() {
  const scope = useResearch();
  const { busy, run, sendCommand, notices } = useAction();
  const [selected, setSelected] = useState<string>();
  const [base, setBase] = useState<any>();
  const [latestContent, setLatestContent] = useState<any>();
  const [positions, setPositions] = useState<Pos>(() => {
    try {
      return JSON.parse(scope.drafts["graph:layout"] ?? "{}");
    } catch {
      return {};
    }
  });
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const science = scope.view?.science?.state;
  const versions: any[] = (science?.versions ?? []).filter((v: any) => v.kind === "graph");
  const latest = versions.at(-1);
  const specs: any[] = (science?.versions ?? []).filter((v: any) => v.kind === "spec");
  const codeVersions: any[] = (science?.versions ?? []).filter((v: any) => v.kind === "code");
  const draftKey = "code:graph";
  let raw: any;
  try {
    raw = scope.drafts[draftKey] ? JSON.parse(scope.drafts[draftKey]) : undefined;
  } catch {}
  const editing = raw?.nativeDraft === 1 ? raw : undefined;
  const baseRef: { id: string; hash: string } | undefined = editing?.base;

  useEffect(() => {
    if (!latest) return setLatestContent(undefined);
    let alive = true;
    void scope.client
      .read(`/science/versions/${latest.id}/${latest.hash}`)
      .then((d: any) => alive && setLatestContent(d.value.content), () => {});
    return () => {
      alive = false;
    };
  }, [latest?.hash]);
  useEffect(() => {
    if (!baseRef) return setBase(undefined);
    let alive = true;
    void scope.client
      .read(`/science/versions/${baseRef.id}/${baseRef.hash}`)
      .then((d: any) => alive && setBase(d.value.content), () => {});
    return () => {
      alive = false;
    };
  }, [baseRef?.hash]);

  if (!scope.view) return <PaneLoading />;
  const content = editing?.content ?? latestContent;
  const write = (next: any) =>
    scope.setDraft(
      draftKey,
      JSON.stringify({
        nativeDraft: 1,
        content: next,
        id: editing?.id ?? latest?.id,
        base: editing?.base ?? (latest ? { id: latest.id, hash: latest.hash } : undefined),
      }),
    );
  const startNew = () =>
    write({
      spec: specs.length ? { id: specs.at(-1).id, hash: specs.at(-1).hash } : { id: "", hash: "" },
      nodes: [newNode("data", "Price data")],
      edges: [],
    });
  const edit = (fn: (c: any) => any) => write(fn(structuredClone(content)));
  const diff = editing ? graphDiff(base, editing.content) : [];
  const node = content?.nodes.find((n: any) => n.id === selected);
  const latestOf = (id: string) =>
    (science?.versions ?? []).filter((v: any) => v.id === id).at(-1);
  const approvedSpecs = specs.filter((sp) => latestDecision(science, sp)?.startsWith("approv"));
  const newestSpec = approvedSpecs.at(-1);
  const referenced = specs.find((sp) => sp.hash === content?.spec?.hash);
  const staleSpec =
    newestSpec && content?.spec?.hash && newestSpec.hash !== content.spec.hash &&
    (!referenced || specs.indexOf(referenced) < specs.indexOf(newestSpec));
  const flags: Record<string, string> = {};
  for (const n of content?.nodes ?? [])
    if (n.code?.some((c: any) => latestOf(c.version.id)?.hash !== c.version.hash)) flags[n.id] = "⚠";

  return (
    <div className="pane-col">
      <div className="pane-toolbar">
        <span className="title">
          {editing ? (editing.id ? "revising graph" : "new graph") : latest ? `graph v${latest.version}` : "no graph"}
        </span>
        {latest && !editing && <DecisionTag decision={latestDecision(science, latest)} />}
        {editing && (
          <span className={`tag ${diff.length ? "warn" : ""}`}>
            {base ? `${diff.length} semantic change${diff.length === 1 ? "" : "s"}` : "unsaved"}
          </span>
        )}
        <span className="spacer" />
        {content && (
          <button
            className="btn small"
            disabled={!content}
            onClick={() => {
              const n = newNode("feature", "New component");
              edit((c) => ({ ...c, nodes: [...c.nodes, n] }));
              setSelected(n.id);
            }}
          >
            + node
          </button>
        )}
        {content && !editing && (
          <button className="btn small" onClick={() => write(content)}>
            Edit
          </button>
        )}
        {!content && (
          <button className="btn small primary" onClick={startNew}>
            Start graph
          </button>
        )}
        {editing && (
          <>
            <button className="btn small ghost" onClick={() => scope.setDraft(draftKey, "")}>
              Discard
            </button>
            <button
              className="btn small primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const input = versionInput.parse({ kind: "graph", content: editing.content });
                  await sendCommand({
                    type: "version.create",
                    value: input,
                    ...(editing.id ? { id: editing.id } : {}),
                  });
                  scope.setDraft(draftKey, "");
                }, "Graph version saved. Approval and code generation are separate actions.")
              }
            >
              Save graph version
            </button>
          </>
        )}
      </div>
      <div className="pane-body">
        <div className="pane-inner" style={{ gap: 10 }}>
          {notices}
          {staleSpec && (
            <p className="notice warn">
              This graph references spec {referenced ? `v${referenced.version}` : content.spec.hash.slice(0, 8)}; spec v
              {newestSpec.version} has been approved since. The design may be out of date — review before generating code.
            </p>
          )}
          {content ? (
            <GraphCanvas
              content={content}
              positions={positions}
              selected={selected}
              onSelect={setSelected}
              flags={flags}
              onMove={(id, p) => {
                positionsRef.current = { ...positionsRef.current, [id]: p };
                setPositions(positionsRef.current);
              }}
              onMoveEnd={() => scope.setDraft("graph:layout", JSON.stringify(positionsRef.current))}
            />
          ) : (
            <div className="empty" style={{ paddingTop: 20 }}>
              <h2>No design graph yet</h2>
              <p>
                Model components — data, features, signals, risk, execution, evaluation — with
                stable identities, interfaces, assumptions and linked code.
              </p>
            </div>
          )}
          <p className="note">
            Dragging a node (or arrow keys) only moves it on screen and is stored with this view. Changing labels,
            stages, interfaces or edges is a semantic change saved as a new version.
          </p>
          {editing && diff.length > 0 && (
            <details className="fold" open>
              <summary>Semantic diff against v{versions.find((v) => v.hash === baseRef?.hash)?.version ?? "?"}</summary>
              <div className="fold-body">
                {diff.map((c, i) => (
                  <span key={i} className={c.kind === "added" ? "ok" : c.kind === "removed" ? "err" : "warn"}>
                    {c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"} {c.what}
                  </span>
                ))}
              </div>
            </details>
          )}
          {content && (editing ? true : !!node) && (
            <section className="block">
              <h3 className="section-title">{node ? "node" : "graph"}</h3>
              {!node && editing && (
                <label className="fld">
                  Specification (exact version)
                  <select
                    value={`${content.spec?.id}:${content.spec?.hash}`}
                    onChange={(e) => {
                      const [id, hash] = e.target.value.split(":");
                      edit((c) => ({ ...c, spec: { id, hash } }));
                    }}
                  >
                    <option value=":">Select a saved specification</option>
                    {specs.map((s) => (
                      <option key={s.id + s.hash} value={`${s.id}:${s.hash}`}>
                        Spec v{s.version} · {s.hash.slice(0, 8)} · {latestDecision(science, s) ?? "unreviewed"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {node && !editing && (
                <>
                  <dl className="kv">
                    <div><dt>Label</dt><dd>{node.label}</dd></div>
                    <div><dt>Stage</dt><dd>{node.stage}</dd></div>
                    <div><dt>Inputs</dt><dd>{node.inputs.join(", ") || "—"}</dd></div>
                    <div><dt>Outputs</dt><dd>{node.outputs.join(", ") || "—"}</dd></div>
                    <div><dt>Assumptions</dt><dd>{node.assumptions.join("\n") || "—"}</dd></div>
                    <div><dt>Linked code</dt><dd>{node.code.map((c: any) => `${c.symbol} @ ${c.version.hash.slice(0, 8)}${flags[node.id] ? " (code changed since link)" : ""}`).join("\n") || "—"}</dd></div>
                  </dl>
                  <div>
                    <button className="btn small" onClick={() => write(content)}>
                      Edit graph
                    </button>
                  </div>
                </>
              )}
              {node && editing && (
                <NodeInspector
                  key={node.id}
                  node={node}
                  nodes={content.nodes}
                  edges={content.edges}
                  codeVersions={codeVersions}
                  onChange={(next) =>
                    edit((c) => ({ ...c, nodes: c.nodes.map((n: any) => (n.id === node.id ? next : n)) }))
                  }
                  onEdges={(edges) => edit((c) => ({ ...c, edges }))}
                  onDelete={() => {
                    edit((c) => ({
                      ...c,
                      nodes: c.nodes.filter((n: any) => n.id !== node.id),
                      edges: c.edges.filter((e: any) => e.from !== node.id && e.to !== node.id),
                    }));
                    setSelected(undefined);
                  }}
                />
              )}
            </section>
          )}
          <ActionPanel commands={["approval.record"]} title="Approve or reject an exact graph or code version" />
        </div>
      </div>
    </div>
  );
}

function newNode(stage: string, label: string) {
  return {
    id: crypto.randomUUID(),
    label,
    stage,
    inputs: [],
    outputs: [],
    assumptions: [],
    code: [],
    evidence: [],
  };
}

function NodeInspector({
  node,
  nodes,
  edges,
  codeVersions,
  onChange,
  onEdges,
  onDelete,
}: {
  node: any;
  nodes: any[];
  edges: any[];
  codeVersions: any[];
  onChange: (n: any) => void;
  onEdges: (e: any[]) => void;
  onDelete: () => void;
}) {
  const [target, setTarget] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("");
  const [code, setCode] = useState("");
  const [symbol, setSymbol] = useState("");
  const name = (id: string) => nodes.find((n) => n.id === id)?.label ?? id.slice(0, 6);
  return (
    <div className="form">
      <label className="fld">
        Label
        <input value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })} />
      </label>
      <label className="fld">
        Stage
        <select value={node.stage} onChange={(e) => onChange({ ...node, stage: e.target.value })}>
          {graphStages.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="fld">
        Inputs (comma separated)
        <input defaultValue={node.inputs.join(", ")} onBlur={(e) => onChange({ ...node, inputs: lines(e.target.value) })} />
      </label>
      <label className="fld">
        Outputs (comma separated)
        <input defaultValue={node.outputs.join(", ")} onBlur={(e) => onChange({ ...node, outputs: lines(e.target.value) })} />
      </label>
      <label className="fld">
        Assumptions (one per line)
        <textarea
          rows={3}
          defaultValue={node.assumptions.join("\n")}
          onBlur={(e) => onChange({ ...node, assumptions: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
        />
      </label>
      <fieldset>
        <legend>Edges</legend>
        {edges
          .filter((e) => e.from === node.id || e.to === node.id)
          .map((e, i) => (
            <div className="receipt" key={i}>
              <code>
                {name(e.from)} → {name(e.to)}
                {e.label ? ` · ${e.label}` : ""}
              </code>
              <button className="btn small ghost" onClick={() => onEdges(edges.filter((x) => x !== e))}>
                ×
              </button>
            </div>
          ))}
        <div className="array-item">
          <select aria-label="Edge target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">connect to…</option>
            {nodes
              .filter((n) => n.id !== node.id)
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
          </select>
          <input aria-label="Edge label" placeholder="label" value={edgeLabel} onChange={(e) => setEdgeLabel(e.target.value)} />
          <button
            className="btn small"
            disabled={!target}
            onClick={() => {
              onEdges([...edges, { from: node.id, to: target, label: edgeLabel.trim() }]);
              setTarget("");
              setEdgeLabel("");
            }}
          >
            Add
          </button>
        </div>
      </fieldset>
      <fieldset>
        <legend>Linked code</legend>
        {node.code.map((c: any, i: number) => (
          <div className="receipt" key={i}>
            <code>
              {c.symbol} @ {c.version.hash.slice(0, 10)}
            </code>
            <button
              className="btn small ghost"
              onClick={() => onChange({ ...node, code: node.code.filter((_: any, j: number) => j !== i) })}
            >
              ×
            </button>
          </div>
        ))}
        <div className="array-item">
          <select aria-label="Code version" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">code version…</option>
            {codeVersions.map((v) => (
              <option key={v.id + v.hash} value={`${v.id}:${v.hash}`}>
                Code v{v.version} · {v.hash.slice(0, 8)}
              </option>
            ))}
          </select>
          <input aria-label="Symbol" placeholder="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          <button
            className="btn small"
            disabled={!code || !symbol.trim()}
            onClick={() => {
              const [id, hash] = code.split(":");
              onChange({ ...node, code: [...node.code, { version: { id, hash }, symbol: symbol.trim() }] });
              setSymbol("");
            }}
          >
            Link
          </button>
        </div>
      </fieldset>
      <div>
        <button className="btn small danger" onClick={onDelete}>
          Remove node
        </button>
      </div>
    </div>
  );
}
