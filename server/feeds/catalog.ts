import fs from "node:fs";
import path from "node:path";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { readCompressors, showCell } from "../workbench/parquet.ts";
import { feedCreateSchema, type FeedCreate } from "../../src/feed-contract.ts";
import { CHANNELS, backfillable, channelOf, feedDefSchema, feedDir, feedsDefDir, type FeedDef, type FeedStatus, type Outage, type PartitionRecord } from "./model.ts";

/** The app's view of production feeds: definitions it writes, status and
 * partitions the service writes. The service picks up changes by itself. */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "feed";

export class FeedCatalog {
  constructor(private folderOf: (sid: string) => string) {}
  private defs(sid: string): FeedDef[] {
    const d = feedsDefDir(this.folderOf(sid));
    try {
      return fs
        .readdirSync(d)
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => {
          try {
            return [feedDefSchema.parse(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")))];
          } catch {
            return [];
          }
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }
  def(sid: string, id: string) {
    const d = this.defs(sid).find((x) => x.id === id);
    if (!d) throw new Error(`Feed ${id} not found. Use feeds_list for ids.`);
    return d;
  }
  private write(sid: string, def: FeedDef) {
    const d = feedsDefDir(this.folderOf(sid));
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const f = path.join(d, `${def.id}.json`);
    fs.writeFileSync(f + ".tmp", JSON.stringify(feedDefSchema.parse(def), null, 2), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
    return def;
  }
  status(sid: string, def: FeedDef, serviceRunning: boolean): FeedStatus & { stale: boolean } {
    let s: FeedStatus | null = null;
    try {
      s = JSON.parse(fs.readFileSync(path.join(feedDir(this.folderOf(sid), def.id), "status.json"), "utf8"));
    } catch {}
    const base: FeedStatus = s ?? { state: "starting", detail: "Waiting for the feed service", heartbeatAt: "", rowsToday: 0, rowsTotal: 0, openRows: 0, partitions: 0, reconnects: 0, errors: [] };
    if (def.paused) return { ...base, state: "paused", detail: "Paused", stale: false };
    const stale = !serviceRunning || !base.heartbeatAt || Date.now() - Date.parse(base.heartbeatAt) > 20_000;
    return stale ? { ...base, state: "stopped", detail: serviceRunning ? "Waiting for the feed service to pick it up" : "Collection is switched off", stale: true } : { ...base, stale: false };
  }
  list(sid: string, serviceRunning: boolean) {
    return this.defs(sid).map((def) => ({ def, status: this.status(sid, def, serviceRunning), partitions: this.partitions(sid, def.id, 1) }));
  }
  create(sid: string, input: FeedCreate, workspaceFor: () => string | undefined) {
    let def: FeedDef;
    const common = { version: 1 as const, paused: false, createdAt: new Date().toISOString() };
    if (input.kind === "stream") {
      if (input.exchange === "binance" && !input.market) throw new Error("Give a market for Binance: spot, um or cm.");
      const ch = CHANNELS[`${input.exchange}:${input.channel}`];
      if (!ch) throw new Error(`${input.exchange} channels: ${Object.keys(CHANNELS).filter((k) => k.startsWith(input.exchange)).map((k) => k.split(":")[1]).join(", ")}`);
      if (ch.markets && !ch.markets.includes(input.market!)) throw new Error(`${input.channel} is available for ${ch.markets.join(", ")}`);
      if (ch.interval && !input.interval) throw new Error("Give an interval for bars (e.g. 1m).");
      if (input.interval === "1s" && input.market !== "spot") throw new Error("1-second bars are streamed for spot only");
      if (input.backfillFrom && !backfillable(input.exchange === "binance" ? input.market : undefined, input.channel))
        throw new Error(`${input.exchange === "binance" ? `Binance's archive has no ${input.market} ${input.channel}` : "Coinbase has no archive"}, so past days cannot be filled; leave the date empty to collect from now.`);
      const symbol = input.exchange === "binance" ? input.symbol.toUpperCase() : input.symbol.toUpperCase();
      const title = input.title || `${input.exchange === "binance" ? `Binance ${input.market}` : "Coinbase"} ${input.channel}${input.interval ? ` ${input.interval}` : ""} ${symbol}`;
      def = { ...common, kind: "stream", id: this.unique(sid, title), title, channel: input.channel, ...(input.exchange === "binance" ? { market: input.market } : {}), symbol, ...(input.interval ? { interval: input.interval } : {}), ...(input.backfillFrom ? { backfillFrom: input.backfillFrom } : {}), ...(input.seededFrom ? { seededFrom: input.seededFrom } : {}) };
    } else if (input.kind === "pull") {
      if (input.provider === "binance-archive" && (!input.market || !input.dataset)) throw new Error("Give market and dataset for the archive.");
      if ((input.provider === "binance" || input.provider === "coinbase") && !input.interval) throw new Error("Give an interval for bars.");
      const title = input.title || `${input.provider} ${input.dataset ?? ""} ${input.symbol} every ${input.every}`.replace(/\s+/g, " ");
      def = { ...common, kind: "pull", id: this.unique(sid, title), title, provider: input.provider, ...(input.market ? { market: input.market } : {}), ...(input.dataset ? { dataset: input.dataset } : {}), symbol: input.symbol, ...(input.interval ? { interval: input.interval } : {}), every: input.every, backfillFrom: input.backfillFrom, ...(input.seededFrom ? { seededFrom: input.seededFrom } : {}) };
    } else {
      const ws = input.workspace?.slice(2) ?? workspaceFor();
      if (!ws) throw new Error("No workspace given and nothing is in production.");
      if (!fs.existsSync(path.join(this.folderOf(sid), "Research-Workspaces", ws))) throw new Error("That idea has no Research Development workspace.");
      const title = input.title || `Script: ${input.command.slice(0, 60)}`;
      def = { ...common, kind: "script", id: this.unique(sid, title), title, command: input.command, workspace: ws, every: input.every, timeColumn: input.timeColumn, backfillFrom: input.backfillFrom };
    }
    return this.write(sid, def);
  }
  private unique(sid: string, title: string) {
    const ids = new Set(this.defs(sid).map((d) => d.id));
    let id = slug(title),
      n = 2;
    while (ids.has(id)) id = `${slug(title).slice(0, 66)}-${n++}`;
    return id;
  }
  update(sid: string, id: string, patch: { paused?: boolean; title?: string }) {
    const d = this.def(sid, id);
    return this.write(sid, { ...d, ...(patch.paused !== undefined ? { paused: patch.paused } : {}), ...(patch.title ? { title: patch.title } : {}) });
  }
  /** Remove a feed; its collected data too unless kept. */
  delete(sid: string, id: string, keepData: boolean) {
    const d = this.def(sid, id);
    fs.rmSync(path.join(feedsDefDir(this.folderOf(sid)), `${d.id}.json`), { force: true });
    const dir = feedDir(this.folderOf(sid), d.id);
    let bytes = 0;
    for (const p of this.partitions(sid, id, 100000)) bytes += p.bytes;
    if (!keepData) fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: id, keptData: keepData, bytes };
  }
  partitions(sid: string, id: string, limit = 50): PartitionRecord[] {
    try {
      const all = fs.readFileSync(path.join(feedDir(this.folderOf(sid), id), "partitions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PartitionRecord);
      return all.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
  /** Stretches the live feed did not cover by itself (filled from the exchange, or holes), newest first. */
  outages(sid: string, id: string, limit = 50): Outage[] {
    try {
      return fs.readFileSync(path.join(feedDir(this.folderOf(sid), id), "outages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Outage).slice(-limit).reverse();
    } catch {
      return [];
    }
  }
  /** Latest rows (the open partition, then the newest closed one) and a thinned
   * series of the feed's main value over its recent partitions. */
  async rows(sid: string, id: string, limit = 100) {
    const def = this.def(sid, id);
    const dir = feedDir(this.folderOf(sid), id);
    const columns: { name: string; type: string }[] = channelOf(def)?.columns ?? (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).columns ?? [];
      } catch {
        return [];
      }
    })();
    const names = columns.map((c) => c.name);
    const show = (row: unknown[]) => row.map((v, i) => (v === null || v === undefined ? "" : columns[i]?.type === "timestamp" ? showCell("timestamp", typeof v === "string" ? BigInt(v) : v instanceof Date ? BigInt(v.getTime()) * 1000n : (v as bigint)) : String(v)));
    const out: string[][] = [];
    // Open partition (newest rows at the end of the file).
    try {
      const open = fs.readdirSync(path.join(dir, "open")).filter((f) => f.endsWith(".ndjson")).sort().at(-1);
      if (open) {
        const lines = fs.readFileSync(path.join(dir, "open", open), "utf8").trim().split("\n").filter(Boolean);
        for (const l of lines.slice(-limit)) out.push(show(JSON.parse(l)));
      }
    } catch {}
    const parts = this.partitions(sid, id, 24);
    if (out.length < limit && parts[0]) {
      const buf = await asyncBufferFromFile(path.join(dir, parts[0].file));
      const n = Number((await parquetMetadataAsync(buf)).num_rows);
      const objs = await parquetReadObjects({ file: buf, compressors: readCompressors as any, rowStart: Math.max(0, n - (limit - out.length)), rowEnd: n });
      out.unshift(...objs.map((o) => show(names.map((c) => o[c]))));
    }
    // Series: the main value over the recent partitions + open rows.
    const vi = ["close", "price", "mark", "bid", "value", "index_value", "bid_px_1"].map((n) => names.indexOf(n)).find((i) => i >= 0) ?? -1;
    const series: [string, number][] = [];
    if (vi >= 0) {
      for (const p of [...parts].reverse()) {
        const buf = await asyncBufferFromFile(path.join(dir, p.file));
        const objs = await parquetReadObjects({ file: buf, compressors: readCompressors as any, columns: [names[0], names[vi]] });
        const step = Math.max(1, Math.ceil(objs.length / 80));
        for (let i = 0; i < objs.length; i += step) {
          const t = objs[i][names[0]];
          const v = Number(objs[i][names[vi]]);
          if (Number.isFinite(v)) series.push([t instanceof Date ? t.toISOString() : String(t), v]);
        }
      }
      const step = Math.max(1, Math.ceil(out.length / 200));
      for (let i = 0; i < out.length; i += step) if (Number.isFinite(Number(out[i][vi]))) series.push([out[i][0], Number(out[i][vi])]);
    }
    return { columns: names, types: columns.map((c) => c.type), rows: out.slice(-limit).reverse(), series, valueColumn: vi >= 0 ? names[vi] : "" };
  }
}
