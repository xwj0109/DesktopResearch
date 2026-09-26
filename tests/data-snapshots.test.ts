import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { DataFeeds, csvPreview, fromString } from "../server/workbench/data.ts";
import { RdWorkspaces } from "../server/workbench/rd.ts";
import { inferColumns, readCompressors, toMicros } from "../server/workbench/parquet.ts";

function tmp(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const publicDns = async () => [{ address: "151.101.1.42", family: 4 }];
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};
const readParquet = async (file: string) => {
  const buf = await asyncBufferFromFile(file);
  return { meta: await parquetMetadataAsync(buf), rows: await parquetReadObjects({ file: buf, compressors: readCompressors as any }) };
};
/** A one-entry zip (deflate), as Binance publishes. */
function zip(name: string, text: string) {
  const data = Buffer.from(text);
  const comp = zlib.deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, comp, cd, n, eocd]);
}

test("columns are typed from names and samples; timestamps become UTC microseconds (ms, μs and text)", () => {
  assert.equal(toMicros("1736899200363560"), 1736899200363560n, "spot μs");
  assert.equal(toMicros("1736899205133"), 1736899205133000n, "futures ms");
  assert.equal(toMicros("2025-01-15 00:00:05"), BigInt(Date.parse("2025-01-15T00:00:05Z")) * 1000n);
  assert.deepEqual(
    inferColumns(["id", "price", "qty", "quote_qty", "time", "is_buyer_maker"], ["2351943733", "0.35579", "16.0", "5.69264", "1736899205133", "false"]).map((c) => c.type),
    ["int64", "float64", "float64", "float64", "timestamp", "bool"],
  );
  assert.deepEqual(inferColumns(["date", "hour", "symbol", "strike", "best_buy_iv"], ["2023-10-23", "23", "BNB-231027-205-C", "231027-205", ""]).map((c) => c.type), ["string", "int64", "string", "string", "float64"]);
});

