import { ReviewPane } from "./ReviewPane";
import { LITERATURE_FOCUS, type SourceNavigation } from "../../workbench-contract";
import { ACTIVE_IDEA } from "../WorkbenchEvents";
import { useEffect, useRef, useState } from "react";
import type { PaperHitDTO } from "../../../desktop/contracts";
import type { Annotation, Artifact, Batch } from "../../shared";
import { NativeDocument, type NoteIdeaLink } from "../NativeDocument";
import { PaneLoading, useAction, useResearch } from "../research";
import { formatTime } from "../transcript";
import { SourceQuickLook } from "../SourceQuickLook";
import type { IdeaCoverage } from "../../idea-coverage";
import { importanceLabels, sections as SECTIONS, type Importance, type Section as Level } from "../../source-importance-contract";

const kindGlyph = (a?: Artifact) =>
  a?.kind === "pdf" ? "▤" : a?.kind === "image" ? "▧" : a?.kind === "text" ? "≡" : "□";
type Mode = "read" | "library" | "review";
/** A pursued idea as the window receives it (ideas_pursued without content). */
interface PursuedIdea {
  target: string;
  title: string;
  version: number;
  pursuedOnVersion: number | null;
  reason: string;
  pendingEdits: boolean;
  ranks: Record<string, Level>;
  coverage?: IdeaCoverage;
}
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** "8 papers · 3 notes: 2 supports, 1 contradicts" (zero stances left out). */
function coverageSummary(c: IdeaCoverage) {
  const n = c.notes;
  const stances = (["supports", "contradicts", "refines"] as const).filter((s) => n[s]).map((s) => `${n[s]} ${s}`);
  if (n.unclassified) stances.push(`${n.unclassified} unjudged`);
  return `${count(c.papers.primary + c.papers.secondary, "paper")} · ${count(n.total, "note")}${stances.length ? `: ${stances.join(", ")}` : ""}`;
}
/** Linked notes by stance as one thin bar (empty when there is no evidence yet). */
function EvidenceBar({ c }: { c: IdeaCoverage }) {
  const n = c.notes;
  return (
    <span className={`ev-bar ${n.total ? "" : "ev-none"}`} aria-hidden="true">
      {(["supports", "contradicts", "refines", "unclassified"] as const).map((s) =>
        n[s] ? <i key={s} className={`ev-${s}`} style={{ flexGrow: n[s] }} /> : null,
      )}
    </span>
  );
}
/** Literature's focus: tabs for "All ideas" and each pursued idea; the focused
 * idea (or each idea, in the overview) shows its evidence and one next step. */
