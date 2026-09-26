import { useEffect, useRef, useState } from "react";
import { exportSchema } from "../../platform";
import { fieldLabel } from "../ResearchForm";
import {
  ActionPanel,
  PaneLoading,
  RecordEditor,
  useAction,
  useResearch,
} from "../research";
import { formatTime } from "../transcript";

const statusClass: Record<string, string> = {
  completed: "ok",
  failed: "warn",
  interrupted: "warn",
  cancelled: "",
  queued: "accent",
  running: "accent",
};
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function useRunDetail(runId?: string, status?: string) {
  const { client } = useResearch();
  const [detail, setDetail] = useState<any>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (!runId) return setDetail(undefined);
    let alive = true;
    setError("");
    void client.read(`/science/runs/${runId}`).then(
      (d) => alive && setDetail(d),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [runId, status]);
  return { detail, error };
}

function RunInputs({ config, historical }: { config: any; historical?: boolean }) {
  const ref = (r: any) => (r?.hash ? `${r.id.slice(0, 8)} @ ${r.hash.slice(0, 12)}` : "—");
  return (
    <>
      <dl className="kv">
        <div><dt>Specification</dt><dd>{ref(config.spec)}</dd></div>
        <div><dt>Data contract</dt><dd>{ref(config.contract)}</dd></div>
        <div><dt>Dataset</dt><dd>{ref(config.dataset)}</dd></div>
        <div><dt>Design graph</dt><dd>{ref(config.graph)}</dd></div>
        <div><dt>Rule</dt><dd>{config.rule}{config.rule === "moving-average" ? ` · window ${config.window}` : ""}</dd></div>
        <div><dt>Costs</dt><dd>{config.feeBps} bps fee · {config.slippageBps} bps slippage</dd></div>
        <div><dt>Partition</dt><dd>{config.partition} · {config.start} → {config.end}</dd></div>
        <div><dt>Seed</dt><dd>{config.seed}</dd></div>
      </dl>
      {historical && (
        <p className="note">
          These are the exact historical inputs of this run; current code or specification may have
          changed since.
        </p>
      )}
    </>
  );
}

