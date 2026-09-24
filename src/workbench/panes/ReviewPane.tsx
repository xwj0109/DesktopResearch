import { Notice, useAutoDismiss } from "../Notice";
import {
  composeReviewMessage,
  reviewAttachment,
} from "../../review-attachment";
import { useEffect, useState } from "react";
import type { Annotation, Artifact, Batch } from "../../shared";
import { stageDestinations, useAction, useResearch } from "../research";
import { formatTime } from "../transcript";

export const reviewStatus = (b: Batch) =>
  b.status === "draft"
    ? "Prepared"
    : b.status === "completed"
      ? b.response
        ? "Response available"
        : "Completed"
      : ({
          pending: "Sending",
          "accepted/queued": "Queued",
          working: "Working",
          failed: "Failed",
          "delivery-uncertain": "Delivery uncertain",
        }[b.status] ?? b.status);
export const reviewTitle = (question: string) =>
  question.trim().replace(/\s+/g, " ");

/** A response becomes an editable conjecture, with the exact review as evidence. */
export function ReviewIdeaForm({
  response: initialResponse = "",
  review: fixedReview,
}: {
  response?: string;
  review?: Batch;
}) {
  const scope = useResearch();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [reviewId, setReviewId] = useState(fixedReview?.id ?? "");
  const [title, setTitle] = useState("");
  const [response, setResponse] = useState(initialResponse);
  const reviews: Batch[] = (scope.view?.batches ?? []).filter(
    (b: Batch) => b.annotations.length,
  );
  const review = fixedReview ?? reviews.find((b) => b.id === reviewId);
  if (!reviews.length || scope.portfolio) return null;
  return (
    <div className="review-outcome">
      {!open ? (
        <button className="btn small" onClick={() => setOpen(true)}>
          Create idea from response
        </button>
      ) : (
        <div className="review-outcome-form">
          <strong>Create an editable idea</strong>
          <p className="note">
            Choose the evidence behind this response. The idea keeps an exact
            review reference and starts as a conjecture.
          </p>
          {!fixedReview && (
            <label className="stack">
              Review evidence
              <select
                value={reviewId}
                onChange={(e) => setReviewId(e.target.value)}
              >
                <option value="">Choose a saved review…</option>
                {reviews.map((b) => (
                  <option key={b.id} value={b.id}>
                    {reviewTitle(b.instruction)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="stack">
            Idea title
            <input
              maxLength={500}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The hypothesis you want to develop"
            />
          </label>
          <label className="stack">
            Response or proposed rationale
            <textarea
              rows={5}
              maxLength={12000}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="Paste an agent response or write the reasoning to carry forward"
            />
          </label>
          {initialResponse.length > 12000 && (
            <p role="alert">
              Shorten the response to 12,000 characters before creating the
              idea.
            </p>
          )}
          {action.notices}
          <div className="row-actions">
            <button
              className="btn primary"
              disabled={
                action.busy ||
                !review ||
                !title.trim() ||
                !response.trim() ||
                response.length > 12000
              }
              onClick={() =>
                void action.run(
                  () =>
                    scope.client.write("/native/reviews/review_create_idea", {
                      reviewId: review!.id,
                      expectedHash: review!.hash,
                      title,
                      response,
                    }),
                  "Idea draft created. Open the Idea pane to edit it before saving.",
                )
              }
            >
              Create idea draft
            </button>
            <button
              className="btn"
              disabled={action.busy}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReviewPane({
  picked,
  setPicked,
  instruction,
  setInstruction,
  openArtifact,
  choosePaper,
}: {
  picked: string[];
  setPicked: (ids: string[]) => void;
  instruction: string;
  setInstruction: (value: string) => void;
  openArtifact: (id: string) => void;
  choosePaper: () => void;
}) {
  const scope = useResearch();
  const action = useAction();
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [prepared, setPrepared] = useState<Batch | null>(null);
  const [preparedHovered, setPreparedHovered] = useState(false);
  const [preparedFocused, setPreparedFocused] = useState(false);
  useEffect(() => {
    setPreparedHovered(false);
    setPreparedFocused(false);
  }, [prepared?.id]);
  useAutoDismiss(
    prepared?.id,
    () => setPrepared(null),
    12000,
    preparedHovered || preparedFocused,
  );
  const [duplicate, setDuplicate] = useState<Batch | null>(null);
  const [handoff, setHandoff] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const deletion = useAction();
  useEffect(() => {
    const live = new Set((scope.view.batches ?? []).map((b: Batch) => b.id));
    if (prepared && !live.has(prepared.id)) setPrepared(null);
    if (duplicate && !live.has(duplicate.id)) {
      setDuplicate(null);
      setPicked([]);
    }
    if (deleting && !live.has(deleting)) setDeleting(null);
  }, [scope.view.batches]);
  const remove = (review: Batch) =>
    void deletion.run(async () => {
      try {
        const result = await scope.client.write(
          "/native/reviews/review_delete",
          {
            reviewId: review.id,
            expectedHash: review.hash,
            revision: scope.view.revision,
          },
        );
        if (prepared?.id === review.id) setPrepared(null);
        if (duplicate?.id === review.id) {
          setDuplicate(null);
          setPicked([]);
        }
        setDeleting(null);
        if (result.persistence)
          throw new Error(
            result.persistence.warning +
              " Inspect the saved state; do not repeat deletion.",
          );
      } catch (error) {
        const refusal = (
          error as { refusal?: { code: string; records?: string[] } }
        ).refusal;
        if (refusal?.code === "cited")
          throw new Error(
            `This review is cited by ${refusal.records?.join(", ")}. Keep the snapshot while those research records reference it.`,
          );
        if (refusal?.code === "review-draft-cited")
          throw new Error(
            "An idea draft references this review. Remove that evidence reference or delete the draft first.",
          );
        if (refusal?.code === "review-in-flight")
          throw new Error(
            "This review has active or uncertain delivery. Wait for it to finish or resolve its delivery before deleting.",
          );
        throw error;
      }
    }, "Review deleted. Source notes and conversation attachments are unchanged.");
  const artifacts: Artifact[] = scope.view.artifacts ?? [];
  const annotations: Annotation[] = scope.view.annotations ?? [];
  const batches: Batch[] = (scope.view.batches ?? []).filter(
    (b: Batch) => b.annotations.length,
  );
  const selected = duplicate
    ? duplicate.annotations
    : annotations.filter((n) => picked.includes(n.id));
  const documents = duplicate ? duplicate.documents : artifacts;
  const destination =
    duplicate?.destination ?? stageDestinations[scope.stage] ?? "Ideas";
  const term = query.trim().toLowerCase();
  const groups = documents
    .map((a) => ({
      artifact: a,
      notes: (duplicate ? duplicate.annotations : annotations).filter(
        (n) =>
          n.artifactId === a.id &&
          (!selectedOnly || selected.some((s) => s.id === n.id)) &&
          (!term ||
            `${a.name} ${n.anchor.quote} ${n.comment}`
              .toLowerCase()
              .includes(term)),
      ),
    }))
    .filter((g) => g.notes.length);
  const reason =
    !selected.length && !instruction.trim()
      ? "Select at least one passage and enter a question."
      : !selected.length
        ? "Select at least one passage."
        : !instruction.trim()
          ? "Enter a research question."
          : "";
  const papers = new Set(selected.map((n) => n.artifactId)).size;
  const add = (b: Batch) => {
    try {
      scope.appendComposer(composeReviewMessage("", [reviewAttachment(b)]));
    } catch (error) {
      setHandoff(
        error instanceof Error ? error.message : "Could not attach review.",
      );
      return;
    }
    setHandoff(
      `Review attached to the current conversation. Your existing draft is preserved; press Send when ready.${b.destination !== stageDestinations[scope.stage] ? ` This snapshot was prepared for ${b.destination}.` : ""}`,
    );
  };
  const navigate = (n: Annotation) => {
    scope.setDraft(
      "sources:navigation",
      JSON.stringify({
        id: crypto.randomUUID(),
        artifactId: n.artifactId,
        page: n.anchor.page,
        query: n.anchor.quote,
      }),
    );
    openArtifact(n.artifactId);
  };
  const prepare = () =>
    void action.run(async () => {
      const result = await scope.client.write<{
        review: Batch;
        persistence?: { warning: string };
      }>(
        `/native/reviews/${duplicate ? "review_duplicate" : "review_prepare"}`,
        duplicate
          ? {
              revision: scope.view.revision,
              reviewId: duplicate.id,
              expectedHash: duplicate.hash,
              instruction,
            }
          : {
              revision: scope.view.revision,
              destination,
              annotationIds: selected.map((n) => n.id),
              instruction,
              behavior: "followUp",
            },
      );
      setPrepared(result.review);
      setHandoff("");
      setPicked([]);
      setInstruction("");
      setDuplicate(null);
      if (result.persistence)
        throw new Error(
          result.persistence.warning +
            " Do not repeat preparation; inspect the saved snapshot.",
        );
    }, "");
  return (
    <div className="pane-inner review-pane">
      <header className="review-heading">
        <h2>Prepare a research review</h2>
        <p>Ask a question and choose the passages the agent should consider.</p>
      </header>
      {action.notices}
      {handoff && <Notice message={handoff} onDismiss={() => setHandoff("")} />}
      {prepared && (
        <section
          className="review-success"
          aria-label="Review prepared"
          onMouseEnter={() => setPreparedHovered(true)}
          onMouseLeave={() => setPreparedHovered(false)}
          onFocusCapture={() => setPreparedFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setPreparedFocused(false);
          }}
        >
          <strong>Review prepared</strong>
          <p>
            {prepared.annotations.length} passages from{" "}
            {prepared.documents.length} papers, saved with your question.
          </p>
          <div className="row-actions">
            <button className="btn primary" onClick={() => add(prepared)}>
              Add to conversation
            </button>
            <button
              className="btn"
              onClick={() => {
                const node = globalThis.document?.getElementById(
                  `review-${prepared.id}`,
                ) as HTMLDetailsElement | null;
                if (node) {
                  node.open = true;
                  node.scrollIntoView({ block: "nearest" });
                }
              }}
            >
              View snapshot
            </button>
            <button className="btn" onClick={() => setPrepared(null)}>
              Dismiss
            </button>
          </div>
        </section>
      )}
      <label className="stack review-question">
        What would you like to investigate?
        <textarea
          rows={3}
          maxLength={40000}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Compare these assumptions and identify where they disagree."
        />
      </label>
      <section className="block review-evidence">
        <h3 className="section-title">
          Evidence <span className="count">{selected.length} selected</span>
        </h3>
        {duplicate && (
          <p className="notice">
            Reusing the exact evidence from “
            {reviewTitle(duplicate.instruction)}”. Live edits will not change
            this copy.{" "}
            <button
              className="btn small"
              onClick={() => {
                setDuplicate(null);
                setPicked([]);
              }}
            >
              Choose live passages instead
            </button>
          </p>
        )}
        {!annotations.length && !duplicate ? (
          <div className="review-empty">
            <strong>Choose evidence for your question</strong>
            <p>
              Open a paper and select a passage to add it here. Highlights and
              comments both work.
            </p>
            <button className="btn" onClick={choosePaper}>
              Choose a paper
            </button>
            {artifacts.slice(0, 5).map((a) => (
              <div className="list-row" key={a.id}>
                <span className="title">{a.name}</span>
                <button
                  className="btn small"
                  onClick={() => openArtifact(a.id)}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="review-filters">
              <input
                aria-label="Search review evidence"
                type="search"
                placeholder="Search papers, quotes and comments"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={selectedOnly}
                  onChange={(e) => setSelectedOnly(e.target.checked)}
                />{" "}
                Selected only
              </label>
              {!duplicate && (
                <button
                  className="btn small"
                  disabled={!picked.length}
                  onClick={() => setPicked([])}
                >
                  Clear selection
                </button>
              )}
            </div>
            {!groups.length && (
              <p className="list-empty">
                No passages match these filters.{" "}
                <button
                  className="btn small"
                  onClick={() => {
                    setQuery("");
                    setSelectedOnly(false);
                  }}
                >
                  Reset filters
                </button>
              </p>
            )}
            {groups.map(({ artifact: a, notes }) => (
              <details className="fold review-paper" key={a.id} open>
                <summary>
                  <span className="title">{a.name}</span>
                  <span className="count">
                    {selected.filter((n) => n.artifactId === a.id).length} /{" "}
                    {
                      (duplicate ? duplicate.annotations : annotations).filter(
                        (n) => n.artifactId === a.id,
                      ).length
                    }{" "}
                    selected
                  </span>
                </summary>
                <div className="review-paper-body">
                  {!duplicate && (
                    <button
                      className="btn small"
                      onClick={() =>
                        setPicked([
                          ...new Set([
                            ...picked,
                            ...annotations
                              .filter((n) => n.artifactId === a.id)
                              .map((n) => n.id),
                          ]),
                        ])
                      }
                    >
                      Select all in this paper
                    </button>
                  )}
                  {notes.map((n) => (
                    <div className="review-note" key={n.id}>
                      {!duplicate && (
                        <input
                          type="checkbox"
                          aria-label={`Select passage on page ${n.anchor.page}: ${(n.anchor.quote || n.comment).slice(0, 80)}`}
                          checked={picked.includes(n.id)}
                          onChange={(e) =>
                            setPicked(
                              e.target.checked
                                ? [...picked, n.id]
                                : picked.filter((id) => id !== n.id),
                            )
                          }
                        />
                      )}
                      <div className="review-note-text">
                        <button
                          className="review-page"
                          onClick={() => navigate(n)}
                        >
                          Page {n.anchor.page} · Open passage
                        </button>
                        {n.anchor.quote && (
                          <details className="review-quote">
                            <summary>
                              {n.anchor.quote.length > 180
                                ? `${n.anchor.quote.slice(0, 180)}…`
                                : n.anchor.quote}
                            </summary>
                            <blockquote>{n.anchor.quote}</blockquote>
                          </details>
                        )}
                        {n.comment && <p>{n.comment}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </>
        )}
      </section>
      {!!selected.length && (
        <details className="fold">
          <summary>Preview exact snapshot · {selected.length} passages</summary>
          <div className="fold-body review-preview">
            <strong>{instruction || "Your question will appear here"}</strong>
            {selected.map((n) => (
              <div key={n.id}>
                <strong>
                  {documents.find((a) => a.id === n.artifactId)?.name} · p.{" "}
                  {n.anchor.page}
                </strong>
                <blockquote>{n.anchor.quote}</blockquote>
                {n.comment && <p>{n.comment}</p>}
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="review-action">
        <div>
          <strong>
            {selected.length} passages · {papers} papers
          </strong>
          <span>Destination: {destination}</span>
        </div>
        <button
          className="btn primary"
          disabled={action.busy || !!reason}
          aria-describedby="review-action-help"
          onClick={prepare}
        >
          {action.busy ? "Preparing…" : "Prepare review"}
        </button>
        <p id="review-action-help">
          {reason ||
            "Saves an exact copy of your question and selected passages. Add it to the conversation when ready; sending stays explicit."}
        </p>
      </div>
      {!deleting && deletion.notices}
      {!!batches.length && (
        <section className="block review-history">
          <h3 className="section-title">
            Previous reviews <span className="count">{batches.length}</span>
          </h3>
          {[...batches].reverse().map((b) => (
            <details className="fold" id={`review-${b.id}`} key={b.id}>
              <summary>
                <span className="title review-history-title">
                  {reviewTitle(b.instruction)}
                  <small>
                    {b.annotations.length} passages · {b.documents.length}{" "}
                    papers · {b.destination} ·{" "}
                    {formatTime(b.created)?.full ?? b.created}
                  </small>
                </span>
                <span className="tag">{reviewStatus(b)}</span>
              </summary>
              <div className="fold-body review-history-body">
                <p>
                  Snapshot saved. Later edits to the source notes do not change
                  this evidence.
                </p>
                <div className="row-actions">
                  <button className="btn primary" onClick={() => add(b)}>
                    Add to conversation
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setDuplicate(b);
                      setPicked(b.annotations.map((n) => n.id));
                      setInstruction(b.instruction);
                      setPrepared(null);
                      setQuery("");
                      setSelectedOnly(false);
                      globalThis.document
                        ?.querySelector?.<HTMLTextAreaElement>(
                          ".review-question textarea",
                        )
                        ?.focus();
                    }}
                  >
                    Duplicate as new review
                  </button>
                  <button
                    className="btn danger"
                    disabled={deletion.busy || action.busy}
                    onClick={() => {
                      deletion.setError("");
                      deletion.setStatus("");
                      setDeleting(b.id);
                    }}
                  >
                    Delete review…
                  </button>
                </div>
                {deleting === b.id && (
                  <div
                    className="review-delete-confirm"
                    role="group"
                    aria-label="Confirm review deletion"
                  >
                    <strong>Delete this saved review?</strong>
                    {deletion.notices}
                    <p>
                      This removes the snapshot from Previous reviews. Source
                      papers, notes and attachments already added to
                      conversations remain. This cannot be undone.
                    </p>
                    <div className="row-actions">
                      <button
                        className="btn danger"
                        disabled={deletion.busy}
                        onClick={() => remove(b)}
                      >
                        {deletion.busy ? "Deleting…" : "Delete review"}
                      </button>
                      <button
                        className="btn"
                        disabled={deletion.busy}
                        onClick={() => setDeleting(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <details>
                  <summary>Snapshot details</summary>
                  <p className="review-hash">
                    ID: {b.id}
                    <br />
                    Hash: {b.hash}
                  </p>
                  <textarea
                    aria-label="Immutable review snapshot"
                    readOnly
                    rows={8}
                    value={b.prompt}
                  />
                </details>
                {b.response && (
                  <details>
                    <summary>Recorded response</summary>
                    <p className="review-response">{b.response}</p>
                  </details>
                )}
                <ReviewIdeaForm review={b} response={b.response} />
              </div>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
