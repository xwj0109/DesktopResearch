import type { SourceNavigation } from "../workbench-contract";
import { useEffect, useState } from "react";
import type { Artifact, Annotation } from "../shared";
import type { NativeClient } from "../native-client";
import { PdfViewer, copyText, type PdfSelection } from "./PdfViewer";

type Filter = "all" | "highlights" | "comments" | "open" | "addressed" | "this idea";
/** A note's link to an idea, as shown on the note. */
export interface NoteIdeaLink {
  ideaId: string;
  title: string;
  stance: "supports" | "contradicts" | "refines" | null;
  onVersion: number;
  currentVersion: number | null;
}
const STANCES = ["supports", "contradicts", "refines"] as const;

/** Immutable source reader. PDFs get the continuous, selectable viewer with
 * highlight/comment/ask actions; text and images keep a simple preview and a
 * manual annotation form. Annotations list below either way. The current page,
 * and any unsaved manual quote/comment, persist as a native research draft. */
export function NativeDocument({
  client,
  artifact,
  annotations,
  onAnnotate,
  savedDraft,
  navigation,
  onNavigation,
  onDraft,
  onAsk,
  onDeleteAnnotation,
  reviewPicked = [],
  onTogglePick,
  onBack,
  linksOf,
  focusIdea,
  onLink,
  onReviseIdea,
}: {
  client: NativeClient;
  artifact: Artifact;
  annotations: Annotation[];
  onAnnotate: (value: unknown) => Promise<void>;
  savedDraft?: string;
  navigation?: SourceNavigation;
  onNavigation?: (id: string) => void;
  onDraft: (value: string) => void;
  /** Put a reference to a passage into the stage composer (never sends). */
  onAsk?: (text: string) => void;
  /** Remove a note; resolves to its content so it can be re-created on undo. */
  onDeleteAnnotation?: (id: string) => Promise<{ artifactId: string; anchor: Annotation["anchor"]; comment: string; status: string }>;
  /** Notes chosen for the next frozen review batch (shared with the review tray). */
  reviewPicked?: string[];
  onTogglePick?: (id: string) => void;
  /** Leave the paper for the library (Esc, handled by the pane). */
  onBack?: () => void;
  /** Ideas each note is linked to (with stance). */
  linksOf?: (noteId: string) => NoteIdeaLink[];
  /** Literature's focus idea: notes get stance buttons for it. */
  focusIdea?: { id: string; title: string; version: number } | null;
  /** Link a note to the focus idea with a stance ("unclassified"), or unlink ("none"). */
  onLink?: (noteId: string, stance: (typeof STANCES)[number] | "unclassified" | "none") => void;
  /** Add the note to the focus idea as evidence and open the idea in Ideas. */
  onReviseIdea?: (noteId: string) => void;
}) {
  let restored: any = {};
  try {
    restored = JSON.parse(savedDraft ?? "{}");
  } catch {}
  const [bytes, setBytes] = useState<Uint8Array>(),
    [error, setError] = useState(""),
    [page, setPage] = useState<number>(typeof restored.page === "number" ? restored.page : 1),
    [quote, setQuote] = useState<string>(typeof restored.quote === "string" ? restored.quote : ""),
    [comment, setComment] = useState<string>(typeof restored.comment === "string" ? restored.comment : ""),
    [imageURL, setImageURL] = useState(""),
    [focus, setFocus] = useState<{ id: string; nonce: number }>(),
    [selectedNote, setSelectedNote] = useState<string>(),
    [notesOpen, setNotesOpen] = useState(true),
    [filter, setFilter] = useState<Filter>("all"),
    [editing, setEditing] = useState<{ id: string; text: string } | null>(null),
    [undo, setUndo] = useState<{ label: string; value: { artifactId: string; anchor: Annotation["anchor"]; comment: string; status: string } } | null>(null),
    [copied, setCopied] = useState("");
  useEffect(() => onDraft(JSON.stringify({ page, quote, comment })), [page, quote, comment]);
  useEffect(() => {
    let alive = true;
    void client.bytes("/artifacts/" + artifact.id).then(
      (res) => alive && setBytes(res.body),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [client, artifact.id]);
  useEffect(() => {
    if (!bytes || artifact.kind !== "image") return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: artifact.mime }));
    setImageURL(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes, artifact.kind, artifact.mime]);

  const mine = annotations
    .filter((a) => a.artifactId === artifact.id)
    .sort((a, b) => a.anchor.page - b.anchor.page || a.created.localeCompare(b.created));
  const annotate = (sel: PdfSelection, note: string) =>
    onAnnotate({
      artifactId: artifact.id,
      anchor: { page: sel.page, quote: sel.quote, ...(sel.rect ? { rect: sel.rect } : {}), rotation: 0 },
      comment: note,
      status: "draft",
    });
  const isPlain = (a: Annotation) => a.comment === "Highlight";
  /** Resolves false (with the reason shown) instead of rejecting. */
  const update = (a: Annotation, patch: { comment?: string; status?: string }) =>
    onAnnotate({
      id: a.id,
      artifactId: artifact.id,
      anchor: a.anchor,
      comment: patch.comment ?? a.comment,
      status: patch.status ?? (a.status === "submitted" ? "draft" : a.status),
    }).then(
      () => true,
      (e) => (setError(String(e instanceof Error ? e.message : e)), false),
    );
  const remove = async (id: string) => {
    if (!onDeleteAnnotation) return;
    const note = mine.find((a) => a.id === id);
    try {
      const value = await onDeleteAnnotation(id);
      setUndo({ label: `${note && isPlain(note) ? "Highlight" : "Note"} on p. ${value.anchor.page} removed.`, value });
      if (selectedNote === id) setSelectedNote(undefined);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const restore = async () => {
    if (!undo) return;
    const { artifactId, anchor, comment: text, status } = undo.value;
    try {
      await onAnnotate({ artifactId, anchor, comment: text, status: status === "submitted" ? "draft" : status });
      setUndo(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const flashCopied = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(""), 1400);
  };
  const onFocusIdea = (a: Annotation) => !!focusIdea && !!linksOf?.(a.id).some((l) => l.ideaId === focusIdea.id);
  const shown = mine.filter((a) =>
    filter === "this idea" ? onFocusIdea(a) : filter === "highlights" ? isPlain(a) : filter === "comments" ? !isPlain(a) : filter === "open" ? a.status !== "addressed" : filter === "addressed" ? a.status === "addressed" : true,
  );
  const counts: Record<Filter, number> = {
    all: mine.length,
    highlights: mine.filter(isPlain).length,
    comments: mine.filter((a) => !isPlain(a)).length,
    open: mine.filter((a) => a.status !== "addressed").length,
    addressed: mine.filter((a) => a.status === "addressed").length,
    "this idea": mine.filter(onFocusIdea).length,
  };
  const markdown = () =>
    `## Notes — ${artifact.name}\n\n` +
    mine
      .map((a) => `- p. ${a.anchor.page}: “${a.anchor.quote}”${isPlain(a) ? "" : `\n  — ${a.comment}`}${a.status === "addressed" ? " ✓" : ""}`)
      .join("\n") +
    "\n";
  const reference = (q: string, p: number) =>
    `> “${q.length > 600 ? q.slice(0, 600) + "…" : q}”\n> — ${artifact.name}, p. ${p} (source ${artifact.hash.slice(0, 12)})\n\n`;

  return (
    <section className="doc-reader">
      <div className="doc-head">
        {onBack && (
          <button className="doc-back" onClick={onBack} title="Back to your sources  Esc" aria-label="Back to sources">
            ‹ Sources <kbd>Esc</kbd>
          </button>
        )}
        <span className="title">{artifact.name}</span>
        <span className="tag" title={artifact.hash}>
          immutable · {artifact.hash.slice(0, 12)}
        </span>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {artifact.kind === "pdf" && bytes && (
        <PdfViewer
          bytes={bytes}
          initialPage={page}
          navigation={navigation}
          onNavigation={onNavigation}
          marks={mine.map((a) => ({ id: a.id, page: a.anchor.page, quote: a.anchor.quote, rect: a.anchor.rect, comment: a.comment }))}
          focusMark={focus}
          onPage={setPage}
          onAnnotate={annotate}
          onAsk={onAsk ? (sel) => onAsk(reference(sel.quote, sel.page)) : undefined}
          onMarkClick={(id) => {
            setNotesOpen(true);
            setSelectedNote(id);
            globalThis.document?.getElementById(`note-${id}`)?.scrollIntoView?.({ block: "nearest" });
          }}
          onEditMark={async (id, text) => {
            const a = mine.find((x) => x.id === id);
            if (a && !(await update(a, { comment: text }))) throw new Error("Note not updated.");
          }}
          onRemoveMark={onDeleteAnnotation ? remove : undefined}
        />
      )}
      {artifact.kind !== "pdf" && (
        <div className="doc-view">
          {artifact.kind === "text" && bytes && (
            <pre
              onMouseUp={() => {
                const selection = globalThis.getSelection?.()?.toString();
                if (selection) setQuote(selection.slice(0, 12000));
              }}
            >
              {new TextDecoder().decode(bytes)}
            </pre>
          )}
          {artifact.kind === "image" && imageURL && <img src={imageURL} alt={artifact.name} />}
          {artifact.kind === "unsupported" && (
            <p className="note" style={{ padding: 12 }}>
              This source type has no inline preview. Its immutable metadata remains available for evidence references.
            </p>
          )}
          {!bytes && !error && (
            <p className="note" style={{ padding: 12 }}>
              loading…
            </p>
          )}
        </div>
      )}
      {artifact.kind !== "pdf" && (
        <details className="fold">
          <summary>Annotate this source</summary>
          <div className="fold-body">
            <label className="stack">
              Quoted passage (select text above to fill)
              <textarea value={quote} onChange={(e) => setQuote(e.target.value)} />
            </label>
            <label className="stack">
              Research comment
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <button
              className="btn primary small"
              disabled={!comment.trim()}
              onClick={() =>
                void annotate({ page, quote }, comment).then(
                  () => {
                    setComment("");
                    setQuote("");
                  },
                  (e) => setError(String(e)),
                )
              }
            >
              Save annotation
            </button>
          </div>
        </details>
      )}
      <div className={`doc-notes ${notesOpen ? "open" : ""}`}>
        <div className="doc-notes-head">
          <button className="toggle" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen}>
            <span>{notesOpen ? "▾" : "▸"}</span> notes <span className="count">{mine.length}</span>
          </button>
          {notesOpen && mine.length > 0 && (
            <div className="chips" role="tablist" aria-label="Filter notes">
              {(["all", "highlights", "comments", "open", "addressed", ...(focusIdea ? ["this idea"] : [])] as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                  {f} {counts[f]}
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {notesOpen && mine.length > 0 && (
            <button
              className="btn small ghost"
              onClick={() => {
                copyText(markdown());
                flashCopied("all");
              }}
            >
              {copied === "all" ? "copied ✓" : "Copy all as Markdown"}
            </button>
          )}
        </div>
        {undo && (
          <div className="notice undo" role="status">
            <div>
              <span>{undo.label}</span>
            </div>
            <button className="btn small primary" onClick={() => void restore()}>
              Undo
            </button>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setUndo(null)}>
              ×
            </button>
          </div>
        )}
        {notesOpen && (
          <div className="doc-notes-list">
            {shown.map((a) => {
              const plain = isPlain(a);
              const picked = reviewPicked.includes(a.id);
              return (
                <article
                  id={`note-${a.id}`}
                  className={`annotation ${plain ? "plain" : ""} ${selectedNote === a.id ? "selected" : ""} ${a.status === "addressed" ? "addressed" : ""}`}
                  key={a.id}
                  onClick={() => setSelectedNote(a.id)}
                >
                  <div className="note-meta">
                    <button
                      className="page-link"
                      title="Show on the page"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNote(a.id);
                        setFocus({ id: a.id, nonce: Date.now() });
                      }}
                    >
                      p. {a.anchor.page}
                    </button>
                    <span className={`tag ${plain ? "" : "accent"}`}>{plain ? "highlight" : "comment"}</span>
                    {a.status === "addressed" && <span className="tag ok">addressed</span>}
                    {picked && <span className="tag warn">in review</span>}
                  </div>
                  {a.anchor.quote && <blockquote>“{a.anchor.quote}”</blockquote>}
                  {(() => {
                    const links = linksOf?.(a.id) ?? [];
                    const mineLink = focusIdea ? links.find((l) => l.ideaId === focusIdea.id) : undefined;
                    const others = links.filter((l) => l !== mineLink);
                    if (!others.length && !focusIdea) return null;
                    const drift = (l: NoteIdeaLink) => (l.currentVersion && l.currentVersion !== l.onVersion ? `judged on v${l.onVersion}, idea now v${l.currentVersion}` : `judged on v${l.onVersion}`);
                    return (
                      <div className="note-ideas" onClick={(e) => e.stopPropagation()}>
                        {focusIdea && onLink && (
                          <span className="note-idea-focus" role="group" aria-label={`Stance on ${focusIdea.title}`}>
                            <span className="t" title={mineLink ? drift(mineLink) : "Not linked to the focus idea yet"}>
                              {mineLink ? "" : "link: "}
                              {focusIdea.title || "Untitled idea"}
                            </span>
                            {mineLink && mineLink.currentVersion && mineLink.currentVersion !== mineLink.onVersion && (
                              <span className="v" title={drift(mineLink)}>
                                v{mineLink.onVersion}→v{mineLink.currentVersion}
                              </span>
                            )}
                            {STANCES.map((st) => (
                              <button
                                key={st}
                                className={`stance stance-${st}`}
                                aria-pressed={mineLink?.stance === st}
                                title={mineLink?.stance === st ? "Clear the stance (keep the link)" : `This passage ${st} the idea`}
                                onClick={() => onLink(a.id, mineLink?.stance === st ? "unclassified" : st)}
                              >
                                {st}
                              </button>
                            ))}
                            {mineLink && (
                              <button className="stance unlink" aria-label={`Unlink from ${focusIdea.title}`} title="Unlink from this idea" onClick={() => onLink(a.id, "none")}>
                                ×
                              </button>
                            )}
                          </span>
                        )}
                        {others.map((l) => (
                          <span key={l.ideaId} className={`note-idea stance-${l.stance ?? "none"}`} title={drift(l)}>
                            {l.stance ?? "linked"} · {l.title || "Untitled idea"}
                            {l.currentVersion && l.currentVersion !== l.onVersion ? ` · v${l.onVersion}→v${l.currentVersion}` : ""}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                  {editing?.id === a.id ? (
                    <form
                      className="note-edit"
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void update(a, { comment: editing.text.trim() || "Highlight" }).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <textarea
                        autoFocus
                        rows={3}
                        value={editing.text}
                        placeholder="Comment (leave empty to keep a plain highlight)"
                        onChange={(e) => setEditing({ id: a.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            void update(a, { comment: editing.text.trim() || "Highlight" }).then((ok) => ok && setEditing(null));
                          } else if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      <div className="row-actions">
                        <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="btn small primary">
                          Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    !plain && <p>{a.comment}</p>
                  )}
                  {editing?.id !== a.id && (
                    <div className="note-actions" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setEditing({ id: a.id, text: plain ? "" : a.comment })}>{plain ? "Add comment" : "Edit"}</button>
                      {onDeleteAnnotation && (
                        <button className="danger" onClick={() => void remove(a.id)}>
                          Remove
                        </button>
                      )}
                      {onAsk && a.anchor.quote && (
                        <button onClick={() => onAsk(reference(a.anchor.quote, a.anchor.page) + (plain ? "" : `My note: ${a.comment}\n\n`))}>Ask Pi</button>
                      )}
                      <button
                        onClick={() => {
                          copyText(a.anchor.quote + (plain ? "" : `\n— ${a.comment}`));
                          flashCopied(a.id);
                        }}
                      >
                        {copied === a.id ? "copied ✓" : "Copy"}
                      </button>
                      <button onClick={() => void update(a, { status: a.status === "addressed" ? "draft" : "addressed" })}>
                        {a.status === "addressed" ? "Reopen" : "Addressed"}
                      </button>
                      {focusIdea && onReviseIdea && (
                        <button onClick={() => onReviseIdea(a.id)} title={`Add this note to “${focusIdea.title}” as evidence and open it in Ideas to revise`}>
                          Revise idea
                        </button>
                      )}
                      {onTogglePick && (
                        <button className={picked ? "on" : ""} onClick={() => onTogglePick(a.id)} title="Include in the next frozen review batch">
                          {picked ? "✓ Review" : "Review"}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
            {!shown.length && (
              <p className="list-empty">
                {mine.length ? "No notes match this filter." : artifact.kind === "pdf" ? "Select text on the page to highlight, comment or ask Pi." : "No notes on this source yet."}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
