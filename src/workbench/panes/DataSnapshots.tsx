import { useEffect, useMemo, useRef, useState } from "react";
import { useResearch } from "../research";
import { formatTime } from "../transcript";
import { developingIdea } from "./ResearchDev";

/** Data snapshots for Research Development: frozen data every idea workspace
 * reads from data/. Fetch public market data, register files (e.g. written by
 * the user's own code from a paid feed), and preview what is there. Same
 * registry operations agents use (data_*). */

interface Snapshot {
  name: string;
  title: string;
  file: string;
  source: { kind: string; symbol?: string; interval?: string; from?: string; note?: string; market?: string; dataset?: string };
  format?: string;
  types?: string[];
  files?: number;
  parts?: { date: string }[];
  missing?: string[];
  query?: { start: string; end: string };
  createdAt: string;
  rows: number | null;
  columns: string[];
  first?: string;
  last?: string;
  bytes: number;
  sha256: string;
  preview?: { head: string[][]; tail: string[][]; series: [string, number][]; valueColumn: string };
  references?: { idea: string; path: string }[];
  retainedBy?: { idea: string; title: string; version: number; committedAt: string; current: boolean }[];
}
interface Job {
  id: string;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  rows: number;
  progress: number;
  message: string;
  snapshot?: string;
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KiB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);
const sourceText = (s: Snapshot["source"]) =>
  s.kind === "file"
    ? `file ${s.from ?? ""}`
    : s.kind === "binance-archive"
      ? `Binance ${s.market} ${s.dataset}${s.interval ? ` ${s.interval}` : ""} · ${s.symbol}`
      : `${s.kind} ${s.symbol ?? ""}${s.interval ? ` · ${s.interval}` : ""}`;
/** How to open a snapshot in polars (lazily for folders of daily files). */
export const polarsSnippet = (s: { file: string; format?: string }) =>
  s.file.endsWith("/")
    ? `pl.scan_parquet("data/${s.file}*.parquet")`
    : s.format === "parquet" || s.file.endsWith(".parquet")
      ? `pl.read_parquet("data/${s.file}")`
      : s.file.endsWith(".json")
        ? `pl.read_json("data/${s.file}")`
        : `pl.read_csv("data/${s.file}"${s.file.endsWith(".tsv") ? ", separator=\"\\t\"" : ""})`;
const compact = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumSignificantDigits: 5 }));

