import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { isPublicAddress, type PaperDeps } from "../../desktop/papers.ts";
import { Archive, headerlessColumns, zipEntry, type Market } from "../workbench/binance-archive.ts";
import { cellOf, csvCells, inferColumns, readCompressors, type Column } from "../workbench/parquet.ts";
import { materialise } from "../workbench/rd.ts";
import { EVERY_MS, INTERVAL_MS, channelOf, feedDir, type Channel, type FeedDef, type FeedStatus, type Outage } from "./model.ts";
import { PartitionWriter, partitionKey } from "./writer.ts";

type Cell = string | number | bigint | boolean | null;
export const FEED_HOSTS = new Set(["api.binance.com", "data-api.binance.vision", "fapi.binance.com", "dapi.binance.com", "api.exchange.coinbase.com", "fred.stlouisfed.org"]);
const REST_KLINES: Record<string, string> = { spot: "https://data-api.binance.vision/api/v3/klines", um: "https://fapi.binance.com/fapi/v1/klines", cm: "https://dapi.binance.com/dapi/v1/klines" };
const COINBASE_G: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export interface WorkerContext {
  deps: () => PaperDeps;
  /** Opens a websocket (injectable for tests). */
  socket: (url: string) => WebSocket;
  timing?: Partial<StreamTiming>;
  log: (msg: string) => void;
}

