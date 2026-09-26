import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { isPublicAddress, type PaperDeps } from "../../desktop/papers.ts";
import { ParquetSink, cellOf, csvCells, inferColumns, parquetPreview, showCell, PARQUET_CODEC, type Column } from "./parquet.ts";
import { Archive, headerlessColumns, validateArchive, zipEntry, type ArchiveQuery, type Market } from "./binance-archive.ts";
import { FRED_SERIES, SymbolLists, rankSymbols, type SymbolItem } from "./symbols.ts";

/** Exploratory data snapshots for Research Development (docs/RESEARCH-FLOW.md).
 *
 * A snapshot is data fetched once and frozen: Parquet (zstd, typed columns,
 * UTC-microsecond timestamps) plus a manifest (source, query, fetch time, rows,
 * SHA-256, a small preview). It never changes; a refresh is a new snapshot, so
 * results stay reproducible on the exact bytes. Bars are one file; tick-level
 * archive data is a folder with one file per day, so polars scans it lazily:
 * pl.scan_parquet("data/<name>/*.parquet"). Snapshots live in
 * <strategy>/Data/snapshots/ and every idea workspace sees them read-only as
 * data/. Fetching is backend network I/O to a fixed set of public hosts (no
 * keys, no redirects, public addresses only; archive files are checked against
 * their published SHA-256); paid feeds come in as files the user's own code
 * wrote, registered with provenance. Nothing here executes research code. The
 * formal Data stage (contract, handoff, strict ingest) stays the gate to
 * production backtests. */

export const SNAPSHOT_DIR = ["Data", "snapshots"];
export const DATA_HOSTS = new Set(["data-api.binance.vision", "api.exchange.coinbase.com", "fred.stlouisfed.org"]);
export const INTERVALS = ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"] as const;
const COINBASE_GRANULARITY: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
const MAX_ROWS = 50_000_000;
const MAX_REGISTER = 20 * 1024 * 1024 * 1024; // 20 GiB per registered file
const MAX_ARCHIVE_DOWNLOAD = 500 * 1024 * 1024 * 1024; // 500 GiB per fetch
const SERIES_POINTS = 2000;

export type FetchSource =
  | { kind: "binance"; symbol: string; interval: (typeof INTERVALS)[number] }
  | { kind: "coinbase"; symbol: string; interval: (typeof INTERVALS)[number] }
  | { kind: "fred"; symbol: string }
  | ({ kind: "binance-archive" } & ArchiveQuery);
export interface FetchRequest {
  source: FetchSource;
  start: string; // YYYY-MM-DD (UTC)
  end: string; // YYYY-MM-DD (UTC, inclusive)
  title?: string;
}
export interface SnapshotManifest {
  version: 1;
  name: string;
  title: string;
  /** A file, or a folder of daily files (ends with "/"). */
  file: string;
  format: "parquet" | "csv" | "csv.gz" | "tsv" | "json";
  source: FetchSource | { kind: "file"; from: string; note?: string };
  query?: { start: string; end: string };
  createdAt: string;
  rows: number | null;
  columns: string[];
  types?: string[];
  first?: string;
  last?: string;
  bytes: number;
  sha256: string;
  /** Folder snapshots: one entry per daily file (with the archive's checksum). */
  parts?: { date: string; file: string; rows: number; bytes: number; sha256: string; sourceSha256: string }[];
  missing?: string[];
  preview?: { head: string[][]; tail: string[][]; series: [string, number][]; valueColumn: string };
}
export interface DataJob {
  id: string;
  sid: string;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  rows: number;
  progress: number; // 0..1
  message: string;
  snapshot?: string;
  startedAt: string;
}

const day = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Dates are YYYY-MM-DD (got ${s})`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date ${s}`);
  return t;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "data";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gib = (n: number) => (n < 1024 ** 3 ? `${Math.max(0.1, n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 2 : 1)} GiB`);

