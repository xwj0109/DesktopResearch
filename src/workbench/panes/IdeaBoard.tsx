import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import type { Annotation, Artifact } from "../../shared";
import { ideaSchema, versionInput } from "../../platform";
import { initialValue, pruneBlankItems } from "../ResearchForm";
import { PaneLoading, useAction, useResearch } from "../research";
import { ideaStatus, type IdeaBoardOp } from "../../idea-board-contract";
import { ACTIVE_IDEA } from "../WorkbenchEvents";
import { LITERATURE_FOCUS } from "../../workbench-contract";

/** Idea board: brainstorm drafts and saved ideas grouped by status.
 *
 * The board lives in the strategy store (shared with agents through the
 * backend's workbench tools); this pane shows it with an optimistic local
 * overlay and sends board operations: typing is debounced per idea and sends
 * only changed fields. Drafts are free (add, edit, duplicate, delete with
 * undo). Saving creates an immutable idea version;
 * editing a saved idea keeps a draft of its next version until saved or
 * discarded. Status columns follow explicit `idea.decide` records (each needs
 * a reason). Saved ideas are never deleted, only archived (hidden) here. */

type Uncertainty = "assumed" | "conjectured" | "derived" | "cited" | "tested";
interface Evidence {
  category: Uncertainty;
  reference: { id: string; hash: string };
  description: string;
}
export interface IdeaContent {
  title: string;
  rationale: string;
  universe: string;
  horizon: string;
  falsification: string;
  uncertainty: Uncertainty;
  evidence: Evidence[];
}
interface DraftCard {
  key: string;
  content: IdeaContent;
  updated: string;
}
export interface Board {
  v: 1;
  cards: DraftCard[];
  /** Unsaved edits to saved ideas, by record id. */
  edits: Record<string, IdeaContent>;
  /** Saved idea record ids hidden from the board. */
  archived: string[];
}
type Column = "brainstorm" | "decide" | "pursue" | "revise" | "reject";
type Decision = "pursue" | "revise" | "reject";
interface Card {
  /** "d:<key>" for drafts, "r:<record id>" for saved ideas. */
  key: string;
  draft?: DraftCard;
  recordId?: string;
  latest?: { id: string; hash: string; version: number; created: string };
  content?: IdeaContent;
  edited: boolean;
  column: Column;
  reason?: string;
  /** The decision behind the status (may be on an earlier version: pursue carries). */
  decision?: ReturnType<typeof ideaStatus>["decision"];
  updated: string;
}

export const BOARD_KEY = "ideas:board";
const LEGACY_KEY = "ideas:idea";
const MAX_CARDS = 100;
const LEVELS: Uncertainty[] = ["assumed", "conjectured", "derived", "cited", "tested"];
const LEVEL_HINT: Record<Uncertainty, string> = {
  assumed: "taken as given, not argued",
  conjectured: "plausible, not yet shown",
  derived: "follows from stated premises",
  cited: "supported by a source",
  tested: "checked against data",
};
const FIELDS: { name: keyof IdeaContent; label: string; hint: string }[] = [
  { name: "rationale", label: "Rationale", hint: "Why should this work? The mechanism, and who is on the other side of the trade." },
  { name: "universe", label: "Universe", hint: "What is traded: asset(s), venue, data frequency." },
  { name: "horizon", label: "Horizon", hint: "Holding period and how often positions change." },
  { name: "falsification", label: "Falsification", hint: "What result would prove this wrong?" },
];
/** Status sections, top to bottom. */
const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: "brainstorm", label: "Brainstorm", hint: "unsaved drafts" },
  { id: "decide", label: "To decide", hint: "saved, no decision yet" },
  { id: "pursue", label: "Pursue", hint: "" },
  { id: "revise", label: "Revise", hint: "" },
];

export const blankIdea = (): IdeaContent => initialValue(ideaSchema);
const emptyBoard = (): Board => ({ v: 1, cards: [], edits: {}, archived: [] });
const now = () => new Date().toISOString();

/** Parse the stored board; on first use, adopt the old single-form draft. */
export function readBoard(drafts: Record<string, string>): { board: Board; migrated: boolean } {
  try {
    const raw = drafts[BOARD_KEY] ? JSON.parse(drafts[BOARD_KEY]) : undefined;
    if (raw?.v === 1)
      return {
        board: {
          v: 1,
          cards: Array.isArray(raw.cards) ? raw.cards.filter((c: any) => c?.key && c?.content) : [],
          edits: raw.edits && typeof raw.edits === "object" ? raw.edits : {},
          archived: Array.isArray(raw.archived) ? raw.archived.filter((x: any) => typeof x === "string") : [],
        },
        migrated: false,
      };
  } catch {}
  const board = emptyBoard();
  try {
    const legacy = drafts[LEGACY_KEY] ? JSON.parse(drafts[LEGACY_KEY]) : undefined;
    const content = legacy?.nativeDraft === 1 ? legacy.content : undefined;
    if (content && typeof content === "object") {
      const merged = { ...blankIdea(), ...content };
      if (legacy.id) board.edits[legacy.id] = merged;
      else board.cards.push({ key: crypto.randomUUID(), content: merged, updated: now() });
      return { board, migrated: true };
    }
  } catch {}
  return { board, migrated: false };
}

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field → first problem, for inline messages under each field. */
function fieldErrors(content: IdeaContent) {
  const parsed = versionInput.safeParse({ kind: "idea", content });
  const out: Record<string, string> = {};
  if (parsed.success) return { out, error: undefined };
  for (const issue of parsed.error.issues) {
    const [, field, index, sub] = issue.path.map(String);
    const key = field === "evidence" && index !== undefined ? `evidence.${index}.${sub === "reference" ? "reference" : sub}` : field;
    out[key] ??= sub === "reference" ? "pick a paper or saved record" : issue.code === "too_small" || issue.code === "invalid_type" ? "required" : issue.message;
  }
  return { out, error: parsed.error };
}

