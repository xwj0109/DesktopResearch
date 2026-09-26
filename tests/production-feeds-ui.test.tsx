import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { ResearchProvider } from "../src/workbench/research";
import { FeedQualityPane, FeedsPane, liveFeedFor, periodEnd, selectFeed } from "../src/workbench/panes/Feeds";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, setTimeout };
(globalThis as any).document = { activeElement: null, getElementById() { return null; } };

const day = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const text = (node: any): string => (typeof node === "string" ? node : (node.children ?? []).map(text).join(""));
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

test("a research snapshot maps to the live feed that continues it", () => {
  const bars = liveFeedFor({ name: "btc-1m", title: "BTC 1m", source: { kind: "binance-archive", market: "um", dataset: "klines", symbol: "BTCUSDT", interval: "1m" }, last: `${day(3)}T23:59:00Z` });
  assert.deepEqual(bars, { kind: "stream", exchange: "binance", market: "um", channel: "klines", symbol: "BTCUSDT", interval: "1m", backfillFrom: day(2), seededFrom: "btc-1m" });
  const ticks = liveFeedFor({ name: "t", title: "t", source: { kind: "binance-archive", market: "um", dataset: "trades", symbol: "ETHUSDT" }, last: "2020-01-01T00:00:00Z" });
  assert.equal(ticks!.channel, "aggTrades", "futures trades are streamed as aggregated trades");
  assert.equal(ticks!.backfillFrom, undefined, "no multi-year backfill from an old snapshot");
  assert.equal(liveFeedFor({ name: "m", title: "m", source: { kind: "binance-archive", market: "um", dataset: "metrics", symbol: "BTCUSDT" } })!.kind, "pull");
  assert.equal(liveFeedFor({ name: "f", title: "f", source: { kind: "fred", symbol: "DGS10" }, query: { start: "2020-01-01", end: "2026-01-01" } })!.backfillFrom, "2020-01-01");
  assert.equal(liveFeedFor({ name: "x", title: "x", source: { kind: "file" } }), null);
});

test("an open hour is frozen at the end of the hour; an open day at midnight UTC", () => {
  assert.equal(new Date(periodEnd("2026-09-25T18")).toISOString(), "2026-09-25T19:00:00.000Z");
  assert.equal(new Date(periodEnd("2026-09-25")).toISOString(), "2026-09-26T00:00:00.000Z");
});

