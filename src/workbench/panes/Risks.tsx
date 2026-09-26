import { useState } from "react";
import { useResearch } from "../research";
import { usePoll } from "../usePoll";
import { riskKinds, riskStatuses, type Risk, type RiskStatus } from "../../risk-contract";

/** An idea's risks (docs/WORKFLOW-REDESIGN-PLAN.md §5.4–5.5): what could make
 * it unusable, how well each is known, and the evidence. The same operations
 * as the agent (risk_list, risk_add, risk_set, risk_delete). */

export interface RiskRow extends Risk {
  stale: string | null;
  evidenceRun: { id: string; status: string; commit: string; label: string } | null;
}
export interface RiskList {
  idea: string;
  risks: RiskRow[];
  counts: { failed: number; unknown: number; estimated: number; waived: number; measuredOk: number; stale: number };
}
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
export const RISK_GLYPH: Record<RiskStatus, string> = { unknown: "?", estimated: "≈", "measured-ok": "✓", failed: "✗", waived: "–" };
const STATUS_LABEL: Record<RiskStatus, string> = { unknown: "unknown", estimated: "estimated", "measured-ok": "measured ok", failed: "failed", waived: "waived" };

export const useRisks = (idea: string | null | undefined, ms = 5000) => usePoll<RiskList>(idea?.startsWith("r:") ? `/native/risks?idea=${idea}` : null, ms);

/** "1 risk failed", "3 risks unknown", or "risks checked" — the most important first. */
export function riskSummary(c: RiskList["counts"] | undefined) {
  if (!c) return null;
  const n = (k: number, what: string) => `${k} risk${k === 1 ? "" : "s"} ${what}`;
  if (c.failed) return { text: n(c.failed, "failed"), level: "err" as const };
  if (c.stale) return { text: n(c.stale, "stale"), level: "warn" as const };
  if (c.unknown) return { text: n(c.unknown, "unknown"), level: "warn" as const };
  const total = c.estimated + c.waived + c.measuredOk;
  if (!total) return { text: "no risks yet", level: "dim" as const };
  return { text: c.estimated ? n(c.estimated, "estimated") : "risks checked", level: "ok" as const };
}

export function RisksPanel({ idea }: { idea: string }) {
  const scope = useResearch();
  const list = useRisks(idea, 4000);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Risk["kind"]>("data");
  const [waiving, setWaiving] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState("");
  const write = async (path: string, body: unknown) => {
    setError("");
    try {
      await scope.client.write(path, body);
      await list.reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const setStatus = (r: RiskRow, status: RiskStatus) => {
    if (status === "waived") return setWaiving({ id: r.id, reason: r.reason ?? "" });
    void write("/native/risks/set", { idea, risk: r.id, status });
  };
  const risks = list.data?.risks ?? [];
  return (
    <section className="idea-field risks" aria-label="Risks">
      <span className="idea-field-heading">
        Risks <span className="dim">what could make it unusable in practice, and how well each is known</span>
      </span>
      {risks.length === 0 && list.data && (
        <p className="dim">
          No risks yet. Name the few that could stop this idea (data, timing, compute, latency, cost) and test the cheapest first.{" "}
          <button
            className="btn small ghost"
            onClick={() =>
              scope.appendComposer(
                `Draft the 3–5 risks that could make idea ${idea} unusable in practice (risk_add, status unknown), most fundamental first, and suggest the cheapest test for each.`,
              )
            }
          >
            Ask Pi to draft them
          </button>
        </p>
      )}
      <ul className="risk-list">
        {risks.map((r) => (
          <li key={r.id} className={`risk st-${r.status}`}>
            <span className="g" aria-hidden="true">
              {RISK_GLYPH[r.status]}
            </span>
            <span className="t">
              {r.text} <span className="tag">{r.kind}</span>
              {r.by === "agent" ? <span className="tag">agent</span> : null}
              {r.stale ? (
                <span className="tag warn" title={r.stale}>
                  stale
                </span>
              ) : null}
              {r.evidenceRun ? (
                <button
                  className="link"
                  title={`Evidence: run ${r.evidenceRun.id} (${r.evidenceRun.status})`}
                  onClick={() => {
                    scope.setDraft(`research:run:${idea}`, r.evidenceRun!.id);
                    scope.goToStage?.("research", "runs");
                  }}
                >
                  run {r.evidenceRun.label} · {r.evidenceRun.commit.slice(0, 7)}
                </button>
              ) : r.evidence?.text ? (
                <span className="dim"> · {r.evidence.text}</span>
              ) : null}
              {r.reason ? <span className="dim"> · {r.reason}</span> : null}
            </span>
            <select aria-label={`Status of ${r.text}`} value={r.status} onChange={(e) => setStatus(r, e.target.value as RiskStatus)}>
              {riskStatuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button className="icon-btn" aria-label={`Delete risk ${r.text}`} title="Delete risk" onClick={() => void write("/native/risks/delete", { idea, risk: r.id })}>
              ×
            </button>
            {waiving?.id === r.id && (
              <form
                className="risk-waive"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await write("/native/risks/set", { idea, risk: r.id, status: "waived", reason: waiving.reason.trim() })) setWaiving(null);
                }}
              >
                <input aria-label="Why it is waived" autoFocus placeholder="Why it can be waived, e.g. only matters for live trading" value={waiving.reason} onChange={(e) => setWaiving({ ...waiving, reason: e.target.value })} />
                <button className="btn small" disabled={!waiving.reason.trim()}>
                  Waive
                </button>
                <button type="button" className="btn small ghost" onClick={() => setWaiving(null)}>
                  Cancel
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form
        className="risk-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await write("/native/risks/add", { idea, text: text.trim(), kind }))) setText("");
        }}
      >
        <input aria-label="New risk" placeholder="Add a risk, e.g. funding is published after the decision time" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Kind of risk" value={kind} onChange={(e) => setKind(e.target.value as Risk["kind"])}>
          {riskKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="btn small" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {error && <p className="notice error">{error}</p>}
    </section>
  );
}

/** In a run: record it as the evidence for one of the idea's risks. */
export function RunAsEvidence({ idea, run }: { idea: string; run: string }) {
  const scope = useResearch();
  const list = useRisks(idea, 10000);
  const [risk, setRisk] = useState("");
  const [error, setError] = useState("");
  const risks = list.data?.risks ?? [];
  if (!risks.length) return null;
  const mark = async (status: "measured-ok" | "failed") => {
    setError("");
    try {
      await scope.client.write("/native/risks/set", { idea, risk, status, evidence: { run } });
      setRisk("");
      await list.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const tested = risks.filter((r) => r.evidenceRun?.id === run);
  return (
    <div className="run-evidence">
      {tested.map((r) => (
        <span key={r.id} className={`tag ${r.status === "failed" ? "err" : r.status === "measured-ok" ? "ok" : ""}`}>
          {RISK_GLYPH[r.status]} evidence for: {r.text}
        </span>
      ))}
      <select aria-label="Risk this run tests" value={risk} onChange={(e) => setRisk(e.target.value)}>
        <option value="">This run tests a risk…</option>
        {risks.map((r) => (
          <option key={r.id} value={r.id}>
            {RISK_GLYPH[r.status]} {r.text}
          </option>
        ))}
      </select>
      {risk && (
        <>
          <button className="btn small" onClick={() => void mark("measured-ok")}>
            ✓ holds
          </button>
          <button className="btn small ghost" onClick={() => void mark("failed")}>
            ✗ failed
          </button>
        </>
      )}
      {error && <span className="notice error">{error}</span>}
    </div>
  );
}
