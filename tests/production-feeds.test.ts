import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { readCompressors } from "../server/workbench/parquet.ts";
import { PartitionWriter } from "../server/feeds/writer.ts";
import { FeedCatalog } from "../server/feeds/catalog.ts";
import { FeedDaemon, SERVICE_FILE } from "../server/feeds/daemon.ts";
import { FeedService } from "../server/feeds/service.ts";
import { feedDir, feedsDefDir } from "../server/feeds/model.ts";
import type { WorkerContext } from "../server/feeds/workers.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
function tmp(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feeds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const us = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const waitFor = async (fn: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  return fn();
};
const read = async (file: string) => parquetReadObjects({ file: await asyncBufferFromFile(file), compressors: readCompressors as any });
const noNetwork: WorkerContext["deps"] = () => ({
  lookup: async () => [{ address: "151.101.1.42", family: 4 }],
  fetch: async () => {
    throw new Error("no network in tests");
  },
}) as any;

test("partitions: rows go to the open hour; a past hour is frozen as read-only Parquet with a hash and quality counts; late rows never rewrite it", async (t) => {
  const dir = tmp(t);
  const cols = [{ name: "time", type: "timestamp" as const }, { name: "id", type: "int64" as const }, { name: "price", type: "float64" as const }];
  const w = new PartitionWriter(dir, cols, "hour", "id");
  await w.recover(Date.parse("2026-01-01T10:30:00Z"));
  await w.append([
    [us("2026-01-01T10:00:01Z"), 1n, 100],
    [us("2026-01-01T10:00:01Z"), 1n, 100], // duplicate id
    [us("2026-01-01T10:00:00Z"), 2n, 101], // out of order
    [us("2026-01-01T10:20:00Z"), 3n, 102],
  ]);
  w.flush();
  assert.ok(fs.existsSync(path.join(dir, "open", "2026-01-01T10.ndjson")));
  assert.equal(w.partitions().length, 0);
  await w.append([[us("2026-01-01T11:00:00Z"), 4n, 103]]); // time moves on: 10:00 closes
  const [p] = w.partitions();
  assert.equal(p.key, "2026-01-01T10");
  assert.equal(p.file, "data/2026/01/01/10.parquet");
  assert.equal(p.rows, 4);
  assert.deepEqual(p.quality, { duplicates: 1, outOfOrder: 1, maxGapSeconds: 1200 });
  const file = path.join(dir, p.file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400, "frozen");
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), p.sha256);
  const rows = await read(file);
  assert.deepEqual(rows.map((r) => r.id), [1n, 1n, 2n, 3n]);
  assert.ok(!fs.existsSync(path.join(dir, "open", "2026-01-01T10.ndjson")));

  assert.equal(await w.append([[us("2026-01-01T10:59:00Z"), 5n, 99]]), 0, "late row into a closed hour is dropped");
  await w.tick(Date.parse("2026-01-01T12:00:05Z"));
  assert.equal(w.partitions().length, 1, "a period is frozen only after a grace for rows in flight");
  await w.tick(Date.parse("2026-01-01T12:00:11Z"));
  const p2 = w.partitions()[1];
  assert.equal(p2.key, "2026-01-01T11");
  assert.equal(p2.quality.late, 1);
  assert.equal(w.rowsTotal, 5);
  w.stop();
});