export function ideaMarkdown(c: IdeaContent, label: (id: string) => string) {
  return [
    `Idea: ${c.title || "Untitled"}`,
    ...FIELDS.filter((f) => String(c[f.name] ?? "").trim()).map((f) => `${f.label}: ${String(c[f.name]).trim()}`),
    `Uncertainty: ${c.uncertainty}`,
    ...(c.evidence.length
      ? ["Evidence:", ...c.evidence.map((e) => `- [${e.category}] ${e.reference?.id ? label(e.reference.id) : "no reference"}: ${e.description}`)]
      : []),
  ].join("\n");
}

export function IdeaBoard() {
  const scope = useResearch();
  const action = useAction();
  const open = scope.drafts[ACTIVE_IDEA] || null;
  const setOpen = (key: string | null) => scope.setDraft(ACTIVE_IDEA, key ?? "");
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState<Record<string, IdeaContent>>({});
  const [undo, setUndo] = useState<{ text: string; restore: () => void } | null>(null);
  const [deciding, setDeciding] = useState<{ key: string; decision: Decision } | null>(null);
  const [reason, setReason] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [dropTarget, setDropTarget] = useState<Column | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Column[]>([]);
  /* ── board sync: server state + optimistic overlay ─────────────── */
  const serverBoard: Board = scope.view?.ideas ? { v: 1, ...scope.view.ideas } : emptyBoard();
  const [overlay, setOverlay] = useState<Board | null>(null);
  const board = overlay ?? serverBoard;
  const boardRef = useRef<Board>(board);
  boardRef.current = board;
  const inflight = useRef(0);
  const typing = useRef(new Map<string, { base: IdeaContent; latest: IdeaContent; timer: ReturnType<typeof setTimeout> }>());
  const settle = async () => {
    if (inflight.current || typing.current.size) return;
    await scope.refresh().catch(() => {});
    if (!inflight.current && !typing.current.size) setOverlay(null);
  };
  const send = (op: IdeaBoardOp) => {
    inflight.current++;
    return scope.client
      .write("/native/ideas", op)
      .then(
        () => true,
        (e: any) => (action.setError(`Idea board not saved: ${String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`), false),
      )
      .finally(() => {
        inflight.current--;
        void settle();
      });
  };
  const local = (fn: (b: Board) => Board) => {
    const next = fn(boardRef.current);
    boardRef.current = next;
    setOverlay(next);
  };
  /** Send pending typing for one idea (or all) as a patch of changed fields. */
  const flush = (target?: string) => {
    const sends: Promise<boolean>[] = [];
    for (const [t, entry] of [...typing.current]) {
      if (target && t !== target) continue;
      clearTimeout(entry.timer);
      typing.current.delete(t);
      const patch = Object.fromEntries(
        Object.entries(entry.latest).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((entry.base as any)[k])),
      );
      if (Object.keys(patch).length) sends.push(send({ op: "patch", target: t as `d:${string}`, patch }));
    }
    if (!sends.length) void settle();
    return Promise.all(sends);
  };
  useEffect(() => () => void flush(), []);
  // One-time adoption of a board older builds kept in this window's drafts.
  const { board: legacy, migrated } = readBoard(scope.drafts);
  const hasLegacy = !!scope.drafts[BOARD_KEY] || migrated;
  useEffect(() => {
    if (!hasLegacy || !scope.view) return;
    void send({ op: "adopt", board: { cards: legacy.cards, edits: legacy.edits, archived: legacy.archived } }).then((ok) => {
      if (!ok) return;
      scope.setDraft(BOARD_KEY, "");
      scope.setDraft(LEGACY_KEY, "");
    });
  }, [hasLegacy, !!scope.view]);

  const science = scope.view?.science?.state;
  const versions: any[] = (science?.versions ?? []).filter((v: any) => v.kind === "idea");
  const latestById = useMemo(() => {
    const m = new Map<string, any>();
    for (const v of versions) if (!m.has(v.id) || m.get(v.id).version < v.version) m.set(v.id, v);
    return m;
  }, [scope.view]);

  // Saved content is fetched once per exact version.
  useEffect(() => {
    for (const v of latestById.values()) {
      const k = v.id + v.hash;
      if (loaded[k]) continue;
      scope.client
        .read(`/science/versions/${v.id}/${v.hash}`)
        .then((r: any) => r?.value?.content && setLoaded((old) => ({ ...old, [k]: r.value.content })))
        .catch(() => {});
    }
  }, [latestById]);

  const artifacts: Artifact[] = scope.view?.artifacts ?? [];
  const annotations: Annotation[] = scope.view?.annotations ?? [];
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of artifacts) m.set(a.id, a.name.replace(/\.pdf$/i, ""));
    for (const b of scope.view?.batches ?? []) if (b.annotations.length) m.set(b.id, `Review: ${b.instruction.slice(0, 100)}`);
    for (const v of science?.versions ?? []) m.set(v.id, `${v.kind} v${v.version} (${v.id.slice(0, 8)})`);
    return m;
  }, [scope.view]);
  const label = (id: string) => labels.get(id) ?? id.slice(0, 8);

  if (!scope.view) return <PaneLoading />;

  const decisionOf = (v: any) => {
    const d = [...(science?.decisions ?? [])]
      .filter((x: any) => x.target.id === v.id && x.target.hash === v.hash)
      .sort((a: any, b: any) => String(a.at).localeCompare(String(b.at)))
      .at(-1);
    return d as { decision: Decision; reason: string; at: string } | undefined;
  };
  const cards: Card[] = [
    ...board.cards.map((d) => ({ key: "d:" + d.key, draft: d, content: d.content, edited: true, column: "brainstorm" as Column, updated: d.updated })),
    ...[...latestById.values()].map((v) => {
      const st = ideaStatus(v, versions, science?.decisions ?? []);
      const edit = board.edits[v.id];
      return {
        key: "r:" + v.id,
        recordId: v.id,
        latest: v,
        content: edit ?? loaded[v.id + v.hash],
        edited: !!edit,
        column: (st.status === "to-decide" ? "decide" : st.status) as Column,
        // A revise/reject answered by a newer version no longer explains the row.
        reason: st.status === "to-decide" ? undefined : st.decision?.reason,
        decision: st.decision,
        updated: v.created,
      };
    }),
  ];
  const archived = new Set(board.archived);
  const visible = cards.filter((c) => !(c.recordId && archived.has(c.recordId)));
  const q = filter.trim().toLowerCase();
  const matches = (c: Card) =>
    !q || [c.content?.title, c.content?.rationale, c.content?.universe].some((t) => String(t ?? "").toLowerCase().includes(q));
  const byColumn = (col: Column) =>
    visible.filter((c) => c.column === col && matches(c)).sort((a, b) => b.updated.localeCompare(a.updated));

  /** Pursued ideas continue in Literature: focus it there and go (step 5). */
  const workOnInLiterature = (card: Card) => {
    if (!card.recordId) return;
    scope.setDraft(LITERATURE_FOCUS, `r:${card.recordId}`);
    scope.goToStage?.("literature", "sources");
  };
  /* ── mutations ───────────────────────────────────────────────────── */
  const newIdea = (content = blankIdea()) => {
    if (board.cards.length >= MAX_CARDS) return action.setError(`At most ${MAX_CARDS} draft ideas; save or delete some first.`);
    const card = { key: crypto.randomUUID(), content, updated: now() };
    local((b) => ({ ...b, cards: [card, ...b.cards] }));
    void send({ op: "create", key: card.key, content });
    setOpen("d:" + card.key);
  };
  const setContent = (card: Card, content: IdeaContent) => {
    if (!card.content) return;
    if (card.draft)
      local((b) => ({ ...b, cards: b.cards.map((d) => (d.key === card.draft!.key ? { ...d, content, updated: now() } : d)) }));
    else if (card.recordId) {
      const saved = loaded[card.latest!.id + card.latest!.hash];
      local((b) => {
        const edits = { ...b.edits };
        // Typing back to the saved text clears the pending edit.
        if (saved && same(saved, content)) delete edits[card.recordId!];
        else edits[card.recordId!] = content;
        return { ...b, edits };
      });
    }
    const pending = typing.current.get(card.key);
    if (pending) clearTimeout(pending.timer);
    typing.current.set(card.key, {
      base: pending?.base ?? card.content,
      latest: content,
      timer: setTimeout(() => void flush(card.key), 1200),
    });
  };
  const discardEdits = (card: Card) => {
    typing.current.delete(card.key);
    local((b) => {
      const edits = { ...b.edits };
      delete edits[card.recordId!];
      return { ...b, edits };
    });
    void send({ op: "discard", recordId: card.recordId! });
  };
  const duplicate = (card: Card) => {
    if (!card.content) return;
    newIdea({ ...card.content, title: card.content.title ? `${card.content.title} (copy)` : "" });
  };
  const remove = (card: Card) => {
    const title = card.content?.title || "Untitled idea";
    if (card.draft) {
      const d = card.draft;
      const at = Math.max(0, boardRef.current.cards.findIndex((x) => x.key === d.key));
      typing.current.delete(card.key);
      local((b) => ({ ...b, cards: b.cards.filter((x) => x.key !== d.key) }));
      void send({ op: "delete", key: d.key });
      setUndo({
        text: `Deleted “${title}”.`,
        restore: () => {
          local((b) => ({ ...b, cards: [...b.cards.slice(0, at), d, ...b.cards.slice(at)] }));
          void send({ op: "restore", card: d, index: at });
        },
      });
    } else if (card.recordId) {
      const id = card.recordId;
      local((b) => ({ ...b, archived: [...b.archived.filter((x) => x !== id), id] }));
      void send({ op: "archive", recordId: id });
      setUndo({ text: `Archived “${title}”. Saved versions are kept.`, restore: () => unarchive(id) });
    }
    if (open === card.key) setOpen(null);
  };
  const unarchive = (id: string) => {
    local((b) => ({ ...b, archived: b.archived.filter((x) => x !== id) }));
    void send({ op: "unarchive", recordId: id });
  };
  /** Permanently delete an archived idea: every version, its decisions and
   * its stored text. The backend refuses while another record cites it. */
  const deleteForever = (card: Card) => {
    const id = card.recordId!,
      title = card.content?.title || "Untitled idea";
    void action
      .run(
        async () => {
          try {
            await action.sendCommand({ type: "idea.delete", id });
          } catch (e: any) {
            throw new Error(
              e?.refusal?.code === "cited"
                ? `“${title}” is cited by ${e.refusal.records.join(", ")}. Records keep exact references, so it can't be deleted.`
                : (e?.message ?? String(e)),
            );
          }
          local((b) => {
            const edits = { ...b.edits };
            delete edits[id];
            return { ...b, edits, archived: b.archived.filter((x) => x !== id) };
          });
          await send({ op: "discard", recordId: id });
          await send({ op: "unarchive", recordId: id });
        },
        () => `Deleted “${title}” permanently.`,
      )
      .finally(() => setConfirmDelete(null));
  };

  /** Save the next immutable version (v1 for a draft). Returns the record id. */
  const save = async (card: Card): Promise<string | undefined> => {
    if (!card.content) return;
    await flush(card.key);
    const content = pruneBlankItems(ideaSchema, card.content) as IdeaContent;
    let recordId = card.recordId;
    const ok = await action.run(
      async () => {
        const input = versionInput.parse({ kind: "idea", content });
        const before = new Set(versions.map((v) => v.id));
        await action.sendCommand({ type: "version.create", value: input, ...(recordId ? { id: recordId } : {}) });
        if (card.draft) {
          const latest: any = await scope.client.read("/native/research");
          recordId = (latest?.science?.state?.versions ?? []).find((v: any) => v.kind === "idea" && !before.has(v.id))?.id;
          local((b) => ({ ...b, cards: b.cards.filter((x) => x.key !== card.draft!.key) }));
          await send({ op: "delete", key: card.draft!.key });
        } else discardEdits(card);
      },
      () => `Saved “${content.title}” as a new immutable version.`,
    );
    if (!ok) return;
    if (recordId && open === card.key) setOpen("r:" + recordId);
    return recordId;
  };
  const decide = async (card: Card, decision: Decision, why: string) => {
    if (!card.latest) return false;
    const ok = await action.run(
      () =>
        action.sendCommand({
          type: "idea.decide",
          target: { id: card.latest!.id, hash: card.latest!.hash },
          decision,
          reason: why.trim(),
        }),
      () => `Recorded “${decision}” on v${card.latest!.version}.`,
    );
    if (ok) {
      setDeciding(null);
      setReason("");
    }
    return ok;
  };
  const askDecision = (card: Card, decision: Decision) => {
    setDeciding({ key: card.key, decision });
    setReason("");
  };
  /** Drag between columns: drafts dropped on a status are saved first. */
  const moveTo = async (card: Card, col: Column) => {
    if (card.column === col) return;
    if (col === "brainstorm") return action.setError("Saved ideas stay saved. Use Duplicate to start a new draft from one.");
    if (col === "decide") {
      if (card.draft) await save(card);
      else action.setError("Decisions are kept in history. Record a new decision, or save a new version to decide again.");
      return;
    }
    if (card.draft) {
      const id = await save(card);
      if (id) askDecision({ ...card, key: "r:" + id, draft: undefined, recordId: id }, col as Decision);
      return;
    }
    if (card.edited) return action.setError("Save or discard the edits first: a decision applies to an exact saved version.");
    askDecision(card, col as Decision);
  };
  const askPi = (card: Card) => {
    if (!card.content) return;
    scope.appendComposer(`${ideaMarkdown(card.content, label)}\n\nCritique and sharpen this strategy idea.`);
    action.setStatus("Idea added to the Pi composer. Nothing is sent until you press Send.");
  };

  const current = open ? cards.find((c) => c.key === open) : undefined;
  const noticeBar = (
    <>
      {action.notices}
      {undo && (
        <div className="notice undo" role="status">
          <span>{undo.text}</span>
          <button className="btn small" onClick={() => (undo.restore(), setUndo(null))}>
            Undo
          </button>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setUndo(null)}>
            ×
          </button>
        </div>
      )}
    </>
  );
  const reasonPrompt = (card: Card) =>
    deciding?.key === card.key && (
      <form
        className="idea-reason"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) void decide(card, deciding.decision, reason);
        }}
      >
        <input
          autoFocus
          aria-label={`Reason to ${deciding.decision}`}
          placeholder={`Why ${deciding.decision}? ⏎ to record`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setDeciding(null))}
        />
        <button className="btn small primary" disabled={!reason.trim() || action.busy} type="submit">
          {deciding.decision}
        </button>
      </form>
    );

  if (current)
    return (
      <IdeaEditor
        card={current}
        notices={noticeBar}
        busy={action.busy}
        labels={label}
        artifacts={artifacts}
        annotations={annotations}
        versions={versions.filter((v) => v.id === current.recordId).sort((a, b) => b.version - a.version)}
        records={(science?.versions ?? [])
          .filter((v: any) => v.id !== current.recordId)
          .map((v: any) => ({ id: v.id, hash: v.hash, label: `${v.kind} v${v.version} (${v.id.slice(0, 8)})` }))}
        decisionOf={decisionOf}
        reasonPrompt={reasonPrompt(current)}
        onBack={() => {
          void flush(current.key);
          setOpen(null);
        }}
        onChange={(c) => setContent(current, c)}
        onSave={() => void save(current)}
        onDiscard={() => discardEdits(current)}
        onDuplicate={() => duplicate(current)}
        onRemove={() => remove(current)}
        onAsk={() => askPi(current)}
        onLiterature={current.column === "pursue" && current.recordId ? () => workOnInLiterature(current) : undefined}
        onDecide={(d) => askDecision(current, d)}
        onRestoreVersion={async (v) => {
          const r: any = await scope.client.read(`/science/versions/${v.id}/${v.hash}`);
          if (r?.value?.content) setContent(current, r.value.content);
        }}
      />
    );

  const cardView = (card: Card) => {
    const c = card.content;
    const decisions = card.recordId && !card.edited ? (["pursue", "revise", "reject"] as Decision[]).filter((d) => d !== card.column) : [];
    const second = card.reason ? `“${card.reason}”` : c?.rationale;
    return (
      <article
        key={card.key}
        className={`idea-row ${card.column} ${deciding?.key === card.key || menuFor === card.key ? "active" : ""}`}
        draggable
        onDragStart={(e: DragEvent) => {
          e.dataTransfer.setData("text/x-idea", card.key);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => setOpen(card.key)}
        onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && e.target === e.currentTarget && setOpen(card.key)}
        tabIndex={0}
        aria-label={`Idea: ${c?.title || "Untitled idea"}`}
      >
        <i className={`dot ${card.draft ? "hollow" : ""}`} />
        <div className="main">
          <h4>{c ? c.title || <span className="dim">Untitled idea</span> : <span className="dim">loading…</span>}</h4>
          {second && <p className={card.reason ? "why" : "snippet"}>{second}</p>}
        </div>
        <div className="side" onClick={(e) => e.stopPropagation()}>
          <span className="meta">
            {card.edited && !card.draft && <span className="tag warn">edited</span>}
            {card.draft ? `draft · ${ago(card.updated)}` : `v${card.latest!.version}`}
            {!!c?.evidence?.length && ` · ${c.evidence.length} ev`}
          </span>
          <span className="acts">
            {!!decisions.length && (
              <button
                className={`icon-btn ${menuFor === card.key ? "on" : ""}`}
                title="Decide: pursue, revise or reject"
                aria-label="Decide"
                aria-expanded={menuFor === card.key}
                onClick={() => setMenuFor((m) => (m === card.key ? null : card.key))}
              >
                ⇢
              </button>
            )}
            {card.column === "pursue" && card.recordId && (
              <button className="icon-btn" title="Work on in Literature (focus this idea there)" aria-label="Work on in Literature" onClick={() => workOnInLiterature(card)}>
                ↗
              </button>
            )}
            <button className="icon-btn" title="Ask Pi about this idea" aria-label="Ask Pi" onClick={() => askPi(card)}>
              π
            </button>
            <button className="icon-btn" title="Duplicate as a new draft" aria-label="Duplicate" onClick={() => duplicate(card)}>
              ⧉
            </button>
            <button
              className="icon-btn"
              title={card.draft ? "Delete draft" : "Archive (can be restored)"}
              aria-label={card.draft ? "Delete" : "Archive"}
              onClick={() => remove(card)}
            >
              ×
            </button>
          </span>
        </div>
        {menuFor === card.key && !deciding && (
          <div className="idea-decide" onClick={(e) => e.stopPropagation()}>
            <span className="dim">move to</span>
            {decisions.map((d) => (
              <button key={d} className={`btn small ${d}`} onClick={() => (setMenuFor(null), askDecision(card, d))}>
                {d}
              </button>
            ))}
          </div>
        )}
        {reasonPrompt(card)}
      </article>
    );
  };
  const dropProps = (col: Column) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("text/x-idea")) return;
      e.preventDefault();
      if (dropTarget !== col) setDropTarget(col);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const card = cards.find((c) => c.key === e.dataTransfer.getData("text/x-idea"));
      if (card) void moveTo(card, col);
    },
  });
  const rejectedCount = visible.filter((c) => c.column === "reject").length;
  const archivedCards = cards.filter((c) => c.recordId && archived.has(c.recordId));
  const columns = [...COLUMNS, ...(showRejected ? [{ id: "reject" as Column, label: "Rejected", hint: "decided against" }] : [])];

  return (
    <div className="pane-inner idea-board">
      <header className="idea-overview">
        <div><span className="idea-eyebrow">Research notebook</span><h2>Ideas worth exploring</h2><p>Capture a hypothesis. Shape the argument. Decide what to pursue.</p></div>
        <div className="idea-total"><strong>{visible.length}</strong><span>{visible.length === 1 ? "idea" : "ideas"}</span></div>
      </header>
      <div className="idea-toolbar">
        <button className="btn small primary" onClick={() => newIdea()}>
          + New idea
        </button>
        <input className="idea-filter" aria-label="Filter ideas" placeholder="Search ideas…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="spacer" />
        <button
          className={`idea-toggle ${showRejected ? "on" : ""}`}
          aria-pressed={showRejected}
          aria-label="Show rejected"
          onClick={() => (setShowRejected((v) => !v), setShowArchived(false))}
        >
          rejected <span className="count">{rejectedCount}</span>
        </button>
        <button
          className={`idea-toggle ${showArchived ? "on" : ""}`}
          aria-pressed={showArchived}
          aria-label="Show archived"
          disabled={!archivedCards.length && !showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          archived <span className="count">{archivedCards.length}</span>
        </button>
        <span
          className="idea-help"
          title={
            "Drafts autosave in this window. Save makes an immutable version other records can cite.\n" +
            "Drag an idea into another section, or use ⇢ on it, to record a decision with a reason.\n" +
            "× archives a saved idea; delete it for good from Archived."
          }
        >
          ?
        </span>
      </div>
      {noticeBar}
      {showArchived && archivedCards.length ? (
        <section className="idea-archive" aria-label="Archived">
          <header>
            <button className="btn small ghost" onClick={() => setShowArchived(false)}>
              ← Board
            </button>
            <span>Archived ideas are hidden from the board. Restore one, or delete it for good.</span>
          </header>
          <div className="list">
            {archivedCards.map((c) => {
              const n = versions.filter((v) => v.id === c.recordId).length;
              const title = c.content?.title || "Untitled idea";
              if (confirmDelete === c.key)
                return (
                  <div className="list-row confirm" key={c.key} role="alertdialog" aria-label={`Delete ${title}?`}>
                    <span className="title">
                      Delete “{title}” permanently?
                      <small>
                        Erases {n === 1 ? "its only version" : `all ${n} versions`} and the decisions on {n === 1 ? "it" : "them"}. This can't be undone.
                      </small>
                    </span>
                    <button className="btn small danger" disabled={action.busy} onClick={() => deleteForever(c)}>
                      Delete
                    </button>
                    <button className="btn small ghost" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </div>
                );
              return (
                <div className="list-row" key={c.key}>
                  <span className="title">
                    {title} <small>v{c.latest?.version}</small>
                  </span>
                  <button className="btn small" onClick={() => unarchive(c.recordId!)}>
                    Restore
                  </button>
                  <button className="btn small ghost" onClick={() => setConfirmDelete(c.key)}>
                    Delete…
                  </button>
                </div>
              );
            })}
            {!archivedCards.length && <p className="list-empty">Nothing archived.</p>}
          </div>
        </section>
      ) : (
        <div className="idea-list">
          {columns.map((col) => {
            const list = byColumn(col.id);
            const shut = collapsed.includes(col.id);
            return (
              <section
                key={col.id}
                className={`idea-group ${col.id} ${dropTarget === col.id ? "drop" : ""}`}
                aria-label={col.label}
                {...dropProps(col.id)}
              >
                <header>
                  <button
                    className="group-head"
                    aria-expanded={!shut}
                    title={col.hint || undefined}
                    onClick={() => setCollapsed((c) => (shut ? c.filter((x) => x !== col.id) : [...c, col.id]))}
                  >
                    <span className="caret">{shut ? "▸" : "▾"}</span>
                    <span className="label">{col.label}</span>
                    <span className="count">{list.length}</span>
                  </button>
                  {col.id === "brainstorm" && (
                    <button className="icon-btn" aria-label="New idea" title="New idea" onClick={() => newIdea()}>
                      +
                    </button>
                  )}
                </header>
                {!shut && (
                  <div className="idea-group-body">
                    {list.map(cardView)}
                    {!list.length && (
                      <p className="idea-empty">
                        {col.id === "brainstorm" ? (
                          <button className="btn small ghost" onClick={() => newIdea()}>
                            + jot down an idea
                          </button>
                        ) : q ? (
                          "no matches"
                        ) : (
                          col.id === "decide" ? "Save a draft when it is ready for a decision." : col.id === "pursue" ? "Ideas you choose to investigate appear here." : col.id === "revise" ? "Ideas that need another pass appear here." : "No rejected ideas."
                        )}
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IdeaEditor({
  card,
  notices,
  busy,
  labels,
  artifacts,
  annotations,
  versions,
  records,
  decisionOf,
  reasonPrompt,
  onBack,
  onChange,
  onSave,
  onDiscard,
  onDuplicate,
  onRemove,
  onAsk,
  onLiterature,
  onDecide,
  onRestoreVersion,
}: {
  card: Card;
  notices: React.ReactNode;
  busy: boolean;
  labels: (id: string) => string;
  artifacts: Artifact[];
  annotations: Annotation[];
  versions: any[];
  records: { id: string; hash: string; label: string }[];
  decisionOf: (v: any) => { decision: Decision; reason: string; at: string } | undefined;
  reasonPrompt: React.ReactNode;
  onBack: () => void;
  onChange: (c: IdeaContent) => void;
  onSave: () => void;
  onDiscard: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onAsk: () => void;
  /** Pursued ideas: focus this idea in Literature and go there. */
  onLiterature?: () => void;
  onDecide: (d: Decision) => void;
  onRestoreVersion: (v: any) => void;
}) {
  const scope = useResearch();
  const [showErrors, setShowErrors] = useState(false);
  const [picking, setPicking] = useState(false);
  const c = card.content;
  if (!c)
    return (
      <div className="pane-inner">
        <button className="btn small ghost" onClick={onBack}>
          ← Board
        </button>
        <p className="note">Loading saved idea…</p>
      </div>
    );
  const set = (patch: Partial<IdeaContent>) => onChange({ ...c, ...patch });
  const setEvidence = (i: number, patch: Partial<Evidence>) =>
    set({ evidence: c.evidence.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const blankRow = (e: Evidence) => !(pruneBlankItems(ideaSchema, { ...c, evidence: [e] }) as IdeaContent).evidence.length;
  const { out: all } = fieldErrors(c);
  const errors = Object.fromEntries(Object.entries(all).filter(([k]) => !(k.startsWith("evidence.") && blankRow(c.evidence[Number(k.split(".")[1])]))));
  const err = (k: string) => showErrors && errors[k] && <small className="fld-error">{errors[k]}</small>;
  const canSave = card.draft || card.edited;
  const trySave = () => {
    setShowErrors(true);
    if (!Object.keys(errors).length) onSave();
  };
  const addFromNote = (n: Annotation) => {
    const a = artifacts.find((x) => x.id === n.artifactId);
    if (!a) return;
    const quote = (n.anchor as any)?.quote ?? "";
    const page = (n.anchor as any)?.page;
    set({
      evidence: [
        ...c.evidence,
        {
          category: "cited",
          reference: { id: a.id, hash: a.hash },
          description: `${page ? `p. ${page}: ` : ""}“${quote}”${n.comment && n.comment !== "Highlight" ? ` — ${n.comment}` : ""}`.slice(0, 12000),
        },
      ],
    });
    setPicking(false);
  };
  const decision = card.decision ?? undefined;
  const current = card.column === "decide" || card.column === "brainstorm" ? null : card.column;
  const refOptions = [...artifacts.map((a) => ({ id: a.id, hash: a.hash, label: a.name.replace(/\.pdf$/i, "") })), ...(scope.view?.batches ?? []).filter((b: any) => b.annotations.length).map((b: any) => ({ id: b.id, hash: b.hash, label: `Review: ${b.instruction.slice(0, 100)}` }))];
  const known = (id: string) => refOptions.some((o) => o.id === id) || records.some((r) => r.id === id);

  return (
    <div
      className="pane-inner idea-editor"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (canSave) trySave();
        } else if (e.key === "Escape" && !(e.target as HTMLElement).closest(".idea-reason, .idea-notes")) onBack();
      }}
    >
      <div className="idea-editor-head">
        <button className="btn small ghost" onClick={onBack} title="Back to the board (Esc)">
          ← Board
        </button>
        <span className="state">
          {card.draft
            ? `draft · autosaved ${ago(card.updated)}`
            : card.edited
              ? `unsaved changes to v${card.latest!.version}`
              : `saved v${card.latest!.version}`}
        </span>
        {current && <span className={`tag ${current === "pursue" ? "ok" : current === "reject" ? "warn" : "accent"}`}>{current}</span>}
        <span className="spacer" />
        {onLiterature && (
          <button className="btn small ghost" onClick={onLiterature} title="Focus this idea in Literature and go there">
            Work on in Literature ↗
          </button>
        )}
        <button className="icon-btn" title="Ask Pi about this idea" aria-label="Ask Pi" onClick={onAsk}>
          π
        </button>
        <button className="icon-btn" title="Duplicate as a new draft" aria-label="Duplicate" onClick={onDuplicate}>
          ⧉
        </button>
        <button className="icon-btn" title={card.draft ? "Delete draft" : "Archive"} aria-label={card.draft ? "Delete" : "Archive"} onClick={onRemove}>
          ×
        </button>
      </div>
      {notices}
      <section className="idea-document-title">
      <span className="idea-eyebrow">The hypothesis</span>
      <input
        className="idea-title"
        aria-label="Title"
        placeholder="Name the idea"
        value={c.title}
        autoFocus={!c.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      {err("title")}
      <p className="idea-writing-hint">A clear claim you can investigate and challenge.</p>
      </section>
      <div className="idea-research-fields">
      {FIELDS.map((f, index) => (
        <label className={`idea-field idea-field-${f.name}`} key={f.name}>
          <span className="idea-field-heading"><span className="idea-section-number">{String(index + 1).padStart(2, "0")}</span>{f.name === "rationale" ? "Why it should work" : f.name === "falsification" ? "What would change your mind?" : f.label}</span>
          <textarea
            aria-label={f.label}
            placeholder={f.hint}
            value={String(c[f.name] ?? "")}
            onChange={(e) => set({ [f.name]: e.target.value } as Partial<IdeaContent>)}
          />
          {err(f.name)}
        </label>
      ))}
      </div>
      <section className="idea-field idea-support">
        <span>How established is the idea?</span>
        <div className="seg" role="radiogroup" aria-label="Uncertainty">
          {LEVELS.map((l) => (
            <button
              key={l}
              role="radio"
              aria-checked={c.uncertainty === l}
              className={c.uncertainty === l ? "on" : ""}
              title={LEVEL_HINT[l]}
              onClick={() => set({ uncertainty: l })}
            >
              {l}
            </button>
          ))}
        </div>
        <small className="dim">{LEVEL_HINT[c.uncertainty]}</small>
      </section>
      <section className="idea-field idea-support">
        <span>
          Evidence <span className="count">{c.evidence.length}</span>
        </span>
        {!c.evidence.length && <p className="idea-writing-hint">Connect the papers, passages, or results behind your reasoning.</p>}
        {c.evidence.map((e, i) => (
          <div className="idea-evidence" key={i}>
            <select aria-label={`Evidence ${i + 1} kind`} value={e.category} onChange={(ev) => setEvidence(i, { category: ev.target.value as Uncertainty })}>
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <select
              aria-label={`Evidence ${i + 1} reference`}
              value={e.reference?.hash ? `${e.reference.id}:${e.reference.hash}` : ""}
              onChange={(ev) => {
                const [id, hash] = ev.target.value.split(":");
                setEvidence(i, { reference: { id: id ?? "", hash: hash ?? "" } });
              }}
            >
              <option value="">{refOptions.length || records.length ? "Choose a paper or record…" : "Import a paper in Sources first"}</option>
              {e.reference?.hash && !known(e.reference.id) && (
                <option value={`${e.reference.id}:${e.reference.hash}`}>{labels(e.reference.id)}</option>
              )}
              <optgroup label="Papers & sources">
                {refOptions.map((o) => (
                  <option key={o.id} value={`${o.id}:${o.hash}`}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
              {!!records.length && (
                <optgroup label="Saved records">
                  {records.map((r) => (
                    <option key={r.id + r.hash} value={`${r.id}:${r.hash}`}>
                      {r.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button className="icon-btn" aria-label={`Remove evidence ${i + 1}`} title="Remove" onClick={() => set({ evidence: c.evidence.filter((_, k) => k !== i) })}>
              ×
            </button>
            <textarea
              aria-label={`Evidence ${i + 1} description`}
              placeholder="What does it show, and where (page, theorem)?"
              value={e.description}
              onChange={(ev) => setEvidence(i, { description: ev.target.value })}
            />
            {err(`evidence.${i}.reference`)}
            {err(`evidence.${i}.description`)}
          </div>
        ))}
        <div className="idea-evidence-add">
          <button
            className="btn small ghost"
            onClick={() => set({ evidence: [...c.evidence, { category: "cited", reference: { id: "", hash: "" }, description: "" }] })}
          >
            + Add evidence
          </button>
          <button className="btn small ghost" disabled={!annotations.length} title={annotations.length ? "" : "Highlight passages in a paper first"} onClick={() => setPicking((p) => !p)}>
            + From my highlights
          </button>
        </div>
        {picking && (
          <div className="idea-notes" role="listbox" aria-label="Highlights" onKeyDown={(e) => e.key === "Escape" && setPicking(false)}>
            {annotations.map((n) => (
              <button key={n.id} role="option" aria-selected={false} className="list-row" onClick={() => addFromNote(n)}>
                <span className="title">
                  “{(n.anchor as any)?.quote || "(region)"}”
                  <small>
                    {labels(n.artifactId)} · p. {(n.anchor as any)?.page}
                    {n.comment && n.comment !== "Highlight" ? ` · ${n.comment}` : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <div className="idea-editor-foot">
        {canSave && (
          <button className="btn small primary" disabled={busy} onClick={trySave} title="⌘S">
            {card.draft ? "Save idea" : `Save version ${card.latest!.version + 1}`}
          </button>
        )}
        {card.edited && !card.draft && (
          <button className="btn small ghost" onClick={onDiscard}>
            Discard changes
          </button>
        )}
        {card.recordId && !card.edited && (
          <>
            <span className="dim">Decide on v{card.latest!.version}:</span>
            {(["pursue", "revise", "reject"] as Decision[]).map((d) => (
              <button key={d} className={`btn small ${current === d ? "primary" : "ghost"}`} onClick={() => onDecide(d)}>
                {d}
              </button>
            ))}
          </>
        )}
        {showErrors && !!Object.keys(errors).length && <span className="fld-error">Fill in the highlighted fields to save.</span>}
      </div>
      {reasonPrompt}
      {decision && (
        <p className="note">
          {!decision.carried ? (
            <>
              Decided <b>{decision.decision}</b> on v{decision.onVersion}: “{decision.reason}”
            </>
          ) : decision.decision === "pursue" ? (
            <>
              <b>Pursued</b> since v{decision.onVersion}: “{decision.reason}”. Revisions keep it pursued; decide again to change that.
            </>
          ) : (
            <>
              Decided <b>{decision.decision}</b> on v{decision.onVersion}: “{decision.reason}”. v{card.latest!.version} answers it and is waiting for a decision.
            </>
          )}
        </p>
      )}
      {versions.length > 0 && (
        <details className="fold">
          <summary>History · {versions.length} version{versions.length > 1 ? "s" : ""}</summary>
          <div className="list">
            {versions.map((v) => {
              const d = decisionOf(v);
              return (
                <div className="list-row" key={v.hash}>
                  <span className="title">
                    v{v.version} <small>{new Date(v.created).toLocaleString()}</small>
                  </span>
                  {d && <span className="tag">{d.decision}</span>}
                  <button className="btn small ghost" onClick={() => onRestoreVersion(v)} title="Copy this version's text into the editor">
                    Load
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
