import type { StageId } from "./model";

/** Working surfaces a stage can show. `pi` is always the upper-left pane. */
export type PaneKind =
  | "pi"
  | "sources"
  | "idea"
  | "spec"
  | "files"
  | "changes"
  | "documents"
  | "snapshots"
  | "feeds"
  | "explorer"
  | "quality"
  | "data"
  | "graph"
  | "code"
  | "runs"
  | "results"
  | "conclusion"
  | "portfolio";
export type SlotId = "a" | "b" | "c";
export type LayoutStage = StageId | "portfolio";

export const paneLabels: Record<PaneKind, string> = {
  pi: "Pi",
  sources: "Sources",
  idea: "Idea",
  spec: "Research spec",
  files: "Files",
  changes: "Changes",
  documents: "Documents",
  snapshots: "Data",
  feeds: "Feeds",
  explorer: "Explorer",
  quality: "Quality",
  data: "Contract",
  graph: "Graph",
  code: "Code",
  runs: "Experiments",
  results: "Results",
  conclusion: "Conclusion",
  portfolio: "Evidence",
};
export const paneGlyphs: Record<PaneKind, string> = {
  pi: "❯",
  sources: "▤",
  idea: "✦",
  spec: "§",
  files: "▭",
  changes: "±",
  documents: "▤",
  snapshots: "▦",
  feeds: "≋",
  explorer: "▦",
  quality: "✓",
  data: "§",
  graph: "◇",
  code: "λ",
  runs: "▶",
  results: "◩",
  conclusion: "✓",
  portfolio: "◈",
};

/** Slot a = upper left, b = lower left (optional), c = right column. */
export interface StageLayout {
  a: PaneKind[];
  b?: PaneKind[];
  c: PaneKind[];
  split: number;
  stack: number;
}

/** Stage pane contracts from the product handover (§5). The Design & Code
 * arrangement — Pi upper left, graph lower left, code right — is fixed. */
export const stageLayouts: Record<LayoutStage, StageLayout> = {
  ideas: { a: ["pi"], c: ["sources", "idea"], split: 0.46, stack: 0.6 },
  literature: { a: ["pi"], c: ["sources"], split: 0.44, stack: 0.6 },
  // One workspace per pursued idea: its Pi on the left, its work on the right.
  research: { a: ["pi"], c: ["files", "changes", "documents", "snapshots", "spec", "sources"], split: 0.4, stack: 0.6 },
  // Production data for the idea in production: live feeds, what they hold, their quality, the contract.
  data: { a: ["pi"], c: ["feeds", "explorer", "quality", "data"], split: 0.4, stack: 0.6 },
  code: { a: ["pi"], b: ["graph"], c: ["code"], split: 0.42, stack: 0.56 },
  backtests: { a: ["pi"], c: ["runs"], split: 0.42, stack: 0.6 },
  results: { a: ["pi"], c: ["results", "conclusion"], split: 0.4, stack: 0.6 },
  portfolio: { a: ["pi"], c: ["portfolio"], split: 0.44, stack: 0.6 },
};

export interface LayoutState {
  split?: number;
  stack?: number;
  tabs?: Partial<Record<SlotId, string>>;
  hidden?: SlotId[];
  zoom?: SlotId | null;
  /** Pane contents after swaps; must be a permutation of the stage default. */
  slots?: Partial<Record<SlotId, string[]>>;
  /** Outer split: left column beside (`row`) or above (`column`) slot c. */
  outer?: "row" | "column";
  /** Inner split of the left column: a above b (`column`) or beside it (`row`). */
  inner?: "row" | "column";
}

export const RATIO_MIN = 0.2,
  RATIO_MAX = 0.8,
  PANE_MIN_PX = 300;
/** Clamp a split ratio so both sides keep `PANE_MIN_PX` when the container
 * size is known, and stay within [RATIO_MIN, RATIO_MAX] regardless. */
export function clampRatio(ratio: number, containerPx?: number): number {
  let min = RATIO_MIN,
    max = RATIO_MAX;
  if (containerPx && containerPx > 0) {
    const px = PANE_MIN_PX / containerPx;
    if (px < 0.5) {
      min = Math.max(min, px);
      max = Math.min(max, 1 - px);
    } else min = max = 0.5;
  }
  return Math.round(Math.min(max, Math.max(min, ratio)) * 1000) / 1000;
}

