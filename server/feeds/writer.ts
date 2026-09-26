import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { ParquetSink, readCompressors, showCell, type Column } from "../workbench/parquet.ts";
import type { PartitionRecord } from "./model.ts";

type Cell = string | number | bigint | boolean | null;

/** Partition key for a time in μs: "2026-09-25T15" (hour) or "2026-09-25" (day). */
export const partitionKey = (micros: bigint, grain: "hour" | "day") => new Date(Number(micros / 1000n)).toISOString().slice(0, grain === "hour" ? 13 : 10);
const partitionFile = (key: string, grain: "hour" | "day") => {
  const [d, h] = key.split("T");
  const [y, m, dd] = d.split("-");
  return grain === "hour" ? `data/${y}/${m}/${dd}/${h}.parquet` : `data/${y}/${m}/${dd}.parquet`;
};

/** A period is frozen this long after it ends, so rows still in flight at the boundary make it in. */
export const CLOSE_GRACE_MS = 10_000;
const periodEndMs = (key: string) => Date.parse(key.length > 10 ? `${key}:00:00Z` : `${key}T00:00:00Z`) + (key.length > 10 ? 3_600_000 : 86_400_000);

/** Append-only partitions for one feed. Rows go to the open partition (NDJSON,
 * flushed every second); when time moves past it, it is converted to Parquet,
 * made read-only, hashed and recorded with quality counts. A restarted writer
 * resumes the open partition of the current period and closes older ones. */