/** Checked GET to the feed hosts (public addresses, no redirects, backoff on 429/5xx). */
async function get(ctx: WorkerContext, href: string, signal?: AbortSignal) {
  const url = new URL(href);
  if (url.protocol !== "https:" || !FEED_HOSTS.has(url.hostname)) throw new Error(`${url.hostname} is not an allowed feed host`);
  const deps = ctx.deps();
  const addresses = await deps.lookup(url.hostname);
  if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new Error(`${url.hostname} is not a public internet address; refused`);
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(url.href, { redirect: "manual", signal, credentials: "omit", headers: { "user-agent": "PiResearch/0.1 (production feed)" } } as RequestInit);
    if ((res.status === 429 || res.status === 418 || res.status >= 500) && attempt < 6) {
      await sleep(Math.min(60000, (Number(res.headers.get("retry-after")) || 2 * (attempt + 1)) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}`);
    return res;
  }
}

/** Common: definition, directory, writer, status file. */
abstract class Worker {
  readonly dir: string;
  protected writer: PartitionWriter | null = null;
  protected status: FeedStatus = { state: "starting", detail: "", heartbeatAt: "", rowsToday: 0, rowsTotal: 0, openRows: 0, partitions: 0, reconnects: 0, errors: [] };
  protected stopped = false;
  /** While catching up (archive backfill, REST fills, a pull or script run) past periods close
   * only when the data moves past them, never on the timer mid-period. */
  private catchingUp = 0;
  protected async catchUp<T>(fn: () => Promise<T>) {
    this.catchingUp++;
    try {
      return await fn();
    } finally {
      this.catchingUp--;
    }
  }
  /** The timer's close: skipped while catching up. */
  protected async closeDue() {
    if (!this.catchingUp) await this.writer?.tick();
  }
  protected abort = new AbortController();
  private timers: ReturnType<typeof setInterval>[] = [];
  constructor(
    readonly strategyRoot: string,
    readonly def: FeedDef,
    protected ctx: WorkerContext,
  ) {
    this.dir = feedDir(strategyRoot, def.id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  protected state<T = any>(): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8"));
    } catch {
      return {} as T;
    }
  }
  protected saveState(patch: Record<string, unknown>) {
    fs.writeFileSync(path.join(this.dir, "state.json"), JSON.stringify({ ...this.state(), ...patch }, null, 2), { mode: 0o600 });
  }
  protected set(patch: Partial<FeedStatus>) {
    this.status = { ...this.status, ...patch };
    this.writeStatus();
  }
  error(e: unknown) {
    if (this.stopped) return; // aborted by stop(): not a fault
    const message = String((e as Error)?.message ?? e).slice(0, 400);
    this.ctx.log(`[${this.def.id}] ${message}`);
    this.status.errors = [{ at: new Date().toISOString(), message }, ...this.status.errors].slice(0, 5);
    this.writeStatus();
  }
  writeStatus() {
    const w = this.writer;
    const parts = w?.partitions() ?? [];
    const dayKey = today();
    const rowsToday = parts.filter((p) => p.key.startsWith(dayKey)).reduce((s, p) => s + p.rows, 0) + (w?.openKey?.startsWith(dayKey) ? w.openRows : 0);
    this.status = {
      ...this.status,
      heartbeatAt: new Date().toISOString(),
      rowsTotal: w?.rowsTotal ?? this.status.rowsTotal,
      openRows: w?.openRows ?? 0,
      openPeriod: w?.openKey ?? undefined,
      partitions: parts.length,
      rowsToday,
      ...(w?.lastTime ? { lastTime: new Date(Number(w.lastTime / 1000n)).toISOString() } : {}),
    };
    if (!fs.existsSync(this.dir)) return; // the feed and its data were deleted
    const f = path.join(this.dir, "status.json");
    fs.writeFileSync(f + ".tmp", JSON.stringify(this.status, null, 2), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  }
  protected every(ms: number, fn: () => void | Promise<void>) {
    const t = setInterval(() => void Promise.resolve(fn()).catch((e) => this.error(e)), ms);
    t.unref?.();
    this.timers.push(t);
  }
  abstract start(): Promise<void>;
  async stop() {
    this.stopped = true;
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    this.writer?.stop();
    this.set({ state: this.def.paused ? "paused" : "stopped", detail: this.def.paused ? "Paused" : "Stopped" });
  }
}

/** Parse an archive zip's CSV rows (header or not) into objects by column name. */
async function* archiveRows(zip: string, market: Market, dataset: string) {
  const rl = readline.createInterface({ input: zipEntry(zip), crlfDelay: Infinity });
  let names: string[] | null = null;
  for await (const line of rl) {
    if (!line) continue;
    const cells = csvCells(line);
    if (!names) {
      if (/[a-z]/i.test(cells[0]) && !/^\d/.test(cells[0])) {
        names = cells.map((c) => c.trim());
        continue;
      }
      names = headerlessColumns(market, dataset, cells.length);
    }
    yield { names, cells, obj: Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ""])) as Record<string, string> };
  }
}

/** Timings of the live connections (injectable for tests). */
export interface StreamTiming {
  /** How often each connection is asked to prove it is alive (Binance) / how long heartbeats may be silent (Coinbase). */
  probeMs: number;
  probeTimeoutMs: number;
  /** Planned reconnect before Binance's 24-hour cutoff; the two connections are staggered. */
  rotateMs: number;
  /** First reconnect delay (doubles to 30 s). */
  reconnectMs: number;
}
export const STREAM_TIMING: StreamTiming = { probeMs: 30_000, probeTimeoutMs: 10_000, rotateMs: 20 * 3_600_000, reconnectMs: 1000 };
/** Rows fetched per gap at most; the rest stays missing (the archive repairs it once published). */
export const MAX_FILL_ROWS = 500_000;
const CONNECTIONS = 2;
const AGG_TRADES: Record<string, string> = { spot: "https://data-api.binance.vision/api/v3/aggTrades", um: "https://fapi.binance.com/fapi/v1/aggTrades", cm: "https://dapi.binance.com/dapi/v1/aggTrades" };

interface Conn {
  n: number;
  ws: WebSocket | null;
  live: boolean;
  backoff: number;
  lastMsgAt: number;
  probeId: number;
  probeSentAt: number | null;
  lastProbeAt?: number;
  openedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Live exchange stream, built not to lose data:
 *  - two connections to the same stream at all times; each message is kept once, by the
 *    exchange's sequence number (trade id, book update id), so one connection dropping,
 *    stalling or being rotated before Binance's 24-hour cutoff leaves no gap;
 *  - each connection must prove it is alive (Binance answers a request every 30 s; Coinbase
 *    heartbeats every second) or it is replaced;
 *  - trades and aggregated trades have gap-free ids and bars a fixed step: a skipped one (both
 *    connections down, a restart, the machine asleep) is fetched from the exchange's REST data
 *    before newer rows are written;
 *  - whatever could not be filled is recorded as an outage with its cause (outages.jsonl).
 * Before going live: archive backfill of complete days, then the gap since the last row on disk. */
export class StreamWorker extends Worker {
  private conns: Conn[] = [];
  private ch!: Channel;
  private barMs?: number;
  private timing: StreamTiming;
  /** The newest sequence accepted (either connection), and when the feed last had data. */
  private lastSeq: bigint | null = null;
  private lastTime: bigint | null = null;
  /** Rows without sequence numbers: recent row contents, to drop the second connection's copies. */
  private recent = new Map<string, number>();
  /** Appends and gap fills in arrival order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** When no connection was delivering (a hole unless it gets filled). */
  private downSince: number | null = null;
  private downCause = "";
  private firstFill = false;
  constructor(strategyRoot: string, def: FeedDef, ctx: WorkerContext) {
    super(strategyRoot, def, ctx);
    this.timing = { ...STREAM_TIMING, ...ctx.timing };
  }
  private get sdef() {
    return this.def as Extract<FeedDef, { kind: "stream" }>;
  }
  async start() {
    if (this.def.kind !== "stream") return;
    const ch = channelOf(this.def);
    if (!ch) throw new Error(`Unknown channel ${this.def.channel}`);
    this.ch = ch;
    this.barMs = ch.interval && this.def.interval ? INTERVAL_MS[this.def.interval] : undefined;
    this.writer = new PartitionWriter(this.dir, ch.columns, "hour", ch.idColumn, this.barMs);
    await this.writer.recover(Date.now(), true);
    this.every(5000, async () => {
      await this.closeDue();
      this.status.connections = { live: this.conns.filter((c) => c.live).length, of: CONNECTIONS };
      this.writeStatus();
    });
    // Resume from the newest row on disk.
    const last = await this.writer.lastRow().catch(() => null);
    if (last) {
      this.lastTime = last[0] as bigint;
      const si = ch.seqColumn ? ch.columns.findIndex((c) => c.name === ch.seqColumn) : -1;
      if (si >= 0 && typeof last[si] === "bigint") this.lastSeq = last[si] as bigint;
    }
    try {
      await this.catchUp(async () => {
        await this.backfill(ch.archive);
        await this.fillSinceLast("service was not running");
      });
    } catch (e) {
      this.error(e);
    }
    if (this.stopped) return;
    // Unfillable channels: the time since the last row is a hole, closed by the first live row.
    if (this.lastTime !== null && !this.fillable) {
      this.downSince = Number(this.lastTime / 1000n);
      this.downCause = "not collecting (service off or feed paused)";
    }
    this.set({ state: "starting", detail: `Connecting to ${new URL(this.url).host}` });
    for (let n = 0; n < CONNECTIONS; n++) {
      const c: Conn = { n, ws: null, live: false, backoff: this.timing.reconnectMs, lastMsgAt: 0, probeId: 0, probeSentAt: null, openedAt: 0 };
      this.conns.push(c);
      this.open(c);
    }
    this.every(Math.min(this.timing.probeMs, 5000), () => this.watch());
  }
  private get url() {
    return this.ch.url(this.sdef.market ?? null, this.sdef.symbol, this.sdef.interval);
  }
  private get fillable() {
    return (this.ch.consecutive && !!this.filler) || !!this.barMs;
  }
  /* ── Before going live ─────────────────────────────────────────── */
  private async backfill(archive: Channel["archive"]) {
    const def = this.sdef;
    if (def.market && def.backfillFrom && archive && !this.state().backfilled) {
      const last = this.lastTime ? new Date(Number(this.lastTime / 1000n)).toISOString().slice(0, 10) : null;
      const from = last ? addDays(last, 1) : def.backfillFrom;
      const to = addDays(today(), -1);
      if (from <= to) {
        const q = { market: def.market as Market, dataset: archive.dataset, symbol: def.symbol.toUpperCase(), ...(def.interval ? { interval: def.interval } : {}) };
        const files = await new Archive(this.ctx.deps).list(q, from, to, this.abort.signal);
        for (const [i, f] of files.entries()) {
          if (this.stopped) return;
          this.set({ state: "backfilling", detail: `Backfilling ${f.date} from the archive (${i + 1}/${files.length})` });
          const zip = path.join(this.dir, `backfill-${f.date}.zip`);
          await new Archive(this.ctx.deps).download(f, zip, this.abort.signal, () => {});
          let batch: Cell[][] = [];
          for await (const r of archiveRows(zip, q.market, q.dataset)) {
            const row = archive.row(r.obj);
            if (row) batch.push(row);
            if (batch.length >= 50_000) {
              await this.appendRows(batch);
              batch = [];
              await new Promise((res) => setImmediate(res));
            }
          }
          await this.appendRows(batch);
          fs.rmSync(zip, { force: true });
        }
      }
      this.saveState({ backfilled: true });
    }
    // Bars start today when there is nothing before (filling today is not an outage).
    if (this.barMs && this.lastTime === null) {
      this.lastTime = BigInt(Date.parse(`${today()}T00:00:00Z`) - this.barMs) * 1000n;
      this.firstFill = true;
    }
  }
  /** Rows written by backfill and fills: the resume point moves with them. */
  private async appendRows(rows: Cell[][]) {
    if (!rows.length) return;
    await this.writer!.append(rows);
    // The resume point only moves forward: live rows may already be past a gap being filled.
    const lastRow = rows.at(-1)!;
    if (this.lastTime === null || (lastRow[0] as bigint) > this.lastTime) this.lastTime = lastRow[0] as bigint;
    const si = this.ch.seqColumn ? this.ch.columns.findIndex((c) => c.name === this.ch.seqColumn) : -1;
    if (si >= 0 && typeof lastRow[si] === "bigint" && (this.lastSeq === null || (lastRow[si] as bigint) > this.lastSeq)) this.lastSeq = lastRow[si] as bigint;
  }
  /** After a restart: everything since the last row that the exchange can still serve. */
  private async fillSinceLast(cause: string) {
    if (this.barMs && this.lastTime !== null) {
      const from = Number(this.lastTime / 1000n) + this.barMs;
      const r = await this.fillBars(from, Date.now());
      if (r.filled && !this.firstFill) this.outage({ from: new Date(from).toISOString(), to: new Date().toISOString(), cause, filled: r.filled, unfilled: 0 });
    } else if (this.ch.consecutive && this.filler && this.lastSeq !== null) {
      const from = this.lastSeq + 1n;
      const t0 = this.lastTime;
      const r = await this.fillIds(from, null);
      if (r.filled || r.unfilled) this.outage({ from: t0 ? new Date(Number(t0 / 1000n)).toISOString() : new Date().toISOString(), to: new Date().toISOString(), cause, missing: r.filled + r.unfilled, filled: r.filled, unfilled: r.unfilled });
    }
  }
  /* ── Gap fills from REST ───────────────────────────────────────── */
  private get filler() {
    const def = this.sdef;
    if (def.channel === "trades" && def.market === "spot") return "trades";
    if (def.channel === "aggTrades" && def.market) return "aggTrades";
    if (def.channel === "trades" && !def.market) return "coinbase";
    return null;
  }
  /** Fetch ids from..to (to null: up to the newest) in order and write them. */
  private async fillIds(from: bigint, to: bigint | null): Promise<{ filled: number; unfilled: number }> {
    const def = this.sdef;
    const sym = def.symbol.toUpperCase();
    let filled = 0;
    const want = to === null ? null : Number(to - from + 1n);
    this.set({ state: "backfilling", detail: `Fetching missed trades from id ${from}` });
    if (this.filler === "coinbase") {
      // Pages go backwards from the newest id: collect, then write oldest first.
      const top = to ?? BigInt((await (await get(this.ctx, `https://api.exchange.coinbase.com/products/${def.symbol}/trades?limit=1`, this.abort.signal)).json())[0]?.trade_id ?? 0);
      if (top < from) return { filled: 0, unfilled: 0 };
      const rows: Cell[][] = [];
      let after = top + 1n;
      while (after > from && rows.length < MAX_FILL_ROWS && !this.stopped) {
        const page: any[] = await (await get(this.ctx, `https://api.exchange.coinbase.com/products/${def.symbol}/trades?limit=1000&after=${after}`, this.abort.signal)).json();
        if (!page.length) break;
        for (const t of page) {
          const id = BigInt(t.trade_id);
          if (id >= from && id <= top) rows.push([BigInt(Date.parse(t.time)) * 1000n + BigInt(Number(/\.\d{3}(\d{3})/.exec(t.time)?.[1] ?? 0)), id, Number(t.price), Number(t.size), String(t.side)]);
        }
        after = BigInt(page.at(-1).trade_id);
        await sleep(120);
      }
      rows.reverse();
      // Only a contiguous run from `from` can be written without leaving a hole in the middle.
      let n = 0;
      while (n < rows.length && rows[n][1] === from + BigInt(n)) n++;
      await this.appendRows(rows.slice(0, n));
      filled = n;
      const total = Number(top - from + 1n);
      return { filled, unfilled: Math.max(0, total - filled) };
    }
    let next = from;
    const base = this.filler === "trades" ? "https://api.binance.com/api/v3/historicalTrades" : AGG_TRADES[def.market!];
    while (!this.stopped && filled < MAX_FILL_ROWS && (to === null || next <= to)) {
      const batch: any[] = await (await get(this.ctx, `${base}?symbol=${sym}&fromId=${next}&limit=1000`, this.abort.signal)).json();
      const rows: Cell[][] = [];
      for (const t of batch) {
        const id = BigInt(this.filler === "trades" ? t.id : t.a);
        if (id < next || (to !== null && id > to)) continue;
        if (id !== next) break; // the exchange skipped ids: stop at the hole
        rows.push(this.filler === "trades" ? [BigInt(t.time) * 1000n, id, Number(t.price), Number(t.qty), !!t.isBuyerMaker] : [BigInt(t.T) * 1000n, id, Number(t.p), Number(t.q), BigInt(t.f), BigInt(t.l), !!t.m]);
        next = id + 1n;
      }
      await this.appendRows(rows);
      filled += rows.length;
      if (!rows.length || batch.length < 1000) break;
      await sleep(120);
    }
    return { filled, unfilled: want === null ? (this.stopped || filled >= MAX_FILL_ROWS ? 1 : 0) : Math.max(0, want - filled) };
  }
  /** Closed bars from..to (ms, open times). */
  private async fillBars(fromMs: number, toMs: number): Promise<{ filled: number }> {
    const def = this.sdef;
    if (!def.market || !def.interval || !this.barMs) return { filled: 0 };
    let from = fromMs,
      filled = 0;
    while (from + this.barMs <= Math.min(toMs + this.barMs, Date.now()) && !this.stopped) {
      this.set({ state: "backfilling", detail: `Filling bars from ${new Date(from).toISOString().slice(0, 16)}` });
      const now = Date.now();
      const batch: any[] = await (await get(this.ctx, `${REST_KLINES[def.market]}?symbol=${def.symbol.toUpperCase()}&interval=${def.interval}&startTime=${from}&endTime=${toMs}&limit=1000`, this.abort.signal)).json();
      const closed = batch.filter((k) => Number(k[6]) < now && Number(k[0]) >= from && Number(k[0]) <= toMs);
      if (!closed.length) break;
      await this.appendRows(closed.map((k) => [BigInt(k[0]) * 1000n, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), Number(k[7]), BigInt(k[8])]));
      filled += closed.length;
      from = Number(closed.at(-1)[0]) + this.barMs;
      await sleep(150);
    }
    return { filled };
  }
  private outage(o: Outage) {
    if (!fs.existsSync(this.dir)) return;
    fs.appendFileSync(path.join(this.dir, "outages.jsonl"), JSON.stringify(o) + "\n", { mode: 0o600 });
    this.status.lastOutage = o;
    if (o.filled) this.status.filledToday = (this.status.filledToday ?? 0) + o.filled;
  }
  /* ── Live connections ──────────────────────────────────────────── */
  private open(c: Conn) {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = this.ctx.socket(this.url);
    } catch (e) {
      this.drop(c, `could not connect: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return;
    }
    c.ws = ws;
    c.live = false;
    c.probeSentAt = null;
    c.lastProbeAt = undefined;
    c.openedAt = Date.now();
    c.lastMsgAt = Date.now();
    ws.onopen = () => {
      if (c.ws !== ws) return;
      if (this.ch.subscribe) {
        try {
          ws.send(JSON.stringify(this.ch.subscribe(this.sdef.symbol)));
        } catch {
          this.drop(c, "could not subscribe");
          return;
        }
      }
      if (this.ch.exchange === "binance") this.probe(c); // live once it answers, even with no trades
    };
    ws.onmessage = (e: MessageEvent) => {
      if (c.ws !== ws) return;
      this.receive(c, String(e.data));
    };
    ws.onclose = (e: CloseEvent) => {
      if (c.ws !== ws) return;
      this.drop(c, `disconnected${e?.code ? ` (code ${e.code}${e.reason ? `: ${e.reason.slice(0, 160)}` : ""})` : ""}`);
    };
    ws.onerror = () => {
      if (c.ws !== ws || this.stopped) return;
      this.drop(c, `connection problem with ${new URL(this.url).host}`);
    };
  }
  /** Replace a connection (closed, silent or due for rotation); the other keeps the feed going. */
  private drop(c: Conn, why: string, planned = false) {
    const ws = c.ws;
    c.ws = null;
    c.live = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    if (this.stopped) return;
    if (!planned) {
      this.status.reconnects++;
      this.error(`Connection ${c.n + 1}: ${why}`);
    }
    this.coverage(why);
    const delay = planned ? 0 : c.backoff;
    if (!planned) c.backoff = Math.min(30_000, c.backoff * 2);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.open(c), delay);
    c.timer.unref?.();
  }
  /** Probes, silence and rotation, every few seconds. */
  private watch() {
    const now = Date.now();
    const binance = this.ch.exchange === "binance";
    for (const c of this.conns) {
      if (!c.ws) continue;
      // Do not send application probes during the TCP/TLS/WebSocket handshake.
      if (c.ws.readyState !== 1) {
        if (now - c.openedAt > this.timing.probeTimeoutMs * 3) this.drop(c, "did not connect");
        continue;
      }
      if (c.probeSentAt !== null && now - c.probeSentAt > this.timing.probeTimeoutMs) {
        this.drop(c, "stopped answering");
        continue;
      }
      if (!binance && c.live && now - c.lastMsgAt > this.timing.probeTimeoutMs) {
        this.drop(c, "went silent");
        continue;
      }
      if (!c.live && c.probeSentAt === null && now - c.openedAt > this.timing.probeTimeoutMs * 3) {
        this.drop(c, "did not connect");
        continue;
      }
      // Rotate before the exchange's own cutoff, staggered so both never rotate together
      // (and only while the other connection is delivering).
      const other = this.conns.find((o) => o !== c);
      if (now - c.openedAt > this.timing.rotateMs * (1 + c.n * 0.1) && other?.live) {
        this.drop(c, "rotated", true);
        continue;
      }
      if (binance && c.probeSentAt === null && now - (c.lastProbeAt ?? 0) >= this.timing.probeMs) this.probe(c);
    }
    this.status.connections = { live: this.conns.filter((x) => x.live).length, of: CONNECTIONS };
  }
  /** Binance: ask the connection to prove it is alive (a quiet market sends nothing on its own). */
  private probe(c: Conn) {
    c.probeId++;
    c.probeSentAt = c.lastProbeAt = Date.now();
    try {
      c.ws?.send(JSON.stringify({ method: "LIST_SUBSCRIPTIONS", id: c.probeId }));
    } catch {
      this.drop(c, "stopped answering");
    }
  }
  /** Coverage: when no connection is live, a hole starts (unless a gap fill closes it later). */
  private coverage(why: string) {
    const live = this.conns.some((c) => c.live);
    this.status.connections = { live: this.conns.filter((c) => c.live).length, of: CONNECTIONS };
    if (!live) {
      if (this.downSince === null) {
        this.downSince = Date.now();
        this.downCause = `both connections down (${why})`;
      }
      this.set({ state: "waiting", detail: `Reconnecting (${why || this.downCause})`, lagMs: undefined });
    }
    else if (this.conns.every((c) => c.live)) this.set({ state: "live", detail: `Live from ${new URL(this.url).host} · ${CONNECTIONS} connections` });
    else this.set({ state: "live", detail: `Live from ${new URL(this.url).host} · 1 of ${CONNECTIONS} connections (the other is reconnecting)` });
  }
  private receive(c: Conn, data: string) {
    const recv = Date.now();
    c.lastMsgAt = recv;
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "error" || m.code !== undefined) {
      this.drop(c, `stream error: ${String(m.msg ?? m.message ?? m.reason ?? m.code).slice(0, 200)}`);
      return;
    }
    if (m?.type === "subscriptions") return;
    // Binance probe answer.
    if (m && "result" in m && "id" in m) {
      if (c.probeSentAt !== null && m.id === c.probeId && Array.isArray(m.result)) {
        c.probeSentAt = null;
        this.markLive(c);
      }
      return;
    }
    if (m?.type === "heartbeat") {
      this.markLive(c);
      // Coinbase: the connection has sent every trade up to this id.
      const id = m.last_trade_id !== undefined ? BigInt(m.last_trade_id) : null;
      if (id !== null && this.ch.consecutive && this.lastSeq !== null && id > this.lastSeq) this.gap(this.lastSeq + 1n, id, "missed on the connection", null);
      return;
    }
    const rows = this.ch.parse(m, recv);
    if (!rows.length) return;
    this.markLive(c);
    const seq = this.ch.seqOf?.(m) ?? null;
    if (seq !== null) {
      if (this.lastSeq !== null && seq <= this.lastSeq) return; // the other connection had it
      if (this.lastSeq !== null) {
        if (this.ch.consecutive && seq > this.lastSeq + 1n) this.gap(this.lastSeq + 1n, seq - 1n, this.downSince !== null ? this.downCause : "missed on the connection", recv);
        else if (this.barMs && seq > this.lastSeq + BigInt(this.barMs) * 1000n) this.barGap(Number(this.lastSeq / 1000n) + this.barMs, Number(seq / 1000n) - this.barMs);
      }
      this.lastSeq = seq;
    } else {
      // No sequence: the same row from both connections within a minute is one row.
      const key = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      if (this.recent.has(key)) return;
      this.recent.set(key, recv);
      if (this.recent.size > 5000) for (const [k, t] of this.recent) if (recv - t > 60_000 || this.recent.size > 5000) this.recent.delete(k);
    }
    if (this.downSince !== null) {
      // Coverage is back; for unfillable data the stretch in between is a hole.
      if (!this.fillable) this.outage({ from: new Date(this.downSince).toISOString(), to: new Date(recv).toISOString(), cause: this.downCause, hole: true });
      this.downSince = null;
    }
    const t = rows.at(-1)![0] as bigint;
    this.chain = this.chain.then(async () => {
      await this.writer!.append(rows);
      if (this.lastTime === null || t > this.lastTime) this.lastTime = t;
      this.status.lastEventAt = new Date(recv).toISOString();
      // A bar is known when it closes: its lag counts from its end, not its open.
      this.status.lagMs = Math.max(0, recv - Number(t / 1000n) - (this.barMs ?? 0));
    });
  }
  private markLive(c: Conn) {
    if (c.live) return;
    c.live = true;
    c.backoff = this.timing.reconnectMs;
    this.coverage("");
  }
  /** Missing ids: fetched before any newer row is written. */
  private gap(from: bigint, to: bigint, cause: string, recv: number | null) {
    const t0 = this.lastTime;
    if (this.lastSeq !== null && to > this.lastSeq) this.lastSeq = to; // later copies of these are not live duplicates
    this.chain = this.chain.then(() =>
      this.catchUp(async () => {
        let r = { filled: 0, unfilled: Number(to - from + 1n) };
        try {
          r = await this.fillIds(from, to);
        } catch (e) {
          this.error(e);
        }
        const o: Outage = { from: t0 ? new Date(Number(t0 / 1000n)).toISOString() : new Date(recv ?? Date.now()).toISOString(), to: new Date(recv ?? Date.now()).toISOString(), cause, missing: Number(to - from + 1n), filled: r.filled, unfilled: r.unfilled };
        this.outage(o);
        this.coverage("");
      }),
    );
  }
  private barGap(fromMs: number, toMs: number) {
    this.chain = this.chain.then(() =>
      this.catchUp(async () => {
        const r = await this.fillBars(fromMs, toMs).catch((e) => (this.error(e), { filled: 0 }));
        const missing = Math.round((toMs - fromMs) / this.barMs!) + 1;
        this.outage({ from: new Date(fromMs).toISOString(), to: new Date(toMs + this.barMs!).toISOString(), cause: this.downSince !== null ? this.downCause : "missed on the connection", missing, filled: r.filled, unfilled: Math.max(0, missing - r.filled) });
        this.coverage("");
      }),
    );
  }
  async stop() {
    this.stopped = true;
    for (const c of this.conns) {
      clearTimeout(c.timer);
      const ws = c.ws;
      c.ws = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {}
      }
    }
    this.abort.abort(); // a gap fill in progress stops at its next request
    await this.chain.catch(() => {});
    await super.stop();
  }
}

/** Scheduled pull: new files or bars since the last row, every interval. */
export class PullWorker extends Worker {
  async start() {
    const st = this.state<{ columns?: Column[] }>();
    if (st.columns) {
      this.writer = new PartitionWriter(this.dir, st.columns, "day");
      await this.writer.recover();
    }
    const every = EVERY_MS[(this.def as any).every];
    const run = async () => {
      try {
        await this.catchUp(() => this.run());
        this.set({ state: "waiting", detail: "Up to date", nextRunAt: new Date(Date.now() + every).toISOString() });
      } catch (e) {
        this.error(e);
        this.set({ state: "error", detail: String((e as Error)?.message ?? e).slice(0, 200), nextRunAt: new Date(Date.now() + every).toISOString() });
      }
    };
    this.every(every, run);
    this.every(5000, async () => {
      await this.closeDue();
      this.writeStatus();
    });
    await run();
  }
  private async ensureWriter(columns: Column[]) {
    if (this.writer) return this.writer;
    this.saveState({ columns });
    this.writer = new PartitionWriter(this.dir, columns, "day");
    await this.writer.recover();
    return this.writer;
  }
  private since() {
    const d = this.def as Extract<FeedDef, { kind: "pull" }>;
    return this.writer?.lastTime ? Number(this.writer.lastTime / 1000n) : Date.parse(`${d.backfillFrom}T00:00:00Z`) - 1;
  }
  private async run() {
    const d = this.def as Extract<FeedDef, { kind: "pull" }>;
    this.set({ state: "backfilling", detail: "Fetching new data" });
    if (d.provider === "binance-archive") {
      const q = { market: (d.market ?? "spot") as Market, dataset: d.dataset ?? "trades", symbol: d.symbol.toUpperCase(), ...(d.interval ? { interval: d.interval } : {}) };
      const from = this.writer?.lastTime ? addDays(new Date(this.since()).toISOString().slice(0, 10), 1) : d.backfillFrom;
      const files = await new Archive(this.ctx.deps).list(q, from, addDays(today(), -1), this.abort.signal);
      for (const [i, f] of files.entries()) {
        if (this.stopped) return;
        this.set({ state: "backfilling", detail: `Archive ${f.date} (${i + 1}/${files.length})` });
        const zip = path.join(this.dir, `pull-${f.date}.zip`);
        await new Archive(this.ctx.deps).download(f, zip, this.abort.signal, () => {});
        let batch: Cell[][] = [];
        let columns: Column[] | null = null;
        for await (const r of archiveRows(zip, q.market, q.dataset)) {
          columns ??= (this.state<{ columns?: Column[] }>().columns ?? inferColumns(r.names, r.cells)) as Column[];
          const w = await this.ensureWriter(columns);
          // Rows are keyed by their first timestamp column.
          const ti = columns.findIndex((c) => c.type === "timestamp");
          const row = columns.map((c, j) => cellOf(c.type, r.cells[j] ?? ""));
          if (ti > 0) row.unshift(row.splice(ti, 1)[0]);
          batch.push(row);
          if (batch.length >= 50_000) {
            await w.append(batch);
            batch = [];
          }
        }
        if (batch.length) await this.writer!.append(batch);
        fs.rmSync(zip, { force: true });
      }
    } else if (d.provider === "binance" || d.provider === "coinbase") {
      const iv = d.interval ?? "1d";
      const barMs = INTERVAL_MS[iv];
      const w = await this.ensureWriter([{ name: "time", type: "timestamp" }, ...["open", "high", "low", "close", "volume"].map((n) => ({ name: n, type: "float64" as const }))]);
      let from = this.since() + 1;
      const now = Date.now();
      while (from + barMs <= now && !this.stopped) {
        let rows: Cell[][];
        if (d.provider === "binance") {
          const batch: any[] = await (await get(this.ctx, `${REST_KLINES[d.market ?? "spot"]}?symbol=${d.symbol.toUpperCase()}&interval=${iv}&startTime=${from}&limit=1000`, this.abort.signal)).json();
          rows = batch.filter((k) => Number(k[6]) < now).map((k) => [BigInt(k[0]) * 1000n, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]);
        } else {
          const g = COINBASE_G[iv];
          if (!g) throw new Error(`Coinbase offers ${Object.keys(COINBASE_G).join(", ")}`);
          const to = Math.min(now, from + g * 300 * 1000);
          const batch: any[] = await (await get(this.ctx, `https://api.exchange.coinbase.com/products/${d.symbol}/candles?granularity=${g}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`, this.abort.signal)).json();
          rows = [...batch].sort((a, b) => a[0] - b[0]).filter((c) => (c[0] + g) * 1000 <= now).map((c) => [BigInt(c[0]) * 1_000_000n, c[3], c[2], c[1], c[4], c[5]]);
          if (!rows.length) {
            from = to;
            continue;
          }
        }
        if (!rows.length) break;
        await w.append(rows);
        from = Number((rows.at(-1)![0] as bigint) / 1000n) + barMs;
        await sleep(150);
      }
    } else {
      const csv = await (await get(this.ctx, `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${d.symbol}&cosd=${d.backfillFrom}`, this.abort.signal)).text();
      const w = await this.ensureWriter([{ name: "date", type: "timestamp" }, { name: "value", type: "float64" }]);
      const since = this.since();
      const rows: Cell[][] = [];
      for (const l of csv.trim().split(/\r?\n/).slice(1)) {
        const [dt, v] = l.split(",");
        const t = Date.parse(`${dt}T00:00:00Z`);
        if (t > since) rows.push([BigInt(t) * 1000n, v === "." || v === "" ? null : Number(v)]);
      }
      await w.append(rows);
    }
    await this.writer?.tick();
  }
}

