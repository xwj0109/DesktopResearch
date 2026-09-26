import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { isPublicAddress, type PaperDeps } from "../../desktop/papers.ts";

/** Binance's public data archive (data.binance.vision): daily (and some
 * monthly) zip files of tick trades, aggregated trades, bars, best bid/ask,
 * order-book depth snapshots, open-interest metrics, funding rates and option
 * summaries, each with a published SHA-256. Listing uses the bucket's S3 API.
 * Every download is verified against its checksum before it is read. */

export const ARCHIVE_HOSTS = new Set(["data.binance.vision", "s3-ap-northeast-1.amazonaws.com"]);
const LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const FILES = "https://data.binance.vision";

export const MARKETS = ["spot", "um", "cm", "option"] as const;
export type Market = (typeof MARKETS)[number];
export const KLINE_INTERVALS = ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"] as const;
const KLINE_DATASETS = ["klines", "markPriceKlines", "indexPriceKlines", "premiumIndexKlines"];
/** What each market publishes (see the archive's own listing). */
export const ARCHIVE_DATASETS: Record<Market, string[]> = {
  spot: ["trades", "aggTrades", "klines"],
  um: ["trades", "aggTrades", "klines", "markPriceKlines", "indexPriceKlines", "premiumIndexKlines", "bookTicker", "bookDepth", "metrics", "fundingRate"],
  cm: ["trades", "aggTrades", "klines", "markPriceKlines", "indexPriceKlines", "premiumIndexKlines", "bookTicker", "bookDepth", "metrics", "fundingRate", "liquidationSnapshot"],
  option: ["BVOLIndex", "EOHSummary"],
};
export const MARKET_LABELS: Record<Market, string> = { spot: "Spot", um: "USDⓈ-M futures", cm: "COIN-M futures", option: "Options" };
const MONTHLY_ONLY = new Set(["fundingRate"]);
/** Column names for files published without a header (spot). */
const KLINE_COLUMNS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"];
const HEADERLESS: Record<string, string[]> = {
  "spot:trades": ["id", "price", "qty", "quote_qty", "time", "is_buyer_maker", "is_best_match"],
  "spot:aggTrades": ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker", "is_best_match"],
  "um:trades": ["id", "price", "qty", "quote_qty", "time", "is_buyer_maker"],
  "cm:trades": ["id", "price", "qty", "base_qty", "time", "is_buyer_maker"],
  "um:aggTrades": ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker"],
  "cm:aggTrades": ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker"],
};
export function headerlessColumns(market: Market, dataset: string, width: number): string[] {
  const names = KLINE_DATASETS.includes(dataset) ? KLINE_COLUMNS : HEADERLESS[`${market}:${dataset}`];
  return names && names.length === width ? names : Array.from({ length: width }, (_, i) => `c${i}`);
}

export interface ArchiveQuery {
  market: Market;
  dataset: string;
  symbol: string;
  interval?: string;
}
export interface ArchiveFile {
  date: string; // YYYY-MM-DD, or YYYY-MM for monthly files
  key: string;
  bytes: number;
}
export function validateArchive(q: ArchiveQuery) {
  if (!MARKETS.includes(q.market)) throw new Error(`Markets: ${MARKETS.join(", ")}`);
  if (!ARCHIVE_DATASETS[q.market].includes(q.dataset)) throw new Error(`${MARKET_LABELS[q.market]} publishes: ${ARCHIVE_DATASETS[q.market].join(", ")}`);
  if (!/^[A-Z0-9_]{3,30}$/.test(q.symbol)) throw new Error("Archive symbols look like BTCUSDT, BTCUSD_PERP or BTCBVOLUSDT");
  if (KLINE_DATASETS.includes(q.dataset)) {
    if (!q.interval || !(KLINE_INTERVALS as readonly string[]).includes(q.interval)) throw new Error(`Give an interval: ${KLINE_INTERVALS.join(", ")}`);
    if (q.interval === "1s" && q.market !== "spot") throw new Error("1-second bars are published for spot only");
  }
}
/** data/<market>/<daily|monthly>/<dataset> (the folder whose children are symbols). */
const datasetFolder = (q: { market: Market; dataset: string }) => {
  const base = q.market === "spot" ? "data/spot" : q.market === "option" ? "data/option" : `data/futures/${q.market}`;
  return `${base}/${MONTHLY_ONLY.has(q.dataset) ? "monthly" : "daily"}/${q.dataset}`;
};
const folder = (q: ArchiveQuery) => `${datasetFolder(q)}/${q.symbol}${KLINE_DATASETS.includes(q.dataset) ? `/${q.interval}` : ""}`;
const tag = (q: ArchiveQuery) => (KLINE_DATASETS.includes(q.dataset) ? q.interval! : q.dataset);

export class Archive {
  constructor(private deps: () => PaperDeps) {}

