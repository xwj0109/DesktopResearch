import { useResearch } from "../research";
import { usePoll } from "../usePoll";
import { RISK_GLYPH } from "./Risks";
import type { RiskStatus } from "../../risk-contract";

/** "What the AI sees": the same summary idea_context gives an agent, so the
 * user can check what the conversation knows (docs/WORKFLOW-REDESIGN-PLAN.md §7.3). */
interface IdeaContext {
  idea: { target: string; title: string; version: number; status: string; pursuedSince: number | null; rationale: string; falsification: string; pendingEdits: boolean };
  window: { stage: string | null; current: boolean };
  risks: { counts: Record<string, number>; top: { id: string; text: string; kind: string; status: RiskStatus; stale: string | null }[] };
  literature: { papers: number; notes: { total: number; supports: number; contradicts: number; refines: number }; next: string | null } | null;
  workspace: { pending: number; lastCheckpoint: { sha: string; message: string; at: string } | null; newestDocuments: { path: string }[] };
  runs: { id: string; label: string; status: string; commit: string; metrics: Record<string, number | string> }[];
  candidate: { number: number; version: number; checkpoint: string; state: string } | null;
  agentRuns: { limit: { runs: number; minutes: number }; used: { runs: number; minutes: number } };
  next: string[];
}

export function IdeaContextPanel({ idea, onClose }: { idea: string; onClose: () => void }) {
  const scope = useResearch();
  const { data: c, error } = usePoll<IdeaContext>(`/native/idea-context?idea=${idea}`, 5000);
  return (
    <div className="idea-context" role="dialog" aria-label="What the AI sees">
      <div className="idea-context-head">
        <b>What the AI sees</b>
        <span className="dim">idea_context: the summary Pi reads for this idea, built from its records</span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => scope.appendComposer("Read idea_context and tell me what you would do next, and why.")}>
          Ask Pi what's next
        </button>
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {!c ? (
        <p className="rd-empty">{error ?? "loading…"}</p>
      ) : (
        <div className="idea-context-body">
          <section>
            <h4>Idea</h4>
            <p>
              <b>{c.idea.title}</b> v{c.idea.version} · {c.idea.status}
              {c.idea.pursuedSince ? ` since v${c.idea.pursuedSince}` : ""}
              {c.idea.pendingEdits ? " · unsaved edits" : ""}
            </p>
            <p className="dim">Would change our mind: {c.idea.falsification}</p>
          </section>
          <section>
            <h4>Next</h4>
            {c.next.length ? (
              <ol>
                {c.next.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ol>
            ) : (
              <p className="dim">Nothing pressing.</p>
            )}
          </section>
          <section>
            <h4>Risks</h4>
            {c.risks.top.length ? (
              <ul>
                {c.risks.top.map((r) => (
                  <li key={r.id} className={`risk st-${r.status}`}>
                    <span className="g">{RISK_GLYPH[r.status]}</span> {r.text} <span className="dim">({r.kind}{r.stale ? ", stale" : ""})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dim">None named yet.</p>
            )}
          </section>
          <section>
            <h4>Workspace and runs</h4>
            <p>
              {c.workspace.pending ? `${c.workspace.pending} change${c.workspace.pending === 1 ? "" : "s"} not checkpointed` : "Everything checkpointed"}
              {c.workspace.lastCheckpoint ? ` · last: “${c.workspace.lastCheckpoint.message}” (${c.workspace.lastCheckpoint.sha.slice(0, 8)})` : ""}
            </p>
            {c.workspace.newestDocuments.length > 0 && <p className="dim">Newest documents: {c.workspace.newestDocuments.map((d) => d.path).join(", ")}</p>}
            <ul>
              {c.runs.map((r) => (
                <li key={r.id}>
                  {r.label} · {r.status} · {r.commit}
                  {Object.entries(r.metrics)
                    .slice(0, 3)
                    .map(([k, v]) => ` · ${k} ${typeof v === "number" ? Number(v.toPrecision(4)) : v}`)
                    .join("")}
                </li>
              ))}
            </ul>
            <p className="dim">
              Agent runs this hour: {c.agentRuns.used.runs}/{c.agentRuns.limit.runs} runs, {c.agentRuns.used.minutes}/{c.agentRuns.limit.minutes} min
            </p>
          </section>
          <section>
            <h4>Literature and release</h4>
            <p>
              {c.literature ? `${c.literature.papers} papers · ${c.literature.notes.total} notes (${c.literature.notes.supports} support, ${c.literature.notes.contradicts} contradict)` : "No literature yet"}
            </p>
            <p>{c.candidate ? `Release candidate ${c.candidate.number} (v${c.candidate.version}, ${c.candidate.checkpoint}): ${c.candidate.state}` : "Not a release candidate"}</p>
          </section>
        </div>
      )}
    </div>
  );
}
