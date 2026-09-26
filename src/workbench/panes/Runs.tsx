import { useState } from "react";
import { useResearch } from "../research";
import { usePoll } from "../usePoll";
import { formatTime } from "../transcript";
import { AskPi, RdViewer, developingIdea, type RdFile } from "./ResearchDev";
import { RunAsEvidence, riskSummary, type RiskList } from "./Risks";

/** Runs (Develop) and the release candidate (Release): the workspace's code,
 * executed by the app as recorded runs (server/workbench/runs.ts). The panes
 * use the same registry operations agents use (runs_list, run_submit, …). */

interface Summary {
  id: string;
  idea: string;
  status: "queued" | "preparing" | "running" | "succeeded" | "failed" | "cancelled" | "lost";
  reason: string | null;
  entry: string | null;
  command: string;
  commit: string;
  checkpointMessage: string;
  autoCheckpoint: boolean;
  candidate: number | null;
  origin: "user" | "agent";
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  usage: { wallSeconds: number; peakMemoryBytes?: number } | null;
  metrics: Record<string, number | string>;
  outputs: number;
}
interface Overview {
  idea: string;
  entries: { name: string; command: string; description: string | null }[];
  manifestError: string | null;
  runs: Summary[];
  limit: { runs: number; minutes: number };
  agentUsage: { runs: number; minutes: number };
}
interface Full extends Omit<Summary, "outputs" | "usage" | "metrics"> {
  environment: { lock: { file: string; sha256: string } | null; files: string[]; shell: string };
  hardware: { platform: string; arch: string; cpu: string; cores: number; memoryBytes: number };
  snapshots: { name: string; sha256: string }[];
  usage?: { wallSeconds: number; peakMemoryBytes?: number };
  metrics?: Record<string, number | string>;
  outputs?: { path: string; bytes: number; sha256: string }[];
  outputsTruncated?: boolean;
  wallSeconds: number;
  note?: string;
  logTail: string;
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const active = (s: Summary["status"]) => s === "queued" || s === "preparing" || s === "running";
const GLYPH: Record<Summary["status"], string> = { queued: "○", preparing: "◌", running: "●", succeeded: "✓", failed: "✗", cancelled: "⊘", lost: "?" };
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);
const duration = (s?: number | null) => (s === null || s === undefined ? "" : s < 60 ? `${s.toFixed(1)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
/** Metrics to four significant digits, without trailing zeros (1.2, 0.3, 12,345). */
const metric = (v: number | string) => (typeof v === "number" ? (Math.abs(v) >= 1000 || Number.isInteger(v) ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(4)))) : v);
const label = (r: { entry: string | null; command: string }) => r.entry ?? r.command;
const runKey = (idea: string) => `research:run:${idea}`;
const kindOf = (p: string): RdFile["kind"] => (/\.pdf$/i.test(p) ? "pdf" : /\.(png|jpe?g|gif|webp)$/i.test(p) ? "image" : /\.(py|md|markdown|txt|csv|tsv|json|toml|ya?ml|log|html?|ipynb|tex|sh|r|jl|sql)$/i.test(p) || !p.includes(".") ? "text" : "binary");

/** Develop → Runs: start the workspace's entries, follow them, compare two. */
export function RunsPane() {
  const scope = useResearch();
  const dev = developingIdea(scope.view, scope.drafts);
  const overview = usePoll<Overview>(dev ? `/native/runs?idea=${dev.target}` : null, 2000);
  const [command, setCommand] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!dev) return <p className="rd-empty">Choose a pursued idea to develop in the bar above.</p>;
  const o = overview.data;
  const runs = o?.runs ?? [];
  const chosen = scope.drafts[runKey(dev.target)];
  const selected = runs.find((r) => r.id === chosen) ?? runs[0] ?? null;
  const [a, b] = (scope.drafts[`${runKey(dev.target)}:compare`] ?? "").split(",");
  const comparing = a && b && runs.some((r) => r.id === a) && runs.some((r) => r.id === b) ? ([a, b] as const) : null;
  const submit = async (input: { entry?: string; command?: string }) => {
    setBusy(true);
    setError("");
    try {
      const r = await scope.client.write<Summary>("/native/runs/submit", { idea: dev.target, ...input, wallMinutes: minutes });
      scope.setDraft(runKey(dev.target), r.id);
      scope.setDraft(`${runKey(dev.target)}:compare`, "");
      if (input.command) setCommand("");
      await overview.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rd-split runs-pane">
      <nav className="rd-tree runs-list" aria-label="Runs">
        <div className="runs-start">
          {o?.entries.map((e) => (
            <button key={e.name} className="btn small" disabled={busy} title={`${e.command}${e.description ? `\n${e.description}` : ""}`} onClick={() => void submit({ entry: e.name })}>
              Run ▸ {e.name}
            </button>
          ))}
          <form
            className="runs-command"
            onSubmit={(e) => {
              e.preventDefault();
              if (command.trim()) void submit({ command: command.trim() });
            }}
          >
            <input aria-label="Command to run" placeholder={o?.entries.length ? "or a command…" : "Command, e.g. uv run python train.py"} value={command} onChange={(e) => setCommand(e.target.value)} />
            <input aria-label="Time limit in minutes" type="number" min={1} max={1440} value={minutes} title="Time limit (minutes)" onChange={(e) => setMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 60)))} />
            <button className="btn small" disabled={busy || !command.trim()}>
              Run
            </button>
          </form>
          {o?.manifestError && <p className="notice error">{o.manifestError}</p>}
          {o && !o.entries.length && !o.manifestError && (
            <p className="rd-empty">
              Add entries to <code>research.toml</code> (<code>[run.train]</code> <code>command = "…"</code>) for one-click runs. Runs write results to <code>outputs/</code>; <code>outputs/metrics.json</code> becomes the run's metrics.
            </p>
          )}
          {error && <p className="notice error">{error}</p>}
        </div>
        {runs.map((r) => (
          <button
            key={r.id}
            className={`run-row ${selected?.id === r.id && !comparing ? "on" : ""} ${comparing?.includes(r.id) ? "cmp" : ""}`}
            title="Click to open · ⇧-click to compare with the open run"
            onClick={(e) => {
              if (e.shiftKey && selected && selected.id !== r.id) scope.setDraft(`${runKey(dev.target)}:compare`, `${selected.id},${r.id}`);
              else {
                scope.setDraft(runKey(dev.target), r.id);
                scope.setDraft(`${runKey(dev.target)}:compare`, "");
              }
            }}
          >
            <span className={`t st-${r.status}`}>
              <span className="g" aria-label={r.status}>
                {GLYPH[r.status]}
              </span>{" "}
              {label(r)}
              {r.candidate ? <span className="tag ok">candidate {r.candidate}</span> : null}
              {r.origin === "agent" ? <span className="tag">agent</span> : null}
            </span>
            <span className="m">
              {r.commit.slice(0, 7)} · {formatTime(r.createdAt)?.short ?? ""}
              {r.usage ? ` · ${duration(r.usage.wallSeconds)}` : ""}
              {Object.entries(r.metrics)
                .slice(0, 2)
                .map(([k, v]) => ` · ${k} ${metric(v)}`)
                .join("")}
            </span>
          </button>
        ))}
        {o && !runs.length && <p className="rd-empty">No runs yet.</p>}
        {o && <AgentLimit limit={o.limit} used={o.agentUsage} onSaved={() => void overview.reload()} />}
      </nav>
      {comparing ? (
        <RunCompare a={comparing[0]} b={comparing[1]} onClose={() => scope.setDraft(`${runKey(dev.target)}:compare`, "")} />
      ) : selected ? (
        <RunDetail id={selected.id} others={runs.filter((r) => r.id !== selected.id)} onCompare={(other) => scope.setDraft(`${runKey(dev.target)}:compare`, `${selected.id},${other}`)} />
      ) : (
        <p className="rd-empty">Nothing to show yet.</p>
      )}
    </div>
  );
}

/** How much an agent may run without asking; only the user changes it. */
function AgentLimit({ limit, used, onSaved }: { limit: Overview["limit"]; used: Overview["agentUsage"]; onSaved: () => void }) {
  const scope = useResearch();
  const [edit, setEdit] = useState<{ runs: number; minutes: number } | null>(null);
  const [error, setError] = useState("");
  if (!edit)
    return (
      <p className="runs-limit" title="Runs and run minutes an agent may start in any hour without you">
        Agent limit: {used.runs}/{limit.runs} runs · {used.minutes}/{limit.minutes} min this hour{" "}
        <button className="btn small ghost" onClick={() => setEdit(limit)}>
          Change
        </button>
      </p>
    );
  return (
    <form
      className="runs-limit"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await scope.client.write("/native/runs/limit", edit);
          setEdit(null);
          onSaved();
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      Agent may start{" "}
      <input aria-label="Runs per hour" type="number" min={0} max={100} value={edit.runs} onChange={(e) => setEdit({ ...edit, runs: Number(e.target.value) || 0 })} /> runs and{" "}
      <input aria-label="Run minutes per hour" type="number" min={0} max={1440} value={edit.minutes} onChange={(e) => setEdit({ ...edit, minutes: Number(e.target.value) || 0 })} /> run minutes per hour{" "}
      <button className="btn small">Save</button>
      <button type="button" className="btn small ghost" onClick={() => setEdit(null)}>
        Cancel
      </button>
      {error && <span className="notice error">{error}</span>}
    </form>
  );
}

/** One run: what ran, how it ended, metrics, outputs and the log. */
export function RunDetail({ id, others = [], onCompare }: { id: string; others?: Summary[]; onCompare?: (other: string) => void }) {
  const scope = useResearch();
  const status = usePoll<Full>(`/native/runs/status?run=${id}`, 1500);
  const r = status.data;
  const running = !!r && active(r.status);
  const log = usePoll<{ text: string }>(running ? `/native/runs/log?run=${id}` : null, 1500);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!r) return <p className="rd-empty">{status.error ?? "loading…"}</p>;
  const out = r.outputs?.find((o) => o.path === output);
  return (
    <div className="rd-viewer run-detail">
      <div className="rd-viewer-head">
        <span className={`path st-${r.status}`}>
          {GLYPH[r.status]} {label(r)}
        </span>
        <span className="dim">
          {r.status}
          {r.usage ? ` · ${duration(r.usage.wallSeconds)}` : ""}
        </span>
        {running && (
          <button
            className="btn small ghost"
            onClick={() =>
              scope.client.write("/native/runs/cancel", { run: r.id }).then(
                () => status.reload(),
                (e) => setError(errorText(e)),
              )
            }
          >
            Cancel
          </button>
        )}
        {onCompare && others.length > 0 && (
          <select aria-label="Compare with" value="" onChange={(e) => e.target.value && onCompare(e.target.value)}>
            <option value="">Compare with…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {label(o)} · {o.commit.slice(0, 7)} · {formatTime(o.createdAt)?.short ?? ""}
              </option>
            ))}
          </select>
        )}
        <AskPi text={`About run ${r.id} (${label(r)}, checkpoint ${r.commit.slice(0, 8)}, ${r.status}): `} />
      </div>
      <div className="rd-viewer-body run-body">
        {error && <p className="notice error">{error}</p>}
        {r.reason && <p className={`notice ${r.status === "succeeded" ? "" : "error"}`}>{r.reason}</p>}
        {!running && <RunAsEvidence idea={r.idea} run={r.id} />}
        <dl className="data-meta">
          <dt>checkpoint</dt>
          <dd>
            <code>{r.commit.slice(0, 8)}</code> {r.checkpointMessage}
            {r.autoCheckpoint ? <span className="dim"> · recorded for this run</span> : null}
          </dd>
          <dt>command</dt>
          <dd>
            <code>{r.command}</code>
          </dd>
          <dt>environment</dt>
          <dd>
            {r.environment.lock ? (
              <>
                {r.environment.lock.file} <code>{r.environment.lock.sha256.slice(0, 12)}</code>
              </>
            ) : (
              <span className="warn">no lock file: this environment can't be rebuilt exactly (add uv.lock)</span>
            )}
          </dd>
          <dt>data</dt>
          <dd>{r.snapshots.length ? r.snapshots.map((s) => s.name).join(", ") : <span className="dim">no snapshots used</span>}</dd>
          <dt>hardware</dt>
          <dd>
            {r.hardware.cpu} · {r.hardware.cores} cores · {bytes(r.hardware.memoryBytes)}
          </dd>
          {r.usage?.peakMemoryBytes ? (
            <>
              <dt>peak memory</dt>
              <dd>{bytes(r.usage.peakMemoryBytes)}</dd>
            </>
          ) : null}
          {r.note ? (
            <>
              <dt>note</dt>
              <dd>{r.note}</dd>
            </>
          ) : null}
        </dl>
        {r.metrics && Object.keys(r.metrics).length > 0 && (
          <div className="table-wrap">
            <table aria-label="Metrics">
              <tbody>
                {Object.entries(r.metrics).map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>{metric(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.outputs && r.outputs.length > 0 && (
          <div className="run-outputs" aria-label="Outputs">
            {r.outputs.map((o) => (
              <button key={o.path} className={`rd-doc ${output === o.path ? "on" : ""}`} onClick={() => setOutput(output === o.path ? null : o.path)}>
                <span className="t">{o.path}</span>
                <span className="m">{bytes(o.bytes)}</span>
              </button>
            ))}
            {r.outputsTruncated && <p className="rd-empty">Only the first 2,000 files are listed.</p>}
          </div>
        )}
        {out && (
          <RdViewer
            idea={r.idea}
            file={{ path: out.path, bytes: out.bytes, modified: r.endedAt ?? r.createdAt, kind: kindOf(out.path), document: true }}
            url={`/native/runs/output?run=${r.id}&path=${encodeURIComponent(out.path)}`}
            askPi={`About \`${out.path}\` from run ${r.id}: `}
          />
        )}
        <pre className="run-log" aria-label="Log">
          {(running ? log.data?.text : r.logTail) || (running ? "…" : "(empty log)")}
        </pre>
      </div>
    </div>
  );
}