test("partitions: a restarted writer resumes the current hour and closes older open files; bar feeds count missing bars", async (t) => {
  const dir = tmp(t);
  const cols = [{ name: "time", type: "timestamp" as const }, { name: "close", type: "float64" as const }];
  fs.mkdirSync(path.join(dir, "open"), { recursive: true });
  const line = (iso: string, v: number) => JSON.stringify([us(iso).toString(), v]);
  fs.writeFileSync(path.join(dir, "open", "2026-01-01T08.ndjson"), [line("2026-01-01T08:00:00Z", 1), line("2026-01-01T08:01:00Z", 2), line("2026-01-01T08:05:00Z", 3)].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "open", "2026-01-01T09.ndjson"), line("2026-01-01T09:00:00Z", 4) + "\n");
  const w = new PartitionWriter(dir, cols, "hour", undefined, 60_000);
  await w.recover(Date.parse("2026-01-01T09:10:00Z"));
  const [p] = w.partitions();
  assert.equal(p.key, "2026-01-01T08");
  assert.equal(p.quality.expected, 60);
  assert.equal(p.quality.missing, 57);
  assert.equal(p.quality.maxGapSeconds, 240);
  assert.equal(w.openKey, "2026-01-01T09");
  assert.equal(w.openRows, 1);
  assert.equal(w.rowsTotal, 4, "totals count the recovered hour and the resumed open one");
  await w.append([[us("2026-01-01T09:01:00Z"), 5]]);
  w.stop();
  assert.equal(fs.readFileSync(path.join(dir, "open", "2026-01-01T09.ndjson"), "utf8").trim().split("\n").length, 2, "stop keeps the open hour for the next start");
});

test("partitions: concurrent appends and timer closes never split an hour or drop rows as late", async (t) => {
  const dir = tmp(t);
  const cols = [{ name: "time", type: "timestamp" as const }, { name: "id", type: "int64" as const }];
  const w = new PartitionWriter(dir, cols, "hour", "id");
  await w.recover(Date.parse("2026-01-01T09:00:00Z"));
  const rows = (from: number, n: number, hour: number) => Array.from({ length: n }, (_, i) => [us(`2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`) + BigInt((from + i) * 1000), BigInt(hour * 100000 + from + i)]);
  // Stream messages arrive without waiting for each other; the timer fires in between.
  const work = [w.append(rows(0, 500, 10)), w.tick(Date.parse("2026-01-01T10:30:00Z")), w.append(rows(500, 500, 10)), w.append(rows(0, 300, 11)), w.tick(Date.parse("2026-01-01T11:00:15Z")), w.append(rows(300, 300, 11)), w.tick(Date.parse("2026-01-01T11:00:16Z"))];
  await Promise.all(work);
  await w.tick(Date.parse("2026-01-01T13:00:00Z"));
  const parts = w.partitions();
  assert.deepEqual(parts.map((p) => p.key), ["2026-01-01T10", "2026-01-01T11"], "one file per hour");
  assert.deepEqual(parts.map((p) => p.rows), [1000, 600]);
  assert.ok(parts.every((p) => !p.quality.late));
  w.stop();
});

test("feed catalog: create checks channel, market and interval; status says when collection is off; delete removes data unless kept", (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, "Research-Workspaces", WS), { recursive: true });
  const cat = new FeedCatalog(() => root);
  const none = () => undefined;
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", channel: "trades", symbol: "BTCUSDT" } as any, none), /market/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", market: "um", channel: "trades", symbol: "BTCUSDT" } as any, none), /available for spot/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", market: "spot", channel: "markPrice", symbol: "BTCUSDT" } as any, none), /um, cm/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", market: "spot", channel: "klines", symbol: "BTCUSDT" } as any, none), /interval/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", market: "um", channel: "klines", interval: "1s", symbol: "BTCUSDT" } as any, none), /spot only/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "coinbase", channel: "depth10", symbol: "BTC-USD" } as any, none), /coinbase channels: trades, ticker/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "binance", market: "spot", channel: "bookTicker", symbol: "BTCUSDT", backfillFrom: "2026-01-01" } as any, none), /archive has no spot bookTicker.*collect from now/);
  assert.throws(() => cat.create(SID, { kind: "stream", exchange: "coinbase", channel: "trades", symbol: "BTC-USD", backfillFrom: "2026-01-01" } as any, none), /Coinbase has no archive/);
  assert.equal(cat.create(SID, { kind: "stream", exchange: "binance", market: "um", channel: "bookTicker", symbol: "BTCUSDT", backfillFrom: "2026-01-01" } as any, none).kind, "stream", "futures best bid/ask is archived");
  cat.delete(SID, "binance-um-bookticker-btcusdt", false);
  assert.throws(() => cat.create(SID, { kind: "script", command: "python3 x.py", every: "1d", timeColumn: "date", backfillFrom: "2026-01-01" } as any, none), /nothing is in production/);

  const a = cat.create(SID, { kind: "stream", exchange: "binance", market: "um", channel: "aggTrades", symbol: "btcusdt" } as any, none);
  assert.equal(a.id, "binance-um-aggtrades-btcusdt");
  assert.equal((a as any).symbol, "BTCUSDT");
  const b = cat.create(SID, { kind: "stream", exchange: "binance", market: "um", channel: "aggTrades", symbol: "BTCUSDT" } as any, none);
  assert.equal(b.id, "binance-um-aggtrades-btcusdt-2");
  const s = cat.create(SID, { kind: "script", command: "python3 bbg.py", every: "1d", timeColumn: "date", backfillFrom: "2026-01-01" } as any, () => WS);
  assert.equal((s as any).workspace, WS);

  let [first] = cat.list(SID, false);
  assert.equal(first.status.state, "stopped");
  assert.equal(first.status.detail, "Collection is switched off");
  cat.update(SID, a.id, { paused: true });
  first = cat.list(SID, true).find((f) => f.def.id === a.id)!;
  assert.equal(first.status.state, "paused");

  fs.mkdirSync(path.join(feedDir(root, b.id), "data"), { recursive: true });
  assert.equal(cat.delete(SID, b.id, true).keptData, true);
  assert.ok(fs.existsSync(feedDir(root, b.id)));
  cat.delete(SID, a.id, false);
  assert.ok(!fs.existsSync(feedDir(root, a.id)));
  assert.deepEqual(cat.list(SID, true).map((f) => f.def.id), [s.id]);
});