/** The user's own command (e.g. a Bloomberg pull via xbbg) on a schedule. */
export class ScriptWorker extends Worker {
  async start() {
    const st = this.state<{ columns?: Column[] }>();
    if (st.columns) {
      this.writer = new PartitionWriter(this.dir, st.columns, "day");
      await this.writer.recover();
    }
    const every = EVERY_MS[(this.def as any).every];
    const run = async () => {
      try {
        await this.catchUp(() => this.run());
        this.set({ state: "waiting", detail: "Script ran; up to date", nextRunAt: new Date(Date.now() + every).toISOString() });
      } catch (e) {
        this.error(e);
        this.set({ state: "error", detail: String((e as Error)?.message ?? e).slice(0, 200), nextRunAt: new Date(Date.now() + every).toISOString() });
      }
    };
    this.every(every, run);
    this.every(5000, async () => {
      await this.closeDue();
      this.writeStatus();
    });
    await run();
  }
  private async run() {
    const d = this.def as Extract<FeedDef, { kind: "script" }>;
    const workspace = path.join(this.strategyRoot, "Research-Workspaces", d.workspace);
    if (!fs.existsSync(workspace)) throw new Error("The script's idea workspace does not exist");
    // Production scripts run their sent checkpoint; editing the workspace changes nothing here.
    const cwd = d.checkpoint ? await materialise(workspace, d.checkpoint, path.join(this.dir, "source"), path.join(this.strategyRoot, "Data", "snapshots")) : workspace;
    const out = path.join(this.dir, "script-output");
    fs.rmSync(out, { force: true });
    const since = this.writer?.lastTime ? new Date(Number(this.writer.lastTime / 1000n)).toISOString() : `${d.backfillFrom}T00:00:00Z`;
    this.set({ state: "backfilling", detail: `Running: ${d.command.slice(0, 80)}` });
    const log = fs.createWriteStream(path.join(this.dir, "script.log"), { flags: "w", mode: 0o600 });
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh", ["-lc", d.command], {
        cwd,
        env: { ...process.env, PI_RESEARCH_OUT: out, PI_RESEARCH_SINCE: since, PI_RESEARCH_FEED: d.id },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("error", (e) => (clearTimeout(timer), reject(e)));
      child.on("close", (c) => (clearTimeout(timer), resolve(c ?? 1)));
      this.abort.signal.addEventListener("abort", () => child.kill("SIGTERM"));
    });
    log.end();
    if (code !== 0) throw new Error(`The script exited with ${code}; see script.log`);
    if (!fs.existsSync(out)) throw new Error("The script wrote nothing to $PI_RESEARCH_OUT");
    // CSV or Parquet (by magic bytes); the time column goes first (it keys partitions).
    const head = Buffer.alloc(4);
    const fd = fs.openSync(out, "r");
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    let names: string[] = [],
      raw: string[][] = [];
    if (head.toString() === "PAR1") {
      const buf = await asyncBufferFromFile(out);
      const objs = await parquetReadObjects({ file: buf, compressors: readCompressors as any });
      names = Object.keys(objs[0] ?? {});
      raw = objs.map((o) => names.map((n) => (o[n] instanceof Date ? (o[n] as Date).toISOString() : o[n] === null || o[n] === undefined ? "" : String(o[n]))));
    } else {
      const lines = fs.readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean);
      names = csvCells(lines[0] ?? "").map((c) => c.trim());
      raw = lines.slice(1).map(csvCells);
    }
    const ti = names.indexOf(d.timeColumn);
    if (ti < 0) throw new Error(`The output has no "${d.timeColumn}" column (it has ${names.join(", ")})`);
    const order = [ti, ...names.map((_, i) => i).filter((i) => i !== ti)];
    const sample = raw[0] ?? [];
    let columns = this.state<{ columns?: Column[] }>().columns;
    if (!columns) {
      columns = inferColumns(order.map((i) => names[i]), order.map((i) => sample[i] ?? ""));
      columns[0] = { name: names[ti], type: "timestamp" };
      this.saveState({ columns });
      this.writer = new PartitionWriter(this.dir, columns, "day");
      await this.writer.recover();
    } else if (columns.map((c) => c.name).join(",") !== order.map((i) => names[i]).join(",")) {
      throw new Error(`The script's columns changed (now ${names.join(", ")}); the contract expects ${columns.map((c) => c.name).join(", ")}`);
    }
    const sinceMicros = BigInt(Date.parse(since)) * 1000n;
    const rows = raw
      .map((r) => columns!.map((c, j) => cellOf(c.type, r[order[j]] ?? "")))
      .filter((r) => typeof r[0] === "bigint" && (r[0] as bigint) > sinceMicros)
      .sort((a, b) => ((a[0] as bigint) < (b[0] as bigint) ? -1 : 1));
    await this.writer!.append(rows);
    await this.writer!.tick();
  }
}

export function workerFor(strategyRoot: string, def: FeedDef, ctx: WorkerContext): Worker {
  return def.kind === "stream" ? new StreamWorker(strategyRoot, def, ctx) : def.kind === "pull" ? new PullWorker(strategyRoot, def, ctx) : new ScriptWorker(strategyRoot, def, ctx);
}
export type { Worker };
export { partitionKey };