interface Comparison {
  a: Summary;
  b: Summary;
  differences: { field: string; a: string; b: string }[];
  warnings: string[];
  metrics: { name: string; a: number | string | null; b: number | string | null; delta: number | null }[];
}
/** Two runs side by side: what differed in how they ran, and their metrics. */
function RunCompare({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const c = usePoll<Comparison>(`/native/runs/compare?a=${a}&b=${b}`, 5000).data;
  if (!c) return <p className="rd-empty">loading…</p>;
  return (
    <div className="rd-viewer run-compare">
      <div className="rd-viewer-head">
        <span className="path">
          {label(c.a)} ({c.a.commit.slice(0, 7)}) vs {label(c.b)} ({c.b.commit.slice(0, 7)})
        </span>
        <AskPi text={`Compare runs ${c.a.id} and ${c.b.id} (run_compare): `} />
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="rd-viewer-body run-body">
        {c.warnings.map((w) => (
          <p key={w} className="notice warn">
            {w}
          </p>
        ))}
        <div className="table-wrap">
          <table aria-label="Metrics compared">
            <thead>
              <tr>
                <th>metric</th>
                <th>{c.a.commit.slice(0, 7)}</th>
                <th>{c.b.commit.slice(0, 7)}</th>
                <th>change</th>
              </tr>
            </thead>
            <tbody>
              {c.metrics.map((m) => (
                <tr key={m.name}>
                  <th>{m.name}</th>
                  <td>{m.a === null ? "—" : metric(m.a)}</td>
                  <td>{m.b === null ? "—" : metric(m.b)}</td>
                  <td className={m.delta === null ? "" : m.delta > 0 ? "up" : m.delta < 0 ? "down" : ""}>{m.delta === null ? "" : `${m.delta > 0 ? "+" : ""}${metric(m.delta)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {c.differences.length > 0 && (
          <dl className="data-meta">
            {c.differences.map((d) => (
              <div key={d.field}>
                <dt>{d.field}</dt>
                <dd>
                  <code>{d.a}</code> → <code>{d.b}</code>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

interface CandidateStatus {
  current: null | {
    idea: string;
    title: string;
    version: number;
    number: number;
    checkpoint: string;
    checkpointMessage: string;
    snapshots: { name: string; sha256: string }[];
    committedAt: string;
    entry?: string;
    note?: string;
  };
  checks?: { environmentLock: boolean; snapshotsKept: number; entry: string | null; risks?: RiskList["counts"] };
  state?: "not validated" | "validating" | "passed" | "failed";
  validationRuns?: Summary[];
  earlier: number;
}
/** Release → Candidate: what the candidate is, its checks, and validating it. */
export function CandidatePane() {
  const scope = useResearch();
  const status = usePoll<CandidateStatus>("/native/candidate", 3000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const s = status.data;
  if (!s) return <p className="rd-empty">{status.error ?? "loading…"}</p>;
  const c = s.current;
  if (!c)
    return (
      <div className="candidate-pane">
        <p className="rd-empty">No release candidate yet. Create one in Develop when you are convinced: it freezes the idea's version, a checkpoint and the data it used.</p>
        <button className="btn small ghost" onClick={() => scope.goToStage?.("research")}>
          Develop →
        </button>
      </div>
    );
  const runs = s.validationRuns ?? [];
  const shown = runs.find((r) => r.id === open) ?? runs[0];
  const validate = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await scope.client.write<Summary>("/native/candidate/validate", {});
      setOpen(r.id);
      await status.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rd-split candidate-pane">
      <nav className="rd-tree" aria-label="Release candidate">
        <div className="candidate-head">
          <b>
            “{c.title}” v{c.version}
          </b>
          <span className="dim">
            candidate {c.number} · {formatTime(c.committedAt)?.short ?? ""}
          </span>
          <span className={`tag ${s.state === "passed" ? "ok" : s.state === "failed" ? "err" : ""}`}>{s.state}</span>
        </div>
        <ul className="candidate-checks" aria-label="Checks">
          <li className="ok">
            ✓ exact checkpoint <code>{c.checkpoint.slice(0, 8)}</code> {c.checkpointMessage} (tag candidate/{c.number})
          </li>
          <li className={c.snapshots.length ? "ok" : ""}>
            {c.snapshots.length ? "✓" : "·"} {c.snapshots.length} data snapshot{c.snapshots.length === 1 ? "" : "s"} kept{c.snapshots.length ? `: ${c.snapshots.map((x) => x.name).join(", ")}` : ""}
          </li>
          <li className={s.checks?.environmentLock ? "ok" : "warn"}>{s.checks?.environmentLock ? "✓ environment lock (uv.lock)" : "▲ no environment lock: validation can't be rebuilt exactly (add uv.lock)"}</li>
          {(() => {
            const rs = riskSummary(s.checks?.risks);
            return rs ? (
              <li className={rs.level === "ok" ? "ok" : "warn"}>
                <button className="link" title="Open the idea's risks" onClick={() => (scope.setDraft("ideas:active", c.idea), scope.goToStage?.("ideas", "idea"))}>
                  {rs.level === "ok" ? "✓" : "▲"} {rs.text}
                </button>
              </li>
            ) : null;
          })()}
          <li className={s.checks?.entry ? "ok" : "warn"}>
            {s.checks?.entry ? (
              <>
                ✓ validates with <code>{s.checks.entry}</code>
              </>
            ) : (
              "▲ no validation entry: add [run.validate] to research.toml"
            )}
          </li>
        </ul>
        <button className="btn small primary" disabled={busy || !s.checks?.entry} onClick={() => void validate()}>
          {busy ? "Starting…" : runs.length ? "Validate again" : "Validate"}
        </button>
        {error && <p className="notice error">{error}</p>}
        {runs.length > 0 && <h3 className="section-title">validation runs</h3>}
        {runs.map((r) => (
          <button key={r.id} className={`run-row ${shown?.id === r.id ? "on" : ""}`} onClick={() => setOpen(r.id)}>
            <span className={`t st-${r.status}`}>
              {GLYPH[r.status]} {label(r)}
            </span>
            <span className="m">
              {formatTime(r.createdAt)?.short ?? ""}
              {r.usage ? ` · ${duration(r.usage.wallSeconds)}` : ""}
            </span>
          </button>
        ))}
        {s.earlier > 0 && <p className="rd-empty">{s.earlier} earlier candidate{s.earlier === 1 ? "" : "s"} kept.</p>}
      </nav>
      {shown ? <RunDetail id={shown.id} /> : <p className="rd-empty">Validate the candidate: its entry runs on exactly its checkpoint, not the workspace's later changes.</p>}
    </div>
  );
}