/** A websocket the test drives. */
function fakeSockets() {
  const opened: { url: string; ws: any; sent: string[] }[] = [];
  const socket = (url: string) => {
    const entry = { url, sent: [] as string[], ws: null as any };
    const ws: any = { send: (m: string) => entry.sent.push(m), close: () => ws.onclose?.() };
    entry.ws = ws;
    opened.push(entry);
    queueMicrotask(() => ws.onopen?.());
    return ws as WebSocket;
  };
  return { opened, socket };
}

test("feed service: picks up definitions, streams into partitions, pauses and stops feeds as definitions change", async (t) => {
  const root = tmp(t);
  const strategyRoot = path.join(root, "workspaces", "strategies", SID);
  const cat = new FeedCatalog(() => strategyRoot);
  const def = cat.create(SID, { kind: "stream", exchange: "coinbase", channel: "trades", symbol: "BTC-USD" } as any, () => undefined);
  const { opened, socket } = fakeSockets();
  const logs: string[] = [];
  // The exchange has no newer trades when the feed resumes.
  const quiet: WorkerContext["deps"] = () => ({ lookup: async () => [{ address: "151.101.1.42", family: 4 }], fetch: async () => new Response("[]") }) as any;
  const daemon = new FeedDaemon(root, { deps: quiet, socket, log: (m) => logs.push(m) }, 60_000);
  t.after(() => daemon.stop());
  await daemon.scan();
  assert.ok(await waitFor(() => opened.length === 2), "two connections per stream");
  assert.equal(opened[0].url, "wss://ws-feed.exchange.coinbase.com");
  assert.ok(await waitFor(() => opened[0].sent.length === 1));
  assert.deepEqual(JSON.parse(opened[0].sent[0]), { type: "subscribe", product_ids: ["BTC-USD"], channels: ["matches", "heartbeat"] });
  const now = new Date();
  for (let i = 0; i < 3; i++)
    opened[0].ws.onmessage({ data: JSON.stringify({ type: "match", trade_id: 100 + i, price: "65000.5", size: "0.01", side: "buy", time: new Date(now.getTime() - 1000 + i).toISOString().replace("Z", "123Z") }) });
  const statusFile = path.join(feedDir(strategyRoot, def.id), "status.json");
  const status = () => JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.ok(await waitFor(() => fs.existsSync(statusFile) && status().state === "live"));
  const svc = JSON.parse(fs.readFileSync(SERVICE_FILE(root), "utf8"));
  assert.equal(svc.feeds, 1);
  const { rows, columns } = await (async () => {
    await waitFor(() => fs.readdirSync(path.join(feedDir(strategyRoot, def.id), "open")).length > 0, 3000);
    return cat.rows(SID, def.id, 10);
  })();
  assert.deepEqual(columns, ["time", "trade_id", "price", "size", "maker_side"]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0][1], "102", "newest first");
  assert.equal(cat.list(SID, true)[0].status.state, "live");

  cat.update(SID, def.id, { paused: true });
  await daemon.scan();
  assert.equal(status().state, "paused");
  cat.update(SID, def.id, { paused: false });
  await daemon.scan();
  assert.ok(await waitFor(() => opened.length === 4), "resumed: reconnects");
  cat.delete(SID, def.id, true);
  await daemon.scan();
  assert.equal(JSON.parse(fs.readFileSync(SERVICE_FILE(root), "utf8")).feeds, 0);
  assert.deepEqual(logs, []);
});