export function activeTab(
  slot: SlotId,
  layout: StageLayout,
  state: LayoutState | undefined,
): PaneKind | undefined {
  const tabs = layout[slot];
  if (!tabs?.length) return undefined;
  const chosen = state?.tabs?.[slot] as PaneKind | undefined;
  return chosen && tabs.includes(chosen) ? chosen : tabs[0];
}

/** Which slot hosts a pane in a layout, if any. */
export function slotOf(kind: PaneKind, layout: StageLayout): SlotId | undefined {
  return (["a", "b", "c"] as SlotId[]).find((s) => layout[s]?.includes(kind));
}

export const paneBlurbs: Record<PaneKind, string> = {
  pi: "Scoped Pi conversation for this stage.",
  sources: "Read papers, anchor comments to passages and freeze multi-paper review batches.",
  idea: "Hypothesis record: rationale, universe, horizon, falsification and evidence.",
  spec: "The editable research specification: question, assumptions, rules, validation and acceptance.",
  files: "The idea's workspace folder: code, scripts and data, with a viewer.",
  changes: "What changed since the last checkpoint, recording checkpoints, and their history.",
  documents: "Reports, figures, tables, PDFs and notebooks produced in the workspace.",
  snapshots: "Frozen data snapshots every idea reads from data/: fetch public market data, register your own files, preview.",
  feeds: "Production feeds collected by the background service: live exchange streams, scheduled pulls and your own scripts, with the on/off switch.",
  explorer: "A production feed's latest rows, its main series and how to read its partitions in polars.",
  quality: "Frozen partitions per feed: rows, gaps, duplicates, out-of-order, missing bars, late rows and SHA-256.",
  data: "Data contracts, handoffs, feasibility findings and bounded dataset samples.",
  graph: "Component graph with stable identities, interfaces, assumptions and linked code.",
  code: "Editor over versioned source with diffs. Nothing executes here.",
  runs: "Queue reference experiments; inspect exact inputs, status history and logs.",
  results: "Disclosed results: equity and drawdown, interval references and lineage.",
  conclusion: "Interpretation with supporting and contradicting evidence and limitations.",
  portfolio: "Frozen strategy evidence, portfolio analyses and producer feedback.",
};

export type Dir = "left" | "right" | "up" | "down";
export type Tile = "rail" | SlotId;
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const flat = (l: Pick<StageLayout, "a" | "b" | "c">) =>
  [...l.a, ...(l.b ?? []), ...l.c].sort().join(",");

/** Default layout with any saved swaps applied. Invalid saved slot contents
 * (not a permutation of the stage's panes) fall back to the default. */
export function effectiveLayout(def: StageLayout, state: LayoutState | undefined): StageLayout {
  const saved = state?.slots;
  if (!saved) return def;
  const next = {
    ...def,
    a: (saved.a ?? def.a) as PaneKind[],
    b: def.b ? ((saved.b ?? def.b) as PaneKind[]) : undefined,
    c: (saved.c ?? def.c) as PaneKind[],
  };
  const ok = next.a.length > 0 && next.c.length > 0 && (!def.b || (next.b?.length ?? 0) > 0);
  return ok && flat(next) === flat(def) ? next : def;
}
export const piSlot = (layout: StageLayout): SlotId =>
  (["a", "b", "c"] as SlotId[]).find((s) => layout[s]?.includes("pi")) ?? "a";

/** Exchange two slots' panes (and their active tabs), Hyprland `swapwindow`. */
export function swapSlots(def: StageLayout, state: LayoutState, x: SlotId, y: SlotId): LayoutState {
  const l = effectiveLayout(def, state);
  if (x === y || !l[x] || !l[y]) return state;
  return {
    ...state,
    slots: { a: l.a, ...(l.b ? { b: l.b } : {}), c: l.c, [x]: l[y], [y]: l[x] },
    tabs: { ...state.tabs, [x]: state.tabs?.[y], [y]: state.tabs?.[x] },
  };
}

/** Logical tile geometry in unit space (rail to the left of x=0). This mirrors
 * how StageLayout renders, so keyboard focus moves the way the screen looks. */