/** Head/tail rows, count and a thinned value series, collected while writing. */
class PreviewCollector {
  head: string[][] = [];
  tail: string[][] = [];
  series: [string, number][] = [];
  rows = 0;
  private step = 1;
  private valueIdx: number;
  /** The time axis: the first timestamp column (trade files start with an id). */
  readonly timeIdx: number;
  constructor(readonly columns: Column[]) {
    const t = columns.findIndex((c) => c.type === "timestamp");
    this.timeIdx = t >= 0 ? t : 0;
    const lower = columns.map((c) => c.name.toLowerCase());
    this.valueIdx = ["close", "price", "value", "index_value", "best_bid_price", "last_funding_rate", "sum_open_interest"].map((n) => lower.indexOf(n)).find((i) => i >= 0) ?? columns.findIndex((c) => c.type === "float64");
  }
  add(row: (string | number | bigint | boolean | null)[]) {
    this.rows++;
    const shown = () => row.map((v, i) => showCell(this.columns[i].type, v));
    if (this.head.length < 20) this.head.push(shown());
    if (this.rows % this.step === 0 || this.tail.length < 20) {
      this.tail.push(shown());
      if (this.tail.length > 20) this.tail.shift();
    }
    if (this.valueIdx >= 0 && (this.rows - 1) % this.step === 0) {
      const v = Number(row[this.valueIdx]);
      if (Number.isFinite(v)) this.series.push([showCell(this.columns[this.timeIdx].type, row[this.timeIdx]), v]);
      if (this.series.length > SERIES_POINTS) {
        this.series = this.series.filter((_, i) => i % 2 === 0);
        this.step *= 2;
      }
    }
  }
  /** Rows at the very end (the tail above is sampled once the series thins). */
  last(row: (string | number | bigint | boolean | null)[]) {
    this.lastRow = row.map((v, i) => showCell(this.columns[i].type, v));
  }
  lastRow?: string[];
  result() {
    return { head: this.head, tail: this.lastRow ? [...this.tail.slice(-19), this.lastRow] : this.tail, series: this.series, valueColumn: this.valueIdx >= 0 ? this.columns[this.valueIdx].name : "" };
  }
}

/** Streaming CSV preview (for registered CSV files): header, first/last rows, rows, value series. */
export async function csvPreview(input: Readable) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header: string[] | null = null;
  const head: string[][] = [],
    tail: string[][] = [];
  let rows = 0,
    valueIdx = -1,
    step = 1;
  let series: [string, number][] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = csvCells(line);
    if (!header) {
      header = cells.map((c) => c.trim());
      const lower = header.map((h) => h.toLowerCase());
      valueIdx = ["close", "price", "value"].map((n) => lower.indexOf(n)).find((i) => i >= 0) ?? (header.length > 1 ? header.length - 1 : 0);
      continue;
    }
    rows++;
    if (head.length < 20) head.push(cells);
    tail.push(cells);
    if (tail.length > 20) tail.shift();
    if ((rows - 1) % step === 0) {
      const v = Number(cells[valueIdx]);
      if (Number.isFinite(v)) series.push([cells[0], v]);
      if (series.length > SERIES_POINTS) {
        series = series.filter((_, i) => i % 2 === 0);
        step *= 2;
      }
    }
  }
  return { columns: header ?? [], rows, head, tail, series, valueColumn: header?.[valueIdx] ?? "" };
}

export class DataFeeds {
  private jobs = new Map<string, DataJob & { abort: AbortController }>();
  readonly archive: Archive;
  private lists = new SymbolLists();
  constructor(
    private folderOf: (sid: string) => string,
    private deps: () => PaperDeps,
    private gapMs = 150,
  ) {
    this.archive = new Archive(deps);
  }

