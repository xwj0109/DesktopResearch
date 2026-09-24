import { appendReviewMessage } from "../review-attachment";
import { WorkbenchEvents } from "./WorkbenchEvents";
import { ExternalAgents } from "./ExternalAgents";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type { NativeClient } from "../native-client";
import type { ViewState } from "../../desktop/contracts";
import { sessionKey, updateDraft } from "./model";
import type { Material, MaterialTab, StageId, Thread, WorkbenchData } from "./model";
import { NativeConversation, type RuntimeSummary } from "./NativeConversation";
import { PiTerminal, pasteIntoTerminal } from "./PiTerminal";
import { EmptyPane, PreviewPane } from "./Materials";
import { CommandPalette, type Command } from "./CommandPalette";
import { ToolBlock } from "./transcript";
import {
  activeTab,
  effectiveLayout,
  neighbor,
  paneGlyphs,
  paneLabels,
  piSlot,
  resizeTile,
  stageLayouts,
  swapSlots,
  tileOrder,
  tileRects,
  type Dir,
  type LayoutStage,
  type LayoutState,
  type PaneKind,
  type SlotId,
} from "./layouts";
import { StageLayout, type TileId } from "./StageLayout";
import {
  ActionPanel,
  RecordEditor,
  ResearchProvider,
  useResearchData,
  type Companion,
} from "./research";
import { SourcesPane } from "./panes/SourcesPane";
import { IdeaBoard } from "./panes/IdeaBoard";
import { GraphPane } from "./panes/GraphPane";
import { CodePane } from "./panes/CodePane";
import { DataPane, PortfolioPane, ResultsPane, RunsPane } from "./panes/EvidencePanes";
import { useStageActivity } from "./useStageActivity";
import {
  defaultTheme,
  resolveTheme,
  storeTheme,
  storedTheme,
  themeIds,
  themeStyle,
  themes,
  type ThemeId,
} from "./theme";

/** Original box-drawing π used as the empty-state mark. */
export const piMark = ["──┬─────┬──", "  │     │", "  │     │", "  ╵     ╰─"].join("\n");