function FocusBar({ pursued, focus, onFocus, compact }: { pursued: PursuedIdea[]; focus: PursuedIdea | null; onFocus: (target: string) => void; compact?: boolean }) {
  const since = (p: PursuedIdea) => (p.pursuedOnVersion && p.pursuedOnVersion !== p.version ? ` · pursued since v${p.pursuedOnVersion}` : "");
  return (
    <section className={`lit-focus ${compact ? "compact" : ""}`} aria-label="Literature focus">
      <div className="lit-tabs" role="tablist" aria-label="Literature focus idea">
        <button role="tab" aria-selected={!focus} className={!focus ? "on" : ""} onClick={() => onFocus("")}>
          All ideas <sup>{pursued.length}</sup>
        </button>
        {pursued.map((p) => (
          <button
            key={p.target}
            role="tab"
            aria-selected={focus?.target === p.target}
            className={focus?.target === p.target ? "on" : ""}
            title={`${p.title || "Untitled idea"} · v${p.version}`}
            onClick={() => onFocus(p.target)}
          >
            {p.title || "Untitled idea"}
          </button>
        ))}
      </div>
      {compact ? null : focus ? (
        <div className="lit-idea-card">
          <p className="meta">
            v{focus.version}
            {since(focus)}
            {focus.pendingEdits ? " · unsaved edits" : ""}
            <span className="why" title={focus.reason}> · “{focus.reason}”</span>
          </p>
          {focus.coverage && (
            <>
              <div className="ev">
                <EvidenceBar c={focus.coverage} />
                <span>{coverageSummary(focus.coverage)}</span>
              </div>
              {focus.coverage.next && <p className="next">Next: {focus.coverage.next}</p>}
            </>
          )}
        </div>
      ) : pursued.length ? (
        <div className="lit-ideas" role="list" aria-label="Pursued ideas">
          {pursued.map((p) => (
            <button key={p.target} role="listitem" className="lit-idea-row" onClick={() => onFocus(p.target)} title="Focus Literature on this idea">
              <span className="t">{p.title || "Untitled idea"}</span>
              <span className="v">
                v{p.version}
                {p.pendingEdits ? " · edits" : ""}
              </span>
              {p.coverage && (
                <span className="ev">
                  <EvidenceBar c={p.coverage} />
                  <span>{coverageSummary(p.coverage)}</span>
                  {p.coverage.next && <span className="next">{p.coverage.next}</span>}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="lit-empty">No pursued ideas yet. Mark ideas Pursue in the Ideas stage to work on them here.</p>
      )}
    </section>
  );
}
/** Keys that move the selected source: 1 primary, 2 secondary, 3 (or 0) other. */
const LEVEL_KEYS: Record<string, Level> = { "1": "primary", "2": "secondary", "3": "other", "0": "other" };
const DRAG_TYPE = "application/x-pi-research-source";

/** The library in sections: Primary, Secondary, then Other sources. Collapsed sections keep
 * their header (and count) but their rows leave keyboard navigation. */
export function librarySections<T extends { id: string }>(items: T[], levelOf: (id: string) => Level, collapsed: Set<Level>) {
  const sections = SECTIONS.map((level) => ({ level, items: items.filter((a) => levelOf(a.id) === level) }));
  return { sections, visible: sections.flatMap((s) => (collapsed.has(s.level) ? [] : s.items)) };
}

const hex = async (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
/** Electron prefixes remote errors; show only the reason. */
const reason = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
export const splitPaperRefs = (text: string) => text.split(/[\s,;]+/).filter(Boolean);
/** IDs and links are imported directly; anything else is searched on arXiv. */
const isReference = (t: string) =>
  /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(t) || /^[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?$/i.test(t) || /^https?:\/\//i.test(t);
export const wantsSearch = (text: string) => {
  const parts = splitPaperRefs(text);
  return text.trim().length >= 3 && parts.some((t) => !isReference(t));
};
/** Library names carry "(arXiv 1206.2305)" or "arXiv 1206.2305.pdf". */
export const arxivIdsInLibrary = (artifacts: { name: string }[]) =>
  new Set(artifacts.flatMap((a) => [...a.name.matchAll(/arXiv ([\w.-]+?)(?:v\d+)?(?:\)|\.pdf$)/g)].map((m) => m[1])));

/** Add papers input with arXiv title/author suggestions. Typing words asks
 * main for matches (debounced; main rate-limits to arXiv's 1 request / 3 s);
 * picking one imports it. IDs and links skip the search. */
function AddPaperForm({
  value,
  onChange,
  busy,
  search,
  inLibrary,
  onSubmit,
  onPick,
}: {
  value: string;
  onChange: (text: string) => void;
  busy: boolean;
  search?: (text: string) => Promise<PaperHitDTO[] | null>;
  inLibrary: Set<string>;
  onSubmit: () => void;
  onPick: (hit: PaperHitDTO) => void;
}) {
  const [hits, setHits] = useState<PaperHitDTO[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!search || !wantsSearch(value)) {
      setHits([]);
      setState("idle");
      return;
    }
    setState("searching");
    const timer = setTimeout(() => {
      search(value.trim()).then(
        (found) => {
          if (n !== seq.current || found === null) return;
          setHits(found);
          setCursor(found.length ? 0 : -1);
          setState("done");
        },
        (e) => {
          if (n !== seq.current) return;
          setError(reason(e));
          setState("error");
        },
      );
    }, 450);
    return () => clearTimeout(timer);
  }, [value, search]);
  const shown = open && state !== "idle";
  const pick = (hit: PaperHitDTO) => {
    setOpen(false);
    onPick(hit);
  };
  const byline = (h: PaperHitDTO) => {
    const names = h.authors.slice(0, 3).join(", ") + (h.authorCount > 3 ? " et al." : "");
    return [names, h.year, h.category, h.id].filter(Boolean).join(" · ");
  };
  return (
    <form
      className="add-paper"
      onSubmit={(e) => {
        e.preventDefault();
        if (shown && cursor >= 0 && hits[cursor]) pick(hits[cursor]);
        else if (!wantsSearch(value)) onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="paper-refs">
        Search arXiv, or enter arXiv IDs or PDF links
      </label>
      <div className="paper-combo">
        <input
          id="paper-refs"
          role="combobox"
          aria-expanded={shown}
          aria-controls="paper-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={shown && cursor >= 0 ? `paper-hit-${cursor}` : undefined}
          value={value}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search arXiv by title or author, or paste arXiv IDs / https PDF links"
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!shown) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (hits.length) setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {shown && (
          <div className="paper-suggest" id="paper-suggestions" role="listbox" aria-label="arXiv suggestions">
            {state === "searching" && <div className="hint">Searching arXiv…</div>}
            {state === "error" && <div className="hint error">arXiv search failed: {error}</div>}
            {state === "done" && !hits.length && <div className="hint">No arXiv papers match all of these words.</div>}
            {state !== "error" &&
              hits.map((h, i) => {
                const have = inLibrary.has(h.id.replace("/", "-"));
                return (
                  <div
                    key={h.id}
                    id={`paper-hit-${i}`}
                    role="option"
                    aria-selected={i === cursor}
                    className={`hit ${i === cursor ? "on" : ""}`}
                    // mousedown keeps focus in the input (blur would close the list first)
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(h);
                    }}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className="t">{h.title}</span>
                    <span className="b">
                      {byline(h)}
                      {have && <span className="tag">in library</span>}
                    </span>
                  </div>
                );
              })}
            <div className="foot">
              words must match a title or an author · <kbd>au:</kbd>/<kbd>ti:</kbd> to narrow · ↑↓ ⏎ · thanks to arXiv for use
              of its open access interoperability
            </div>
          </div>
        )}
      </div>
      <button className="btn small primary" disabled={busy || !value.trim() || wantsSearch(value)} type="submit">
        Add papers
      </button>
    </form>
  );
}

/** Universal artifact companion (§6): several open sources with pinning,
 * a library, and the explicit multi-paper annotation → frozen batch loop.
 * Open/active/pinned state is window-wide, so reading context survives stage
 * changes; each document's page is kept in its research draft. */
export function SourcesPane({ initialMode }: { initialMode?: Mode }) {
  const scope = useResearch();
  const { view, companion, setCompanion } = scope;
  const [chosenMode, setMode] = useState<Mode>(
    initialMode ?? (companion.active ? "read" : "library"),
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [refs, setRefs] = useState("");
  const [progress, setProgress] = useState("");
  const [dropping, setDropping] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string; notes: number; wasOpen: boolean } | null>(null);
  // Finder-style library: ↑↓ select, Space previews, Enter opens for work.
  const [cursor, setCursor] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  // Importance: optimistic until the backend's view catches up.
  const [rating, setRating] = useState<Record<string, Level>>({});
  const [collapsed, setCollapsed] = useState<Set<Level>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<Level | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [readerId] = useState(() => Math.random().toString(36).slice(2));
  const latestListKey = useRef<(key: string) => boolean>(() => false);
  /** Escape while reading: back to the library after any focused control handles it. */
  const latestBack = useRef<(() => boolean) | null>(null);
  // While this pane is the active tile, ↑↓ / Space / Enter drive the library
  // even if focus sits on the tile, its header or the page, not only the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const command = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      const editable = (el: Element | null) => !!el?.closest?.("input, textarea, select, [contenteditable=true]");
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && latestBack.current) {
        // Menus and Find consume Escape first; editors and dialogs keep their own Escape behavior.
        const reader = document.querySelector<HTMLElement>(`[data-sources-reader="${readerId}"]`);
        const tile = reader?.closest("[data-slot]");
        if (!tile?.classList.contains("active") || editable(e.target as Element) || editable(document.activeElement)
          || (e.target as Element | null)?.closest?.("[role=dialog]")) return;
        if (latestBack.current()) e.preventDefault();
        return;
      }
      const cmdDelete = command && e.key === "Backspace";
      if (!cmdDelete && (e.metaKey || e.ctrlKey || e.altKey)) return;
      if (!cmdDelete && !["ArrowDown", "ArrowUp", "Home", "End", " ", "Enter", ...Object.keys(LEVEL_KEYS)].includes(e.key)) return;
      const list = listRef.current;
      if (!list || !list.getClientRects().length) return;
      const tile = list.closest("[data-slot]");
      if (!tile?.classList.contains("active")) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused === list) return;
      const onPage = !focused || focused === document.body;
      if (!onPage && !tile.contains(focused)) return;
      if (!onPage && focused!.closest("input, textarea, select, button, a, [contenteditable=true], [role=dialog]")) return;
      if (!latestListKey.current(cmdDelete ? "CommandBackspace" : e.key)) return;
      e.preventDefault();
      list.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const upload = useAction(),
    annotate = useAction();
  let navigation: SourceNavigation | undefined;
  try { navigation = JSON.parse(scope.drafts["sources:navigation"] ?? "null") ?? undefined; } catch {}
  useEffect(() => {
    if (navigation?.id && navigation.artifactId === companion.active) setMode("read");
  }, [navigation?.id, companion.active]);
  if (!view) return <PaneLoading />;
  const artifacts: Artifact[] = view.artifacts ?? [];
  const annotations: Annotation[] = view.annotations ?? [];
  const batches: Batch[] = view.batches ?? [];
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const open = companion.open.filter((id) => byId.has(id));
  const active = companion.active && byId.has(companion.active) ? companion.active : null;
  const activeArtifact = active ? byId.get(active) : undefined;
  // Reading with nothing open (last paper closed, or deleted) shows the library.
  const mode: Mode = chosenMode === "read" && !activeArtifact ? "library" : chosenMode;

  const openArtifact = (id: string) => {
    let next = open.includes(id) ? open : [...open, id];
    // Keep at most 12 tabs; evict the oldest unpinned tab first.
    while (next.length > 12) {
      const victim = next.find((x) => !companion.pinned.includes(x) && x !== id);
      if (!victim) break;
      next = next.filter((x) => x !== victim);
    }
    setCompanion({ ...companion, open: next, active: id });
    setMode("read");
  };
  const saved: Record<string, Importance> = view.importance ?? {};
  // Literature works on one pursued idea at a time: its ranks replace the
  // library-wide sections while it is the focus (see docs/RESEARCH-FLOW.md).
  const pursued: PursuedIdea[] = scope.stage === "literature" ? (view.pursued ?? []) : [];
  const focus = pursued.find((p) => p.target === scope.drafts[LITERATURE_FOCUS]) ?? null;
  const setFocus = (target: string) => {
    setCollapsed(new Set());
    scope.setDraft(LITERATURE_FOCUS, target);
  };
  const rated = (id: string) => rating[`${focus?.target ?? ""}|${id}`];
  /** A note's idea links with titles and current versions (for the reader). */
  const linksOf = (noteId: string): NoteIdeaLink[] =>
    Object.entries((view.noteLinks ?? {})[noteId] ?? {}).map(([ideaId, l]: [string, any]) => {
      const p = ((view.pursued ?? []) as PursuedIdea[]).find((x) => x.target === `r:${ideaId}`);
      const versions = (view.science?.state?.versions ?? []).filter((v: any) => v.kind === "idea" && v.id === ideaId);
      return {
        ideaId,
        title: p?.title ?? view.ideaTitles?.[ideaId] ?? "Idea",
        stance: l.stance,
        onVersion: l.version,
        currentVersion: p?.version ?? (versions.length ? Math.max(...versions.map((v: any) => v.version)) : null),
      };
    });
  const levelOf = (id: string): Level => rated(id) ?? (focus ? focus.ranks[id] : saved[id]) ?? "other";
  const { sections, visible } = librarySections(artifacts, levelOf, collapsed);
  const grouped = artifacts.some((a) => levelOf(a.id) !== "other") || !!dragging;
  const reveal = (id: string) =>
    setTimeout(() => globalThis.document?.getElementById(`source-row-${id}`)?.scrollIntoView?.({ block: "nearest" }), 0);
  const selected = visible.find((a) => a.id === cursor) ?? null;
  const selectedIndex = selected ? visible.indexOf(selected) : -1;
  const step = (delta: number) => {
    if (!visible.length) return;
    const i =
      selectedIndex < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, selectedIndex + delta));
    setCursor(visible[i].id);
    reveal(visible[i].id);
  };
  /** Same operation agents use (source_importance); the row moves at once. */
  const rate = (id: string, level: Level) => {
    if (levelOf(id) === level) return;
    const key = `${focus?.target ?? ""}|${id}`;
    setRating((r) => ({ ...r, [key]: level }));
    // The row stays selected in its new section, which must be open.
    setCollapsed((c) => (c.has(level) ? new Set([...c].filter((x) => x !== level)) : c));
    reveal(id);
    scope.client
      .write("/native/source-importance", { artifactId: id, importance: level, ...(focus ? { idea: focus.target } : {}) })
      .then(
        () => scope.refresh().catch(() => {}),
        (e: unknown) => upload.setError(`Section not saved: ${reason(e)}`),
      )
      .finally(() =>
        setRating((r) => {
          const { [key]: _, ...rest } = r;
          return rest;
        }),
      );
  };
  const toggleSection = (level: Level) =>
    setCollapsed((c) => (c.has(level) ? new Set([...c].filter((x) => x !== level)) : new Set([...c, level])));
  const openFromList = (id: string) => {
    setPeek(false);
    openArtifact(id);
  };
  /** Library keys; true when handled. */
  const listKey = (key: string) => {
    if (key === "ArrowDown" || key === "ArrowUp") step(key === "ArrowDown" ? 1 : -1);
    else if (key === "Home" || key === "End") step(key === "Home" ? -visible.length : visible.length);
    else if (key === " ") {
      if (!selected) step(1);
      setPeek((p) => !p || !selected);
    } else if (key === "Enter" && selected) openFromList(selected.id);
    else if (key === "Escape" && peek) setPeek(false);
    else if (LEVEL_KEYS[key] && selected) rate(selected.id, LEVEL_KEYS[key]);
    else if (key === "CommandBackspace" && selected) {
      // ⌘⌫ like Finder's Move to Trash: no confirmation, because the notice
      // offers Undo and Recently deleted keeps it. Selection moves on.
      if (upload.busy) return true;
      const frozen = frozenIn(selected);
      if (frozen) {
        upload.setError(refusalText(selected, { refusal: { code: "frozen-batch", batch: frozen.hash.slice(0, 10) } }));
        return true;
      }
      const next = visible[selectedIndex + 1] ?? visible[selectedIndex - 1];
      setPeek(false);
      setCursor(next?.id ?? null);
      deleteArtifact(selected);
    }
    else return false;
    return true;
  };
  latestListKey.current = listKey;
  const backToLibrary = () => {
    setMode("library");
    setTimeout(() => listRef.current?.focus(), 0);
  };
  latestBack.current = mode === "read" ? () => (backToLibrary(), true) : null;
  const listKeys = (e: React.KeyboardEvent) => {
    // Keys belong to the list itself; buttons inside rows keep their own Space/Enter.
    if (e.target !== e.currentTarget) return;
    const cmdDelete = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "Backspace";
    if (!cmdDelete && (e.metaKey || e.ctrlKey || e.altKey)) return;
    if (listKey(cmdDelete ? "CommandBackspace" : e.key)) e.preventDefault();
  };
  const closeArtifact = (id: string) => {
    const next = open.filter((x) => x !== id);
    setCompanion({
      open: next,
      pinned: companion.pinned.filter((x) => x !== id),
      active: active === id ? (next.at(-1) ?? null) : active,
    });
    // Closing the paper being read returns to the library, not another tab.
    if (mode === "read" && active === id) setMode("library");
  };
  const togglePin = (id: string) =>
    setCompanion({
      ...companion,
      pinned: companion.pinned.includes(id)
        ? companion.pinned.filter((x) => x !== id)
        : [...companion.pinned, id],
    });
  /** Import files one by one against the latest revision; identical bytes
   * already in the library are opened instead of duplicated. `section` places
   * newly imported sources (existing ones keep theirs). */
  const ingest = async (items: { name: string; bytes: Uint8Array | ArrayBuffer; label?: string }[], section?: Importance, idea?: string) => {
    const done: string[] = [],
      skipped: string[] = [],
      unplaced: string[] = [];
    let last: string | undefined;
    for (const [i, item] of items.entries()) {
      setProgress(`Importing ${i + 1}/${items.length}: ${item.label ?? item.name}`);
      const latest = await scope.client.read("/native/research");
      const digest = await hex(item.bytes);
      const existing = (latest.artifacts as Artifact[]).find((a) => a.hash === digest);
      if (existing) {
        skipped.push(existing.name);
        last = existing.id;
        continue;
      }
      await scope.client.upload(new File([item.bytes as BlobPart], item.name), latest.revision);
      const after = await scope.client.read("/native/research");
      const added = (after.artifacts as Artifact[]).find((a) => a.hash === digest)?.id;
      last = added ?? last;
      done.push(item.name);
      // The import stands even if placing it fails; say so instead.
      if (added && section)
        await scope.client
          .write("/native/source-importance", { artifactId: added, importance: section, ...(idea ? { idea } : {}) })
          .catch(() => unplaced.push(item.name));
    }
    if (last) openArtifact(last);
    return [
      done.length ? `Imported ${done.length}: ${done.join(" · ")}` : "",
      skipped.length ? `Already in library: ${skipped.join(" · ")}` : "",
      unplaced.length ? `Left in Other sources: ${unplaced.join(" · ")}` : "",
    ]
      .filter(Boolean)
      .join("  ·  ");
  };
  const importFiles = (files: File[]) =>
    void upload
      .run(async () => {
        const items = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
        return (await ingest(items)) || "Nothing imported.";
      }, (summary) => summary)
      .finally(() => setProgress(""));
  const addPapers = (parts = splitPaperRefs(refs)) => {
    const fetchPaper = scope.client.bridge.fetchPaper;
    if (!parts.length || !fetchPaper) return;
    if (parts.length > 10) return upload.setError("Add at most 10 papers at a time.");
    void upload
      .run(async () => {
        const fetched: { name: string; bytes: Uint8Array; label: string }[] = [],
          failed: string[] = [];
        for (const [i, part] of parts.entries()) {
          setProgress(`Downloading ${i + 1}/${parts.length}: ${part}`);
          try {
            const paper = await fetchPaper(part);
            fetched.push({ name: paper.name, bytes: paper.bytes, label: paper.title ?? paper.name });
          } catch (e) {
            failed.push(`${part} — ${reason(e)}`);
          }
        }
        // Papers you pick from arXiv yourself start as primary sources (for the
        // focus idea in Literature, else library-wide).
        const summary = fetched.length ? await ingest(fetched, "primary", focus?.target) : "";
        setRefs(failed.length ? failed.map((f) => f.split(" — ")[0]).join(" ") : "");
        if (failed.length) upload.setError(`Not added: ${failed.join(" · ")}`);
        return summary;
      }, (summary) => summary)
      .finally(() => setProgress(""));
  };

  /** Delete after explicit confirmation. The backend refuses sources that are
   * in a frozen batch or cited by a scientific record, and says which. */
  const refusalText = (a: { name: string }, e: any) => {
    const r = e?.refusal;
    if (r?.code === "frozen-batch")
      return `"${a.name}" is part of frozen review batch ${r.batch}. Frozen history keeps its sources, so it can't be deleted.`;
    if (r?.code === "cited")
      return `"${a.name}" is cited by ${r.records.join(", ")}. Save a new version of that record without the citation, then delete.`;
    if (r?.code === "not-restorable") return `"${a.name}" is no longer in recently deleted.`;
    if (r?.code === "full") return "The library is full (200 sources or 1000 annotations); delete something first.";
    return reason(e);
  };
  const restoreArtifact = (d: { id: string; name: string; wasOpen?: boolean }) =>
    void upload.run(
      async () => {
        try {
          const latest = await scope.client.read("/native/research");
          await scope.client.write(`/artifacts/${d.id}/restore`, { revision: latest.revision });
        } catch (e) {
          throw new Error(refusalText(d, e));
        }
        setUndo(null);
        if (d.wasOpen)
          setCompanion({ ...companion, open: [...companion.open.filter((x) => x !== d.id), d.id], active: d.id });
      },
      () => `Restored ${d.name}.`,
    );
  const deleteArtifact = (a: Artifact) =>
    void upload
      .run(async () => {
        const wasOpen = companion.open.includes(a.id);
        const latest = await scope.client.read("/native/research");
        let result: any;
        try {
          result = await scope.client.write(`/artifacts/${a.id}/delete`, { revision: latest.revision });
        } catch (e) {
          throw new Error(refusalText(a, e));
        }
        setUndo({ id: a.id, name: a.name, notes: result.annotationsRemoved ?? 0, wasOpen });
        scope.setDraft("artifact:" + a.id, "");
        setCompanion({
          open: companion.open.filter((x) => x !== a.id),
          pinned: companion.pinned.filter((x) => x !== a.id),
          active: companion.active === a.id ? null : companion.active,
        });
        setPicked((old) => old.filter((id) => !annotations.some((n) => n.id === id && n.artifactId === a.id)));
      }, () => "")
      .finally(() => setConfirming(null));
  /** Frozen batches keep their sources; known client-side, so explain up front. */
  const frozenIn = (a: Artifact) => batches.find((b) => b.documents?.some((d) => d.id === a.id));

  const sourceRow = (a: Artifact) => {
      const notes = annotations.filter((n) => n.artifactId === a.id).length;
      const frozen = frozenIn(a);
      if (confirming === a.id)
        return (
          <div className="list-row confirm" key={a.id} role="alertdialog" aria-label={`Delete ${a.name}?`}>
            <span className="title">
              Delete {a.name}?
              <small>
                Removes the file{notes ? ` and its ${notes} annotation${notes === 1 ? "" : "s"}` : ""} from this
                strategy. Refused if a scientific record cites it.
              </small>
            </span>
            <button className="btn small danger" disabled={upload.busy} onClick={() => deleteArtifact(a)}>
              Delete
            </button>
            <button className="btn small ghost" disabled={upload.busy} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        );
      return (
        <div
          className={`list-row ${open.includes(a.id) ? "selected" : ""} ${cursor === a.id ? "cursor" : ""} ${dragging === a.id ? "dragging" : ""}`}
          key={a.id}
          id={`source-row-${a.id}`}
          role="option"
          aria-selected={cursor === a.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, a.id);
            e.dataTransfer.effectAllowed = "move";
            // Reveal the drop targets after the drag has begun: changing the
            // layout inside dragstart itself can make Chromium abort it.
            setTimeout(() => {
              setCursor(a.id);
              setDragging(a.id);
            }, 0);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropOn(null);
          }}
          onClick={() => {
            setCursor(a.id);
            listRef.current?.focus();
          }}
          onDoubleClick={() => openFromList(a.id)}
        >
          <span className="dim">{kindGlyph(a)}</span>
          <button
            className="title"
            style={{ textAlign: "left" }}
            tabIndex={-1}
            title="Click to select · Space to preview · double-click or Enter to open"
            onClick={(e) => {
              e.stopPropagation();
              setCursor(a.id);
              listRef.current?.focus();
            }}
            onDoubleClick={() => openFromList(a.id)}
          >
            {a.name}
            <small>
              {a.hash.slice(0, 12)} · {Math.max(1, Math.round(a.bytes / 1024))} KiB
              {notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}
            </small>
          </button>
          <select
            className={`importance-pick level-${levelOf(a.id)}`}
            aria-label={`Section of ${a.name}`}
            title="Section · keys 1 primary, 2 secondary, 3 other, or drag to a section"
            value={levelOf(a.id)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => rate(a.id, e.target.value as Level)}
          >
            {SECTIONS.map((level) => (
              <option key={level} value={level}>
                {importanceLabels[level]}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={(e) => (e.stopPropagation(), openFromList(a.id))}>
            {open.includes(a.id) ? "Show" : "Open"}
          </button>
          <button
            className="icon-btn"
            aria-label={`Delete ${a.name}`}
            title={
              frozen
                ? `Part of frozen review batch ${frozen.hash.slice(0, 10)}; frozen history keeps its sources`
                : "Delete this source"
            }
            disabled={upload.busy || !!frozen}
            onClick={() => setConfirming(a.id)}
          >
            ×
          </button>
        </div>
      );
  };

  const ordered = [
    ...open.filter((id) => companion.pinned.includes(id)),
    ...open.filter((id) => !companion.pinned.includes(id)),
  ];

  return (
    <div
      className={`pane-col ${dropping ? "file-drop" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (files.length) {
          setMode("library");
          importFiles(files.slice(0, 20));
        }
      }}
    >
      <div className="doc-tabs" role="tablist" aria-label="Open sources">
        {ordered.map((id) => {
          const a = byId.get(id)!;
          const pinned = companion.pinned.includes(id);
          const current = mode === "read" && id === active;
          return (
            <div className={`doc-tab ${current ? "active" : ""} ${pinned ? "pinned" : ""}`} key={id}>
              <button
                role="tab"
                aria-selected={current}
                title={`${a.name} · ${a.hash.slice(0, 12)}`}
                onClick={() => {
                  setCompanion({ ...companion, active: id });
                  setMode("read");
                }}
              >
                <span className="g">{pinned ? "◆" : kindGlyph(a)}</span>
                <span className="name">{a.name}</span>
              </button>
              <button
                className="x"
                aria-label={pinned ? `Unpin ${a.name}` : `Pin ${a.name}`}
                title={pinned ? "Unpin" : "Pin: keeps this source open and first"}
                onClick={() => togglePin(id)}
              >
                {pinned ? "◆" : "◇"}
              </button>
              {!pinned && (
                <button className="x" aria-label={`Close ${a.name}`} onClick={() => closeArtifact(id)}>
                  ×
                </button>
              )}
            </div>
          );
        })}
        <span className="spacer" />
        <button
          role="tab"
          aria-selected={mode === "library"}
          className={`mode ${mode === "library" ? "on" : ""}`}
          onClick={() => setMode("library")}
        >
          library <sup>{artifacts.length}</sup>
        </button>
        <button
          role="tab"
          aria-selected={mode === "review"}
          className={`mode ${mode === "review" ? "on" : ""}`}
          onClick={() => setMode("review")}
        >
          Review <sup>{picked.length} selected</sup>
        </button>
      </div>
      <div className={`pane-body ${mode === "read" ? "source-reading" : ""}`}>
        {mode === "read" && activeArtifact && (
          <div className="doc-host" data-sources-reader={readerId}>
            {/* The focus idea stays visible while reading (notes link to it). */}
            {scope.stage === "literature" && <FocusBar compact pursued={pursued} focus={focus} onFocus={setFocus} />}
            {annotate.notices}
            <NativeDocument
              key={active!}
              client={scope.client}
              artifact={activeArtifact}
              annotations={annotations}
              savedDraft={scope.drafts["artifact:" + active]}
              navigation={navigation?.artifactId === active ? navigation : undefined}
              onNavigation={(id) => {
                if (navigation?.id === id) scope.setDraft("sources:navigation", "");
              }}
              onDraft={(value) => {
                // Page 1 with nothing typed is the default; don't spend a draft slot on it.
                let trivial = false;
                try {
                  const d = JSON.parse(value);
                  trivial = d.page === 1 && !d.quote && !d.comment;
                } catch {}
                if (trivial && !scope.drafts["artifact:" + active]) return;
                scope.setDraft("artifact:" + active, trivial ? "" : value);
              }}
              onAnnotate={async (annotation) => {
                const saved = await annotate.run(async () => {
                  const latest = await scope.client.read("/native/research");
                  const result = await scope.client.write("/annotations", { revision: latest.revision, annotation });
                  // A new note made while Literature focuses an idea is linked to it
                  // (stance to be judged). Linking is separate: the note stands either way.
                  if (focus && !(annotation as { id?: string }).id) {
                    const before = new Set(((latest.annotations ?? []) as Annotation[]).map((n) => n.id));
                    const created = ((result?.annotations ?? []) as Annotation[]).find((n) => !before.has(n.id));
                    if (created)
                      await scope.client
                        .write("/native/note-links", { noteId: created.id, idea: focus.target, stance: "unclassified" })
                        .catch(() => {});
                  }
                }, focus && !(annotation as { id?: string }).id ? `Saved to notes and linked to “${focus.title}”.` : "Saved to notes, anchored to this immutable source.");
                if (!saved) throw new Error("Annotation not saved. Your comment has been retained.");
              }}
              onAsk={(text) => scope.appendComposer(text)}
              onDeleteAnnotation={async (id) => {
                let result: any;
                const ok = await annotate.run(async () => {
                  const latest = await scope.client.read("/native/research");
                  try {
                    result = await scope.client.write(`/annotations/${id}/delete`, { revision: latest.revision });
                  } catch (e: any) {
                    throw new Error(
                      e?.refusal?.code === "cited"
                        ? `This note is cited by ${e.refusal.records.join(", ")}. Scientific records keep exact references, so it can't be removed.`
                        : reason(e),
                    );
                  }
                }, "");
                if (!ok || !result) throw new Error("Note not removed.");
                setPicked((old) => old.filter((x) => x !== id));
                return result.annotation;
              }}
              onBack={backToLibrary}
              linksOf={linksOf}
              focusIdea={focus ? { id: focus.target.slice(2), title: focus.title, version: focus.version } : null}
              onReviseIdea={(noteId) => {
                if (!focus) return;
                void annotate.run(async () => {
                  // One registry operation (agents use idea_add_note); the window
                  // then takes you to the idea itself.
                  await scope.client.write("/native/idea-note", { noteId, idea: focus.target, show: false });
                  scope.setDraft(ACTIVE_IDEA, focus.target);
                  scope.goToStage?.("ideas", "idea");
                }, `Added to “${focus.title}” as an unsaved revision.`);
              }}
              onLink={(noteId, stance) => {
                if (!focus) return;
                void annotate.run(async () => {
                  await scope.client.write("/native/note-links", { noteId, idea: focus.target, stance });
                }, "");
              }}
              reviewPicked={picked}
              onTogglePick={(id) => setPicked((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]))}
            />
          </div>
        )}
        {mode === "library" && (
          <div className="pane-inner">
            {upload.notices}
            {undo && (
              <div className="notice undo" role="status">
                <div>
                  <span>
                    Deleted {undo.name}
                    {undo.notes ? ` and its ${undo.notes} annotation${undo.notes === 1 ? "" : "s"}` : ""}.
                  </span>
                </div>
                <button className="btn small primary" disabled={upload.busy} onClick={() => restoreArtifact(undo)}>
                  Undo
                </button>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setUndo(null)}>
                  ×
                </button>
              </div>
            )}
            {scope.stage === "literature" && (
              <FocusBar pursued={pursued} focus={focus} onFocus={setFocus} />
            )}
            <section className="block">
              <header className="source-library-header">
                <div className="source-library-heading">
                  <div className="source-library-title">
                    <h3>Your sources</h3>
                    <span className="source-library-count" aria-label={`${artifacts.length} sources`}>{artifacts.length}</span>
                  </div>
                  <p>Papers, passages, and the evidence behind your ideas.</p>
                </div>
                <label className="file-pick source-import-button">
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M10 13V3m0 0L6 7m4-4 4 4M3 12v5h14v-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{upload.busy ? "Importing…" : "Import files"}</span>
                  <input
                    type="file"
                    aria-label="Import source files"
                    multiple
                    accept=".pdf,.txt,.md,.tex,.csv,.png,.jpg,.jpeg"
                    disabled={upload.busy}
                    onChange={(e) => {
                      const files = [...(e.target.files ?? [])];
                      if (files.length) importFiles(files.slice(0, 20));
                      e.target.value = "";
                    }}
                  />
                </label>
              </header>
              {scope.client.bridge.fetchPaper && (
                <AddPaperForm
                  value={refs}
                  onChange={setRefs}
                  busy={upload.busy}
                  search={scope.client.bridge.searchPapers}
                  inLibrary={arxivIdsInLibrary(artifacts)}
                  onSubmit={() => addPapers()}
                  onPick={(hit) => {
                    // Already imported: open it instead of downloading again.
                    const existing = artifacts.find((a) => arxivIdsInLibrary([a]).has(hit.id.replace("/", "-")));
                    if (existing) {
                      setRefs("");
                      openArtifact(existing.id);
                    } else addPapers([hit.id]);
                  }}
                />
              )}
              <p className="note">
                {progress ||
                  "Type title or author words for arXiv suggestions (only the words go to arXiv). Downloads run only when you pick a paper or press Add papers: https links to public hosts only, PDFs up to 20 MiB, checked before import. Or drop files anywhere on this pane. Nothing is sent to Pi."}
              </p>
              <div
                ref={listRef}
                data-autofocus
                className="list source-list"
                role="listbox"
                aria-label="Sources"
                tabIndex={0}
                aria-activedescendant={selected ? `source-row-${selected.id}` : undefined}
                onKeyDown={listKeys}
                onFocus={(e) => e.target === e.currentTarget && !selected && visible[0] && setCursor(visible[0].id)}
              >
                {/* Always the same section structure (headers hidden while
                    everything is in Other): Chromium cancels a drag whose
                    source row is re-created, so starting a drag must not
                    re-parent rows. */}
                {sections.map(({ level, items }) =>
                      !items.length && !dragging ? null : (
                        <div
                          key={level}
                          className={`source-section level-${level} ${dropOn === level ? "drop" : ""}`}
                          role={grouped ? "group" : undefined}
                          aria-label={grouped ? `${importanceLabels[level]} sources · ${items.length}` : undefined}
                          onDragOver={(e) => {
                            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dropOn !== level) setDropOn(level);
                          }}
                          onDragLeave={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
                          }}
                          onDrop={(e) => {
                            const id = e.dataTransfer.getData(DRAG_TYPE);
                            if (!id) return;
                            e.preventDefault();
                            setDropOn(null);
                            setDragging(null);
                            rate(id, level);
                          }}
                        >
                          {grouped && <button
                            className="source-section-head"
                            tabIndex={-1}
                            aria-expanded={!collapsed.has(level)}
                            onClick={() => toggleSection(level)}
                          >
                            <span className="caret">{collapsed.has(level) ? "▸" : "▾"}</span>
                            <span className="name">{importanceLabels[level]} sources</span>
                            <span className="count">{items.length}</span>
                          </button>}
                          {!collapsed.has(level) && items.map(sourceRow)}
                          {!items.length && <p className="source-section-empty">Drop here</p>}
                        </div>
                      ),
                    )}
                {artifacts.length > 0 && (
                  <p className="list-hint">
                    ↑↓ select · space preview · ⏎ open · 1 primary · 2 secondary · 3 other · or drag
                  </p>
                )}
                {!artifacts.length && !(view.deleted ?? []).length && (
                  <p className="list-empty">
                    No sources yet. Import PDFs, text or images; originals stay intact and
                    annotations bind to their exact revision.
                  </p>
                )}
              </div>
            </section>
            {peek && selected && (
              <SourceQuickLook
                artifact={selected}
                position={selectedIndex + 1}
                total={visible.length}
                onClose={() => {
                  setPeek(false);
                  listRef.current?.focus();
                }}
                onOpen={() => openFromList(selected.id)}
                onStep={step}
              />
            )}
            {(view.deleted ?? []).length > 0 && (
              <details className="fold">
                <summary>Recently deleted · {view.deleted.length}</summary>
                <div className="fold-body" style={{ alignItems: "stretch" }}>
                  <div className="list">
                    {view.deleted.map((d: { artifact: Artifact; annotations: number; at: string }) => (
                      <div className="list-row" key={d.artifact.id}>
                        <span className="dim">{kindGlyph(d.artifact)}</span>
                        <span className="title">
                          {d.artifact.name}
                          <small>
                            deleted {formatTime(d.at)?.full ?? d.at}
                            {d.annotations ? ` · ${d.annotations} annotation${d.annotations === 1 ? "" : "s"}` : ""}
                          </small>
                        </span>
                        <button
                          className="btn small"
                          disabled={upload.busy}
                          onClick={() => restoreArtifact({ id: d.artifact.id, name: d.artifact.name })}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="note">
                    The last 20 deleted sources are kept with their annotations and can be restored with their
                    original identity. Older ones are removed for good.
                  </p>
                </div>
              </details>
            )}
          </div>
        )}
        <div hidden={mode !== "review"}><ReviewPane picked={picked} setPicked={setPicked} instruction={instruction} setInstruction={setInstruction} openArtifact={openArtifact} choosePaper={() => setMode("library")} /></div>

      </div>
    </div>
  );
}