  dir(sid: string) {
    const d = path.join(this.folderOf(sid), ...SNAPSHOT_DIR);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  snapshots(sid: string): SnapshotManifest[] {
    const d = this.dir(sid);
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as SnapshotManifest;
          const { preview: _, parts, ...rest } = m;
          return [{ ...rest, ...(parts ? { files: parts.length } : {}) } as SnapshotManifest];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  snapshot(sid: string, name: string): SnapshotManifest {
    if (!/^[a-z0-9-]{1,120}$/.test(name)) throw new Error("Invalid snapshot name");
    const f = path.join(this.dir(sid), `${name}.json`);
    if (!fs.existsSync(f)) throw new Error(`Snapshot ${name} not found. Use data_snapshots for names.`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  /** Code in the strategy's idea workspaces that mentions a snapshot's file
   * (what would stop working if it were deleted). Text files up to 1 MiB. */
  references(sid: string, name: string) {
    const m = this.snapshot(sid, name);
    const needle = m.file.replace(/\/$/, "");
    const root = path.join(this.folderOf(sid), "Research-Workspaces");
    const hits: { idea: string; path: string }[] = [];
    const SKIP = new Set([".git", "data", "node_modules", ".venv", "venv", "__pycache__", ".ipynb_checkpoints"]);
    const TEXT = /\.(py|ipynb|r|jl|ts|js|mjs|sql|md|txt|toml|ya?ml|json|sh|cfg|ini)$/i;
    let ideas: string[] = [];
    try {
      ideas = fs.readdirSync(root).filter((d) => /^[0-9a-f-]{36}$/.test(d));
    } catch {
      return hits;
    }
    for (const idea of ideas) {
      const walk = (rel: string) => {
        for (const e of fs.readdirSync(path.join(root, idea, rel), { withFileTypes: true })) {
          if (hits.length >= 20 || SKIP.has(e.name)) continue;
          const p = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && TEXT.test(e.name)) {
            const full = path.join(root, idea, p);
            if (fs.statSync(full).size <= 1024 * 1024 && fs.readFileSync(full, "utf8").includes(needle)) hits.push({ idea: `r:${idea}`, path: p });
          }
        }
      };
      try {
        walk("");
      } catch {
        /* an unreadable workspace is skipped */
      }
    }
    return hits;
  }
  /** Delete a snapshot for good (file or daily folder, and its manifest). */
  delete(sid: string, name: string) {
    const m = this.snapshot(sid, name);
    if ([...this.jobs.values()].some((j) => j.sid === sid && j.status === "running" && j.snapshot === name)) throw new Error("That snapshot is still being written");
    const d = this.dir(sid);
    const target = path.join(d, m.file.replace(/\/$/, ""));
    if (path.dirname(target) !== d) throw new Error("Invalid snapshot file");
    const references = this.references(sid, name);
    // Read-only files in an owner-writable folder: unlinking is allowed; the folder is removed whole.
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(path.join(d, `${name}.json`), { force: true });
    return { deleted: name, bytes: m.bytes, references };
  }
  jobsOf(sid: string) {
    return [...this.jobs.values()].filter((j) => j.sid === sid).map(({ abort: _, ...j }) => j).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  cancel(sid: string, id: string) {
    const j = this.jobs.get(id);
    if (!j || j.sid !== sid) throw new Error("Job not found");
    if (j.status === "running") j.abort.abort();
    return { job: id, status: j.status };
  }
  private uniqueName(sid: string, base: string) {
    const d = this.dir(sid);
    let name = slug(base),
      n = 2;
    while (fs.existsSync(path.join(d, `${name}.json`))) name = `${slug(base).slice(0, 74)}-${n++}`;
    return name;
  }
  private async sha(file: string) {
    const h = createHash("sha256");
    await pipeline(fs.createReadStream(file), h);
    return h.digest("hex");
  }
  private writeManifest(sid: string, m: SnapshotManifest) {
    const f = path.join(this.dir(sid), `${m.name}.json`);
    fs.writeFileSync(f + ".tmp", JSON.stringify(m, null, 2), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
    return m;
  }

  /* ── fetching ───────────────────────────────────────────────────────── */

  private async getData(href: string, signal: AbortSignal): Promise<any> {
    const url = new URL(href);
    if (url.protocol !== "https:" || !DATA_HOSTS.has(url.hostname)) throw new Error(`${url.hostname} is not an allowed data host`);
    const deps = this.deps();
    const addresses = await deps.lookup(url.hostname);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new Error(`${url.hostname} is not a public internet address; refused`);
    for (let attempt = 0; ; attempt++) {
      const res = await deps.fetch(url.href, { redirect: "manual", signal, credentials: "omit", headers: { accept: "application/json,text/csv", "user-agent": "PiResearch/0.1 (research data; user-initiated)" } } as RequestInit);
      if ((res.status === 429 || res.status === 418 || res.status >= 500) && attempt < 5) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1);
        await sleep(Math.min(wait, 60000));
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new Error(`${url.hostname} redirected; refused`);
      if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = await res.text();
      return url.hostname === "fred.stlouisfed.org" ? text : JSON.parse(text);
    }
  }
  /** Ticker suggestions: symbols the source can serve that match `query` (ranked). */
  async symbols(source: "binance-archive" | "binance" | "coinbase" | "fred", query: string, market?: Market, dataset?: string) {
    let items: SymbolItem[];
    if (source === "fred") items = FRED_SERIES;
    else if (source === "coinbase")
      items = await this.lists.list("coinbase", async () =>
        ((await this.getData("https://api.exchange.coinbase.com/products", new AbortController().signal)) as any[]).map((p) => ({
          symbol: String(p.id),
          label: `${p.base_currency}/${p.quote_currency}${p.status !== "online" ? ` · ${p.status}` : ""}`,
          ...(p.status !== "online" || p.trading_disabled ? { inactive: true } : {}),
        })),
      );
    else {
      const m: Market = source === "binance" ? "spot" : (market ?? "spot");
      const d = source === "binance" ? "klines" : (dataset ?? "trades");
      items = await this.lists.list(`archive:${m}:${d}`, async () => (await this.archive.symbols(m, d)).map((symbol) => ({ symbol })));
    }
    return { symbols: rankSymbols(items, query), total: items.length };
  }
  /** What an archive fetch would download: files, size, dates the archive lacks, and free disk. */
  async estimate(sid: string, q: ArchiveQuery, start: string, end: string) {
    validateArchive(q);
    if (day(end) < day(start)) throw new Error("The end date is before the start date");
    const files = await this.archive.list(q, start, end);
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    const monthly = files[0]?.date.length === 7;
    const missing: string[] = [];
    if (!monthly)
      for (let t = day(start); t <= day(end); t += 86400000) {
        const d = new Date(t).toISOString().slice(0, 10);
        if (!files.some((f) => f.date === d)) missing.push(d);
      }
    const free = (() => {
      try {
        const st = fs.statfsSync(this.dir(sid));
        return st.bavail * st.bsize;
      } catch {
        return os.freemem();
      }
    })();
    return { files: files.length, bytes, first: files[0]?.date ?? null, last: files.at(-1)?.date ?? null, missing: missing.length > 60 ? [...missing.slice(0, 60), `… ${missing.length - 60} more`] : missing, missingCount: missing.length, freeBytes: free };
  }
  /** Validate and start a fetch; returns the job at once (it runs in the background). */
  fetch(sid: string, req: FetchRequest) {
    const start = day(req.start),
      end = day(req.end) + 86400000 - 1;
    if (end < start) throw new Error("The end date is before the start date");
    const s = req.source;
    if (s.kind === "binance" && !/^[A-Z0-9]{4,20}$/.test(s.symbol)) throw new Error("Binance symbols look like BTCUSDT");
    if (s.kind === "coinbase" && !/^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/.test(s.symbol)) throw new Error("Coinbase products look like BTC-USD");
    if (s.kind === "coinbase" && !COINBASE_GRANULARITY[s.interval]) throw new Error(`Coinbase offers ${Object.keys(COINBASE_GRANULARITY).join(", ")}`);
    if (s.kind === "fred" && !/^[A-Z0-9_.]{1,40}$/.test(s.symbol)) throw new Error("FRED series ids look like DGS10");
    if ((s.kind === "binance" || s.kind === "coinbase") && !INTERVALS.includes(s.interval)) throw new Error(`Intervals: ${INTERVALS.join(", ")}`);
    if (s.kind === "binance-archive") validateArchive(s);
    const what = s.kind === "binance-archive" ? `Binance ${s.market} ${s.dataset}${s.interval ? ` ${s.interval}` : ""} ${s.symbol}` : `${s.kind} ${s.symbol}${"interval" in s ? ` ${s.interval}` : ""}`;
    const title = req.title?.trim() || `${what} ${req.start} → ${req.end}`;
    const job: DataJob & { abort: AbortController } = { id: randomUUID(), sid, title, status: "running", rows: 0, progress: 0, message: "Starting", startedAt: new Date().toISOString(), abort: new AbortController() };
    this.jobs.set(job.id, job);
    const run = s.kind === "binance-archive" ? this.runArchive(job, req, s) : this.run(job, req, start, end);
    void run.catch((e) => {
      job.status = job.abort.signal.aborted ? "cancelled" : "failed";
      job.message = job.abort.signal.aborted ? "Cancelled" : String(e?.message ?? e).slice(0, 400);
    });
    const { abort: _, ...out } = job;
    return out;
  }
  /** Bars and series from the APIs → one Parquet file. */
  private async run(job: DataJob & { abort: AbortController }, req: FetchRequest, start: number, end: number) {
    const s = req.source as Exclude<FetchSource, { kind: "binance-archive" }>;
    const name = this.uniqueName(job.sid, `${s.kind}-${s.symbol}${"interval" in s ? `-${s.interval}` : ""}-${req.start}-${req.end}`);
    const file = `${name}.parquet`;
    const target = path.join(this.dir(job.sid), file);
    const part = target + ".part";
    const bar = (extra: Column[] = []): Column[] => [{ name: "time", type: "timestamp" }, ...["open", "high", "low", "close", "volume"].map((n) => ({ name: n, type: "float64" as const })), ...extra];
    const columns: Column[] =
      s.kind === "fred" ? [{ name: "date", type: "timestamp" }, { name: "value", type: "float64" }] : s.kind === "binance" ? bar([{ name: "quote_volume", type: "float64" }, { name: "trades", type: "int64" }]) : bar();
    const sink = new ParquetSink(part, columns);
    const preview = new PreviewCollector(columns);
    const signal = job.abort.signal;
    let first: string | undefined, last: string | undefined;
    const push = (row: (string | number | bigint | boolean | null)[]) => {
      const typed = row.map((v, i) => (typeof v === "string" ? cellOf(columns[i].type, v) : v));
      sink.push(typed);
      preview.add(typed);
      preview.last(typed);
      const t = showCell(columns[0].type, typed[0]);
      first ??= t;
      last = t;
    };
    try {
      if (s.kind === "fred") {
        job.message = "Downloading";
        const csv: string = await this.getData(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.symbol}&cosd=${req.start}&coed=${req.end}`, signal);
        for (const l of csv.trim().split(/\r?\n/).slice(1)) {
          const [d, v] = l.split(",");
          push([d, v === "." ? "" : v]);
        }
        job.rows = preview.rows;
        job.progress = 1;
      } else if (s.kind === "binance") {
        let from = start;
        while (from <= end) {
          if (signal.aborted) throw new Error("Cancelled");
          const batch: any[] = await this.getData(`https://data-api.binance.vision/api/v3/klines?symbol=${s.symbol}&interval=${s.interval}&startTime=${from}&endTime=${end}&limit=1000`, signal);
          if (!batch.length) break;
          for (const k of batch) push([String(k[0]), k[1], k[2], k[3], k[4], k[5], k[7], String(k[8])]);
          job.rows = preview.rows;
          if (job.rows > MAX_ROWS) throw new Error(`More than ${MAX_ROWS.toLocaleString("en-US")} rows; for tick-level or 1s history use the Binance archive`);
          from = Number(batch.at(-1)[0]) + 1;
          job.progress = Math.min(1, (from - start) / (end - start || 1));
          job.message = `Fetched ${job.rows.toLocaleString("en-US")} bars, up to ${last?.slice(0, 16)}`;
          await sleep(this.gapMs);
        }
      } else {
        const g = COINBASE_GRANULARITY[s.interval];
        for (let from = start; from <= end; from += g * 300 * 1000) {
          if (signal.aborted) throw new Error("Cancelled");
          const to = Math.min(end, from + g * 300 * 1000 - 1);
          const batch: any[] = await this.getData(
            `https://api.exchange.coinbase.com/products/${s.symbol}/candles?granularity=${g}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`,
            signal,
          );
          for (const c of [...batch].sort((a, b) => a[0] - b[0])) {
            const t = new Date(c[0] * 1000).toISOString();
            if (last && t <= last) continue;
            push([t, c[3], c[2], c[1], c[4], c[5]].map(String));
          }
          job.rows = preview.rows;
          if (job.rows > MAX_ROWS) throw new Error(`More than ${MAX_ROWS.toLocaleString("en-US")} rows; fetch a shorter range`);
          job.progress = Math.min(1, (to - start) / (end - start || 1));
          job.message = `Fetched ${job.rows.toLocaleString("en-US")} bars${last ? `, up to ${last.slice(0, 16)}` : ""}`;
          await sleep(this.gapMs);
        }
      }
      if (!preview.rows) throw new Error("The source returned no data for that range");
      sink.finish();
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    fs.renameSync(part, target);
    fs.chmodSync(target, 0o400); // frozen
    const m = this.writeManifest(job.sid, {
      version: 1,
      name,
      title: job.title,
      file,
      format: "parquet",
      source: s,
      query: { start: req.start, end: req.end },
      createdAt: new Date().toISOString(),
      rows: preview.rows,
      columns: columns.map((c) => c.name),
      types: columns.map((c) => c.type),
      first,
      last,
      bytes: fs.statSync(target).size,
      sha256: await this.sha(target),
      preview: preview.result(),
    });
    this.finishJob(job, m);
  }
  private finishJob(job: DataJob, m: SnapshotManifest) {
    job.status = "done";
    job.progress = 1;
    job.snapshot = m.name;
    job.rows = m.rows ?? 0;
    job.message = `${(m.rows ?? 0).toLocaleString("en-US")} rows · ${gib(m.bytes)} Parquet (${PARQUET_CODEC.toLowerCase()})`;
  }
  /** Binance archive files (tick trades, depth, metrics…) → one Parquet file per day in a folder. */
  private async runArchive(job: DataJob & { abort: AbortController }, req: FetchRequest, q: ArchiveQuery & { kind: "binance-archive" }) {
    const signal = job.abort.signal;
    job.message = "Listing the archive";
    const files = await this.archive.list(q, req.start, req.end, signal);
    if (!files.length) throw new Error(`Binance publishes no ${q.dataset} for ${q.symbol} (${q.market}) between ${req.start} and ${req.end}`);
    const total = files.reduce((s, f) => s + f.bytes, 0);
    if (total > MAX_ARCHIVE_DOWNLOAD) throw new Error(`That is ${gib(total)} to download; fetch at most ${gib(MAX_ARCHIVE_DOWNLOAD)} at a time`);
    const est = await this.estimate(job.sid, q, req.start, req.end);
    // Parquet (zstd) of tick CSV is usually smaller than the zip; keep a safety margin anyway.
    if (est.freeBytes < total * 1.5 + 1024 ** 3) throw new Error(`Not enough free disk: ${gib(total)} to download, ${gib(est.freeBytes)} free`);
    const name = this.uniqueName(job.sid, `binance-${q.market}-${q.dataset}${q.interval ? `-${q.interval}` : ""}-${q.symbol}-${req.start}-${req.end}`);
    const folder = path.join(this.dir(job.sid), name);
    const partDir = folder + ".part";
    fs.mkdirSync(partDir, { recursive: true, mode: 0o700 });
    const parts: NonNullable<SnapshotManifest["parts"]> = [];
    let preview: PreviewCollector | null = null;
    let columns: Column[] = [];
    let downloaded = 0,
      first: string | undefined,
      last: string | undefined;
    try {
      for (const f of files) {
        if (signal.aborted) throw new Error("Cancelled");
        job.message = `Downloading ${f.date} (${parts.length + 1}/${files.length})`;
        const zip = path.join(partDir, `${f.date}.zip`);
        const sourceSha256 = await this.archive.download(f, zip, signal, (n) => {
          downloaded += n;
          job.progress = Math.min(0.999, downloaded / (total || 1));
        });
        job.message = `Converting ${f.date} to Parquet (${parts.length + 1}/${files.length})`;
        const out = path.join(partDir, `${f.date}.parquet`);
        const rl = readline.createInterface({ input: zipEntry(zip), crlfDelay: Infinity });
        let sink: ParquetSink | null = null;
        let names: string[] | null = null;
        let rows = 0;
        for await (const line of rl) {
          if (!line) continue;
          const cells = csvCells(line);
          if (!names) {
            // Futures files carry a header; spot files do not.
            if (/[a-z]/i.test(cells[0]) && !/^\d/.test(cells[0])) {
              names = cells.map((c) => c.trim());
              continue;
            }
            names = headerlessColumns(q.market as Market, q.dataset, cells.length);
          }
          if (!sink) {
            if (!columns.length) columns = inferColumns(names, cells);
            else if (columns.length !== names.length) throw new Error(`${f.date}: the file's columns changed (${names.join(", ")})`);
            sink = new ParquetSink(out, columns);
            preview ??= new PreviewCollector(columns);
          }
          const typed = columns.map((c, i) => cellOf(c.type, cells[i] ?? ""));
          sink.push(typed);
          preview!.add(typed);
          preview!.last(typed);
          rows++;
          if (rows === 1 && !first) first = showCell(columns[preview!.timeIdx].type, typed[preview!.timeIdx]);
          if (rows % 250_000 === 0) job.rows = (parts.reduce((s, p) => s + p.rows, 0) + rows);
          if (rows % 50_000 === 0) await new Promise((r) => setImmediate(r)); // keep the backend responsive
        }
        fs.rmSync(zip, { force: true });
        if (!sink) continue; // an empty day
        const bytes = sink.finish();
        last = preview!.lastRow?.[preview!.timeIdx] ?? last;
        parts.push({ date: f.date, file: `${f.date}.parquet`, rows, bytes, sha256: await this.sha(out), sourceSha256 });
        fs.chmodSync(out, 0o400);
        job.rows = parts.reduce((s, p) => s + p.rows, 0);
      }
    } catch (e) {
      fs.rmSync(partDir, { recursive: true, force: true });
      throw e;
    }
    if (!parts.length) {
      fs.rmSync(partDir, { recursive: true, force: true });
      throw new Error("The archive files held no rows");
    }
    fs.renameSync(partDir, folder);
    const m = this.writeManifest(job.sid, {
      version: 1,
      name,
      title: job.title,
      file: `${name}/`,
      format: "parquet",
      source: q,
      query: { start: req.start, end: req.end },
      createdAt: new Date().toISOString(),
      rows: parts.reduce((s, p) => s + p.rows, 0),
      columns: columns.map((c) => c.name),
      types: columns.map((c) => c.type),
      first,
      last,
      bytes: parts.reduce((s, p) => s + p.bytes, 0),
      sha256: createHash("sha256").update(parts.map((p) => `${p.file}:${p.sha256}`).join("\n")).digest("hex"),
      parts,
      ...(est.missingCount ? { missing: est.missing } : {}),
      preview: preview!.result(),
    });
    this.finishJob(job, m);
  }

  /* ── registering files ─────────────────────────────────────────────── */

  /** Freeze a file (the user's own, or one their code wrote, e.g. from a paid
   * feed) as a snapshot with provenance. The file is copied, never moved. */
  async register(sid: string, from: string, shown: string, title: string, note?: string) {
    const st = fs.statSync(from);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > MAX_REGISTER) throw new Error("Files up to 20 GiB can be registered");
    const lower = from.toLowerCase();
    const ext = lower.endsWith(".csv.gz") ? ".csv.gz" : path.extname(lower);
    if (![".csv", ".csv.gz", ".parquet", ".tsv", ".json"].includes(ext)) throw new Error("CSV, CSV.GZ, TSV, Parquet or JSON files can be registered");
    const name = this.uniqueName(sid, title || path.basename(from, ext));
    const file = `${name}${ext}`;
    const target = path.join(this.dir(sid), file);
    fs.copyFileSync(from, target + ".part");
    fs.renameSync(target + ".part", target);
    fs.chmodSync(target, 0o400);
    let preview: { columns: string[]; rows: number; head: string[][]; tail: string[][]; series: [string, number][]; valueColumn: string } | null = null;
    if (ext === ".csv" || ext === ".csv.gz") {
      const stream = fs.createReadStream(target);
      preview = await csvPreview(ext === ".csv.gz" ? stream.pipe(zlib.createGunzip()) : stream);
    } else if (ext === ".parquet") preview = await parquetPreview(target).catch(() => null);
    return this.writeManifest(sid, {
      version: 1,
      name,
      title: title || path.basename(from),
      file,
      format: ext.slice(1) as SnapshotManifest["format"],
      source: { kind: "file", from: shown, ...(note ? { note } : {}) },
      createdAt: new Date().toISOString(),
      rows: preview ? preview.rows : null,
      columns: preview?.columns ?? [],
      first: preview?.head[0]?.[0],
      last: preview?.tail.at(-1)?.[0],
      bytes: st.size,
      sha256: await this.sha(target),
      ...(preview ? { preview: { head: preview.head, tail: preview.tail, series: preview.series, valueColumn: preview.valueColumn } } : {}),
    });
  }
}

/** Test helper: a Readable from a string. */
export const fromString = (s: string) => Readable.from([s]);