  private async checked(href: string) {
    const url = new URL(href);
    if (url.protocol !== "https:" || !ARCHIVE_HOSTS.has(url.hostname)) throw new Error(`${url.hostname} is not an allowed data host`);
    const deps = this.deps();
    const addresses = await deps.lookup(url.hostname);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new Error(`${url.hostname} is not a public internet address; refused`);
    return { url, deps };
  }
  private async get(href: string, signal?: AbortSignal) {
    const { url, deps } = await this.checked(href);
    for (let attempt = 0; ; attempt++) {
      const res = await deps.fetch(url.href, { redirect: "manual", signal, credentials: "omit", headers: { "user-agent": "PiResearch/0.1 (research data; user-initiated)" } } as RequestInit);
      if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, Math.min(60000, (Number(res.headers.get("retry-after")) || 2 * (attempt + 1)) * 1000)));
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new Error(`${url.hostname} redirected; refused`);
      return res;
    }
  }
  /** The archive's files for a query within [start, end] (dates YYYY-MM-DD), in date order. */
  async list(q: ArchiveQuery, start: string, end: string, signal?: AbortSignal): Promise<ArchiveFile[]> {
    validateArchive(q);
    const dir = folder(q),
      prefix = `${dir}/${q.symbol}-${tag(q)}-`;
    const monthly = MONTHLY_ONLY.has(q.dataset);
    const from = monthly ? start.slice(0, 7) : start,
      to = monthly ? end.slice(0, 7) : end;
    const out: ArchiveFile[] = [];
    // S3 lists keys after `marker` in order: start just before the first wanted date.
    let marker = `${prefix}${from}`.replace(/.$/, (c) => String.fromCharCode(c.charCodeAt(0) - 1));
    for (let page = 0; page < 200; page++) {
      const res = await this.get(`${LIST}?prefix=${encodeURIComponent(prefix)}&marker=${encodeURIComponent(marker)}`, signal);
      if (!res.ok) throw new Error(`Archive listing answered ${res.status}`);
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>(?:(?!<\/Contents>)[\s\S])*?<Size>(\d+)<\/Size>/g)].map((m) => ({ key: m[1], bytes: Number(m[2]) }));
      let past = false;
      for (const k of keys) {
        marker = k.key;
        if (!k.key.endsWith(".zip")) continue;
        const date = k.key.slice(prefix.length, -4);
        if (date > to) {
          past = true;
          break;
        }
        if (date >= from) out.push({ date, key: k.key, bytes: k.bytes });
      }
      if (past || !/<IsTruncated>true<\/IsTruncated>/.test(xml) || !keys.length) break;
    }
    return out;
  }
  /** Every symbol the archive holds for a market and dataset (delisted ones included). */
  async symbols(market: Market, dataset: string): Promise<string[]> {
    if (!ARCHIVE_DATASETS[market]?.includes(dataset)) throw new Error(`${MARKET_LABELS[market] ?? market} publishes: ${ARCHIVE_DATASETS[market]?.join(", ")}`);
    const prefix = `${datasetFolder({ market, dataset })}/`;
    const out: string[] = [];
    let marker = "";
    for (let page = 0; page < 50; page++) {
      const res = await this.get(`${LIST}?prefix=${encodeURIComponent(prefix)}&delimiter=/${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`);
      if (!res.ok) throw new Error(`Archive listing answered ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) {
        const sym = m[1].slice(prefix.length).replace(/\/$/, "");
        if (sym) out.push(sym);
      }
      const next = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
      marker = next;
    }
    return out;
  }
  /** Download one archive file to `file`, verifying its published SHA-256. */
  async download(f: ArchiveFile, file: string, signal: AbortSignal, onBytes: (n: number) => void) {
    const res = await this.get(`${FILES}/${f.key}`, signal);
    if (!res.ok || !res.body) throw new Error(`${f.key} answered ${res.status}`);
    const hash = createHash("sha256");
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        onBytes(value.byteLength);
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    const digest = hash.digest("hex");
    const sum = await this.get(`${FILES}/${f.key}.CHECKSUM`, signal);
    if (!sum.ok) throw new Error(`No published checksum for ${f.key}`);
    const expected = (await sum.text()).trim().split(/\s+/)[0];
    if (expected !== digest) throw new Error(`Checksum mismatch for ${f.key}; the download was discarded`);
    return digest;
  }
}

/** The single CSV inside a Binance archive zip, as a stream (central directory
 * → local header → deflate or stored data). */
export function zipEntry(file: string): Readable {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("Not a zip archive");
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(46);
    fs.readSync(fd, cd, 0, 46, cdOffset);
    if (cd.readUInt32LE(0) !== 0x02014b50) throw new Error("Unreadable zip directory");
    const method = cd.readUInt16LE(10),
      csize = cd.readUInt32LE(20),
      local = cd.readUInt32LE(42);
    if (csize === 0xffffffff || local === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, local);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("Unreadable zip entry");
    const start = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = fs.createReadStream(file, { start, end: start + csize - 1 });
    if (method === 0) return raw.pipe(new PassThrough());
    if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
    return raw.pipe(zlib.createInflateRaw());
  } finally {
    fs.closeSync(fd);
  }
}