export function tileRects(layout: StageLayout, state: LayoutState, railOpen: boolean): Partial<Record<Tile, Rect>> {
  const out: Partial<Record<Tile, Rect>> = {};
  if (railOpen) out.rail = { x: -0.25, y: 0, w: 0.25, h: 1 };
  const hidden = state.hidden ?? [];
  if (state.zoom && layout[state.zoom]) {
    out[state.zoom] = { x: 0, y: 0, w: 1, h: 1 };
    return out;
  }
  const a = !hidden.includes("a"),
    b = !!layout.b && !hidden.includes("b"),
    c = !hidden.includes("c");
  const left = a || b;
  const split = state.split ?? layout.split,
    stack = state.stack ?? layout.stack;
  const outerRow = (state.outer ?? "row") === "row",
    innerRow = state.inner === "row";
  const whole = { x: 0, y: 0, w: 1, h: 1 };
  const leftRect = !c ? whole : outerRow ? { x: 0, y: 0, w: split, h: 1 } : { x: 0, y: 0, w: 1, h: split };
  if (c)
    out.c = !left ? whole : outerRow ? { x: split, y: 0, w: 1 - split, h: 1 } : { x: 0, y: split, w: 1, h: 1 - split };
  if (left) {
    const r = leftRect;
    if (a && b) {
      out.a = innerRow ? { ...r, w: r.w * stack } : { ...r, h: r.h * stack };
      out.b = innerRow
        ? { x: r.x + r.w * stack, y: r.y, w: r.w * (1 - stack), h: r.h }
        : { x: r.x, y: r.y + r.h * stack, w: r.w, h: r.h * (1 - stack) };
    } else if (a) out.a = r;
    else out.b = r;
  }
  return out;
}

/** Nearest visible tile in a direction whose edge faces the focused tile. */
export function neighbor(rects: Partial<Record<Tile, Rect>>, from: Tile, dir: Dir): Tile | undefined {
  const f = rects[from];
  if (!f) return undefined;
  const eps = 1e-6;
  let best: Tile | undefined,
    bestScore = Infinity;
  for (const [id, r] of Object.entries(rects) as [Tile, Rect][]) {
    if (id === from) continue;
    const overlapY = Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y);
    const overlapX = Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x);
    let gap: number, overlap: number;
    if (dir === "left") (gap = f.x - (r.x + r.w)), (overlap = overlapY);
    else if (dir === "right") (gap = r.x - (f.x + f.w)), (overlap = overlapY);
    else if (dir === "up") (gap = f.y - (r.y + r.h)), (overlap = overlapX);
    else (gap = r.y - (f.y + f.h)), (overlap = overlapX);
    if (gap < -eps || overlap <= eps) continue;
    const score = gap * 10 - overlap;
    if (score < bestScore) (bestScore = score), (best = id);
  }
  return best;
}

/** Visible tiles in reading order (for ⌃Tab cycling). */
export function tileOrder(rects: Partial<Record<Tile, Rect>>): Tile[] {
  return (Object.entries(rects) as [Tile, Rect][])
    .filter(([id]) => id !== "rail")
    .sort(([, p], [, q]) => p.y - q.y || p.x - q.x)
    .map(([id]) => id);
}

/** Grow (delta > 0) or shrink the focused tile along an axis by moving the
 * split that bounds it, like Hyprland's relative `resizeactive`. */
export function resizeTile(layout: StageLayout, state: LayoutState, tile: SlotId, axis: "x" | "y", delta: number): LayoutState {
  const outerAxis = (state.outer ?? "row") === "row" ? "x" : "y";
  const innerAxis = state.inner === "row" ? "x" : "y";
  const hidden = state.hidden ?? [];
  const bothInner = !!layout.b && !hidden.includes("a") && !hidden.includes("b");
  if (bothInner && tile !== "c" && axis === innerAxis) {
    const stack = state.stack ?? layout.stack;
    return { ...state, stack: clampRatio(stack + (tile === "a" ? delta : -delta)) };
  }
  if (axis === outerAxis && !hidden.includes("c") && !(hidden.includes("a") && (hidden.includes("b") || !layout.b))) {
    const split = state.split ?? layout.split;
    return { ...state, split: clampRatio(split + (tile === "c" ? -delta : delta)) };
  }
  return state;
}