export function Clock() {
  const format = () =>
    new Date().toLocaleString(undefined, {
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  const [now, setNow] = useState(format);
  useEffect(() => {
    const timer = setInterval(() => setNow(format()), 15000);
    return () => clearInterval(timer);
  }, []);
  return <span className="bar-clock">{now}</span>;
}

function PreviewConversation({
  thread,
  material,
  onMaterial,
  portfolio,
}: {
  thread: Thread;
  material: Material;
  onMaterial: () => void;
  portfolio: boolean;
}) {
  return (
    <div className="transcript-inner">
      <div className="divider">illustrative conversation · authored fixture</div>
      <article className="msg user">
        <div className="msg-meta">
          <strong>you</strong>
          <span>sample prompt</span>
        </div>
        <div className="msg-body">{thread.prompt}</div>
      </article>
      <article className="msg assistant">
        <div className="msg-meta">
          <strong className="who-pi">pi</strong>
          <span>prewritten example · no model execution</span>
        </div>
        <div className="tools">
          {thread.activities.map((activity) => (
            <ToolBlock
              key={activity.title}
              name={activity.title}
              status="ok"
              output={activity.detail}
              tag="sample"
            />
          ))}
        </div>
        <div className="prose msg-body">
          <p>{thread.introduction}</p>
          {thread.points.length > 0 && (
            <ol>
              {thread.points.map((point) => (
                <li key={point.title}>
                  <strong>{point.title}</strong> {point.text}
                </li>
              ))}
            </ol>
          )}
        </div>
        <button className="artifact" onClick={onMaterial}>
          <span className="g">{portfolio ? "◇" : "▤"}</span>
          <span className="label">
            {material.title.replace("\n", " ")}
            <small>
              {portfolio
                ? "Frozen evidence example · no run attached"
                : "CC0 research note · timing assumption, §02"}
            </small>
          </span>
          <span className="g">›</span>
        </button>
        <div className="prose msg-body">
          <p>{thread.closing}</p>
        </div>
      </article>
    </div>
  );
}

/** Transport-free composer for the design preview and disconnected windows. */
function LocalComposer({
  value,
  onChange,
  disabled,
  context,
  label,
  sendLabel,
  footnote,
  inputRef,
  maxLength,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  context: string;
  label: string;
  sendLabel: string;
  footnote: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  maxLength?: number;
}) {
  return (
    <section className="composer" aria-label="Local composer">
      <div className="composer-box">
        <div className="composer-ctx">
          <span>{context}</span>
          <span className="spacer" />
          <span>draft stays in this session</span>
        </div>
        <div className="composer-input">
          <label className="sr-only" htmlFor="draft">
            {label}
          </label>
          <textarea
            ref={inputRef}
            id="draft"
            data-autofocus
            maxLength={maxLength}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Think through the next research question…"
            rows={3}
            aria-describedby="preview-composer-note"
          />
        </div>
        <div className="composer-bar">
          <span className="tag">
            <span className="dot idle" />
            pi · not connected
          </span>
          <span className="tag">no model selected</span>
          <span className="spacer" />
          <button
            className="btn primary send"
            disabled
            aria-label={sendLabel}
            title="Not connected — drafts cannot be sent"
          >
            Send
          </button>
        </div>
      </div>
      <p className="composer-foot" id="preview-composer-note">
        <span>{footnote}</span>
      </p>
    </section>
  );
}


/** Real research panes for a connected workspace window. */
function ResearchPane({ kind, stage }: { kind: PaneKind; stage: string }) {
  switch (kind) {
    case "sources":
      return <SourcesPane initialMode={stage === "literature" ? "library" : undefined} />;
    case "idea":
      return <IdeaBoard />;
    case "bibliography":
      return (
        <RecordEditor
          kinds={["search-brief", "bibliography"]}
          intro={
            <p className="note">
              Your bibliography order is the curated order: reorder entries with ↑↓. Inclusion
              decisions and reasons are part of each entry.
            </p>
          }
        />
      );
    case "spec":
      return (
        <RecordEditor
          kinds={["spec"]}
          editorOpen
          intro={
            <p className="note">
              Keep cited results, derivations, assumptions, conjectures and tested observations
              distinct. Approving an exact version is what lets its data requirements go to Data.
            </p>
          }
        >
          <ActionPanel commands={["approval.record", "handoff.create", "proposal.review"]} />
        </RecordEditor>
      );
    case "data":
      return <DataPane />;
    case "graph":
      return <GraphPane />;
    case "code":
      return <CodePane />;
    case "runs":
      return <RunsPane />;
    case "results":
      return <ResultsPane />;
    case "conclusion":
      return <RecordEditor kinds={["conclusion"]} />;
    case "portfolio":
      return <PortfolioPane />;
    default:
      return null;
  }
}

/** Desktop composition. Domain content enters only through props; the native
 * adapter (client, saved view, launcher) is optional so the same shell renders
 * the explicitly synthetic design preview. */
export interface NativeWorkbench {
  kind: "strategy" | "portfolio";
  initial: ViewState;
  client?: NativeClient;
  preparing?: boolean;
  isPreparing?: () => boolean;
  registerSnapshot?: (get: () => ViewState) => void;
  onChange: (state: ViewState) => void;
  onLauncher: () => void;
  saveStatus: string;
  /** App-wide theme owned by the desktop shell; omitted in tests/preview. */
  theme?: ThemeId;
  onTheme?: (id: ThemeId) => void;
}
const noCompanion: Companion = { open: [], pinned: [], active: null };

export function Workbench({ data, native }: { data: WorkbenchData; native?: NativeWorkbench }) {
  const [workspaceId, setWorkspaceId] = useState(data.workspaces[0].id);
  const [stage, setStage] = useState<StageId>(native?.initial.stage ?? "literature");
  const [portfolio, setPortfolio] = useState(native?.kind === "portfolio");
  const [railOpen, setRailOpen] = useState(native?.initial.railOpen ?? true);
  const [palette, setPalette] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(native?.initial.drafts ?? {});
  const [researchDrafts, setResearchDrafts] = useState<Record<string, string>>(
    native?.initial.researchDrafts ?? {},
  );
  const [layouts, setLayouts] = useState<Partial<Record<LayoutStage, LayoutState>>>(
    native?.initial.layouts ?? {},
  );
  const [companion, setCompanion] = useState<Companion>(native?.initial.companion ?? noCompanion);
  const [localTheme, setLocalTheme] = useState<ThemeId>(() =>
    native ? resolveTheme(native.initial.theme) : storedTheme(),
  );
  const theme = native?.theme ?? localTheme;
  const [active, setActive] = useState<TileId>("a");
  const [runtime, setRuntime] = useState<RuntimeSummary>();
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const workspace = data.workspaces.find((item) => item.id === workspaceId) || data.workspaces[0];
  const activeStage = data.stages.find((item) => item.id === stage)!;
  const key = native
    ? portfolio
      ? "portfolio"
      : stage
    : portfolio
      ? "portfolio:review"
      : sessionKey(workspaceId, stage);
  const draftKey = (id: StageId) => (native ? id : sessionKey(workspaceId, id));
  const thread = portfolio ? data.portfolio : workspace.threads[stage];
  const material = data.materials[portfolio ? data.workspaces[0].id : workspaceId];
  const scopeName = portfolio && !native ? "Portfolio" : workspace.shortName;
  const stageName = portfolio ? (native ? "Portfolio" : "Evidence review") : activeStage.label;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const scopePath = `${slug(scopeName) || "workspace"}/${slug(stageName)}`;
  const layoutStage: LayoutStage = portfolio ? "portfolio" : stage;
  const defaults = stageLayouts[layoutStage];
  const lstate = layouts[layoutStage] ?? {};
  const layout = effectiveLayout(defaults, lstate);
  const lastFocus = useRef<Partial<Record<TileId, HTMLElement>>>({});
  const previousStage = useRef<StageId | null>(null);
  const setLState = (next: LayoutState) => setLayouts((old) => ({ ...old, [layoutStage]: next }));
  const stagesAvailable = native?.kind !== "portfolio";
  const research = useResearchData(native?.client);
  const activity = useStageActivity(
    native?.client,
    native?.kind === "strategy" ? data.stages.map((s) => s.id) : [],
    stage,
  );

  const snapshot = useRef<ViewState>({} as ViewState);
  snapshot.current = {
    version: 1,
    stage,
    tab: native?.initial.tab ?? "note",
    paneOpen: native?.initial.paneOpen ?? true,
    railOpen,
    paneWidth: native?.initial.paneWidth ?? 440,
    drafts,
    layouts,
    companion,
    ...(native?.client ? { researchDrafts } : {}),
  };
  useLayoutEffect(() => {
    native?.registerSnapshot?.(() => snapshot.current);
  }, [native?.registerSnapshot]);
  useLayoutEffect(() => {
    native?.onChange(snapshot.current);
  }, [stage, railOpen, drafts, researchDrafts, layouts, companion]);
  useEffect(() => {
    transcript.current?.scrollTo?.({ top: 0 });
  }, [key]);
  useEffect(() => {
    if (native?.client) document.title = `${workspace.name} · ${stageName} — Pi Research`;
  }, [workspace.name, stageName, native?.client]);

  const changeDraft = (text: string) => {
    if (native?.isPreparing?.()) return;
    const next = updateDraft(snapshot.current.drafts, key, text);
    snapshot.current = { ...snapshot.current, drafts: next };
    setDrafts(next);
  };
  const changeResearchDraft = (id: string, text: string) => {
    if (native?.isPreparing?.()) return;
    const next = { ...snapshot.current.researchDrafts };
    if (text) next[id] = text;
    else delete next[id];
    snapshot.current = { ...snapshot.current, researchDrafts: next };
    setResearchDrafts(next);
  };
  /** Focus a tile, restoring the element last focused inside it (or its
   * preferred input), the way a window manager hands focus back to a window. */
  const focusSlot = (slot: TileId) => {
    setActive(slot);
    setTimeout(() => {
      const tile = globalThis.document?.querySelector?.(
        slot === "rail" ? "[data-tile=rail]" : `[data-slot=${slot}]`,
      ) as HTMLElement | null;
      if (!tile) return;
      const last = lastFocus.current[slot];
      const target =
        last && last.isConnected && tile.contains(last) && last.offsetParent !== null
          ? last
          : ((tile.querySelector("[data-autofocus]:not([disabled])") as HTMLElement | null) ?? tile);
      target.focus?.();
    }, 0);
  };
  const focusComposer = () => {
    const pi = piSlot(layout);
    if (lstate.zoom && lstate.zoom !== pi) setLState({ ...lstate, zoom: null });
    setActive(pi);
    setTimeout(() => {
      (composer.current ?? (globalThis.document?.getElementById?.("live-draft") as HTMLTextAreaElement | null))?.focus?.();
    }, 0);
  };
  const toggleSlots = (slots: SlotId[]) => {
    const targets = slots.filter((s) => layout[s] && !layout[s]!.includes("pi"));
    if (!targets.length) return;
    const hidden = lstate.hidden ?? [];
    const hide = !targets.every((t) => hidden.includes(t));
    setLState({
      ...lstate,
      hidden: hide ? [...new Set([...hidden, ...targets])] : hidden.filter((h) => !targets.includes(h)),
      zoom: lstate.zoom && targets.includes(lstate.zoom) ? null : lstate.zoom,
    });
  };
  /** The companion is whatever sits across the outer split from Pi. */
  const companionSlots: SlotId[] = piSlot(layout) === "c" ? ["a", "b"] : ["c"];
  const companionHidden = companionSlots
    .filter((s) => layout[s])
    .every((s) => (lstate.hidden ?? []).includes(s));
  const lowerSlot: SlotId | undefined = layout.b ? (piSlot(layout) === "b" ? "a" : "b") : undefined;
  const toggleCompanion = () => toggleSlots(companionSlots);
  const showPane = (kind: PaneKind) => {
    const slot = (["a", "b", "c"] as SlotId[]).find((s) => layout[s]?.includes(kind));
    if (!slot) return;
    setLState({
      ...lstate,
      hidden: (lstate.hidden ?? []).filter((h) => h !== slot),
      tabs: { ...lstate.tabs, [slot]: kind },
      zoom: lstate.zoom && lstate.zoom !== slot ? null : lstate.zoom,
    });
    focusSlot(slot);
  };
  const focusedSlot = (): SlotId => (active === "rail" ? piSlot(layout) : active);
  const zoomActive = () => {
    const slot = focusedSlot();
    setLState({ ...lstate, zoom: lstate.zoom === slot ? null : slot });
  };
  const rects = () => tileRects(layout, lstate, railOpen);
  /** SUPER + arrows: move focus to the tile on that side. */
  const moveFocus = (dir: Dir) => {
    const target = neighbor(rects(), active, dir);
    if (target) focusSlot(target);
  };
  /** SUPER + SHIFT + arrows: swap the focused pane with its neighbour; focus follows it. */
  const swapDir = (dir: Dir) => {
    if (active === "rail" || lstate.zoom) return;
    const target = neighbor(rects(), active, dir);
    if (!target || target === "rail") return;
    swap(active, target);
  };
  const swap = (from: SlotId, to: SlotId) => {
    setLState(swapSlots(defaults, lstate, from, to));
    focusSlot(to);
  };
  /** SUPER + J: flip the split that contains the focused tile. */
  const toggleSplit = () => {
    const slot = focusedSlot();
    const hidden = lstate.hidden ?? [];
    const innerActive = layout.b && slot !== "c" && !hidden.includes("a") && !hidden.includes("b");
    if (innerActive) setLState({ ...lstate, inner: lstate.inner === "row" ? "column" : "row" });
    else setLState({ ...lstate, outer: (lstate.outer ?? "row") === "row" ? "column" : "row" });
  };
  /** SUPER + W: hide the focused pane (Pi's pane is never hidden). */
  const hideActive = () => {
    const slot = focusedSlot();
    if (layout[slot]?.includes("pi")) return;
    toggleSlots([slot]);
    focusSlot(piSlot(layout));
  };
  const resizeActive = (axis: "x" | "y", delta: number) =>
    setLState(resizeTile(layout, lstate, focusedSlot(), axis, delta));
  /** ⌃Tab: cycle focus through visible panes in reading order. */
  const cycleTiles = (step: number) => {
    const order = tileOrder(rects());
    if (!order.length) return;
    const i = order.indexOf(active as SlotId);
    focusSlot(order[(i + step + order.length) % order.length]);
  };
  const cycleTab = (step: number) => {
    const slot = focusedSlot();
    const tabs = layout[slot];
    if (!tabs || tabs.length < 2) return;
    const current = activeTab(slot, layout, lstate)!;
    const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
    setLState({ ...lstate, tabs: { ...lstate.tabs, [slot]: next } });
  };
  const stepStage = (step: number) => {
    if (!stagesAvailable) return;
    const ids = data.stages.map((s) => s.id);
    navigate(ids[(ids.indexOf(stage) + step + ids.length) % ids.length]);
  };
  const navigate = (id: StageId) => {
    if (native?.kind === "portfolio") return;
    if (id !== stage || portfolio) previousStage.current = stage;
    setStage(id);
    setPortfolio(false);
  };
  const openPortfolio = () => setPortfolio(true);
  const chooseTheme = (id: ThemeId) => {
    if (native?.onTheme) return native.onTheme(id);
    setLocalTheme(id);
    if (!native) storeTheme(id);
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const code = event.code;
      const arrows: Record<string, Dir> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const go = (fn: () => void) => {
        event.preventDefault();
        fn();
      };
      // ALT+TAB analogue: ⌃Tab cycles panes.
      if (event.ctrlKey && !event.metaKey && !event.altKey && code === "Tab")
        return go(() => cycleTiles(event.shiftKey ? -1 : 1));
      if (!(event.metaKey || event.ctrlKey)) return;
      // SUPER = ⌘⌥ (Ctrl+Alt elsewhere); matched on physical keys because ⌥ alters characters.
      if (event.altKey) {
        const dir = arrows[code];
        if (dir && event.ctrlKey && event.metaKey)
          return dir === "left" || dir === "right" ? go(() => cycleTab(dir === "right" ? 1 : -1)) : undefined;
        if (dir) return go(() => (event.shiftKey ? swapDir(dir) : moveFocus(dir)));
        const digit = /^Digit([1-7])$/.exec(code);
        if (digit && stagesAvailable) return go(() => navigate(data.stages[Number(digit[1]) - 1].id));
        if (code === "KeyJ") return go(toggleSplit);
        if (code === "KeyF") return go(zoomActive);
        if (code === "KeyW") return go(hideActive);
        if (code === "KeyK") return go(() => setPalette("keys "));
        if (code === "BracketRight") return go(() => stepStage(1));
        if (code === "BracketLeft") return go(() => stepStage(-1));
        if (code === "Backquote")
          return go(() => previousStage.current && navigate(previousStage.current));
        if (code === "Equal" || code === "Minus")
          return go(() => resizeActive(event.shiftKey ? "y" : "x", code === "Equal" ? 0.05 : -0.05));
        if (code === "Home") return go(() => setLState({}));
        return;
      }
      const k = event.key.toLowerCase();
      if (k === "k") go(() => setPalette((open) => (open === null ? "" : null)));
      else if (k === "b" && !event.shiftKey) go(() => setRailOpen((open) => !open));
      else if (code === "Backslash") go(() => (event.shiftKey ? lowerSlot && toggleSlots([lowerSlot]) : toggleCompanion()));
      else if (k === "f" && event.shiftKey) go(zoomActive);
      else if (k === "t" && event.shiftKey) go(() => setPalette("theme "));
      else if ((k === "[" || k === "]") && !event.shiftKey) go(() => cycleTab(k === "]" ? 1 : -1));
      else if (/^[1-7]$/.test(k) && !event.shiftKey && stagesAvailable)
        go(() => navigate(data.stages[Number(k) - 1].id));
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  });

  /** Omarchy tiling bindings (default/hypr/bindings/tiling.lua), SUPER = ⌘⌥. */
  const keymap: { id: string; keys: string; label: string; run: () => void }[] = [
    { id: "focus-left", keys: "⌘⌥←", label: "Focus pane on the left", run: () => moveFocus("left") },
    { id: "focus-right", keys: "⌘⌥→", label: "Focus pane on the right", run: () => moveFocus("right") },
    { id: "focus-up", keys: "⌘⌥↑", label: "Focus pane above", run: () => moveFocus("up") },
    { id: "focus-down", keys: "⌘⌥↓", label: "Focus pane below", run: () => moveFocus("down") },
    { id: "swap-left", keys: "⌘⌥⇧←", label: "Swap pane to the left", run: () => swapDir("left") },
    { id: "swap-right", keys: "⌘⌥⇧→", label: "Swap pane to the right", run: () => swapDir("right") },
    { id: "swap-up", keys: "⌘⌥⇧↑", label: "Swap pane up", run: () => swapDir("up") },
    { id: "swap-down", keys: "⌘⌥⇧↓", label: "Swap pane down", run: () => swapDir("down") },
    { id: "cycle", keys: "⌃Tab", label: "Focus next pane", run: () => cycleTiles(1) },
    { id: "cycle-back", keys: "⌃⇧Tab", label: "Focus previous pane", run: () => cycleTiles(-1) },
    { id: "split", keys: "⌘⌥J", label: "Toggle split direction", run: toggleSplit },
    { id: "fullscreen", keys: "⌘⌥F", label: "Full screen pane (zoom)", run: zoomActive },
    { id: "close", keys: "⌘⌥W", label: "Hide focused pane", run: hideActive },
    { id: "grow", keys: "⌘⌥=", label: "Widen focused pane", run: () => resizeActive("x", 0.05) },
    { id: "shrink", keys: "⌘⌥−", label: "Narrow focused pane", run: () => resizeActive("x", -0.05) },
    { id: "taller", keys: "⌘⌥⇧=", label: "Make focused pane taller", run: () => resizeActive("y", 0.05) },
    { id: "shorter", keys: "⌘⌥⇧−", label: "Make focused pane shorter", run: () => resizeActive("y", -0.05) },
    { id: "tab-next", keys: "⌘⌥⌃→  ⌘]", label: "Next tab in pane", run: () => cycleTab(1) },
    { id: "tab-prev", keys: "⌘⌥⌃←  ⌘[", label: "Previous tab in pane", run: () => cycleTab(-1) },
    { id: "stage-next", keys: "⌘⌥]", label: "Next stage", run: () => stepStage(1) },
    { id: "stage-prev", keys: "⌘⌥[", label: "Previous stage", run: () => stepStage(-1) },
    { id: "stage-former", keys: "⌘⌥`", label: "Former stage", run: () => previousStage.current && navigate(previousStage.current) },
    { id: "reset", keys: "⌘⌥Home", label: "Reset stage layout", run: () => setLState({}) },
    { id: "keys", keys: "⌘⌥K", label: "Show key bindings", run: () => setPalette("keys ") },
  ];

  const commands: Command[] = [
    ...(native
      ? [
          {
            id: "launcher",
            label: "Workspace launcher",
            detail: "Open independent strategies and portfolios",
            glyph: "⌂",
            group: "workspace",
            run: native.onLauncher,
          },
          ...(native.kind === "strategy" && native.client
            ? [
                {
                  id: "external-agents",
                  label: "External agents (MCP)…",
                  detail: "Let Claude Code, Codex or Cursor use this strategy's workbench tools",
                  glyph: "⇄",
                  group: "workspace",
                  run: () => setAgentsOpen(true),
                },
              ]
            : []),
        ]
      : [
          ...data.workspaces.map((item) => ({
            id: item.id,
            label: item.name,
            detail: "Strategy workspace",
            glyph: "◆",
            group: "workspace",
            run: () => {
              setWorkspaceId(item.id);
              setPortfolio(false);
            },
          })),
          {
            id: "portfolio",
            label: "Portfolio review",
            detail: "Frozen source evidence",
            glyph: "◇",
            group: "workspace",
            run: openPortfolio,
          },
        ]),
    ...(stagesAvailable
      ? data.stages.map((item, index) => ({
          id: item.id,
          label: item.label,
          detail: `${workspace.shortName} · research stage`,
          glyph: String(index + 1),
          hint: `⌘${index + 1}`,
          group: "stages",
          run: () => navigate(item.id),
        }))
      : []),
    ...(["a", "b", "c"] as SlotId[]).flatMap((slot) =>
      (layout[slot] ?? []).map((kind) => ({
        id: `pane-${kind}`,
        label: `Go to ${paneLabels[kind].toLowerCase()}`,
        detail: `${stageName} pane`,
        glyph: paneGlyphs[kind],
        group: "panes",
        run: () => showPane(kind),
      })),
    ),
    {
      id: "toggle-companion",
      label: companionHidden ? "Show companion pane" : "Hide companion pane",
      detail: "Layout",
      glyph: "◨",
      hint: "⌘\\",
      group: "layout",
      run: toggleCompanion,
    },
    ...(lowerSlot
      ? [
          {
            id: "toggle-lower",
            label: `${(lstate.hidden ?? []).includes(lowerSlot) ? "Show" : "Hide"} ${paneLabels[activeTab(lowerSlot, layout, lstate)!].toLowerCase()} pane`,
            detail: "Layout",
            glyph: "⬒",
            hint: "⌘⇧\\",
            group: "layout",
            run: () => toggleSlots([lowerSlot]),
          },
        ]
      : []),
    {
      id: "zoom",
      label: lstate.zoom ? "Restore tiled layout" : "Zoom focused pane",
      detail: "Layout",
      glyph: "⤢",
      hint: "⌘⌥F",
      group: "layout",
      run: zoomActive,
    },
    ...keymap.map((b) => ({
      id: `key-${b.id}`,
      label: b.label,
      detail: "keys · tiling",
      glyph: "⌘",
      hint: b.keys,
      group: "keys · tiling",
      run: b.run,
    })),
    {
      id: "reset-layout",
      label: `Reset ${stageName} layout`,
      detail: "Split positions, hidden panes and tabs",
      glyph: "↺",
      group: "layout",
      run: () => setLState({}),
    },
    {
      id: "toggle-rail",
      label: railOpen ? "Hide workspace navigation" : "Show workspace navigation",
      detail: "Layout",
      glyph: "◧",
      hint: "⌘B",
      group: "layout",
      run: () => setRailOpen((value) => !value),
    },
    {
      id: "composer",
      label: native?.client ? "Focus composer" : "Focus local draft",
      detail: native?.client ? "Write to Pi" : "Writing only · sending disabled",
      glyph: "❯",
      group: "layout",
      run: focusComposer,
    },
    ...themeIds.map((id) => ({
      id: `theme-${id}`,
      label: `Theme · ${themes[id].label}`,
      detail: themes[id].mode,
      glyph: id === theme ? "●" : "○",
      hint: id === theme ? "current" : themes[id].mode,
      group: "theme",
      run: () => chooseTheme(id),
    })),
  ];

  const saveWarn = native?.saveStatus.toLowerCase().includes("not saved");
  const runtimeIndicator: ReactNode = native?.client ? (
    runtime?.connected ? (
      <>
        <span className={`dot ${runtime.running ? "live" : "ok"}`} />
        {runtime.running ? "pi working" : `pi${runtime.model ? ` · ${runtime.model}` : ""}`}
      </>
    ) : (
      <>
        <span className="dot idle" />
        pi offline
      </>
    )
  ) : (
    <>
      <span className="dot idle" />
      {native ? "disconnected" : "preview · no runtime"}
    </>
  );
  const stageActivity = (id: StageId) =>
    id === stage && !portfolio
      ? { pending: runtime?.pending ?? 0, running: !!runtime?.running }
      : activity[id];
  const waiting = data.stages.filter((s) => (stageActivity(s.id)?.pending ?? 0) > 0);
  const hiddenC = companionHidden;

  const piPane = (
    <>
      <div className="conv-head">
        {!railOpen && (
          <button
            className="icon-btn"
            onClick={() => setRailOpen(true)}
            aria-label="Show workspace navigation"
            title="Show workspace navigation  ⌘B"
          >
            ›
          </button>
        )}
        <div className="crumbs">
          <span>{scopeName} /</span>
          <h1>{thread.title}</h1>
        </div>
        <span className={`tag ${native?.client ? "accent" : native ? "" : "warn"}`}>
          {native?.client
            ? portfolio
              ? "portfolio review"
              : "canonical session"
            : native
              ? "disconnected"
              : "local preview"}
        </span>
        <button
          className="icon-btn"
          aria-label={lstate.zoom === piSlot(layout) ? "Restore layout" : "Zoom Pi"}
          title={`${lstate.zoom === piSlot(layout) ? "Restore layout" : "Zoom pane"}  ⌘⌥F`}
          onClick={() => {
            const pi = piSlot(layout);
            setLState({ ...lstate, zoom: lstate.zoom === pi ? null : pi });
          }}
        >
          {lstate.zoom === piSlot(layout) ? "⤡" : "⤢"}
        </button>
        <button
          className={`icon-btn ${hiddenC ? "" : "on"}`}
          aria-label={hiddenC ? "Show companion pane" : "Hide companion pane"}
          title={`${hiddenC ? "Show" : "Hide"} companion pane  ⌘\\`}
          aria-expanded={!hiddenC}
          onClick={toggleCompanion}
        >
          ◨
        </button>
      </div>
      {native?.client?.bridge.terminalOpen ? (
        <div className="conversation-terminal" key={key}>
          <PiTerminal
            bridge={native.client.bridge}
            stage={portfolio ? "portfolio" : stage}
            theme={theme}
            onStatus={({ running }) => setRuntime({ connected: running, running: false, pending: 0, model: "Pi CLI" })}
          />
        </div>
      ) : native?.client ? (
        <NativeConversation
          key={key}
          autoConnect={!portfolio}
          client={native.client}
          stage={portfolio ? "portfolio" : stage}
          draft={drafts[key] || ""}
          onDraft={changeDraft}
          preparing={native.preparing}
          context={`${scopeName} / ${stageName}`}
          saveStatus={native.saveStatus}
          onRuntime={setRuntime}
        />
      ) : (
        <>
          <div
            ref={transcript}
            className="transcript"
            tabIndex={0}
            aria-label={native ? "Conversation" : "Illustrative conversation"}
          >
            {native ? (
              <div className="transcript-inner">
                <div className="empty">
                  <pre aria-hidden="true">{piMark}</pre>
                  <h2>Your research starts here</h2>
                  <p>No conversation or activity is loaded. Pi is not connected.</p>
                  <p className="note">
                    Write a local draft below. Live conversation and scientific integrations need a
                    connected desktop client; sending is unavailable here.
                  </p>
                </div>
              </div>
            ) : (
              <PreviewConversation
                key={key}
                thread={thread}
                material={material}
                portfolio={portfolio}
                onMaterial={() => showPane(portfolio ? "portfolio" : layout.c.includes("sources") ? "sources" : (layout.b?.[0] ?? layout.c[0]))}
              />
            )}
          </div>
          <LocalComposer
            value={drafts[key] || ""}
            onChange={changeDraft}
            disabled={native?.preparing}
            inputRef={composer}
            maxLength={native ? 100000 : undefined}
            context={`${scopeName} / ${stageName}`}
            label={`Local draft for ${portfolio ? "Portfolio review" : `${workspace.shortName}, ${activeStage.label}`}`}
            sendLabel={
              native
                ? "Send unavailable: no connected runtime"
                : "Send unavailable: design preview has no connected runtime"
            }
            footnote={native ? native.saveStatus : "Local draft only · Send disabled · Clears on reload"}
          />
        </>
      )}
    </>
  );

  const renderPane = (kind: PaneKind) => {
    if (kind === "pi") return piPane;
    if (native?.client) return <ResearchPane kind={kind} stage={portfolio ? "portfolio" : stage} />;
    if (native) return <EmptyPane kind={kind} />;
    return (
      <PreviewPane
        key={`${portfolio ? "portfolio" : workspaceId}:${kind}`}
        kind={kind}
        material={material}
        portfolio={portfolio}
      />
    );
  };

  const shell = (
    <div
      inert={native?.preparing}
      className={native?.client?.bridge.integratedTitlebar ? "wb integrated-titlebar" : "wb"}
      data-theme={theme}
      style={{ ...themeStyle(theme ?? defaultTheme) } as CSSProperties}
    >
      <header className="bar">
        <div className="bar-left">
          <button
            className="bar-item bar-menu"
            onClick={() => setPalette("")}
            aria-label="Open command palette"
            title="Command palette  ⌘K"
          >
            π
          </button>
          {!railOpen && <nav className="bar-ws" aria-label="Stage workspaces">
            {stagesAvailable &&
              data.stages.map((item, index) => {
                const focused = !portfolio && stage === item.id;
                const a = stageActivity(item.id);
                return (
                  <button
                    key={item.id}
                    className={`${focused ? "focused" : ""} ${drafts[draftKey(item.id)]?.trim() || a?.running ? "occupied" : ""} ${a?.pending ? "alert" : ""}`}
                    aria-label={`${index + 1} ${item.label}${a?.pending ? " · waiting for you" : ""}`}
                    aria-current={focused ? "page" : undefined}
                    title={`${item.label}  ⌘${index + 1}${a?.pending ? " · Pi is waiting for a response" : ""}`}
                    onClick={() => navigate(item.id)}
                  >
                    {focused ? "■" : index + 1}
                  </button>
                );
              })}
            {(portfolio || !native) && (
              <button
                className={portfolio ? "focused" : ""}
                aria-label="Portfolio review"
                aria-current={portfolio ? "page" : undefined}
                onClick={native ? undefined : openPortfolio}
              >
                {portfolio ? "■" : "P"}
              </button>
            )}
          </nav>}
          <span className="bar-title">
            <strong>{scopeName}</strong> › {stageName}
          </span>
        </div>
        <Clock />
        <div className="bar-right">
          {waiting.length > 0 && (
            <button
              className="bar-item warn"
              onClick={() => navigate(waiting[0].id)}
              title="Pi is waiting for a response in another stage"
            >
              ! {waiting.map((s) => s.label.toLowerCase()).join(", ")}
            </button>
          )}
          {!native?.client?.bridge.terminalOpen && <span className="bar-item">{runtimeIndicator}</span>}
          {native && <span className={`bar-item bar-status ${saveWarn ? "warn" : ""}`}>{native.saveStatus}</span>}
          <button
            className="bar-item"
            onClick={() => setPalette("theme ")}
            aria-label="Change theme"
            title="Theme  ⌘⇧T"
          >
            ◐ {themes[theme].label.toLowerCase()}
          </button>
          <span className="bar-item">
            <kbd>⌘K</kbd>
          </span>
        </div>
      </header>
      <div
        className="tiles"
        onFocusCapture={(e) => {
          const target = e.target as HTMLElement;
          const tile = target.closest?.("[data-slot],[data-tile]") as HTMLElement | null;
          if (!tile || tile === target) return;
          lastFocus.current[(tile.dataset.slot ?? tile.dataset.tile) as TileId] = target;
        }}
      >
        {railOpen && (
          <aside
            className={`tile rail ${active === "rail" ? "active" : ""}`}
            data-tile="rail"
            tabIndex={-1}
            aria-label="Workspace navigation"
            onPointerDownCapture={() => setActive("rail")}
            onFocusCapture={() => setActive("rail")}
          >
            <span className="tile-label" aria-hidden="true">
              workspace
            </span>
            <div className="scroll">
              <div className="rail-body">
                <div className="rail-ident" style={{ display: "flex", gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{native ? workspace.name : "Pi Research"}</strong>
                    <span>
                      {native
                        ? native.kind === "portfolio"
                          ? "independent portfolio"
                          : "strategy · seven stages"
                        : "synthetic preview"}
                    </span>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => setRailOpen(false)}
                    aria-label="Hide workspace navigation"
                    title="Hide workspace navigation  ⌘B"
                  >
                    ‹
                  </button>
                </div>
                {!native && (
                  <div className="rail-group">
                    <h2 className="section-title">strategies</h2>
                    <nav aria-label="Strategy workspaces">
                      {data.workspaces.map((item) => {
                        const current = !portfolio && workspaceId === item.id;
                        return (
                          <button
                            className="row"
                            key={item.id}
                            aria-current={current ? "page" : undefined}
                            onClick={() => {
                              setWorkspaceId(item.id);
                              setPortfolio(false);
                            }}
                          >
                            <span className="num">◆</span>
                            <span className="label">
                              {item.shortName}
                              <small>{item.description}</small>
                            </span>
                          </button>
                        );
                      })}
                      <button className="row" aria-current={portfolio ? "page" : undefined} onClick={openPortfolio}>
                        <span className="num">◇</span>
                        <span className="label">
                          Portfolio
                          <small>frozen evidence · read only</small>
                        </span>
                      </button>
                    </nav>
                  </div>
                )}
                {stagesAvailable && (
                  <div className="rail-group">
                    <h2 className="section-title">
                      stages <span className="count">07</span>
                    </h2>
                    <nav aria-label="Research stages">
                      {data.stages.map((item, index) => {
                        const current = !portfolio && stage === item.id;
                        const a = stageActivity(item.id);
                        const panes = stageLayouts[item.id];
                        return (
                          <div key={item.id}>
                            <button
                              className="row"
                              data-stage={item.id}
                              onClick={() => navigate(item.id)}
                              aria-current={current ? "page" : undefined}
                            >
                              <span className="num">{index + 1}</span>
                              <span className="label">{item.label}</span>
                              {a?.pending ? (
                                <span className="mark alert" title="Pi is waiting for a response">
                                  !
                                </span>
                              ) : a?.running ? (
                                <span className="mark live" title="Pi is working">
                                  ●
                                </span>
                              ) : drafts[draftKey(item.id)]?.trim() ? (
                                <span className="mark" title="Unsent draft">
                                  ●
                                </span>
                              ) : null}
                            </button>
                            {current && (
                              <div className="row sub" aria-hidden="true">
                                <span className="label">
                                  {[...panes.a, ...(panes.b ?? []), ...panes.c]
                                    .map((k) => paneLabels[k].toLowerCase())
                                    .join(" · ")}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </nav>
                  </div>
                )}
                {native?.kind === "portfolio" && (
                  <div className="rail-group">
                    <h2 className="section-title">portfolio</h2>
                    <p className="rail-note">
                      Independent evidence review. Imports are frozen packages; feedback cannot edit a
                      producer strategy.
                    </p>
                  </div>
                )}
                <div className="rail-foot">
                  {native && (
                    <button className="row" onClick={native.onLauncher}>
                      <span className="num">⌂</span>
                      <span className="label">Workspace launcher</span>
                    </button>
                  )}
                  <div className="rail-note">
                    <span className={`dot ${runtime?.connected ? "ok" : "idle"}`} />
                    <span>
                      {portfolio
                        ? native
                          ? "Independent evidence context"
                          : "Frozen source references"
                        : `${workspace.shortName} context · shared across stages`}
                      <br />
                      {native?.client
                        ? "Independent stage sessions"
                        : native
                          ? "Local workspace · no runtime attached"
                          : "Synthetic content · no inference · no executions"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
        <StageLayout
          key={layoutStage}
          layout={layout}
          defaults={defaults}
          onSwap={swap}
          state={lstate}
          onState={setLState}
          active={active}
          onActive={(tile) => {
            setActive(tile);
          }}
          render={renderPane}
          tileLabel={(kind) => (kind === "pi" ? `~/${scopePath}` : paneLabels[kind].toLowerCase())}
        />
      </div>
      {palette !== null && (
        <CommandPalette commands={commands} initialQuery={palette} onClose={() => setPalette(null)} />
      )}
    </div>
  );

  if (!native?.client) return shell;
  return (
    <ResearchProvider
      value={{
        client: native.client,
        portfolio,
        stage: portfolio ? "portfolio" : stage,
        view: research.view,
        loadError: research.error,
        refresh: research.refresh,
        drafts: researchDrafts,
        setDraft: changeResearchDraft,
        setComposer: (text) => {
          if (pasteIntoTerminal(portfolio ? "portfolio" : stage, text)) return;
          changeDraft(text);
          focusComposer();
        },
        appendComposer: (text) => {
          // With the real Pi CLI in the pane, "Ask Pi" types into it.
          if (pasteIntoTerminal(portfolio ? "portfolio" : stage, text)) return;
          const current = (snapshot.current.drafts as Record<string, string>)[key] ?? "";
          changeDraft(appendReviewMessage(current, text));
          focusComposer();
        },
        companion,
        setCompanion,
      }}
    >
      {shell}
      {agentsOpen && <ExternalAgents onClose={() => setAgentsOpen(false)} />}
      <WorkbenchEvents
        onReveal={(pane) => {
          // Bring the changed pane forward if this stage has it; each stage
          // only shows its own panes, so otherwise report it (no stage jump:
          // every stage has its own Pi conversation).
          const slot = (["a", "b", "c"] as SlotId[]).find((s) => layout[s]?.includes(pane));
          if (!slot) return false;
          setLState({ ...lstate, hidden: (lstate.hidden ?? []).filter((s) => s !== slot), tabs: { ...lstate.tabs, [slot]: pane }, zoom: null });
          return true;
        }}
        onShow={(pane) => navigate(pane === "idea" ? "ideas" : "literature")}
      />
    </ResearchProvider>
  );
}