export class PartitionWriter {
  private open: { key: string; lines: string[]; rows: number } | null = null;
  private timer?: ReturnType<typeof setInterval>;
  rowsTotal = 0;
  late = 0;
  lastTime: bigint | null = null;
  private idIdx: number;
  /** Appends and closes run one at a time (stream messages arrive concurrently). */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
  constructor(
    readonly dir: string,
    readonly columns: Column[],
    readonly grain: "hour" | "day",
    idColumn?: string,
    /** Bars per partition when the feed is a bar series (for missing-bar counts). */
    private barMs?: number,
  ) {
    fs.mkdirSync(path.join(dir, "open"), { recursive: true, mode: 0o700 });
    this.idIdx = idColumn ? columns.findIndex((c) => c.name === idColumn) : -1;
    this.rowsTotal = this.partitions().reduce((s, p) => s + p.rows, 0);
    this.lastTime = (() => {
      const last = this.partitions().at(-1)?.last;
      return last ? BigInt(Date.parse(last)) * 1000n : null;
    })();
  }
  partitions(): PartitionRecord[] {
    try {
      return fs.readFileSync(path.join(this.dir, "partitions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
  /** Resume: keep the current period's open file, close older ones. With keepLatest the newest
   * open file stays open whatever its period (a stream fills the gap since it before it closes). */
  async recover(now = Date.now(), keepLatest = false) {
    const files = fs.readdirSync(path.join(this.dir, "open")).filter((f) => f.endsWith(".ndjson")).sort();
    const current = keepLatest && files.length ? files.at(-1)!.slice(0, -7) : partitionKey(BigInt(now) * 1000n, this.grain);
    for (const f of files) {
      const key = f.slice(0, -7);
      const lines = fs.readFileSync(path.join(this.dir, "open", f), "utf8").split("\n").filter(Boolean);
      if (key === current && !this.open) {
        this.open = { key, lines: [], rows: lines.length };
        const last = lines.at(-1);
        if (last) this.lastTime = BigInt(JSON.parse(last)[0]);
      } else await this.closeKey(key);
    }
    // Closed partitions plus the resumed open period.
    this.rowsTotal = this.partitions().reduce((s, p) => s + p.rows, 0) + (this.open?.rows ?? 0);
    this.timer ??= setInterval(() => this.flush(), 1000);
    this.timer.unref?.();
  }
  private decode(line: string): Cell[] {
    const raw = JSON.parse(line) as (string | number | boolean | null)[];
    return raw.map((v, i) => (v !== null && (this.columns[i].type === "int64" || this.columns[i].type === "timestamp") ? BigInt(v as string) : v)) as Cell[];
  }
  /** The newest row on disk: the open period's last line, else the last frozen partition's last row. */
  async lastRow(): Promise<Cell[] | null> {
    this.flush();
    const open = fs.readdirSync(path.join(this.dir, "open")).filter((f) => f.endsWith(".ndjson")).sort().at(-1);
    if (open) {
      const lines = fs.readFileSync(path.join(this.dir, "open", open), "utf8").trimEnd().split("\n").filter(Boolean);
      if (lines.length) return this.decode(lines.at(-1)!);
    }
    const last = this.partitions().at(-1);
    if (!last) return null;
    const file = await asyncBufferFromFile(path.join(this.dir, last.file));
    const n = Number((await parquetMetadataAsync(file)).num_rows);
    const [obj] = await parquetReadObjects({ file, compressors: readCompressors as any, rowStart: n - 1, rowEnd: n });
    return obj ? this.columns.map((c) => { const v = obj[c.name]; return v instanceof Date ? BigInt(v.getTime()) * 1000n : c.type === "timestamp" && typeof v === "bigint" ? v : (v ?? null) as Cell; }) : null;
  }
  private encode(row: Cell[]) {
    return JSON.stringify(row.map((v) => (typeof v === "bigint" ? v.toString() : v)));
  }
  /** Append rows (in time order); returns how many were kept. */
  append(rows: Cell[][]) {
    return this.serial(() => this.appendNow(rows));
  }
  private async appendNow(rows: Cell[][]) {
    let kept = 0;
    for (const row of rows) {
      const t = row[0] as bigint;
      if (typeof t !== "bigint") continue;
      const key = partitionKey(t, this.grain);
      if (this.open && key < this.open.key) {
        this.late++; // its partition is closed or closing: frozen history is never rewritten
        continue;
      }
      if (!this.open || key !== this.open.key) {
        if (this.open) await this.closeKey(this.open.key);
        if (this.partitions().some((p) => p.key === key)) {
          this.late++;
          continue;
        }
        this.open = { key, lines: [], rows: 0 };
      }
      this.open.lines.push(this.encode(row));
      this.open.rows++;
      this.rowsTotal++;
      this.lastTime = t;
      kept++;
    }
    return kept;
  }
  flush() {
    if (!this.open?.lines.length) return;
    if (!fs.existsSync(path.join(this.dir, "open"))) return void (this.open.lines = []); // deleted with its data
    fs.appendFileSync(path.join(this.dir, "open", `${this.open.key}.ndjson`), this.open.lines.join("\n") + "\n", { mode: 0o600 });
    this.open.lines = [];
  }
  get openRows() {
    return this.open?.rows ?? 0;
  }
  get openKey() {
    return this.open?.key ?? null;
  }
  /** Close the open partition once its period has passed (plus a grace for rows in flight).
   * Workers do not call this while catching up past periods: those close when the data moves on. */
  tick(now = Date.now()) {
    return this.serial(async () => {
      if (this.open && now >= periodEndMs(this.open.key) + CLOSE_GRACE_MS) await this.closeKey(this.open.key);
    });
  }
  private async closeKey(key: string) {
    if (this.open?.key === key) this.flush();
    const src = path.join(this.dir, "open", `${key}.ndjson`);
    if (this.open?.key === key) this.open = null;
    if (!fs.existsSync(src)) return;
    const rel = partitionFile(key, this.grain);
    const out = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    const sink = new ParquetSink(out + ".part", this.columns);
    let rows = 0,
      dup = 0,
      disorder = 0,
      maxGap = 0,
      prev: bigint | null = null,
      first: bigint | null = null;
    const seen = new Set<string>();
    const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const row = this.decode(line);
      const t = row[0] as bigint;
      if (prev !== null) {
        if (t < prev) disorder++;
        else maxGap = Math.max(maxGap, Number(t - prev) / 1e6);
      }
      if (this.idIdx >= 0 && row[this.idIdx] !== null) {
        const id = String(row[this.idIdx]);
        if (seen.has(id)) dup++;
        else seen.add(id);
      }
      first ??= t;
      prev = t;
      sink.push(row);
      rows++;
    }
    if (!rows) {
      fs.rmSync(src, { force: true });
      fs.rmSync(out + ".part", { force: true });
      return;
    }
    const bytes = sink.finish();
    fs.renameSync(out + ".part", out);
    fs.chmodSync(out, 0o400);
    const h = createHash("sha256");
    await pipeline(fs.createReadStream(out), h);
    const periodMs = this.grain === "hour" ? 3_600_000 : 86_400_000;
    const expected = this.barMs ? Math.round(periodMs / this.barMs) : undefined;
    const record: PartitionRecord = {
      key,
      file: rel,
      rows,
      bytes,
      sha256: h.digest("hex"),
      first: first !== null ? showCell("timestamp", first) : null,
      last: prev !== null ? showCell("timestamp", prev) : null,
      closedAt: new Date().toISOString(),
      quality: {
        duplicates: dup,
        outOfOrder: disorder,
        maxGapSeconds: rows > 1 ? Math.round(maxGap * 1000) / 1000 : null,
        ...(expected ? { expected, missing: Math.max(0, expected - (rows - dup)) } : {}),
        ...(this.late ? { late: this.late } : {}),
      },
    };
    this.late = 0;
    fs.appendFileSync(path.join(this.dir, "partitions.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    fs.rmSync(src, { force: true });
  }
  /** Stop: flush, keep the open partition for the next start. */
  stop() {
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