function harness() {
  const writes: [string, any][] = [];
  const feed = {
    def: { id: "binance-um-klines-1m-btcusdt", title: "Binance um klines 1m BTCUSDT", kind: "stream", channel: "klines", market: "um", symbol: "BTCUSDT", interval: "1m", paused: false, createdAt: "2026-09-25T10:00:00Z", seededFrom: "btc-1m" },
    status: { state: "live", detail: "Live from fstream.binance.com", heartbeatAt: new Date().toISOString(), lagMs: 180, rowsToday: 960, rowsTotal: 4200, openRows: 20, openPeriod: "2026-09-25T12", partitions: 3, reconnects: 0, errors: [] },
    partitions: [],
  };
  let service = { mode: "launchd", enabled: false, running: false, heartbeatAt: null, pid: null, feeds: 0, log: "" };
  let feeds: any[] = [];
  const client = {
    read: async (path: string) => {
      if (path === "/native/feeds") return { service, feeds };
      if (path === "/native/data/snapshots")
        return { snapshots: [{ name: "btc-1m", title: "BTC USDⓈ-M 1m bars", source: { kind: "binance-archive", market: "um", dataset: "klines", symbol: "BTCUSDT", interval: "1m" }, last: `${day(2)}T23:59:00Z` }, { name: "other", title: "unrelated", source: { kind: "fred", symbol: "X" } }] };
      if (path.startsWith("/native/feeds/partitions"))
        return {
          partitions: [
            { key: "2026-09-25T11", file: "data/2026/09/25/11.parquet", rows: 58, bytes: 4096, sha256: "b".repeat(64), first: null, last: null, closedAt: "", quality: { duplicates: 0, outOfOrder: 0, maxGapSeconds: 180, expected: 60, missing: 2 } },
            { key: "2026-09-25T10", file: "data/2026/09/25/10.parquet", rows: 60, bytes: 4096, sha256: "a".repeat(64), first: null, last: null, closedAt: "", quality: { duplicates: 0, outOfOrder: 0, maxGapSeconds: 60, expected: 60, missing: 0 } },
          ],
          outages: [
            { from: "2026-09-25T11:20:00.000Z", to: "2026-09-25T11:20:40.000Z", cause: "both connections down (disconnected)", missing: 812, filled: 812, unfilled: 0 },
            { from: "2026-09-25T09:00:00.000Z", to: "2026-09-25T09:02:00.000Z", cause: "service was not running", missing: 5000, filled: 4000, unfilled: 1000 },
          ],
        };
      throw new Error(`unexpected read ${path}`);
    },
    write: async (path: string, body: any) => {
      writes.push([path, body]);
      if (path === "/native/feeds/service") service = { ...service, enabled: body.on, running: body.on, heartbeatAt: new Date().toISOString() as any, feeds: feeds.length };
      if (path === "/native/feeds/create") feeds = [feed];
      if (path === "/native/feeds/delete") feeds = [];
      return path === "/native/feeds/create" ? feed.def : {};
    },
  };
  const view = { production: { current: { idea: "r:1", title: "Funding carry", version: 2, checkpoint: "c".repeat(40), checkpointMessage: "final", snapshots: [{ name: "btc-1m", sha256: "d".repeat(64) }], committedAt: "2026-09-25T09:00:00Z" }, history: [] } };
  const scope: any = { client, portfolio: false, stage: "data", view, loadError: "", refresh: async () => {} };
  return { writes, scope, feed };
}

test("Feeds: the collection switch, collecting the research data live, and deleting with a confirmation", async () => {
  selectFeed(null);
  const h = harness();
  let r: any;
  await act(async () => void (r = create(<ResearchProvider value={h.scope}><FeedsPane /></ResearchProvider>)));
  await flush();
  const sw = r.root.find((n: any) => n.props.role === "switch");
  assert.equal(sw.props["aria-checked"], false);
  assert.match(text(r.toJSON()), /Collection is off/);
  assert.match(text(r.toJSON()), /installs a background login item/);
  // The production idea's snapshot, with the live feed that continues it.
  assert.match(text(r.toJSON()), /BTC USDⓈ-M 1m bars/);
  assert.doesNotMatch(text(r.toJSON()), /unrelated/, "only snapshots sent to production");
  const collect = r.root.find((n: any) => n.type === "button" && text(n) === "Collect live");
  await act(async () => void collect.props.onClick());
  await flush();
  assert.deepEqual(h.writes[0], ["/native/feeds/create", { kind: "stream", exchange: "binance", market: "um", channel: "klines", symbol: "BTCUSDT", interval: "1m", backfillFrom: day(1), seededFrom: "btc-1m" }]);
  assert.match(text(r.toJSON()), /collected live by “Binance um klines 1m BTCUSDT”/);
  assert.match(text(r.toJSON()), /lag 180 ms/);
  assert.match(text(r.toJSON()), /960 rows today/);

  await act(async () => void r.root.find((n: any) => n.props.role === "switch").props.onClick());
  await flush();
  assert.deepEqual(h.writes[1], ["/native/feeds/service", { on: true }]);
  assert.equal(r.root.find((n: any) => n.props.role === "switch").props["aria-checked"], true);
  assert.match(text(r.toJSON()), /keep collecting when the app is closed/);

  const del = r.root.find((n: any) => n.props["aria-label"] === "Delete Binance um klines 1m BTCUSDT");
  await act(async () => void del.props.onClick({ stopPropagation() {} }));
  assert.match(text(r.toJSON()), /keep its collected data \(4,200 rows\)/);
  assert.equal(h.writes.length, 2, "nothing deleted before confirming");
  const confirm = r.root.find((n: any) => n.type === "button" && text(n) === "Delete");
  await act(async () => void confirm.props.onClick());
  await flush();
  assert.deepEqual(h.writes[2], ["/native/feeds/delete", { id: "binance-um-klines-1m-btcusdt", keepData: false }]);
  r.unmount();
});

