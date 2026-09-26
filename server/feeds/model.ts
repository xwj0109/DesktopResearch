import path from "node:path";
import { z } from "zod";
import type { Column } from "../workbench/parquet.ts";
import { ARCHIVE_DATASETS } from "../workbench/binance-archive.ts";

/** Production feeds (the Data stage): datasets that keep updating while the
 * background service runs. A feed is a definition file; the service collects
 * into append-only partitions that are frozen (Parquet, read-only, hashed)
 * once their hour or day has passed, so later data never changes a past
 * result. Layout, per strategy:
 *   Data/production/feeds/<id>.json          definition (the app writes it)
 *   Data/production/<id>/data/YYYY/MM/DD/HH.parquet (hourly) or YYYY/MM/DD.parquet (daily)
 *   Data/production/<id>/open/<key>.ndjson   the partition being written
 *   Data/production/<id>/partitions.jsonl    closed partitions: rows, sha256, quality
 *   Data/production/<id>/status.json         the service's live status
 *   Data/production/<id>/state.json          the service's progress (backfill, last time) */

import { FEED_MARKETS } from "../../src/feed-contract.ts";
export { FEED_MARKETS };
export type FeedMarket = (typeof FEED_MARKETS)[number];
type Cell = string | number | bigint | boolean | null;
type Raw = Record<string, any>;
const ts = (ms: number | string) => BigInt(Math.round(Number(ms))) * 1000n; // ms → μs
const num = (v: any) => (v === undefined || v === null || v === "" ? null : Number(v));
const T = (name: string): Column => ({ name, type: "timestamp" });
const F = (name: string): Column => ({ name, type: "float64" });
const I = (name: string): Column => ({ name, type: "int64" });
const B = (name: string): Column => ({ name, type: "bool" });
const S = (name: string): Column => ({ name, type: "string" });
const big = (v: any) => (v === undefined || v === null || v === "" ? null : BigInt(String(v).split(".")[0]));
/** Archive times are ms (futures) or μs (spot since 2025). */
const archiveTs = (v: string) => (v.length >= 16 ? BigInt(v) : BigInt(v) * 1000n);

export interface Channel {
  label: string;
  exchange: "binance" | "coinbase";
  markets: readonly FeedMarket[] | null; // null: coinbase
  interval?: boolean;
  columns: Column[];
  /** Websocket URL for a market and symbol. */
  url(market: FeedMarket | null, symbol: string, interval?: string): string;
  /** Subscribe message sent after connecting (Coinbase). */
  subscribe?(symbol: string): unknown;
  /** Rows from one stream message (receive time in ms for streams without event times). */
  parse(m: Raw, recvMs: number): Cell[][];
  /** The Binance archive dataset holding the same data, and its row mapping (for backfill). */
  archive?: { dataset: string; row(r: Record<string, string>): Cell[] | null };
  /** An id column to count duplicates by. */
  idColumn?: string;
  /** The message's sequence number: strictly increasing on one connection, the same on both,
   * so the second connection's copies are dropped by it. None: rows are deduplicated by content. */
  seqOf?(m: Raw): bigint | null;
  /** Sequence numbers run without gaps (trade ids), so a skipped one is missing data to fetch. */
  consecutive?: boolean;
  /** The stored column holding the sequence (to resume after a restart). */
  seqColumn?: string;
}
const DEPTH = 10;
const depthColumns = [T("time"), I("update_id"), ...Array.from({ length: DEPTH }, (_, i) => [F(`bid_px_${i + 1}`), F(`bid_qty_${i + 1}`)]).flat(), ...Array.from({ length: DEPTH }, (_, i) => [F(`ask_px_${i + 1}`), F(`ask_qty_${i + 1}`)]).flat()];
const binanceUrl = (market: FeedMarket | null, stream: string, book = false) =>
  market === "spot"
    ? `wss://stream.binance.com:9443/ws/${stream}`
    : market === "um"
      ? // USDⓈ-M: market data (trades, bars, mark price, liquidations) on /market, the book on /ws.
        `wss://fstream.binance.com/${book ? "ws" : "market/ws"}/${stream}`
      : `wss://dstream.binance.com/ws/${stream}`;