test("Binance archive: listing, checksum-verified downloads, headerless spot ticks and headed futures → one Parquet file per day", async (t) => {
  const root = tmp(t);
  const d1 = "918657697,0.35591000,8995.00000000,3201.41045000,1736899200363560,False,True\n918657698,0.35592000,100.00000000,35.592,1736899200463560,True,True\n";
  const d2 = "918657699,0.35600000,10.00000000,3.56,1736985600000000,False,True\n";
  const files: Record<string, Buffer> = {
    "2025-01-15": zip("DOGEUSDT-trades-2025-01-15.csv", d1),
    "2025-01-16": zip("DOGEUSDT-trades-2025-01-16.csv", d2),
  };
  const key = (d: string) => `data/spot/daily/trades/DOGEUSDT/DOGEUSDT-trades-${d}.zip`;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const seen: string[] = [];
  let corrupt = false;
  const fetch: typeof globalThis.fetch = (async (url: string) => {
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === "s3-ap-northeast-1.amazonaws.com") {
      const keys = ["2025-01-14", "2025-01-15", "2025-01-16", "2025-01-18"].flatMap((d) => [`<Contents><Key>${key(d)}</Key><Size>${files[d]?.length ?? 10}</Size></Contents>`, `<Contents><Key>${key(d)}.CHECKSUM</Key><Size>96</Size></Contents>`]);
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.join("")}</ListBucketResult>`);
    }
    const d = /trades-(\d{4}-\d{2}-\d{2})\.zip/.exec(u.pathname)![1];
    if (u.pathname.endsWith(".CHECKSUM")) return new Response(`${corrupt ? "0".repeat(64) : sha(files[d])}  DOGEUSDT-trades-${d}.zip\n`);
    return new Response(new Uint8Array(files[d]));
  }) as unknown as typeof globalThis.fetch;
  const data = new DataFeeds(() => root, () => ({ fetch, lookup: publicDns }), 0);
  const q = { market: "spot" as const, dataset: "trades", symbol: "DOGEUSDT" };
  const est = await data.estimate("s", q, "2025-01-15", "2025-01-17");
  assert.deepEqual([est.files, est.bytes, est.first, est.last, est.missing], [2, files["2025-01-15"].length + files["2025-01-16"].length, "2025-01-15", "2025-01-16", ["2025-01-17"]]);
  assert.match(seen[0], /prefix=data%2Fspot%2Fdaily%2Ftrades%2FDOGEUSDT%2FDOGEUSDT-trades-&marker=/);

  data.fetch("s", { source: { kind: "binance-archive", ...q }, start: "2025-01-15", end: "2025-01-17" });
  await waitFor(() => data.jobsOf("s")[0].status !== "running");
  const job = data.jobsOf("s")[0];
  assert.equal(job.status, "done", job.message);
  assert.match(job.message, /3 rows · .* Parquet \((zstd|snappy)\)/);
  const [m] = data.snapshots("s");
  assert.equal(m.file, "binance-spot-trades-dogeusdt-2025-01-15-2025-01-17/");
  assert.deepEqual([m.rows, (m as any).files, m.format], [3, 2, "parquet"]);
  assert.deepEqual(m.columns, ["id", "price", "qty", "quote_qty", "time", "is_buyer_maker", "is_best_match"]);
  assert.deepEqual(m.types, ["int64", "float64", "float64", "float64", "timestamp", "bool", "bool"]);
  const full = data.snapshot("s", m.name);
  assert.deepEqual(full.parts!.map((p) => [p.date, p.rows, p.sourceSha256]), [["2025-01-15", 2, sha(files["2025-01-15"])], ["2025-01-16", 1, sha(files["2025-01-16"])]]);
  assert.deepEqual(full.missing, ["2025-01-17"]);
  const day1 = path.join(root, "Data", "snapshots", m.file, "2025-01-15.parquet");
  const { meta, rows } = await readParquet(day1);
  assert.equal(Number(meta.num_rows), 2);
  const timeCol = meta.schema.find((s: any) => s.name === "time") as any;
  assert.equal(timeCol.logical_type?.type, "TIMESTAMP");
  assert.equal(timeCol.logical_type?.unit, "MICROS");
  assert.equal((rows[0].time as Date).toISOString(), "2025-01-15T00:00:00.363Z");
  assert.deepEqual([rows[0].id, rows[0].price, rows[0].is_buyer_maker, rows[1].is_buyer_maker], [918657697n, 0.35591, false, true]);
  assert.match(String(meta.row_groups[0].columns[0].meta_data?.codec), /ZSTD|SNAPPY/);
  assert.equal(fs.statSync(day1).mode & 0o222, 0, "read-only");
  assert.equal(full.preview!.valueColumn, "price");
  assert.deepEqual([m.first, m.last], ["2025-01-15T00:00:00.363Z", "2025-01-16T00:00:00.000Z"], "the range is time, not trade ids");
  assert.equal(full.preview!.series[0][0], "2025-01-15T00:00:00.363Z");

  // A checksum mismatch discards everything.
  corrupt = true;
  data.fetch("s", { source: { kind: "binance-archive", ...q }, start: "2025-01-15", end: "2025-01-15" });
  await waitFor(() => data.jobsOf("s")[0].status !== "running");
  assert.match(data.jobsOf("s")[0].message, /Checksum mismatch/);
  assert.deepEqual(data.snapshots("s").length, 1);
  assert.ok(!fs.readdirSync(path.join(root, "Data", "snapshots")).some((f) => f.endsWith(".part")));

  // Validation.
  await assert.rejects(data.estimate("s", { market: "option", dataset: "trades", symbol: "BTCUSDT" }, "2024-01-01", "2024-01-02"), /Options \(historical\)|publishes/);
  await assert.rejects(data.estimate("s", { market: "um", dataset: "klines", symbol: "BTCUSDT", interval: "1s" }, "2024-01-01", "2024-01-02"), /1-second bars are published for spot only/);
});

test("Binance bars via the API are written as one typed Parquet file; Coinbase and FRED too (missing values null)", async (t) => {
  const root = tmp(t);
  const start = Date.parse("2024-01-01T00:00:00Z");
  const fetch: typeof globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname === "data-api.binance.vision") {
      const from = Math.ceil(Number(u.searchParams.get("startTime")) / 60000) * 60000;
      const n = from < start + 1500 * 60000 ? 1000 : 0;
      return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => { const tt = from + i * 60000; return [tt, "100", "101", "99", String(100 + (tt - start) / 6e7), "5", tt + 59999, "500", 7]; })));
    }
    if (u.hostname === "api.exchange.coinbase.com") {
      const s = Date.parse(u.searchParams.get("start")!) / 1000;
      return new Response(JSON.stringify([2, 1, 0].map((i) => [s + i * 86400, 9, 11, 10, 10.5 + i, 3])));
    }
    return new Response("observation_date,DGS10\n2024-01-02,3.95\n2024-01-03,.\n2024-01-04,3.99\n");
  }) as unknown as typeof globalThis.fetch;
  const data = new DataFeeds(() => root, () => ({ fetch, lookup: publicDns }), 0);
  data.fetch("s", { source: { kind: "binance", symbol: "BTCUSDT", interval: "1m" }, start: "2024-01-01", end: "2024-01-02" });
  data.fetch("s", { source: { kind: "coinbase", symbol: "BTC-USD", interval: "1d" }, start: "2024-01-01", end: "2024-01-03" });
  data.fetch("s", { source: { kind: "fred", symbol: "DGS10" }, start: "2024-01-01", end: "2024-01-05" });
  await waitFor(() => data.jobsOf("s").every((j) => j.status !== "running"));
  for (const j of data.jobsOf("s")) assert.equal(j.status, "done", j.message);
  const by = (k: string) => data.snapshots("s").find((s) => s.source.kind === k)!;
  const bn = by("binance");
  assert.deepEqual([bn.rows, bn.file, bn.types], [2000, "binance-btcusdt-1m-2024-01-01-2024-01-02.parquet", ["timestamp", "float64", "float64", "float64", "float64", "float64", "float64", "int64"]]);
  const b = await readParquet(path.join(root, "Data", "snapshots", bn.file));
  assert.equal(Number(b.meta.num_rows), 2000);
  assert.deepEqual([(b.rows[0].time as Date).toISOString(), b.rows[0].close, b.rows[0].trades], ["2024-01-01T00:00:00.000Z", 100, 7n]);
  const cb = await readParquet(path.join(root, "Data", "snapshots", by("coinbase").file));
  assert.deepEqual(cb.rows.map((r: any) => [(r.time as Date).toISOString().slice(0, 10), r.close]), [["2024-01-01", 10.5], ["2024-01-02", 11.5], ["2024-01-03", 12.5]]);
  const fred = await readParquet(path.join(root, "Data", "snapshots", by("fred").file));
  assert.deepEqual(fred.rows.map((r: any) => r.value), [3.95, null, 3.99], "missing values are null, not NaN");
  assert.equal(data.snapshot("s", bn.name).preview!.valueColumn, "close");

  // Validation up front; cancel keeps nothing.
  assert.throws(() => data.fetch("s", { source: { kind: "binance", symbol: "btc/usd", interval: "1m" }, start: "2024-01-01", end: "2024-01-02" }), /BTCUSDT/);
  assert.throws(() => data.fetch("s", { source: { kind: "fred", symbol: "DGS10" }, start: "2024-02-01", end: "2024-01-01" }), /before the start/);
  const privateData = new DataFeeds(() => root, () => ({ fetch, lookup: async () => [{ address: "127.0.0.1", family: 4 }] }), 0);
  privateData.fetch("p", { source: { kind: "fred", symbol: "DGS10" }, start: "2024-01-01", end: "2024-01-05" });
  await waitFor(() => privateData.jobsOf("p")[0].status !== "running");
  assert.match(privateData.jobsOf("p")[0].message, /not a public internet address/);
  let release!: () => void;
  const slow = (async () => {
    await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify([[Date.parse("2024-01-01T00:00:00Z"), "1", "1", "1", "1", "1", 0, "1", 1]]));
  }) as unknown as typeof globalThis.fetch;
  const c = new DataFeeds(() => root, () => ({ fetch: slow, lookup: publicDns }), 0);
  const job = c.fetch("c", { source: { kind: "binance", symbol: "ETHUSDT", interval: "1h" }, start: "2024-01-01", end: "2024-03-01" });
  await new Promise((r) => setTimeout(r, 20));
  c.cancel("c", job.id);
  release();
  await waitFor(() => c.jobsOf("c")[0].status !== "running");
  assert.equal(c.jobsOf("c")[0].status, "cancelled");
  assert.deepEqual(fs.readdirSync(path.join(root, "Data", "snapshots")).filter((f) => f.startsWith("binance-ethusdt")), []);
});

test("files (CSV, Parquet) are registered as snapshots with provenance; each idea workspace sees snapshots read-only as data/, never committed", async (t) => {
  const root = tmp(t);
  const data = new DataFeeds(() => root, () => ({ fetch: globalThis.fetch, lookup: publicDns }), 0);
  const rd = new RdWorkspaces(() => root);
  const dir = await rd.ensure("s", "11111111-1111-4111-8111-111111111111", "Kelly");
  assert.equal(fs.readlinkSync(path.join(dir, "data")), path.join("..", "..", "Data", "snapshots"));
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\/data$/m);
  fs.writeFileSync(path.join(dir, "bbg.csv"), "date,PX_LAST\n2024-01-02,42000\n2024-01-03,43000\n");
  const m = await data.register("s", rd.resolve(dir, "bbg.csv"), "bbg.csv", "XBT Bloomberg", "Bloomberg XBTUSD Curncy PX_LAST via xbbg");
  assert.deepEqual([m.rows, m.columns, m.first, m.last, m.source], [2, ["date", "PX_LAST"], "2024-01-02", "2024-01-03", { kind: "file", from: "bbg.csv", note: "Bloomberg XBTUSD Curncy PX_LAST via xbbg" }]);
  // A Parquet file (as polars would write it) gets a real preview too.
  const { ParquetSink } = await import("../server/workbench/parquet.ts");
  const sink = new ParquetSink(path.join(dir, "ticks.parquet"), [{ name: "time", type: "timestamp" }, { name: "price", type: "float64" }]);
  for (let i = 0; i < 50; i++) sink.push([BigInt(Date.parse("2024-01-01T00:00:00Z") + i * 1000) * 1000n, 100 + i]);
  sink.finish();
  const pq = await data.register("s", rd.resolve(dir, "ticks.parquet"), "ticks.parquet", "Ticks");
  assert.deepEqual([pq.rows, pq.columns, pq.format, pq.preview!.valueColumn, pq.preview!.series.length, pq.preview!.tail.at(-1)![1]], [50, ["time", "price"], "parquet", "price", 50, "149"]);
  assert.ok(fs.existsSync(path.join(dir, "data", "xbt-bloomberg.csv")));
  assert.deepEqual((await rd.changes(dir)).files.map((f) => f.path).sort(), ["bbg.csv", "ticks.parquet"]);
  assert.ok(!rd.files(dir).some((f) => f.path.startsWith("data/")));
  await assert.rejects(data.register("s", rd.resolve(dir, ".gitignore"), ".gitignore", "x"), /can be registered/);
  const p = await csvPreview(fromString('time,open,close\n1,2,3\n4,"5",6\n'));
  assert.deepEqual([p.rows, p.valueColumn, p.series], [2, "close", [["1", 3], ["4", 6]]]);
});

test("ticker suggestions: ranked matches from what each source serves; lists load once", async () => {
  const { rankSymbols, FRED_SERIES } = await import("../server/workbench/symbols.ts");
  const items = ["SOLBTC", "SOLUSDC", "SOLUSDT", "SOL", "ASOLUSDT", "SOLVUSDT", "BTCUSDT", "ETHUSDT", "BTCFDUSD"].map((symbol) => ({ symbol }));
  assert.deepEqual(rankSymbols(items, "sol", 5).map((s) => s.symbol), ["SOL", "SOLUSDT", "SOLUSDC", "SOLBTC", "SOLVUSDT"], "exact, then prefix by preferred quote");
  assert.deepEqual(rankSymbols(items, "", 3).map((s) => s.symbol), ["BTCUSDT", "BTCFDUSD", "ETHUSDT"], "empty query: the majors");
  assert.deepEqual(rankSymbols(["SOLBUSD", "SOLUSDC", "SOLVUSDT"].map((symbol) => ({ symbol })), "SOL").map((s) => s.symbol), ["SOLUSDC", "SOLBUSD", "SOLVUSDT"], "quotes are read exactly (SOLBUSD is not SOL-USD)");
  assert.deepEqual(rankSymbols(["ETHFI-USD", "ETH-GBP", "ETH-USD"].map((symbol) => ({ symbol })), "eth").map((s) => s.symbol), ["ETH-USD", "ETH-GBP", "ETHFI-USD"], "any ETH-… product before other coins");
  assert.ok(rankSymbols(items, "SOL").some((s) => s.symbol === "ASOLUSDT"), "contains matches come after prefixes");
  assert.equal(rankSymbols(FRED_SERIES, "treasury")[0].symbol, "DGS10", "FRED matches titles too");
  assert.deepEqual(rankSymbols([{ symbol: "BTC-USD", inactive: true }, { symbol: "BTC-USDT" }], "btc").map((s) => s.symbol), ["BTC-USDT", "BTC-USD"], "inactive last");

  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === "api.exchange.coinbase.com") return new Response(JSON.stringify([{ id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", status: "online" }, { id: "OLD-USD", base_currency: "OLD", quote_currency: "USD", status: "delisted" }]));
    const page2 = u.searchParams.get("marker");
    const p = (s: string) => `<CommonPrefixes><Prefix>data/futures/um/daily/bookDepth/${s}/</Prefix></CommonPrefixes>`;
    return new Response(`<ListBucketResult><Prefix>data/futures/um/daily/bookDepth/</Prefix>${page2 ? p("SOLUSDT") + p("XRPUSDT") : p("BTCUSDT") + p("ETHUSDT")}<IsTruncated>${page2 ? "false" : "true"}</IsTruncated>${page2 ? "" : "<NextMarker>data/futures/um/daily/bookDepth/ETHUSDT/</NextMarker>"}</ListBucketResult>`);
  }) as unknown as typeof globalThis.fetch;
  const data = new DataFeeds(() => fs.mkdtempSync(path.join(os.tmpdir(), "sym-")), () => ({ fetch, lookup: publicDns }), 0);
  const a = await data.symbols("binance-archive", "", "um", "bookDepth");
  assert.equal(a.total, 4, "paged through the archive listing");
  assert.deepEqual(a.symbols.map((s) => s.symbol), ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
  assert.match(calls[0], /prefix=data%2Ffutures%2Fum%2Fdaily%2FbookDepth%2F&delimiter=\//);
  await data.symbols("binance-archive", "sol", "um", "bookDepth");
  assert.equal(calls.length, 2, "the list is cached");
  const cb = await data.symbols("coinbase", "");
  assert.deepEqual(cb.total, 2);
  assert.deepEqual((await data.symbols("coinbase", "usd")).symbols.map((s) => [s.symbol, s.label]), [["BTC-USD", "BTC/USD"], ["OLD-USD", "OLD/USD · delisted"]]);
  assert.equal((await data.symbols("fred", "vix")).symbols[0].symbol, "VIXCLS");
  await assert.rejects(data.symbols("binance-archive", "", "spot", "bookDepth"), /Spot publishes/);
});

test("deleting a snapshot removes its file or daily folder and manifest for good, and reports the code that read it", async (t) => {
  const root = tmp(t);
  const data = new DataFeeds(() => root, () => ({ fetch: globalThis.fetch, lookup: publicDns }), 0);
  const rd = new RdWorkspaces(() => root);
  const idea = "11111111-1111-4111-8111-111111111111";
  const dir = await rd.ensure("s", idea, "Kelly");
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n");
  const one = await data.register("s", rd.resolve(dir, "px.csv"), "px.csv", "Prices");
  // A folder snapshot like the archive writes (read-only daily files).
  const folder = path.join(root, "Data", "snapshots", "ticks");
  fs.mkdirSync(folder);
  for (const d of ["2025-01-15", "2025-01-16"]) {
    fs.writeFileSync(path.join(folder, `${d}.parquet`), "PAR1");
    fs.chmodSync(path.join(folder, `${d}.parquet`), 0o400);
  }
  fs.writeFileSync(path.join(root, "Data", "snapshots", "ticks.json"), JSON.stringify({ version: 1, name: "ticks", title: "Ticks", file: "ticks/", format: "parquet", source: { kind: "binance-archive" }, createdAt: "2026-09-25T10:00:00Z", rows: 2, columns: [], bytes: 8, sha256: "x" }));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "fit.py"), 'import polars as pl\ndf = pl.scan_parquet("data/ticks/*.parquet")\n');
  fs.writeFileSync(path.join(dir, "notes.md"), `Uses data/${one.file}\n`);

  assert.deepEqual(data.references("s", "ticks"), [{ idea: `r:${idea}`, path: "src/fit.py" }]);
  assert.deepEqual(data.references("s", one.name), [{ idea: `r:${idea}`, path: "notes.md" }]);
  const r = data.delete("s", "ticks");
  assert.deepEqual([r.deleted, r.bytes, r.references], ["ticks", 8, [{ idea: `r:${idea}`, path: "src/fit.py" }]]);
  assert.equal(fs.existsSync(folder), false, "the whole daily folder is gone (read-only files included)");
  assert.throws(() => data.snapshot("s", "ticks"), /not found/);
  data.delete("s", one.name);
  assert.deepEqual(data.snapshots("s"), []);
  assert.ok(fs.existsSync(path.join(dir, "px.csv")), "the workspace's own file is untouched");
  assert.throws(() => data.delete("s", "../x"), /Invalid snapshot name/);
  assert.throws(() => data.delete("s", "nope"), /not found/);
});