/** One series over time: a 2px line, recessive axes, crosshair + tooltip. */
export function SeriesChart({ series, label }: { series: [string, number][]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (series.length < 2) return <p className="rd-empty">Not enough points to chart.</p>;
  const W = 640,
    H = 180,
    L = 8,
    R = 64,
    T = 10,
    B = 22;
  const values = series.map((p) => p[1]);
  let lo = Math.min(...values),
    hi = Math.max(...values);
  if (lo === hi) (lo -= 1), (hi += 1);
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const x = (i: number) => L + (i / (series.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const d = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const move = (e: React.MouseEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(((px - L) / (W - L - R)) * (series.length - 1)))));
  };
  const h = hover !== null ? series[hover] : null;
  // Intraday ranges label the ends with times, longer ranges with dates.
  const sameDay = series[0][0].slice(0, 10) === series.at(-1)![0].slice(0, 10);
  const end = (s: string) => (sameDay && s.length > 10 ? s.slice(0, 16).replace("T", " ") : s.slice(0, 10));
  return (
    <figure className="series-chart" aria-label={`${label} over time`}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={move} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="tick" x={W - R + 6} y={y(t) + 3}>
              {compact(t)}
            </text>
          </g>
        ))}
        <path className="line" d={d} />
        <text className="tick" x={L} y={H - 6}>
          {end(series[0][0])}
        </text>
        <text className="tick end" x={W - R} y={H - 6}>
          {end(series.at(-1)![0])}
        </text>
        {h && (
          <g>
            <line className="cross" x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} />
            <circle className="dot" cx={x(hover!)} cy={y(h[1])} r={4} />
          </g>
        )}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <b>{compact(h[1])}</b> <span>{h[0].replace("T", " ").slice(0, 16)}</span>
        </div>
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** What the Binance archive publishes per market (mirrors server/workbench/binance-archive.ts). */
export const ARCHIVE: Record<string, { label: string; datasets: string[]; example: string }> = {
  spot: { label: "Spot", datasets: ["trades", "aggTrades", "klines"], example: "BTCUSDT" },
  um: { label: "USDⓈ-M futures", datasets: ["trades", "aggTrades", "bookTicker", "bookDepth", "metrics", "fundingRate", "klines", "markPriceKlines", "indexPriceKlines", "premiumIndexKlines"], example: "BTCUSDT" },
  cm: { label: "COIN-M futures", datasets: ["trades", "aggTrades", "bookTicker", "bookDepth", "metrics", "fundingRate", "liquidationSnapshot", "klines", "markPriceKlines", "indexPriceKlines", "premiumIndexKlines"], example: "BTCUSD_PERP" },
  option: { label: "Options (historical)", datasets: ["BVOLIndex", "EOHSummary"], example: "BTCBVOLUSDT" },
};
export const DATASET_LABELS: Record<string, string> = {
  trades: "trades (every tick)",
  aggTrades: "aggregated trades",
  klines: "bars",
  bookTicker: "best bid/ask (every update)",
  bookDepth: "order-book depth snapshots",
  metrics: "open interest & long/short ratios",
  fundingRate: "funding rates (monthly files)",
  liquidationSnapshot: "liquidations",
  markPriceKlines: "mark-price bars",
  indexPriceKlines: "index-price bars",
  premiumIndexKlines: "premium-index bars",
  BVOLIndex: "BVOL volatility index",
  EOHSummary: "hourly option summaries",
};
const gibText = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MiB`);

interface SymbolItem {
  symbol: string;
  label?: string;
  inactive?: boolean;
}
/** Ticker field with suggestions from what the source can serve (data_symbols). */
export function SymbolInput({ label, source, market, dataset, value, onChange }: { label: string; source: string; market?: string; dataset?: string; value: string; onChange: (v: string) => void }) {
  const scope = useResearch();
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SymbolItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setState((s) => (s === "done" ? s : "loading"));
    const t = setTimeout(() => {
      const extra = source === "binance-archive" ? `&market=${market}&dataset=${dataset}` : "";
      scope.client.read<{ symbols: SymbolItem[]; total: number }>(`/native/data/symbols?source=${source}&q=${encodeURIComponent(value.trim())}${extra}`).then(
        (r) => {
          if (n !== seq.current) return;
          setHits(r.symbols);
          setTotal(r.total);
          setCursor(0);
          setState("done");
        },
        () => n === seq.current && setState("error"),
      );
    }, 150);
    return () => clearTimeout(t);
  }, [open, value, source, market, dataset]);
  const pick = (s: SymbolItem) => {
    onChange(s.symbol);
    setOpen(false);
  };
  const known = hits.some((h) => h.symbol.toUpperCase() === value.trim().toUpperCase());
  return (
    <label className="symbol-field">
      {label}
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls="symbol-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={open && hits[cursor] ? `symbol-hit-${cursor}` : undefined}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => (onChange(e.target.value.toUpperCase()), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (hits.length) setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
          } else if (e.key === "Enter" && open && hits[cursor] && !known) {
            e.preventDefault();
            pick(hits[cursor]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="symbol-suggest" id="symbol-suggestions" role="listbox" aria-label="Ticker suggestions">
          {state === "loading" && !hits.length && <div className="hint">Loading tickers…</div>}
          {state === "error" && <div className="hint">Suggestions unavailable; any symbol can still be typed.</div>}
          {hits.map((h, i) => (
            <div
              key={h.symbol}
              id={`symbol-hit-${i}`}
              role="option"
              aria-selected={i === cursor}
              className={`hit ${i === cursor ? "on" : ""} ${h.inactive ? "inactive" : ""}`}
              onMouseDown={(e) => (e.preventDefault(), pick(h))}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="t">{h.symbol}</span>
              {h.label && <span className="b">{h.label}</span>}
            </div>
          ))}
          {state === "done" && !hits.length && <div className="hint">{value.trim() ? "No match in this list; you can still fetch any symbol." : "Type to search."}</div>}
          {state === "done" && total > 0 && <div className="foot">{source === "fred" ? "common series · any FRED id works" : `${total.toLocaleString("en-US")} tickers`} · ↑↓ ⏎</div>}
        </div>
      )}
    </label>
  );
}

function FetchForm({ onStarted }: { onStarted: () => void }) {
  const scope = useResearch();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [f, setF] = useState({ source: "binance-archive", market: "um", dataset: "trades", symbol: "BTCUSDT", interval: "1m", start: yesterday, end: yesterday, title: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<{ files: number; bytes: number; missingCount: number; freeBytes: number; first: string | null; last: string | null } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const archive = f.source === "binance-archive";
  const barsInArchive = archive && /Klines$|^klines$/.test(f.dataset);
  const set = (k: keyof typeof f, v: string) =>
    setF((o) => {
      const n = { ...o, [k]: v };
      if (k === "source") {
        n.symbol = v === "binance" || v === "binance-archive" ? "BTCUSDT" : v === "coinbase" ? "BTC-USD" : "DGS10";
        if (v !== "binance-archive") n.start = `${Number(today.slice(0, 4)) - 1}-01-01`;
      }
      if (k === "market") {
        n.dataset = ARCHIVE[v].datasets[0];
        n.symbol = ARCHIVE[v].example;
      }
      return n;
    });
  // Archive fetches can be huge: show files, download size, gaps and free disk first.
  useEffect(() => {
    setEstimate(null);
    if (!archive || !f.symbol.trim()) return;
    const q = `market=${f.market}&dataset=${f.dataset}&symbol=${f.symbol.trim().toUpperCase()}${barsInArchive ? `&interval=${f.interval}` : ""}&start=${f.start}&end=${f.end}`;
    const t = setTimeout(() => {
      setEstimating(true);
      scope.client.read(`/native/data/estimate?${q}`).then(
        (e: any) => (setEstimate(e), setEstimating(false)),
        (e) => (setError(errorText(e)), setEstimating(false)),
      );
    }, 500);
    return () => clearTimeout(t);
  }, [archive, f.market, f.dataset, f.symbol, f.interval, f.start, f.end, barsInArchive]);
  const intervals =
    f.source === "coinbase" ? ["1m", "5m", "15m", "1h", "6h", "1d"] : archive ? (f.market === "spot" ? ["1s", "1m", "5m", "15m", "1h", "4h", "1d"] : ["1m", "5m", "15m", "1h", "4h", "1d"]) : ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"];
  return (
    <form
      className="data-form"
      aria-label="Fetch data"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await scope.client.write("/native/data/fetch", {
            source: f.source,
            symbol: f.symbol.trim(),
            ...(archive ? { market: f.market, dataset: f.dataset, ...(barsInArchive ? { interval: f.interval } : {}) } : f.source !== "fred" ? { interval: f.interval } : {}),
            start: f.start,
            end: f.end,
            ...(f.title.trim() ? { title: f.title.trim() } : {}),
          });
          onStarted();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Source
        <select value={f.source} onChange={(e) => set("source", e.target.value)}>
          <option value="binance-archive">Binance archive · tick level</option>
          <option value="binance">Binance bars (API)</option>
          <option value="coinbase">Coinbase bars</option>
          <option value="fred">FRED series</option>
        </select>
      </label>
      {archive && (
        <>
          <label>
            Market
            <select value={f.market} onChange={(e) => set("market", e.target.value)}>
              {Object.entries(ARCHIVE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Data
            <select value={f.dataset} onChange={(e) => set("dataset", e.target.value)}>
              {ARCHIVE[f.market].datasets.map((d) => (
                <option key={d} value={d}>
                  {DATASET_LABELS[d] ?? d}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <SymbolInput
        label={f.source === "fred" ? "Series" : f.source === "coinbase" ? "Product" : "Symbol"}
        source={f.source}
        market={f.market}
        dataset={f.dataset}
        value={f.symbol}
        onChange={(v) => set("symbol", v)}
      />
      {(f.source === "binance" || f.source === "coinbase" || barsInArchive) && (
        <label>
          Interval
          <select value={intervals.includes(f.interval) ? f.interval : intervals[1]} onChange={(e) => set("interval", e.target.value)}>
            {intervals.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        From
        <input type="date" value={f.start} onChange={(e) => set("start", e.target.value)} />
      </label>
      <label>
        To
        <input type="date" value={f.end} onChange={(e) => set("end", e.target.value)} />
      </label>
      <button className="btn small primary" disabled={busy || !f.symbol.trim() || (archive && estimate?.files === 0)}>
        {busy ? "Starting…" : "Fetch"}
      </button>
      {archive && (
        <p className="data-estimate" aria-live="polite">
          {estimating
            ? "Checking the archive…"
            : estimate
              ? estimate.files
                ? `${estimate.files} file${estimate.files === 1 ? "" : "s"} (${estimate.first} → ${estimate.last}) · ${gibText(estimate.bytes)} to download${estimate.missingCount ? ` · ${estimate.missingCount} day${estimate.missingCount === 1 ? "" : "s"} not in the archive` : ""} · ${gibText(estimate.freeBytes)} free`
                : "The archive has nothing for that symbol, data and dates."
              : ""}
        </p>
      )}
      {error && <p className="notice error">{error}</p>}
      <p className="note">
        {archive
          ? "Binance's public archive, checked against its published SHA-256, saved as Parquet (zstd) with one file per day; read it lazily with polars: pl.scan_parquet(\"data/<name>/*.parquet\"). Tick trades run to gigabytes per month."
          : "Public data, no keys, saved as Parquet. Bars over years take a few minutes and run in the background."}{" "}
        For Bloomberg or other paid feeds, have Pi write the file with your own code in the workspace, then register it.
      </p>
    </form>
  );
}

function RegisterForm({ idea, onDone }: { idea: string; onDone: () => void }) {
  const scope = useResearch();
  const [files, setFiles] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    scope.client.read<{ files: { path: string }[] }>(`/native/rd/files?idea=${idea}`).then(
      (r) => setFiles(r.files.map((f) => f.path).filter((p) => /\.(csv|csv\.gz|tsv|parquet|json)$/i.test(p))),
      (e) => setError(errorText(e)),
    );
  }, [idea]);
  return (
    <form
      className="data-form"
      aria-label="Register a file"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await scope.client.write("/native/data/register", { idea, path: pick, title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="wide">
        File in this idea's workspace
        <select value={pick} onChange={(e) => (setPick(e.target.value), !title && setTitle(e.target.value.split("/").pop()!.replace(/\.(csv|csv\.gz|tsv|parquet|json)$/i, "")))}>
          <option value="">{files.length ? "Choose a file…" : "No CSV, Parquet or JSON files in the workspace yet"}</option>
          {files.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="wide">
        Where it came from
        <input value={note} placeholder="e.g. Bloomberg XBTUSD Curncy, PX_LAST, via xbbg" onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="btn small primary" disabled={busy || !pick || !title.trim()}>
        {busy ? "Registering…" : "Register"}
      </button>
      {error && <p className="notice error">{error}</p>}
    </form>
  );
}

/** The strategy's data snapshots, fetches in progress, and a preview. */
export function DataSnapshotsPane() {
  const scope = useResearch();
  const dev = developingIdea(scope.view, scope.drafts);
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Snapshot | null>(null);
  const [form, setForm] = useState<"fetch" | "register" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const running = jobs.some((j) => j.status === "running");
  const ideaTitle = (target: string) =>
    (scope.view?.pursued ?? []).find((p: any) => p.target === target)?.title ?? scope.view?.ideaTitles?.[target.slice(2)] ?? "an idea";
  const load = () => {
    scope.client.read<{ snapshots: Snapshot[] }>("/native/data/snapshots").then((r) => setSnaps(r.snapshots), (e) => setError(errorText(e)));
    scope.client.read<{ jobs: Job[] }>("/native/data/jobs").then((r) => setJobs(r.jobs), () => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 1500 : 5000);
    return () => clearInterval(t);
  }, [running, scope.client]);
  const selected = snaps?.find((s) => s.name === chosen) ?? snaps?.[0] ?? null;
  useEffect(() => {
    if (!selected) return setDetail(null);
    let live = true;
    scope.client.read<Snapshot>(`/native/data/preview?name=${selected.name}`).then((d) => live && setDetail(d), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [selected?.name, selected?.sha256, confirming]);
  const snippet = selected ? polarsSnippet(selected) : "";
  /** Delete for good (snapshots can be gigabytes; there is no trash). */
  const remove = async (s: Snapshot) => {
    setDeleting(true);
    setError("");
    try {
      const r = await scope.client.write<{ bytes: number }>("/native/data/delete", { name: s.name });
      const rest = (snaps ?? []).filter((x) => x.name !== s.name);
      const i = (snaps ?? []).findIndex((x) => x.name === s.name);
      // Drop it at once so nothing asks for the deleted snapshot's preview.
      setSnaps(rest);
      setDetail(null);
      setChosen(rest[Math.min(i, rest.length - 1)]?.name ?? null);
      setNotice(`Deleted “${s.title}” · freed ${size(r?.bytes ?? s.bytes)}.`);
      setConfirming(null);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };
  const active = jobs.filter((j) => j.status === "running" || (j.status !== "done" && !j.snapshot));
  return (
    <div className="data-pane">
      <div className="data-toolbar">
        <button className={`btn small ${form === "fetch" ? "primary" : "ghost"}`} onClick={() => setForm((f) => (f === "fetch" ? null : "fetch"))}>
          + Fetch data
        </button>
        <button className={`btn small ${form === "register" ? "primary" : "ghost"}`} disabled={!dev} title={dev ? "" : "Choose an idea to develop first"} onClick={() => setForm((f) => (f === "register" ? null : "register"))}>
          + Register a file
        </button>
        <span className="dim">{snaps ? `${snaps.length} snapshot${snaps.length === 1 ? "" : "s"} · shared by every idea as data/` : ""}</span>
      </div>
      {form === "fetch" && <FetchForm onStarted={() => (setForm(null), load())} />}
      {form === "register" && dev && <RegisterForm idea={dev.target} onDone={() => (setForm(null), load())} />}
      {error && <p className="notice error">{error}</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}{" "}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice("")}>
            ×
          </button>
        </p>
      )}
      {active.length > 0 && (
        <div className="data-jobs" aria-label="Fetches">
          {active.map((j) => (
            <div key={j.id} className={`data-job ${j.status}`}>
              <span className="t">{j.title}</span>
              <span className="bar" aria-hidden="true">
                <i style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </span>
              <span className="m">{j.status === "running" ? j.message : `${j.status}: ${j.message}`}</span>
              {j.status === "running" && (
                <button className="btn small ghost" onClick={() => void scope.client.write("/native/data/cancel", { job: j.id }).then(load)}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="rd-split data-split">
        <nav
          className="rd-tree"
          aria-label="Data snapshots"
          onKeyDown={(e) => {
            // ⌘⌫ asks to delete the selected snapshot (it is permanent, so it always confirms).
            if (e.metaKey && e.key === "Backspace" && selected) {
              e.preventDefault();
              setConfirming(selected.name);
            }
          }}
        >
          {(snaps ?? []).map((s) => (
            <button key={s.name} className={`rd-doc ${selected?.name === s.name ? "on" : ""}`} title={s.file} onClick={() => setChosen(s.name)}>
              <span className="t">{s.title}</span>
              <span className="m">
                {sourceText(s.source)} · {s.rows !== null ? `${s.rows.toLocaleString("en-US")} rows` : size(s.bytes)}
              </span>
            </button>
          ))}
          {snaps && !snaps.length && <p className="rd-empty">No data yet. Fetch public market data, or register a file from a workspace.</p>}
        </nav>
        {selected ? (
          <div className="rd-viewer">
            <div className="rd-viewer-head">
              <span className="path">{selected.title}</span>
              <span className="dim">
                {sourceText(selected.source)}
                {selected.query ? ` · ${selected.query.start} → ${selected.query.end}` : ""}
              </span>
              <button className="btn small ghost danger" onClick={() => setConfirming(selected.name)} title="Delete this snapshot for good  ⌘⌫">
                Delete…
              </button>
            </div>
            {confirming === selected.name && (
              <div className="data-confirm" role="alertdialog" aria-label={`Delete ${selected.title}?`}>
                <p>
                  <b>Delete “{selected.title}” for good?</b> Frees {size(selected.bytes)}. It cannot be restored; the same data can be fetched again as a new snapshot.
                </p>
                {detail?.name === selected.name && (detail.retainedBy?.length ?? 0) > 0 && (
                  <p className="warn">
                    Kept by the release candidate{detail.retainedBy!.length === 1 ? "" : "s"}{" "}
                    {detail.retainedBy!.map((c) => `“${c.title}” v${c.version}`).join(", ")}. A candidate's data must stay so it can be run again, so it can't be deleted.
                  </p>
                )}
                {detail?.name === selected.name && (detail.references?.length ?? 0) > 0 ? (
                  <div className="refs">
                    <p>Code that reads it will stop working:</p>
                    <ul>
                      {detail.references!.map((r) => (
                        <li key={`${r.idea}:${r.path}`}>
                          {ideaTitle(r.idea)} · <code>{r.path}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : detail?.name === selected.name ? (
                  <p className="dim">No code in the idea workspaces mentions data/{selected.file}.</p>
                ) : null}
                <div className="row-actions">
                  <button className="btn small danger" disabled={deleting || (detail?.name === selected.name && (detail.retainedBy?.length ?? 0) > 0)} onClick={() => void remove(selected)}>
                    {deleting ? "Deleting…" : "Delete for good"}
                  </button>
                  <button className="btn small ghost" disabled={deleting} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="rd-viewer-body data-detail">
              <dl className="data-meta">
                <dt>rows</dt>
                <dd>{selected.rows !== null ? selected.rows.toLocaleString("en-US") : "—"}</dd>
                <dt>range</dt>
                <dd>{selected.first ? `${selected.first.slice(0, 16).replace("T", " ")} → ${selected.last?.slice(0, 16).replace("T", " ")}` : "—"}</dd>
                <dt>columns</dt>
                <dd>{selected.columns.map((c, i) => (selected.types?.[i] ? `${c}: ${selected.types[i]}` : c)).join(", ") || "—"}</dd>
                <dt>file</dt>
                <dd>
                  data/{selected.file}
                  {selected.files ? ` · ${selected.files} daily Parquet files` : ""} · {size(selected.bytes)} · sha256 {selected.sha256.slice(0, 12)}
                </dd>
                {selected.missing?.length ? (
                  <>
                    <dt>gaps</dt>
                    <dd>Not in the archive: {selected.missing.join(", ")}</dd>
                  </>
                ) : null}
                <dt>fetched</dt>
                <dd>{formatTime(selected.createdAt)?.full ?? selected.createdAt}</dd>
                {selected.source.note && (
                  <>
                    <dt>source</dt>
                    <dd>{selected.source.note}</dd>
                  </>
                )}
              </dl>
              <p className="data-snippet">
                <code>{snippet}</code>
                <button
                  className="btn small ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(snippet);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? "copied ✓" : "Copy"}
                </button>
              </p>
              {detail?.name === selected.name && detail.preview ? (
                <>
                  <SeriesChart series={detail.preview.series} label={`${detail.preview.valueColumn} · ${selected.title}`} />
                  <PreviewTable columns={selected.columns} head={detail.preview.head} tail={detail.preview.tail} rows={selected.rows ?? 0} />
                </>
              ) : detail?.name === selected.name ? (
                <p className="rd-empty">No preview for this file type; read it with your own tools.</p>
              ) : (
                <p className="rd-empty">loading…</p>
              )}
            </div>
          </div>
        ) : (
          <p className="rd-empty">Nothing selected.</p>
        )}
      </div>
    </div>
  );
}

function PreviewTable({ columns, head, tail, rows }: { columns: string[]; head: string[][]; tail: string[][]; rows: number }) {
  const gap = rows > head.length + tail.length;
  const shown = useMemo(() => (gap ? [...head.slice(0, 8), null, ...tail.slice(-8)] : head), [head, tail, gap]);
  return (
    <div className="table-wrap rd-table">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) =>
            r ? (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ) : (
              <tr key={i} className="gap">
                <td colSpan={columns.length}>… {(rows - 16).toLocaleString("en-US")} more rows …</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
