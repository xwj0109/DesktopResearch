import { useRef, useState } from "react";
import { PaneVisible } from "./usePoll";
import { useBadge } from "./badges";
import type { CSSProperties, ReactNode } from "react";
import {
  activeTab,
  clampRatio,
  paneLabels,
  type LayoutState,
  type PaneKind,
  type SlotId,
  type StageLayout as Layout,
  type Tile,
} from "./layouts";

export type TileId = Tile;
const DRAG_TYPE = "application/x-pi-research-slot";

/** Split handle. `vertical` handles sit between side-by-side tiles (←/→);
 * `horizontal` ones between stacked tiles (↑/↓). Double-click resets. */
function Gutter({
  orientation,
  ratio,
  label,
  onRatio,
  onReset,
  measure,
}: {
  orientation: "vertical" | "horizontal";
  ratio: number;
  label: string;
  onRatio: (r: number) => void;
  onReset: () => void;
  measure: () => DOMRect | undefined;
}) {
  const vertical = orientation === "vertical";
  return (
    <div
      className={vertical ? "gutter" : "gutter-h"}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const less = vertical ? "ArrowLeft" : "ArrowUp",
          more = vertical ? "ArrowRight" : "ArrowDown";
        const size = measure();
        const px = size ? (vertical ? size.width : size.height) : undefined;
        if (e.key === less || e.key === more) {
          e.preventDefault();
          onRatio(clampRatio(ratio + (e.key === more ? 0.02 : -0.02), px));
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          onRatio(clampRatio(e.key === "Home" ? 0 : 1, px));
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add("dragging");
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const r = measure();
        if (!r) return;
        onRatio(
          vertical
            ? clampRatio((e.clientX - r.left) / r.width, r.width)
            : clampRatio((e.clientY - r.top) / r.height, r.height),
        );
      }}
      onPointerUp={(e) => {
        e.currentTarget.classList.remove("dragging");
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}

/** Stage working area. `layout` is the effective layout (swaps applied):
 * left column holds a (+ optional b), c is the other side of the outer split.
 * Hidden and zoomed-away tiles stay mounted so their state is preserved. */
export function StageLayout({
  layout,
  defaults,
  state,
  onState,
  active,
  onActive,
  onSwap,
  render,
  tileLabel,
}: {
  layout: Layout;
  defaults: Layout;
  state: LayoutState;
  onState: (next: LayoutState) => void;
  active: TileId;
  onActive: (tile: TileId) => void;
  onSwap: (from: SlotId, to: SlotId) => void;
  render: (kind: PaneKind, slot: SlotId) => ReactNode;
  tileLabel: (kind: PaneKind, slot: SlotId) => string;
}) {
  const box = useRef<HTMLDivElement>(null),
    col = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<SlotId | null>(null);
  const hidden = state.hidden ?? [];
  const zoom = state.zoom ?? null;
  const split = state.split ?? layout.split,
    stack = state.stack ?? layout.stack;
  const outerRow = (state.outer ?? "row") === "row",
    innerRow = state.inner === "row";
  const hasA = !hidden.includes("a");
  const hasB = !!layout.b?.length && !hidden.includes("b");
  const hasC = !hidden.includes("c");
  const hasLeft = hasA || hasB;
  const visible = (slot: SlotId) =>
    zoom ? zoom === slot : slot === "a" ? hasA : slot === "b" ? hasB : hasC;
  const set = (patch: LayoutState) => onState({ ...state, ...patch });

  const tile = (slot: SlotId, style?: CSSProperties) => {
    const tabs = layout[slot];
    if (!tabs?.length) return null;
    const current = activeTab(slot, layout, state)!;
    const label = paneLabels[current];
    const holdsPi = tabs.includes("pi");
    // A second pane below the current tab; never the same one twice.
    const wanted = state.below?.[slot] as PaneKind | undefined;
    const below = wanted && wanted !== current && tabs.includes(wanted) ? wanted : undefined;
    const setBelow = (kind?: PaneKind) => set({ below: { ...state.below, [slot]: kind } });
    return (
      <section
        key={slot}
        className={`tile slot slot-${slot} ${active === slot ? "active" : ""} ${drop === slot ? "drop" : ""} ${below ? "split" : ""}`}
        data-slot={slot}
        data-pane={current}
        aria-label={label}
        tabIndex={-1}
        hidden={!visible(slot)}
        style={style}
        onPointerDownCapture={() => onActive(slot)}
        onFocusCapture={() => onActive(slot)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (drop !== slot) setDrop(slot);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE) as SlotId;
          setDrop(null);
          if (from && from !== slot) {
            e.preventDefault();
            onSwap(from, slot);
          }
        }}
      >
        <span
          className="tile-label"
          draggable={!zoom}
          title="Drag onto another pane to swap  ·  ⌘⌥⇧ + arrows"
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, slot);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDrop(null)}
        >
          {tileLabel(current, slot)}
        </span>
        {!(tabs.length === 1 && holdsPi) && (
          <div className="tabs" role="tablist" aria-label={`${label} pane`}>
            {tabs.map((kind) => (
              <button
                key={kind}
                id={`pane-tab-${kind}`}
                role="tab"
                aria-selected={kind === current}
                onClick={() => set({ tabs: { ...state.tabs, [slot]: kind } })}
              >
                {paneLabels[kind]}
                <TabBadge kind={kind} />
              </button>
            ))}
            <span className="spacer" />
            {!holdsPi && tabs.length > 1 && (
              <button
                className={`icon-btn ${below ? "on" : ""}`}
                aria-label={below ? `Close ${paneLabels[below]} below` : "Show another pane below"}
                aria-pressed={!!below}
                title={below ? "Show one pane" : "Show another pane below"}
                onClick={() => setBelow(below ? undefined : tabs.find((k) => k !== current))}
              >
                ⊟
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={zoom === slot ? "Restore layout" : `Zoom ${label}`}
              title={`${zoom === slot ? "Restore layout" : "Zoom pane"}  ⌘⌥F`}
              onClick={() => set({ zoom: zoom === slot ? null : slot })}
            >
              {zoom === slot ? "⤡" : "⤢"}
            </button>
            {!holdsPi && (
              <button
                className="icon-btn"
                aria-label={`Hide ${label}`}
                title="Hide pane  ⌘⌥W"
                onClick={() =>
                  set({
                    hidden: [...hidden.filter((h) => h !== slot), slot],
                    zoom: zoom === slot ? null : zoom,
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        )}
        {below && (
          <div className="below-head">
            <select aria-label="Pane below" value={below} onChange={(e) => setBelow(e.target.value as PaneKind)}>
              {tabs
                .filter((k) => k !== current)
                .map((k) => (
                  <option key={k} value={k}>
                    {paneLabels[k]}
                  </option>
                ))}
            </select>
            <TabBadge kind={below} />
          </div>
        )}
        {tabs.map((kind) => (
          <div className={`slot-body ${kind === below ? "below" : ""}`} key={kind} hidden={kind !== current && kind !== below}>
            <PaneVisible.Provider value={(kind === current || kind === below) && visible(slot)}>{render(kind, slot)}</PaneVisible.Provider>
          </div>
        ))}
      </section>
    );
  };

  const basis = (ratio: number, on: boolean) =>
    on ? `0 0 calc((100% - var(--gap)) * ${ratio})` : "1 1 0";
  return (
    <div className={`stage ${outerRow ? "" : "col-dir"}`} ref={box}>
      <div
        ref={col}
        className={`stage-col ${innerRow ? "row-dir" : ""}`}
        hidden={!(visible("a") || visible("b"))}
        style={{ flex: basis(split, hasC && hasLeft && !zoom) }}
      >
        {tile("a", { flex: basis(stack, hasA && hasB && !zoom) })}
        {hasA && hasB && !zoom && (
          <Gutter
            orientation={innerRow ? "vertical" : "horizontal"}
            ratio={stack}
            label="Resize stacked panes"
            onRatio={(r) => set({ stack: r })}
            onReset={() => set({ stack: defaults.stack })}
            measure={() => col.current?.getBoundingClientRect()}
          />
        )}
        {layout.b && tile("b", { flex: "1 1 0" })}
      </div>
      {hasC && hasLeft && !zoom && (
        <Gutter
          orientation={outerRow ? "vertical" : "horizontal"}
          ratio={split}
          label={outerRow ? "Resize columns" : "Resize rows"}
          onRatio={(r) => set({ split: r })}
          onReset={() => set({ split: defaults.split })}
          measure={() => box.current?.getBoundingClientRect()}
        />
      )}
      {tile("c", { flex: "1 1 0" })}
    </div>
  );
}

/** A tab's count or mark, e.g. uncheckpointed changes or a new document. */
function TabBadge({ kind }: { kind: string }) {
  const badge = useBadge(kind);
  return badge ? <span className="tab-badge" aria-label={`(${badge})`}>{badge}</span> : null;
}
