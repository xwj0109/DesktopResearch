import { useEffect, useState } from "react";
import { useResearch } from "../research";
import { formatTime } from "../transcript";

/** The production stages (Data, Design & Code, Backtests, Results) work on the
 * release candidate created in Research Development: this bar states which, exactly. */
export const PRODUCTION_STAGES = ["data", "code", "backtests", "results"];

export function ProductionBar() {
  const scope = useResearch();
  const c = scope.view?.production?.current;
  if (!scope.view || scope.portfolio) return null;
  return (
    <div className="rd-bar prod-bar" role="region" aria-label="Release candidate">
      <span className="lbl">candidate</span>
      {c ? (
        <>
          <span className="prod-title" title={c.title}>
            {c.title}
          </span>
          <span className="meta">
            v{c.version} · checkpoint “{c.checkpointMessage}” ({c.checkpoint.slice(0, 8)}) · {c.snapshots.length} snapshot{c.snapshots.length === 1 ? "" : "s"} · created {formatTime(c.committedAt)?.full ?? c.committedAt}
          </span>
        </>
      ) : (
        <>
          <span className="rd-none">No release candidate yet. Create one in Research Development when you are convinced.</span>
          <button className="btn small ghost" onClick={() => scope.goToStage?.("research")}>
            Research Development →
          </button>
        </>
      )}
    </div>
  );
}

interface Preview {
  title: string | null;
  version: number | null;
  pursued: boolean;
  checkpoint: { sha: string; message: string; at: string } | null;
  pending: number;
  snapshots: { name: string; title: string; bytes: number; referenced: boolean }[];
  current: { idea: string; version: number; checkpoint: string } | null;
  entries?: { name: string; command: string }[];
  defaultEntry?: string | null;
}
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Research Development → release candidate: what gets frozen, then the commit. */
export function SendToProduction({ idea, onClose }: { idea: string; onClose: () => void }) {
  const scope = useResearch();
  const [p, setP] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const load = () =>
    scope.client.read<Preview>(`/native/production/preview?idea=${idea}`).then(
      (d) => {
        setP(d);
        setPicked(new Set(d.snapshots.filter((s) => s.referenced).map((s) => s.name)));
        setEntry((e) => e || d.defaultEntry || "");
      },
      (e) => setError(errorText(e)),
    );
  useEffect(() => {
    void load();
  }, [idea]);
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await scope.client.write("/native/production/commit", { idea, snapshots: [...picked], ...(note.trim() ? { note: note.trim() } : {}), ...(entry.trim() ? { entry: entry.trim() } : {}) });
      setSent(true);
      await scope.refresh().catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prod-send" role="dialog" aria-label="Create release candidate">
      {sent ? (
        <>
          <p>
            <b>“{p?.title}” v{p?.version} is the release candidate.</b> Validate it and collect its live data in Release.
          </p>
          <div className="row-actions">
            <button className="btn small primary" onClick={() => scope.goToStage?.("data", "candidate")}>
              Go to Release →
            </button>
            <button className="btn small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : !p ? (
        <p className="rd-empty">{error || "Preparing…"}</p>
      ) : (
        <>
          <p>
            <b>
              Create a release candidate from “{p.title}” v{p.version}?
            </b>{" "}
            This freezes the idea's exact version, the workspace checkpoint {p.checkpoint ? `“${p.checkpoint.message}” (${p.checkpoint.sha.slice(0, 8)}, ${formatTime(p.checkpoint.at)?.short ?? ""})` : ""} and the data it used. That data is kept while the candidate is.
            {p.current ? (p.current.idea === idea ? ` It becomes the current candidate in place of v${p.current.version}; earlier candidates are kept.` : " It becomes the current candidate in place of another idea's; earlier candidates are kept.") : ""}
          </p>
          {p.pending > 0 && (
            <p className="notice error">
              The workspace has {p.pending} change{p.pending === 1 ? "" : "s"} not yet checkpointed. Record a checkpoint in the Changes tab first, so the candidate is an exact state.
            </p>
          )}
          {p.snapshots.length > 0 && (
            <fieldset className="prod-snaps">
              <legend>Data snapshots to freeze with it</legend>
              {p.snapshots.map((s) => (
                <label key={s.name}>
                  <input type="checkbox" checked={picked.has(s.name)} onChange={() => setPicked((x) => (x.has(s.name) ? new Set([...x].filter((n) => n !== s.name)) : new Set([...x, s.name])))} />
                  {s.title}
                  {s.referenced ? <span className="tag">used by the code</span> : null}
                </label>
              ))}
            </fieldset>
          )}
          <label className="prod-entry">
            Validate with{" "}
            {p.entries?.length ? (
              <select aria-label="Validation entry" value={entry} onChange={(e) => setEntry(e.target.value)}>
                <option value="">(choose later)</option>
                {p.entries.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}: {e.command}
                  </option>
                ))}
              </select>
            ) : (
              <input aria-label="Validation command" placeholder="a command, e.g. uv run python validate.py" value={entry} onChange={(e) => setEntry(e.target.value)} />
            )}
          </label>
          <input className="prod-note" aria-label="Note" placeholder="Note (optional), e.g. why this version" value={note} onChange={(e) => setNote(e.target.value)} />
          {error && <p className="notice error">{error}</p>}
          <div className="row-actions">
            <button className="btn small primary" disabled={busy || p.pending > 0 || !p.pursued} onClick={() => void send()}>
              {busy ? "Creating…" : "Create release candidate"}
            </button>
            <button className="btn small ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            {p.pending > 0 && (
              <button className="btn small ghost" onClick={() => void load()}>
                Check again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