test("feed service: the user's own script runs in the idea workspace on a schedule; its output becomes partitions; changed columns are refused", async (t) => {
  const root = tmp(t);
  const strategyRoot = path.join(root, "workspaces", "strategies", SID);
  const ws = path.join(strategyRoot, "Research-Workspaces", WS);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "pull.sh"), `printf 'value,date\\n1.5,2026-01-02\\n2.5,2026-01-03\\n' > "$PI_RESEARCH_OUT"; echo "since=$PI_RESEARCH_SINCE"`);
  const cat = new FeedCatalog(() => strategyRoot);
  const def = cat.create(SID, { kind: "script", command: "sh pull.sh", every: "1d", timeColumn: "date", backfillFrom: "2026-01-01" } as any, () => WS);
  const daemon = new FeedDaemon(root, { deps: noNetwork, socket: fakeSockets().socket, log: () => {} }, 60_000);
  t.after(() => daemon.stop());
  await daemon.scan();
  const dir = feedDir(strategyRoot, def.id);
  const status = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "status.json")) && status().state === "waiting"), JSON.stringify(fs.existsSync(path.join(dir, "status.json")) && status()));
  assert.match(fs.readFileSync(path.join(dir, "script.log"), "utf8"), /since=2026-01-01T00:00:00Z/);
  const parts = cat.partitions(SID, def.id);
  assert.deepEqual(parts.map((p) => p.key).sort(), ["2026-01-02", "2026-01-03"]);
  const rows = await read(path.join(dir, parts.find((p) => p.key === "2026-01-02")!.file));
  assert.deepEqual(Object.keys(rows[0]), ["date", "value"], "time column first");
  assert.equal(rows[0].value, 1.5);

  // Next run: new columns → refused, history untouched.
  await daemon.stop();
  fs.writeFileSync(path.join(ws, "pull.sh"), `printf 'date,value,extra\\n2026-01-04,3,x\\n' > "$PI_RESEARCH_OUT"`);
  const again = new FeedDaemon(root, { deps: noNetwork, socket: fakeSockets().socket, log: () => {} }, 60_000);
  t.after(() => again.stop());
  await again.scan();
  assert.ok(await waitFor(() => status().state === "error"));
  assert.match(status().detail, /columns changed/);
  assert.equal(cat.partitions(SID, def.id).length, 2);
  assert.ok(fs.existsSync(feedsDefDir(strategyRoot)));
});

test("collection switch (child mode): on starts the service and it heartbeats; off stops it; nothing is installed", async (t) => {
  const root = tmp(t);
  const agents = path.join(root, "LaunchAgents");
  const svc = new FeedService(root, undefined, "child", agents);
  t.after(() => svc.dispose());
  assert.equal(svc.status().running, false);
  await svc.enable();
  assert.ok(await waitFor(() => svc.status().running, 20000), fs.existsSync(svc.logFile) ? fs.readFileSync(svc.logFile, "utf8") : "no log");
  assert.equal(svc.status().enabled, true);
  await svc.disable();
  const st = svc.status();
  assert.equal(st.running, false);
  assert.equal(st.enabled, false);
  assert.ok(!fs.existsSync(agents), "no LaunchAgent written in child mode");
});
