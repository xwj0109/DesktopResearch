import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerFor, type WorkerContext } from "../server/feeds/workers.ts";
import { PartitionWriter } from "../server/feeds/writer.ts";
import { CHANNELS, feedDir, type FeedDef } from "../server/feeds/model.ts";

/** The live collector under failure: dropped and silent connections, skipped ids, restarts. */

const timing = { probeMs: 40, probeTimeoutMs: 120, rotateMs: 3_600_000, reconnectMs: 20 };
const waitFor = async (fn: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  return fn();
};
function setup(t: any, def: Partial<FeedDef> & { channel: string }, rest: (url: URL) => unknown = () => []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sockets: { url: string; ws: any; sent: any[]; answers: boolean }[] = [];
  const fetched: string[] = [];
  const ctx: WorkerContext = {
    deps: () =>
      ({
        lookup: async () => [{ address: "151.101.1.42", family: 4 }],
        fetch: async (href: string) => {
          fetched.push(href);
          return new Response(JSON.stringify(rest(new URL(href))), { status: 200 });
        },
      }) as any,
    socket: (url) => {
      const entry = { url, sent: [] as any[], ws: null as any, answers: true };
      const ws: any = {
        readyState: 1,
        send: (m: string) => {
          const msg = JSON.parse(m);
          entry.sent.push(msg);
          // Binance answers the liveness request (unless this connection is silently dead).
          if (msg.method === "LIST_SUBSCRIPTIONS" && entry.answers) queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ result: [], id: msg.id }) }));
        },
        close: () => queueMicrotask(() => ws.onclose?.()),
      };
      entry.ws = ws;
      sockets.push(entry);
      queueMicrotask(() => ws.onopen?.());
      return ws;
    },
    log: () => {},
    timing,
  };
  const full = { version: 1, id: "f", title: "f", paused: false, createdAt: new Date().toISOString(), kind: "stream", symbol: "BTCUSDT", ...def } as FeedDef;
  const worker = workerFor(root, full, ctx);
  t.after(() => worker.stop());
  const dir = feedDir(root, "f");
  const rows = () =>
    fs.existsSync(path.join(dir, "open"))
      ? fs.readdirSync(path.join(dir, "open")).sort().flatMap((f) => fs.readFileSync(path.join(dir, "open", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
      : [];
  const outages = () => (fs.existsSync(path.join(dir, "outages.jsonl")) ? fs.readFileSync(path.join(dir, "outages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const status = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  return { root, dir, worker, sockets, fetched, rows, outages, status, ctx };
}
const now = () => Date.now();
const trade = (id: number, t = now()) => JSON.stringify({ e: "trade", t: id, p: "100.5", q: "0.1", T: t, m: false });
const send = (s: { ws: any }, data: string) => s.ws.onmessage?.({ data });
const flushed = async (rows: () => any[], n: number) => waitFor(() => rows().length >= n, 3000);

test("two connections: every trade is kept once, and one connection dropping leaves no gap", async (t) => {
  const f = setup(t, { channel: "trades", market: "spot" });
  await f.worker.start();
  assert.equal(f.sockets.length, 2, "two connections to the same stream");
  for (const id of [1, 2, 3]) for (const s of f.sockets) send(s, trade(id));
  send(f.sockets[0], trade(4));
  f.sockets[0].ws.close(); // connection 1 drops; connection 2 carries on
  send(f.sockets[1], trade(4));
  send(f.sockets[1], trade(5));
  assert.ok(await flushed(f.rows, 5));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(f.rows().map((r) => r[1]), ["1", "2", "3", "4", "5"], "once each, in order");
  assert.equal(f.fetched.length, 0, "nothing needed fetching");
  assert.deepEqual(f.outages(), [], "no outage: the other connection covered it");
  assert.equal(f.sockets.length, 3, "the dropped connection was replaced once");
  assert.equal(f.status().connections.live, 2, "and the replacement is live (it answered the probe) on a quiet market");
});

test("a skipped trade id is fetched by id before newer trades are written", async (t) => {
  const f = setup(t, { channel: "trades", market: "spot" }, (url) => {
    assert.equal(url.hostname, "api.binance.com");
    assert.equal(url.pathname, "/api/v3/historicalTrades");
    const from = Number(url.searchParams.get("fromId"));
    return [from, from + 1, from + 2].map((id) => ({ id, price: "100.1", qty: "0.2", time: now() - 500, isBuyerMaker: true }));
  });
  await f.worker.start();
  send(f.sockets[0], trade(1));
  send(f.sockets[0], trade(2));
  send(f.sockets[0], trade(6)); // 3, 4 and 5 never arrived on either connection
  send(f.sockets[1], trade(4)); // a late copy of a filled id is not written twice
  send(f.sockets[0], trade(7));
  assert.ok(await flushed(f.rows, 7));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(f.rows().map((r) => r[1]), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.match(f.fetched[0], /fromId=3/);
  const [o] = f.outages();
  assert.deepEqual([o.missing, o.filled, o.unfilled, o.cause], [3, 3, 0, "missed on the connection"]);
});

test("while a gap is being fetched, live trades keep arriving: each is written once, in order, fetched once", async (t) => {
  const f = setup(t, { channel: "trades", market: "spot" }, (url) => {
    const from = Number(url.searchParams.get("fromId"));
    return [from, from + 1, from + 2].map((id) => ({ id, price: "1", qty: "1", time: now() - 500, isBuyerMaker: false }));
  });
  const slow = f.worker as any;
  const fill = slow.fillIds.bind(slow);
  slow.fillIds = async (...a: any[]) => (await new Promise((r) => setTimeout(r, 150)), fill(...a)); // the REST round trip
  await f.worker.start();
  for (const id of [1, 2, 6]) send(f.sockets[0], trade(id));
  for (const id of [7, 8, 9, 10]) for (const s of f.sockets) send(s, trade(id));
  await new Promise((r) => setTimeout(r, 400)); // the fill has finished
  for (const id of [11, 12]) for (const s of f.sockets) send(s, trade(id));
  assert.ok(await flushed(f.rows, 12));
  await new Promise((r) => setTimeout(r, 1300));
  assert.deepEqual(f.rows().map((r) => r[1]), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.equal(f.fetched.length, 1, "no refetch of trades that already arrived");
  assert.equal(f.outages().length, 1);
});

test("a connection that stops answering is replaced; the feed stays live on the other", async (t) => {
  const f = setup(t, { channel: "aggTrades", market: "um" });
  await f.worker.start();
  const agg = (a: number) => JSON.stringify({ e: "aggTrade", a, p: "1", q: "1", f: a, l: a, T: now(), m: true });
  for (const s of f.sockets) send(s, agg(1));
  f.sockets[0].answers = false; // half-open: no close, no data, no answers
  assert.ok(await waitFor(() => f.sockets.length === 3, 3000), "silent connection replaced");
  assert.ok(f.sockets[0].sent.some((m) => m.method === "LIST_SUBSCRIPTIONS"), "it was probed");
  assert.ok(await waitFor(() => f.status().connections?.live === 2, 3000));
  assert.match(f.status().detail, /2 connections/);
});

test("after a restart, the trades since the last row on disk are fetched before going live", async (t) => {
  const f = setup(t, { channel: "trades", market: "spot" }, (url) => {
    const from = Number(url.searchParams.get("fromId"));
    return from <= 12 ? [from, from + 1].filter((id) => id <= 12).map((id) => ({ id, price: "1", qty: "1", time: now() - 1000, isBuyerMaker: false })) : [];
  });
  // Rows 9 and 10 were written before the service stopped.
  const w = new PartitionWriter(f.dir, CHANNELS["binance:trades"].columns, "hour", "id");
  await w.recover();
  await w.append([9, 10].map((id) => [BigInt(now() - 60_000) * 1000n, BigInt(id), 1, 1, false]));
  w.stop();
  await f.worker.start();
  assert.match(f.fetched[0], /fromId=11/);
  assert.ok(await flushed(f.rows, 4));
  assert.deepEqual(f.rows().map((r) => r[1]), ["9", "10", "11", "12"]);
  assert.equal(f.outages()[0].cause, "service was not running");
  assert.equal(f.outages()[0].filled, 2);
  assert.equal(f.sockets.length, 2, "connected only after catching up");
});

test("data without ids (best bid/ask): a stretch with both connections down is recorded as a hole", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  await f.worker.start();
  const book = (u: number) => JSON.stringify({ u, s: "BTCUSDT", b: "1", B: "1", a: "2", A: "1" });
  for (const s of f.sockets) send(s, book(10));
  send(f.sockets[1], book(10)); // duplicate dropped by update id
  f.sockets[0].ws.close();
  f.sockets[1].ws.close();
  assert.ok(await waitFor(() => f.sockets.length === 4));
  send(f.sockets[2], book(20));
  assert.ok(await flushed(f.rows, 2));
  const [o] = f.outages();
  assert.equal(o.hole, true);
  assert.match(o.cause, /both connections down/);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(f.rows().map((r) => r[1]), ["10", "20"]);
});

test("Coinbase: a heartbeat naming a newer trade id than we have fetches the missed trades", async (t) => {
  const f = setup(t, { channel: "trades", symbol: "BTC-USD" }, (url) => {
    assert.equal(url.pathname, "/products/BTC-USD/trades");
    const after = Number(url.searchParams.get("after"));
    return [after - 1, after - 2, after - 3].map((id) => ({ trade_id: id, side: "buy", size: "0.1", price: "65000", time: new Date(now() - 500).toISOString() }));
  });
  await f.worker.start();
  const match = (id: number) => JSON.stringify({ type: "match", trade_id: id, price: "65000", size: "0.1", side: "sell", time: new Date().toISOString() });
  send(f.sockets[0], match(5));
  send(f.sockets[0], JSON.stringify({ type: "heartbeat", last_trade_id: 8, product_id: "BTC-USD", time: new Date().toISOString() }));
  assert.ok(await flushed(f.rows, 4));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(f.rows().map((r) => r[1]), ["5", "6", "7", "8"]);
  assert.match(f.fetched[0], /after=9/);
});

test("a slow handshake is not probed before open; a hung handshake is retried", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  const socket = f.ctx.socket;
  f.ctx.socket = (url) => {
    const ws = socket(url);
    Object.defineProperty(ws, "readyState", { value: 0 });
    Object.defineProperty(ws, "onopen", { get: () => null, set: () => {} });
    return ws;
  };
  const worker = f.worker as any;
  await f.worker.start();
  for (const c of worker.conns) {
    c.live = false;
    c.probeSentAt = null;
    c.openedAt = Date.now() - timing.probeMs * 2;
  }
  for (const s of f.sockets) s.sent.length = 0;
  worker.watch();
  assert.ok(f.sockets.every((s) => s.sent.length === 0), "no probe during handshake");
  assert.equal(f.status().reconnects, 0);
  for (const c of worker.conns) c.openedAt = Date.now() - timing.probeTimeoutMs * 4;
  worker.watch();
  assert.equal(f.status().reconnects, 2);
  assert.equal(f.status().state, "waiting");
});

test("socket construction failure and error without close both retry and recover", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  const socket = f.ctx.socket;
  let attempts = 0;
  f.ctx.socket = (url) => {
    if (attempts++ === 0) throw new Error("network unavailable");
    return socket(url);
  };
  await f.worker.start();
  assert.ok(await waitFor(() => f.status().connections?.live === 2));
  const failed = f.sockets[0];
  failed.ws.onerror?.({}); // no close event follows
  assert.equal(f.status().connections.live, 1);
  assert.ok(await waitFor(() => f.status().connections?.live === 2));
  assert.equal(f.status().reconnects, 2);
  assert.match(f.status().errors.at(-1).message, /network unavailable/);
});

test("probe replies must match the outstanding request; failed handshakes retain backoff", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  (f.worker as any).timing = { ...timing, probeMs: 60_000, probeTimeoutMs: 60_000 };
  const socket = f.ctx.socket;
  f.ctx.socket = (url) => {
    const ws = socket(url);
    f.sockets.at(-1)!.answers = false;
    return ws;
  };
  await f.worker.start();
  const worker = f.worker as any;
  const c = worker.conns[0];
  send(f.sockets[0], JSON.stringify({ result: [], id: c.probeId + 100 }));
  send(f.sockets[0], JSON.stringify({ result: null, id: c.probeId }));
  send(f.sockets[0], 'null');
  assert.equal(c.live, false);
  assert.notEqual(c.probeSentAt, null);
  f.sockets[0].ws.onclose({ code: 1006, reason: "" });
  assert.ok(await waitFor(() => f.sockets.length >= 3));
  assert.equal(c.backoff, timing.reconnectMs * 2, "open alone does not reset retry delay");
  f.sockets[2].ws.onclose({ code: 1006, reason: "" });
  assert.equal(c.backoff, timing.reconnectMs * 4);
  assert.ok(await waitFor(() => c.ws !== null && c.probeSentAt !== null));
  send({ ws: c.ws }, JSON.stringify({ result: [], id: c.probeId }));
  assert.equal(c.live, true);
  assert.equal(c.backoff, timing.reconnectMs);
  assert.match(f.status().errors[0].message, /code 1006/);
});

test("a second outage before the first new row still shows reconnecting, with no stale lag", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  await f.worker.start();
  for (const s of f.sockets.slice()) s.ws.onclose({ code: 1006 });
  assert.ok(await waitFor(() => f.status().connections?.live === 2));
  assert.equal(f.status().state, "live", "probes restore coverage on a quiet stream");
  for (const s of f.sockets.slice(2)) s.ws.onclose({ code: 1006 });
  assert.equal(f.status().connections.live, 0);
  assert.equal(f.status().state, "waiting", "downSince already existed from the first outage");
  assert.equal(f.status().lagMs, undefined);
});

test("exchange error responses replace the affected connection", async (t) => {
  const f = setup(t, { channel: "bookTicker", market: "spot" });
  await f.worker.start();
  assert.ok(await waitFor(() => f.status().connections?.live === 2));
  send(f.sockets[0], JSON.stringify({ code: 2, msg: "Invalid request", id: 1 }));
  assert.equal(f.status().connections.live, 1);
  assert.match(f.status().errors[0].message, /Invalid request/);
  assert.ok(await waitFor(() => f.status().connections?.live === 2));
});