test("Quality: frozen partitions with their gaps and missing bars; issues are flagged", async () => {
  const h = harness();
  await h.scope.client.write("/native/feeds/create", {});
  let r: any;
  await act(async () => void (r = create(<ResearchProvider value={h.scope}><FeedQualityPane /></ResearchProvider>)));
  await flush();
  await flush();
  const tables = r.root.findAll((n: any) => n.type === "table");
  assert.equal(tables.length, 2, "outages, then partitions");
  const rows = tables[1].findAll((n: any) => n.type === "tr");
  assert.equal(rows.length, 3);
  assert.match(text(r.toJSON()), /2 frozen partitions · 1 with issues/);
  assert.match(text(r.toJSON()), /Open hour 2026-09-25 12:00 UTC · 20 rows so far · frozen at .* your time/);
  assert.equal(rows[1].props.className, "flag");
  assert.match(text(rows[1]), /2026-09-25 11:00583 min/);
  assert.match(text(rows[1]), /bbbbbbbbbb/);
  // Outages: what the connections missed, what was refetched, what is still missing.
  const outageRows = tables[0].findAll((n: any) => n.type === "tr");
  assert.equal(outageRows.length, 3);
  assert.equal(outageRows[2].props.className, "flag", "the one that left data missing is flagged");
  assert.match(text(r.toJSON()), /outages 2/);
  assert.match(text(r.toJSON()), /1 left data missing/);
  assert.match(text(r.toJSON()), /service was not running5,0004,0001,000/);
  assert.match(text(r.toJSON()), /both connections down \(disconnected\)8128120/);
  r.unmount();
});

test("recovered errors are collapsed history; a current outage is labelled reconnecting", async () => {
  const h = harness();
  const s: any = h.feed.status;
  s.errors = [{ at: new Date(Date.now() - 29 * 60_000).toISOString(), message: "Connection problem with stream.binance.com:9443" }];
  s.lastEventAt = new Date().toISOString();
  s.connections = { live: 2, of: 2 };
  await h.scope.client.write("/native/feeds/create", {});
  let r: any;
  await act(async () => void (r = create(<ResearchProvider value={h.scope}><FeedsPane /></ResearchProvider>)));
  await flush();
  const history = r.root.findByType("details");
  assert.equal(history.props.open, undefined, "history is collapsed by default");
  assert.match(text(history), /Recent issues · last 29 min ago/);
  assert.match(text(history), /Connection problem/);
  assert.equal(r.root.findAll((n: any) => typeof n.props.className === "string" && n.props.className.split(" ").includes("err")).length, 0, "no red current failure after recovery");
  assert.match(text(r.toJSON()), /last received \d+s ago/);
  assert.match(text(r.toJSON()), /2 of 2 connections/);
  await act(async () => r.unmount());

  s.state = "waiting";
  s.detail = "Reconnecting (both connections down)";
  s.connections = { live: 0, of: 2 };
  await act(async () => void (r = create(<ResearchProvider value={h.scope}><FeedsPane /></ResearchProvider>)));
  await flush();
  const tag = r.root.find((n: any) => n.props["data-state"] === "waiting");
  assert.equal(text(tag), "reconnecting");
  assert.match(tag.props.className, /warn/);
  assert.doesNotMatch(text(r.toJSON()), /lag 180 ms/);
  assert.equal(r.root.findAll((n: any) => n.props.className === "err" && text(n).startsWith("Reconnecting")).length, 1);
  await act(async () => r.unmount());

  h.feed.def.kind = "pull";
  s.nextRunAt = new Date(Date.now() + 60_000).toISOString();
  s.detail = "Up to date";
  await act(async () => void (r = create(<ResearchProvider value={h.scope}><FeedsPane /></ResearchProvider>)));
  await flush();
  assert.equal(text(r.root.find((n: any) => n.props["data-state"] === "waiting")), "scheduled");
  await act(async () => r.unmount());
});