/** Backtests right pane (§5.6): queue, run records and a lower log region. */
export function RunsPane() {
  const scope = useResearch();
  const cancel = useAction();
  const [selected, setSelected] = useState<string>();
  const runs: any[] = scope.view?.science?.state?.runs ?? [];
  const run = runs.find((r) => r.id === selected) ?? runs.at(-1);
  const { detail, error } = useRunDetail(run?.id, run?.status);
  if (!scope.view) return <PaneLoading />;
  return (
    <div className="pane-col">
      <div className="pane-body">
        <div className="pane-inner">
          <ActionPanel commands={["run.queue"]} title="Queue reference experiment" />
          <section className="block">
            <h3 className="section-title">
              runs <span className="count">{runs.length}</span>
            </h3>
            <div className="list" role="listbox" aria-label="Experiment runs">
              {[...runs].reverse().map((r) => (
                <button
                  key={r.id}
                  role="option"
                  aria-selected={r.id === run?.id}
                  className={`list-row ${r.id === run?.id ? "selected" : ""}`}
                  onClick={() => setSelected(r.id)}
                >
                  <span className="title">
                    run {r.id.slice(0, 8)}
                    <small>
                      input {r.inputHash.slice(0, 10)} · {formatTime(r.history.at(-1)?.at)?.short ?? ""}
                    </small>
                  </span>
                  <span className={`tag ${statusClass[r.status] ?? ""}`}>{r.status}</span>
                </button>
              ))}
              {!runs.length && (
                <p className="list-empty">
                  No runs yet. Runs need an approved specification, contract, dataset and graph;
                  reruns create new records.
                </p>
              )}
            </div>
          </section>
          {run && (
            <section className="block">
              <div className="block-head">
                <h3 className="section-title">run {run.id.slice(0, 8)}</h3>
                {(run.status === "queued" || run.status === "running") && (
                  <button
                    className="btn small danger"
                    disabled={cancel.busy}
                    onClick={() =>
                      void cancel.run(
                        () => cancel.sendCommand({ type: "run.cancel", runId: run.id }),
                        "Cancellation recorded. Inspect the run history for the outcome.",
                      )
                    }
                  >
                    Cancel run
                  </button>
                )}
              </div>
              {cancel.notices}
              {error && <p className="notice error">{error}</p>}
              {detail?.input?.config && <RunInputs config={detail.input.config} historical />}
              {detail?.requiresExposure && (
                <p className="notice warn">
                  Completed. Results stay undisclosed until you disclose them explicitly in the Results stage.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
      {run && (
        <div className="log" aria-label="Run log">
          {run.history.map((h: any, i: number) => (
            <div key={i}>
              <span className="dim">{formatTime(h.at)?.full ?? h.at}</span>{" "}
              <span className={statusClass[h.status] ?? ""}>{h.status.padEnd(11)}</span> {h.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Equity (top) and drawdown (bottom) with a draggable interval selection. */
export function EquityChart({
  points,
  range,
  onRange,
}: {
  points: any[];
  range: [number, number] | null;
  onRange: (r: [number, number] | null) => void;
}) {
  const W = 600,
    H = 230,
    L = 44,
    R = 10,
    top = 12,
    eqH = 130,
    ddTop = 164,
    ddH = 52;
  const svg = useRef<SVGSVGElement>(null);
  const anchor = useRef<number | null>(null);
  const n = points.length;
  const eq = points.map((p) => p.equity ?? 1),
    dd = points.map((p) => p.drawdown ?? 0);
  const max = Math.max(...eq),
    min = Math.min(...eq),
    ddMin = Math.min(-0.0001, ...dd);
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, n - 1);
  const ye = (v: number) => top + eqH - (eqH * (v - min)) / Math.max(1e-9, max - min);
  const yd = (v: number) => ddTop + (ddH * v) / ddMin;
  const index = (clientX: number) => {
    const rect = svg.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
  };
  const line = eq.map((v, i) => `${x(i)},${ye(v)}`).join(" ");
  const ddArea = `${x(0)},${ddTop} ${dd.map((v, i) => `${x(i)},${yd(v)}`).join(" ")} ${x(n - 1)},${ddTop}`;
  return (
    <div className="chart">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Equity and drawdown; drag to select an interval"
        onPointerDown={(e) => {
          anchor.current = index(e.clientX);
          svg.current?.setPointerCapture?.(e.pointerId);
          onRange(null);
        }}
        onPointerMove={(e) => {
          if (anchor.current === null) return;
          const i = index(e.clientX);
          if (i !== anchor.current) onRange([Math.min(anchor.current, i), Math.max(anchor.current, i)]);
        }}
        onPointerUp={() => {
          anchor.current = null;
        }}
        style={{ cursor: "crosshair", touchAction: "none" }}
      >
        <g className="grid">
          {[0, 0.5, 1].map((t) => (
            <line key={t} x1={L} x2={W - R} y1={top + eqH * t} y2={top + eqH * t} />
          ))}
          <line x1={L} x2={W - R} y1={ddTop} y2={ddTop} />
        </g>
        <text x="4" y={top + 8}>{max.toFixed(3)}</text>
        <text x="4" y={top + eqH}>{min.toFixed(3)}</text>
        <text x="4" y={ddTop + ddH}>{pct(ddMin)}</text>
        <text x="4" y={ddTop - 4}>dd</text>
        {range && (
          <rect className="brush" x={x(range[0])} y={top - 4} width={Math.max(1, x(range[1]) - x(range[0]))} height={H - top - 8} />
        )}
        <polygon className="area" points={`${x(0)},${top + eqH} ${line} ${x(n - 1)},${top + eqH}`} />
        <polyline points={line} />
        <polygon className="dd" points={ddArea} />
        <text x={L} y={H - 2}>{points[0]?.date}</text>
        <text x={W - R} y={H - 2} textAnchor="end">{points.at(-1)?.date}</text>
      </svg>
    </div>
  );
}

function intervalStats(points: any[], [i, j]: [number, number]) {
  const start = i > 0 ? points[i - 1].equity : points[i].equity / (1 + points[i].return);
  let peak = -Infinity,
    worst = 0,
    turnover = 0,
    cost = 0;
  for (let k = i; k <= j; k++) {
    peak = Math.max(peak, points[k].equity);
    worst = Math.min(worst, points[k].equity / peak - 1);
    turnover += points[k].turnover ?? 0;
    cost += points[k].cost ?? 0;
  }
  return { ret: points[j].equity / start - 1, worst, turnover, cost };
}

/** Results right pane (§5.7): disclosure, charts, interval references, lineage. */
export function ResultsPane() {
  const scope = useResearch();
  const expose = useAction(),
    exporter = useAction();
  const [selected, setSelected] = useState<string>();
  const [reason, setReason] = useState("");
  const [range, setRange] = useState<[number, number] | null>(null);
  const science = scope.view?.science?.state;
  const runs: any[] = (science?.runs ?? []).filter((r: any) => r.status === "completed");
  const run = runs.find((r) => r.id === selected) ?? runs.at(-1);
  const { detail, error } = useRunDetail(run?.id, `${run?.status}:${run?.exposures?.length}`);
  useEffect(() => setRange(null), [run?.id]);
  if (!scope.view) return <PaneLoading />;
  const points: any[] = detail?.output?.points ?? [];
  const stats = range && points.length ? intervalStats(points, range) : null;
  const cfg = detail?.input?.config;
  return (
    <div className="pane-col">
      <div className="pane-toolbar">
        <select aria-label="Completed run" value={run?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {!runs.length && <option value="">no completed runs</option>}
          {[...runs].reverse().map((r) => (
            <option key={r.id} value={r.id}>
              run {r.id.slice(0, 8)} · {r.exposures.length ? "disclosed" : "undisclosed"}
            </option>
          ))}
        </select>
        {cfg && <span className="tag">{cfg.partition}</span>}
        <span className="spacer" />
      </div>
      <div className="pane-body">
        <div className="pane-inner">
          {error && <p className="notice error">{error}</p>}
          {!run && (
            <div className="empty" style={{ paddingTop: 12 }}>
              <h2>No completed runs</h2>
              <p>Queue an experiment in Backtests. Results appear here once a run completes.</p>
            </div>
          )}
          {detail?.requiresExposure && (
            <section className="block">
              <p className="notice warn">
                This run's results are not disclosed yet. Disclosure is recorded against the run.{" "}
                {detail.disclosureNotice}
              </p>
              {expose.notices}
              <label className="stack">
                Reason for disclosure
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div>
                <button
                  className="btn primary small"
                  disabled={expose.busy || !reason.trim()}
                  onClick={() =>
                    void expose.run(
                      () => expose.sendCommand({ type: "run.expose", runId: run.id, reason }),
                      "Disclosure recorded.",
                    )
                  }
                >
                  Disclose results
                </button>
              </div>
            </section>
          )}
          {points.length > 0 && (
            <>
              <EquityChart points={points} range={range} onRange={setRange} />
              <div className="range-row">
                <label>
                  from
                  <input
                    type="range"
                    min={0}
                    max={points.length - 1}
                    value={range?.[0] ?? 0}
                    onChange={(e) => {
                      const a = Number(e.target.value);
                      setRange([Math.min(a, range?.[1] ?? points.length - 1), range?.[1] ?? points.length - 1]);
                    }}
                    aria-label="Interval start"
                  />
                </label>
                <label>
                  to
                  <input
                    type="range"
                    min={0}
                    max={points.length - 1}
                    value={range?.[1] ?? points.length - 1}
                    onChange={(e) => {
                      const b = Number(e.target.value);
                      setRange([range?.[0] ?? 0, Math.max(b, range?.[0] ?? 0)]);
                    }}
                    aria-label="Interval end"
                  />
                </label>
                {range && (
                  <button className="btn small ghost" onClick={() => setRange(null)}>
                    Clear
                  </button>
                )}
              </div>
              {range && stats && (
                <section className="block selection">
                  <h3 className="section-title">
                    selection · {points[range[0]].date} → {points[range[1]].date}
                  </h3>
                  <dl className="kv">
                    <div><dt>Interval return</dt><dd>{pct(stats.ret)}</dd></div>
                    <div><dt>Max drawdown</dt><dd>{pct(stats.worst)}</dd></div>
                    <div><dt>Turnover · cost</dt><dd>{stats.turnover.toFixed(3)} · {pct(stats.cost)}</dd></div>
                  </dl>
                  <div>
                    <button
                      className="btn primary small"
                      onClick={() =>
                        scope.appendComposer(
                          `[result reference · run ${run.id} · input ${run.inputHash.slice(0, 12)} · ${cfg.partition} · ${cfg.rule} · dataset ${cfg.dataset.id.slice(0, 8)}@${cfg.dataset.hash.slice(0, 12)} · interval ${points[range[0]].date} → ${points[range[1]].date} (points ${range[0] + 1}–${range[1] + 1} of ${points.length}) · computed: return ${pct(stats.ret)}, max drawdown ${pct(stats.worst)}]\n`,
                        )
                      }
                    >
                      Ask Pi about this interval
                    </button>
                  </div>
                  <p className="note">
                    Adds an exact run/interval reference to Pi’s input. Nothing is sent until you send it there.
                  </p>
                </section>
              )}
              <dl className="kv">
                {Object.entries(detail.output.metrics ?? {}).map(([k, v]) => (
                  <div key={k}>
                    <dt>{fieldLabel(k)}</dt>
                    <dd>{v === null ? "Unavailable" : typeof v === "number" ? v.toPrecision(5) : String(v)}</dd>
                  </div>
                ))}
              </dl>
              {detail.output.limitations?.map((t: string) => (
                <p className="notice warn" key={t}>
                  {t}
                </p>
              ))}
            </>
          )}
          {cfg && (
            <details className="fold">
              <summary>Lineage · exact inputs</summary>
              <div className="fold-body" style={{ alignItems: "stretch" }}>
                <RunInputs config={cfg} historical />
              </div>
            </details>
          )}
          {run && !detail?.requiresExposure && (
            <section className="block">
              <h3 className="section-title">frozen exports</h3>
              {exporter.notices}
              <div className="list">
                {(science?.exports ?? []).map((r: any) => (
                  <div className="list-row" key={r.id}>
                    <span className="title">
                      Export {r.id.slice(0, 8)}
                      <small>run {r.runId.slice(0, 8)}</small>
                    </span>
                    <button
                      className="btn small"
                      onClick={() =>
                        void exporter.run(async () => {
                          if (!scope.client.bridge.exportFile) throw new Error("File export unavailable");
                          const data = await scope.client.read(`/science/exports/${r.id}`);
                          await scope.client.bridge.exportFile({
                            name: `evidence-${r.id}.json`,
                            text: JSON.stringify(data, null, 2),
                          });
                        }, "Export saved.")
                      }
                    >
                      Save file
                    </button>
                  </div>
                ))}
                {!(science?.exports ?? []).length && <p className="list-empty">No frozen exports.</p>}
              </div>
              <ActionPanel commands={["export.create"]} title="Freeze evidence export for a portfolio" />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Data right pane (§5.4): contracts, handoffs, feasibility and bounded samples. */
export function DataPane() {
  const scope = useResearch();
  const inspect = useAction();
  const [rows, setRows] = useState<any>();
  const science = scope.view?.science?.state;
  if (!scope.view) return <PaneLoading />;
  return (
    <RecordEditor
      kinds={["contract"]}
      intro={
        <p className="note">
          Contracts make universe, units, timing and missingness explicit. Infeasible requirements go
          back to Research Development; nothing is silently substituted.
        </p>
      }
    >
      <section className="block">
        <h3 className="section-title">
          handoffs <span className="count">{science?.handoffs?.length ?? 0}</span>
        </h3>
        <div className="list">
          {(science?.handoffs ?? []).map((h: any) => {
            const f = (science?.feasibility ?? []).filter((x: any) => x.handoff === h.id).at(-1);
            return (
              <div className="list-row" key={h.id}>
                <span className="title">
                  spec {h.spec.hash.slice(0, 8)} → contract {h.contract.hash.slice(0, 8)}
                  <small>{f ? f.findings.join(" · ") : h.note}</small>
                </span>
                <span className={`tag ${f ? (f.feasible ? "ok" : "warn") : ""}`}>
                  {f ? (f.feasible ? "feasible" : "infeasible") : "unassessed"}
                </span>
              </div>
            );
          })}
          {!science?.handoffs?.length && (
            <p className="list-empty">No handoffs. Approve a specification and contract, then create one from Research Development.</p>
          )}
        </div>
      </section>
      <section className="block">
        <h3 className="section-title">
          datasets <span className="count">{science?.datasets?.length ?? 0}</span>
        </h3>
        {inspect.notices}
        <div className="list">
          {(science?.datasets ?? []).map((d: any) => (
            <div className="list-row" key={d.id}>
              <span className="title">
                {d.id.slice(0, 8)} · {d.count} rows
                <small>{[...(d.findings ?? []), ...(d.warnings ?? [])].join(" · ") || d.parser}</small>
              </span>
              <span className={`tag ${d.status === "accepted" ? "ok" : "warn"}`}>{d.status}</span>
              <button
                className="btn small"
                onClick={() => void inspect.run(async () => setRows(await scope.client.read(`/science/datasets/${d.id}`)), "")}
              >
                Sample
              </button>
            </div>
          ))}
          {!science?.datasets?.length && <p className="list-empty">No datasets ingested.</p>}
        </div>
        {rows && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>date</th>
                  <th>close</th>
                  {rows.rows.some((r: any) => r.signal !== undefined) && <th>signal</th>}
                </tr>
              </thead>
              <tbody>
                {rows.rows.map((r: any) => (
                  <tr key={r.date}>
                    <td>{r.date}</td>
                    <td>{r.close}</td>
                    {r.signal !== undefined && <td>{r.signal}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">
              Bounded sample: first {rows.rows.length} of {rows.dataset.count} rows · rows {rows.dataset.rowsHash?.slice(0, 12)}
            </p>
          </div>
        )}
      </section>
      <ActionPanel commands={["approval.record", "feasibility.record", "dataset.ingest"]} />
    </RecordEditor>
  );
}

/** Portfolio right pane (§11): frozen imports, analyses and producer feedback. */
export function PortfolioPane() {
  const scope = useResearch();
  const act = useAction();
  const [inspected, setInspected] = useState<any>();
  const science = scope.view?.science?.state;
  if (!scope.view) return <PaneLoading />;
  const inspect = (path: string) => void act.run(async () => setInspected(await scope.client.read(path)), "");
  return (
    <div className="pane-inner">
      {act.notices}
      <section className="block">
        <div className="block-head">
          <h3 className="section-title">
            frozen strategy evidence <span className="count">{science?.imports?.length ?? 0}</span>
          </h3>
          <label className="btn small file-pick">
            Import package
            <input
              type="file"
              accept=".json"
              disabled={act.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void act.run(async () => {
                    if (file.size > 5 * 1024 * 1024) throw new Error("Evidence package exceeds 5 MiB");
                    const pkg = exportSchema.parse(JSON.parse(await file.text()));
                    await act.sendCommand({ type: "import.add", package: pkg });
                  }, "Evidence imported as a frozen package.");
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <div className="list">
          {(science?.imports ?? []).map((r: any) => (
            <div className="list-row" key={r.id}>
              <span className="title">
                Producer {r.strategyId.slice(0, 12)}
                <small>
                  run {r.runId.slice(0, 12)} · {r.authenticity}
                </small>
              </span>
              <button className="btn small" onClick={() => inspect(`/imports/${r.id}`)}>
                Inspect
              </button>
            </div>
          ))}
          {!science?.imports?.length && (
            <p className="list-empty">
              No evidence imported. Freeze an export in a strategy's Results stage, then import the file here.
              Source updates never change imported evidence.
            </p>
          )}
        </div>
      </section>
      <section className="block">
        <h3 className="section-title">analyses</h3>
        <div className="list">
          {(science?.analyses ?? []).map((r: any) => (
            <button className="list-row" key={r.id} onClick={() => inspect(`/analyses/${r.id}`)}>
              <span className="title">Analysis {r.id.slice(0, 8)}</span>
            </button>
          ))}
          {!science?.analyses?.length && <p className="list-empty">No analyses yet.</p>}
        </div>
      </section>
      <section className="block">
        <h3 className="section-title">producer feedback</h3>
        <div className="list">
          {(science?.proposals ?? []).map((r: any) => (
            <button
              className="list-row"
              key={r.id}
              onClick={() =>
                void act.run(async () => {
                  if (!scope.client.bridge.exportFile) throw new Error("File export unavailable");
                  await scope.client.bridge.exportFile({
                    name: `proposal-${r.id}.json`,
                    text: JSON.stringify(await scope.client.read(`/proposals/${r.id}`), null, 2),
                  });
                }, "Proposal saved.")
              }
            >
              <span className="title">Save proposal {r.id.slice(0, 8)}</span>
            </button>
          ))}
          {!science?.proposals?.length && <p className="list-empty">No proposals drafted.</p>}
        </div>
        <p className="note">Feedback is a request; it cannot edit or approve producer research.</p>
      </section>
      <ActionPanel commands={["analysis.create", "proposal.create"]} />
      {inspected && (
        <details className="fold" open>
          <summary>Inspected record</summary>
          <pre className="code" style={{ border: 0 }}>
            {JSON.stringify(inspected, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