export const CHANNELS: Record<string, Channel> = {
  "binance:trades": {
    label: "trades (every tick)",
    exchange: "binance",
    markets: ["spot"],
    columns: [T("time"), I("id"), F("price"), F("qty"), B("is_buyer_maker")],
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@trade`),
    parse: (m) => (m.e === "trade" ? [[ts(m.T), big(m.t), num(m.p), num(m.q), !!m.m]] : []),
    archive: { dataset: "trades", row: (r) => [archiveTs(r.time), big(r.id), num(r.price), num(r.qty), /true/i.test(r.is_buyer_maker)] },
    idColumn: "id",
    seqOf: (m) => (m.e === "trade" ? big(m.t) : null),
    consecutive: true,
    seqColumn: "id",
  },
  "binance:aggTrades": {
    label: "aggregated trades",
    exchange: "binance",
    markets: ["spot", "um", "cm"],
    columns: [T("time"), I("agg_trade_id"), F("price"), F("quantity"), I("first_trade_id"), I("last_trade_id"), B("is_buyer_maker")],
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@aggTrade`),
    parse: (m) => (m.e === "aggTrade" ? [[ts(m.T), big(m.a), num(m.p), num(m.q), big(m.f), big(m.l), !!m.m]] : []),
    archive: {
      dataset: "aggTrades",
      row: (r) => [archiveTs(r.transact_time), big(r.agg_trade_id), num(r.price), num(r.quantity), big(r.first_trade_id), big(r.last_trade_id), /true/i.test(r.is_buyer_maker)],
    },
    idColumn: "agg_trade_id",
    seqOf: (m) => (m.e === "aggTrade" ? big(m.a) : null),
    consecutive: true,
    seqColumn: "agg_trade_id",
  },
  "binance:klines": {
    label: "bars (closed)",
    exchange: "binance",
    markets: ["spot", "um", "cm"],
    interval: true,
    columns: [T("time"), F("open"), F("high"), F("low"), F("close"), F("volume"), F("quote_volume"), I("trades")],
    url: (m, s, iv) => binanceUrl(m, `${s.toLowerCase()}@kline_${iv}`),
    parse: (m) => {
      const k = m.k;
      return m.e === "kline" && k?.x ? [[ts(k.t), num(k.o), num(k.h), num(k.l), num(k.c), num(k.v), num(k.q), big(k.n)]] : [];
    },
    archive: { dataset: "klines", row: (r) => [archiveTs(r.open_time), num(r.open), num(r.high), num(r.low), num(r.close), num(r.volume), num(r.quote_volume), big(r.count)] },
    // Closed bars by open time (μs); a skipped bar is fetched from REST.
    seqOf: (m) => (m.e === "kline" && m.k?.x ? ts(m.k.t) : null),
    seqColumn: "time",
  },
  "binance:bookTicker": {
    label: "best bid/ask (every update)",
    exchange: "binance",
    markets: ["spot", "um", "cm"],
    columns: [T("time"), I("update_id"), F("bid"), F("bid_qty"), F("ask"), F("ask_qty")],
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@bookTicker`, true),
    parse: (m, recv) => (m.b !== undefined && m.a !== undefined ? [[ts(m.T ?? m.E ?? recv), big(m.u), num(m.b), num(m.B), num(m.a), num(m.A)]] : []),
    archive: { dataset: "bookTicker", row: (r) => [archiveTs(r.transaction_time), big(r.update_id), num(r.best_bid_price), num(r.best_bid_qty), num(r.best_ask_price), num(r.best_ask_qty)] },
    idColumn: "update_id",
    seqOf: (m) => (m.b !== undefined && m.a !== undefined ? big(m.u) : null),
    seqColumn: "update_id",
  },
  "binance:depth10": {
    label: "order book, top 10 levels",
    exchange: "binance",
    markets: ["spot", "um", "cm"],
    columns: depthColumns,
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@depth${DEPTH}@${m === "spot" ? "100ms" : "500ms"}`, true),
    parse: (m, recv) => {
      const bids: string[][] = m.bids ?? m.b,
        asks: string[][] = m.asks ?? m.a;
      if (!bids || !asks) return [];
      const lv = (side: string[][]) => Array.from({ length: DEPTH }, (_, i) => [num(side[i]?.[0]), num(side[i]?.[1])]).flat();
      return [[ts(m.T ?? m.E ?? recv), big(m.lastUpdateId ?? m.u), ...lv(bids), ...lv(asks)]];
    },
    seqOf: (m) => ((m.bids ?? m.b) && (m.asks ?? m.a) ? big(m.lastUpdateId ?? m.u) : null),
    seqColumn: "update_id",
  },
  "binance:markPrice": {
    label: "mark price, index, funding (1s)",
    exchange: "binance",
    markets: ["um", "cm"],
    columns: [T("time"), F("mark"), F("index"), F("funding_rate"), T("next_funding_time")],
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@markPrice@1s`),
    parse: (m) => (m.e === "markPriceUpdate" ? [[ts(m.E), num(m.p), num(m.i), num(m.r), m.T ? ts(m.T) : null]] : []),
    seqOf: (m) => (m.e === "markPriceUpdate" ? ts(m.E) : null),
    seqColumn: "time",
  },
  "binance:liquidations": {
    label: "liquidations",
    exchange: "binance",
    markets: ["um", "cm"],
    columns: [T("time"), S("side"), F("price"), F("avg_price"), F("qty"), S("status")],
    url: (m, s) => binanceUrl(m, `${s.toLowerCase()}@forceOrder`),
    parse: (m) => (m.e === "forceOrder" && m.o ? [[ts(m.o.T), String(m.o.S), num(m.o.p), num(m.o.ap), num(m.o.q), String(m.o.X)]] : []),
  },
  "coinbase:trades": {
    label: "trades (every match)",
    exchange: "coinbase",
    markets: null,
    columns: [T("time"), I("trade_id"), F("price"), F("size"), S("maker_side")],
    url: () => "wss://ws-feed.exchange.coinbase.com",
    // Heartbeats (every second, with the last trade id) reveal missed trades and silent connections.
    subscribe: (s) => ({ type: "subscribe", product_ids: [s], channels: ["matches", "heartbeat"] }),
    parse: (m) => (m.type === "match" ? [[BigInt(Date.parse(m.time)) * 1000n + BigInt(Number(/\.\d{3}(\d{3})/.exec(m.time)?.[1] ?? 0)), big(m.trade_id), num(m.price), num(m.size), String(m.side)]] : []),
    idColumn: "trade_id",
    seqOf: (m) => (m.type === "match" ? big(m.trade_id) : null),
    consecutive: true,
    seqColumn: "trade_id",
  },
  "coinbase:ticker": {
    label: "ticker (price, best bid/ask)",
    exchange: "coinbase",
    markets: null,
    columns: [T("time"), F("price"), F("bid"), F("bid_size"), F("ask"), F("ask_size"), F("volume_24h")],
    url: () => "wss://ws-feed.exchange.coinbase.com",
    subscribe: (s) => ({ type: "subscribe", product_ids: [s], channels: ["ticker", "heartbeat"] }),
    parse: (m) => (m.type === "ticker" && m.time ? [[BigInt(Date.parse(m.time)) * 1000n, num(m.price), num(m.best_bid), num(m.best_bid_size), num(m.best_ask), num(m.best_ask_size), num(m.volume_24h)]] : []),
    seqOf: (m) => (m.type === "ticker" && m.time ? big(m.sequence) : null),
  },
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = {
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().min(1).max(200),
  paused: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Research snapshot this feed continues in production (provenance). */
  seededFrom: z.string().max(120).optional(),
};
export const feedDefSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("stream"), channel: z.string().max(40), market: z.enum(FEED_MARKETS).optional(), symbol: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/), interval: z.string().max(4).optional(), backfillFrom: day.optional() }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("pull"),
      provider: z.enum(["binance-archive", "binance", "coinbase", "fred"]),
      market: z.enum(["spot", "um", "cm", "option"]).optional(),
      dataset: z.string().max(40).optional(),
      symbol: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
      interval: z.string().max(4).optional(),
      every: z.enum(["15m", "1h", "6h", "1d"]),
      backfillFrom: day,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("script"),
      /** A command the user owns, run in an idea workspace (e.g. "python3 bloomberg.py"). */
      command: z.string().min(1).max(1000),
      workspace: z.string().regex(/^[0-9a-f-]{36}$/),
      every: z.enum(["15m", "1h", "6h", "1d"]),
      timeColumn: z.string().min(1).max(80),
      backfillFrom: day,
    })
    .strict(),
]);
export type FeedDef = z.infer<typeof feedDefSchema>;

export interface FeedStatus {
  state: "starting" | "backfilling" | "live" | "waiting" | "paused" | "error" | "stopped";
  detail: string;
  heartbeatAt: string;
  lastEventAt?: string; // when the service received the latest row
  lastTime?: string; // the latest row's own time
  lagMs?: number;
  rowsToday: number;
  rowsTotal: number;
  openRows: number;
  /** The period being written (frozen when it ends): 2026-09-25T18 or 2026-09-25. */
  openPeriod?: string;
  partitions: number;
  reconnects: number;
  /** Connections delivering data (streams keep two). */
  connections?: { live: number; of: number };
  /** Rows fetched to close gaps today, and the latest stretch nothing covered. */
  filledToday?: number;
  lastOutage?: Outage;
  errors: { at: string; message: string }[];
  nextRunAt?: string;
}
/** A stretch the live feed did not cover by itself: filled from the exchange, or a hole. */
export interface Outage {
  from: string;
  to: string;
  cause: string;
  /** Rows known missing (from sequence numbers), fetched again, and still missing. */
  missing?: number;
  filled?: number;
  unfilled?: number;
  /** No sequence numbers (books, mark price): how much is lost is unknown. */
  hole?: boolean;
}
export interface PartitionRecord {
  key: string; // 2026-09-25T15 (hourly) or 2026-09-25 (daily)
  file: string; // data/2026/09/25/15.parquet
  rows: number;
  bytes: number;
  sha256: string;
  first: string | null;
  last: string | null;
  closedAt: string;
  quality: { duplicates: number; outOfOrder: number; maxGapSeconds: number | null; expected?: number; missing?: number; late?: number };
}

/** Whether Binance's archive keeps a stream's data, so past days can be filled. */
export function backfillable(market: string | undefined, channel: string) {
  const dataset = CHANNELS[`binance:${channel}`]?.archive?.dataset;
  return !!market && !!dataset && (ARCHIVE_DATASETS as Record<string, string[]>)[market]?.includes(dataset);
}
export const productionDir = (strategyRoot: string) => path.join(strategyRoot, "Data", "production");
export const feedDir = (strategyRoot: string, id: string) => path.join(productionDir(strategyRoot), id);
export const feedsDefDir = (strategyRoot: string) => path.join(productionDir(strategyRoot), "feeds");
/** A stream feed's channel (or undefined when unknown). */
export const channelOf = (def: FeedDef) => (def.kind === "stream" ? CHANNELS[`${def.market ? "binance" : "coinbase"}:${def.channel}`] : undefined);
export const grainOf = (def: FeedDef): "hour" | "day" => (def.kind === "stream" ? "hour" : "day");
export const EVERY_MS: Record<string, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "6h": 21_600_000, "1d": 86_400_000 };
export const INTERVAL_MS: Record<string, number> = { "1s": 1000, "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000 };
