import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useResearch } from "../research";
import { formatTime } from "../transcript";
import { ARCHIVE, DATASET_LABELS, SeriesChart, SymbolInput } from "./DataSnapshots";

/** The Data stage: production data for the idea in production. Feeds keep
 * collecting in a background service (switched on and off here); closed hours
 * and days are frozen, hashed and quality-checked. Same registry operations
 * agents use (feeds_*, feed_*). */

interface ServiceStatus {
  mode: "launchd" | "child";
  enabled: boolean;
  running: boolean;
  heartbeatAt: string | null;
  pid: number | null;
  feeds: number;
  log: string;
}
interface FeedDef {
  id: string;
  title: string;
  kind: "stream" | "pull" | "script";
  paused: boolean;
  createdAt: string;
  seededFrom?: string;
  channel?: string;
  market?: string;
  symbol?: string;
  interval?: string;
  provider?: string;
  dataset?: string;
  every?: string;
  command?: string;
  backfillFrom?: string;
}
interface Status {
  state: "starting" | "backfilling" | "live" | "waiting" | "paused" | "error" | "stopped";
  detail: string;
  heartbeatAt: string;
  lastEventAt?: string;
  lastTime?: string;
  lagMs?: number;
  rowsToday: number;
  rowsTotal: number;
  openRows: number;
  openPeriod?: string;
  partitions: number;
  reconnects: number;
  connections?: { live: number; of: number };
  filledToday?: number;
  errors: { at: string; message: string }[];
  nextRunAt?: string;
}
interface Outage {
  from: string;
  to: string;
  cause: string;
  missing?: number;
  filled?: number;
  unfilled?: number;
  hole?: boolean;
}
interface Partition {
  key: string;
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
  first: string | null;
  last: string | null;
  closedAt: string;
  quality: { duplicates: number; outOfOrder: number; maxGapSeconds: number | null; expected?: number; missing?: number; late?: number };
}
interface Feed {
  def: FeedDef;
  status: Status;
  partitions: Partition[];
}
interface FeedsView {
  service: ServiceStatus;
  feeds: Feed[];
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const n = (v: number) => v.toLocaleString("en-US");
const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KiB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(1)} MiB` : `${(b / 1024 ** 3).toFixed(2)} GiB`);
const ago = (iso?: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const untilText = (ms: number) => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  return m < 1 ? "any moment" : m < 90 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
};
const lagText = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const STATE_LABEL: Record<Status["state"], string> = { live: "live", backfilling: "catching up", starting: "starting", waiting: "scheduled", paused: "paused", error: "error", stopped: "not collecting" };
const STATE_TONE: Record<Status["state"], string> = { live: "ok", backfilling: "accent", starting: "accent", waiting: "", paused: "", error: "warn", stopped: "" };
const MARKET_LABEL: Record<string, string> = { spot: "Spot", um: "USDⓈ-M futures", cm: "COIN-M futures" };
export const feedSource = (d: FeedDef) =>
  d.kind === "stream"
    ? `${d.market ? `Binance ${MARKET_LABEL[d.market] ?? d.market}` : "Coinbase"} · ${d.channel}${d.interval ? ` ${d.interval}` : ""} · ${d.symbol}`
    : d.kind === "pull"
      ? `${d.provider}${d.dataset ? ` ${d.dataset}` : ""}${d.interval ? ` ${d.interval}` : ""} · ${d.symbol} · every ${d.every}`
      : `script · every ${d.every}`;

/** Live channels (mirrors server/feeds/model.ts CHANNELS). */
const STREAMS: Record<"binance" | "coinbase", { id: string; label: string; markets?: string[]; interval?: boolean }[]> = {
  binance: [
    { id: "trades", label: "trades (every tick)", markets: ["spot"] },
    { id: "aggTrades", label: "aggregated trades", markets: ["spot", "um", "cm"] },
    { id: "klines", label: "bars (closed)", markets: ["spot", "um", "cm"], interval: true },
    { id: "bookTicker", label: "best bid/ask (every update)", markets: ["spot", "um", "cm"] },
    { id: "depth10", label: "order book, top 10 levels", markets: ["spot", "um", "cm"] },
    { id: "markPrice", label: "mark price, index, funding (1s)", markets: ["um", "cm"] },
    { id: "liquidations", label: "liquidations", markets: ["um", "cm"] },
  ],
  coinbase: [
    { id: "trades", label: "trades (every match)" },
    { id: "ticker", label: "ticker (price, best bid/ask)" },
  ],
};
/** What Binance's archive keeps per market (for filling past days; mirrors server/feeds/model.ts backfillable). */
const ARCHIVED: Record<string, string[]> = { spot: ["trades", "aggTrades", "klines"], um: ["trades", "aggTrades", "klines", "bookTicker"], cm: ["trades", "aggTrades", "klines", "bookTicker"] };
const canBackfill = (exchange: string, market: string, channel: string) => exchange === "binance" && !!ARCHIVED[market]?.includes(channel);
/** When an open period ends and is frozen (ms). */
export const periodEnd = (key: string) => Date.parse(key.length > 10 ? `${key}:00:00Z` : `${key}T00:00:00Z`) + (key.length > 10 ? 3_600_000 : 86_400_000);
const BAR_INTERVALS = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"];
const EVERY = ["15m", "1h", "6h", "1d"];

/* ── Shared state: the feed list (polled) and the feed being looked at ── */
let selected: string | null = null;
const subs = new Set<() => void>();
export const selectFeed = (id: string | null) => {
  selected = id;
  subs.forEach((f) => f());
};
const useSelectedFeed = () =>
  useSyncExternalStore(
    (cb) => (subs.add(cb), () => void subs.delete(cb)),
    () => selected,
  );

function useFeeds(everyMs = 2000) {
  const scope = useResearch();
  const [view, setView] = useState<FeedsView | null>(null);
  const [error, setError] = useState("");
  const live = useRef(true);
  const load = () =>
    scope.client.read<FeedsView>("/native/feeds").then(
      (v) => live.current && (setView(v), setError("")),
      (e) => live.current && setError(errorText(e)),
    );
  useEffect(() => {
    live.current = true;
    void load();
    const t = setInterval(() => void load(), everyMs);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, []);
  return { view, error, load };
}

/** Pick a feed for Explorer and Quality (the one chosen in Feeds, else the first). */
function useFeedChoice(feeds: Feed[] | undefined) {
  const chosen = useSelectedFeed();
  return feeds?.find((f) => f.def.id === chosen) ?? feeds?.[0] ?? null;
}
function FeedPicker({ feeds, feed }: { feeds: Feed[]; feed: Feed | null }) {
  return (
    <label className="feed-picker">
      <span className="lbl">feed</span>
      <select value={feed?.def.id ?? ""} onChange={(e) => selectFeed(e.target.value)} aria-label="Feed">
        {feeds.map((f) => (
          <option key={f.def.id} value={f.def.id}>
            {f.def.title}
          </option>
        ))}
      </select>
    </label>
  );
}
function StateTag({ s }: { s: Status }) {
  const reconnecting = s.state === "waiting" && !s.nextRunAt;
  return (
    <span className={`tag feed-state ${reconnecting ? "warn" : STATE_TONE[s.state]}`} data-state={s.state}>
      <i aria-hidden="true" />
      {reconnecting ? "reconnecting" : STATE_LABEL[s.state]}
    </span>
  );
}

/* ── Feeds ────────────────────────────────────────────────────────── */

function ServiceSwitch({ service, onChanged }: { service: ServiceStatus; onChanged: () => void }) {
  const scope = useResearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = service.enabled || service.running;
  const flip = async () => {
    setBusy(true);
    setError("");
    try {
      await scope.client.write("/native/feeds/service", { on: !on });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const state = service.running ? `Collecting · ${service.feeds} feed${service.feeds === 1 ? "" : "s"} · heartbeat ${ago(service.heartbeatAt)}` : on ? "Starting…" : "Collection is off";
  return (
    <div className={`feed-service ${service.running ? "running" : on ? "starting" : "off"}`}>
      <button role="switch" aria-checked={on} aria-label="Background collection" className="switch" disabled={busy} onClick={() => void flip()}>
        <i aria-hidden="true" />
      </button>
      <div className="txt">
        <b>{state}</b>
        <span>
          {on
            ? service.mode === "launchd"
              ? "Runs in the background as a login item, so feeds keep collecting when the app is closed."
              : "Runs with the app (development mode); it stops when the app quits."
            : "Feeds stay defined but nothing is collected. Switching on installs a background login item that keeps collecting while the app is closed."}
        </span>
        {error && <span className="err">{error}</span>}
      </div>
    </div>
  );
}

interface Snapshot {
  name: string;
  title: string;
  source: { kind: string; symbol?: string; interval?: string; market?: string; dataset?: string };
  last?: string;
  query?: { start: string; end: string };
}
const nextDay = (iso?: string) => (iso ? new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) : today());
/** The live feed that continues a research snapshot, when there is one. */
export function liveFeedFor(s: Snapshot): Record<string, unknown> | null {
  const src = s.source;
  const from = nextDay(s.last ?? s.query?.end);
  const backfill = from < today() && Date.parse(from) > Date.now() - 90 * 86400000 ? { backfillFrom: from } : {};
  const seed = { seededFrom: s.name };
  if (src.kind === "binance-archive" && src.symbol && src.market && src.market !== "option") {
    const m = src.market;
    const channel =
      src.dataset === "trades" ? (m === "spot" ? "trades" : "aggTrades") : src.dataset === "aggTrades" ? "aggTrades" : src.dataset === "klines" ? "klines" : src.dataset === "bookTicker" ? "bookTicker" : src.dataset === "bookDepth" ? "depth10" : src.dataset === "markPriceKlines" ? "markPrice" : src.dataset === "liquidationSnapshot" ? "liquidations" : null;
    if (channel) return { kind: "stream", exchange: "binance", market: m, channel, symbol: src.symbol, ...(channel === "klines" && src.interval ? { interval: src.interval } : {}), ...(["trades", "aggTrades", "klines", "bookTicker"].includes(channel) ? backfill : {}), ...seed };
    return { kind: "pull", provider: "binance-archive", market: m, dataset: src.dataset, symbol: src.symbol, ...(src.interval ? { interval: src.interval } : {}), every: "1d", backfillFrom: from > today() ? today() : from, ...seed };
  }
  if (src.kind === "binance" && src.symbol) return { kind: "stream", exchange: "binance", market: "spot", channel: "klines", symbol: src.symbol, interval: src.interval ?? "1m", ...seed };
  if (src.kind === "coinbase" && src.symbol) return { kind: "pull", provider: "coinbase", symbol: src.symbol, interval: src.interval ?? "1h", every: src.interval === "1d" ? "1d" : "15m", backfillFrom: from > today() ? today() : from, ...seed };
  if (src.kind === "fred" && src.symbol) return { kind: "pull", provider: "fred", symbol: src.symbol, every: "1d", backfillFrom: s.query?.start ?? daysAgo(365), ...seed };
  return null;
}
const describe = (input: Record<string, any>) =>
  input.kind === "stream"
    ? `${input.exchange === "binance" ? `Binance ${MARKET_LABEL[input.market] ?? input.market}` : "Coinbase"} ${input.channel}${input.interval ? ` ${input.interval}` : ""} live${input.backfillFrom ? `, filling ${input.backfillFrom} → today from the archive first` : ""}`
    : `${input.provider}${input.dataset ? ` ${input.dataset}` : ""}${input.interval ? ` ${input.interval}` : ""} every ${input.every}, from ${input.backfillFrom}`;

/** Snapshots the production idea's research used, each with the feed that keeps it going. */
function FromResearch({ feeds, onCreated }: { feeds: Feed[]; onCreated: () => void }) {
  const scope = useResearch();
  const current = scope.view?.production?.current;
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const names = (current?.snapshots ?? []).map((s: any) => s.name).join(",");
  useEffect(() => {
    if (!names) return;
    scope.client.read<{ snapshots: Snapshot[] }>("/native/data/snapshots").then((r) => setSnaps(r.snapshots.filter((s) => names.split(",").includes(s.name))), () => setSnaps([]));
  }, [names]);
  if (!current || !names || !snaps?.length) return null;
  const create = async (s: Snapshot, input: Record<string, unknown>) => {
    setBusy(s.name);
    setError("");
    try {
      const def = await scope.client.write<FeedDef>("/native/feeds/create", input);
      selectFeed(def.id);
      onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="feed-seeds" aria-label="From your research">
      <h3 className="section-title">
        from your research <span className="count">{snaps.length}</span>
      </h3>
      <p className="note">The data “{current.title}” was developed on. Collect the same data live so production code sees what the research saw.</p>
      {snaps.map((s) => {
        const input = liveFeedFor(s);
        const running = feeds.find((f) => f.def.seededFrom === s.name);
        return (
          <div className="feed-seed" key={s.name}>
            <span className="t">
              {s.title}
              <small>{running ? `collected live by “${running.def.title}”` : input ? describe(input) : "a file from your own code: collect it with a script feed"}</small>
            </span>
            {running ? (
              <button className="btn small ghost" onClick={() => selectFeed(running.def.id)}>
                Show
              </button>
            ) : input ? (
              <button className="btn small primary" disabled={!!busy} onClick={() => void create(s, input)}>
                {busy === s.name ? "Creating…" : "Collect live"}
              </button>
            ) : null}
          </div>
        );
      })}
      {error && <p className="notice error">{error}</p>}
    </section>
  );
}

function NewFeed({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const scope = useResearch();
  const current = scope.view?.production?.current;
  const [kind, setKind] = useState<"stream" | "pull" | "script">("stream");
  const [exchange, setExchange] = useState<"binance" | "coinbase">("binance");
  const [market, setMarket] = useState("spot");
  const [channel, setChannel] = useState("aggTrades");
  const [interval, setInterval_] = useState("1m");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [backfill, setBackfill] = useState("");
  const [provider, setProvider] = useState<"binance-archive" | "binance" | "coinbase" | "fred">("binance-archive");
  const [dataset, setDataset] = useState("metrics");
  const [every, setEvery] = useState("1h");
  const [from, setFrom] = useState(daysAgo(7));
  const [command, setCommand] = useState("");
  const [timeColumn, setTimeColumn] = useState("date");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const channels = STREAMS[exchange].filter((c) => !c.markets || c.markets.includes(market));
  const ch = channels.find((c) => c.id === channel) ?? channels[0];
  useEffect(() => {
    if (!channels.some((c) => c.id === channel)) setChannel(channels[0].id);
  }, [exchange, market]);
  useEffect(() => {
    if (exchange === "coinbase" && !symbol.includes("-")) setSymbol("BTC-USD");
    if (exchange === "binance" && symbol.includes("-")) setSymbol(market === "cm" ? "BTCUSD_PERP" : "BTCUSDT");
  }, [exchange]);
  const archived = canBackfill(exchange, market, ch.id);
  useEffect(() => {
    if (!archived) setBackfill("");
  }, [archived]);
  const pullMarket = provider === "binance-archive" ? market : provider === "binance" ? market : undefined;
  const input =
    kind === "stream"
      ? { kind, exchange, ...(exchange === "binance" ? { market } : {}), channel: ch.id, symbol: symbol.trim(), ...(ch.interval ? { interval } : {}), ...(backfill ? { backfillFrom: backfill } : {}), ...(title.trim() ? { title: title.trim() } : {}) }
      : kind === "pull"
        ? { kind, provider, ...(pullMarket ? { market: pullMarket } : {}), ...(provider === "binance-archive" ? { dataset } : {}), symbol: symbol.trim(), ...(provider === "binance" || provider === "coinbase" || (provider === "binance-archive" && /klines/i.test(dataset)) ? { interval } : {}), every, backfillFrom: from, ...(title.trim() ? { title: title.trim() } : {}) }
        : { kind, command: command.trim(), every, timeColumn: timeColumn.trim(), backfillFrom: from, ...(title.trim() ? { title: title.trim() } : {}) };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const def = await scope.client.write<FeedDef>("/native/feeds/create", input);
      onCreated(def.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const suggestSource = kind === "stream" ? (exchange === "coinbase" ? "coinbase" : "binance-archive") : provider;
  const suggestDataset = kind === "stream" ? "aggTrades" : dataset;
  return (
    <div className="data-form feed-form" role="form" aria-label="New feed">
      <div className="seg" role="tablist" aria-label="Kind of feed">
        {(
          [
            ["stream", "Live stream"],
            ["pull", "Scheduled pull"],
            ["script", "Your script"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      <span className="break" />
      {kind === "stream" && (
        <>
          <label>
            Exchange
            <select value={exchange} onChange={(e) => setExchange(e.target.value as any)}>
              <option value="binance">Binance</option>
              <option value="coinbase">Coinbase</option>
            </select>
          </label>
          {exchange === "binance" && (
            <label>
              Market
              <select value={market} onChange={(e) => setMarket(e.target.value)}>
                {Object.entries(MARKET_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Channel
            <select value={ch.id} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {ch.interval && (
            <label>
              Bar
              <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
                {BAR_INTERVALS.filter((i) => i !== "1s" || market === "spot").map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {kind === "pull" && (
        <>
          <label>
            Source
            <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
              <option value="binance-archive">Binance archive (daily files)</option>
              <option value="binance">Binance bars</option>
              <option value="coinbase">Coinbase bars</option>
              <option value="fred">FRED series</option>
            </select>
          </label>
          {(provider === "binance-archive" || provider === "binance") && (
            <label>
              Market
              <select value={market} onChange={(e) => setMarket(e.target.value)}>
                {Object.entries(ARCHIVE)
                  .filter(([k]) => provider === "binance-archive" || k !== "option")
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {provider === "binance-archive" && (
            <label>
              Dataset
              <select value={ARCHIVE[market]?.datasets.includes(dataset) ? dataset : ARCHIVE[market]?.datasets[0]} onChange={(e) => setDataset(e.target.value)}>
                {(ARCHIVE[market]?.datasets ?? []).map((d) => (
                  <option key={d} value={d}>
                    {DATASET_LABELS[d] ?? d}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(provider === "binance" || provider === "coinbase" || (provider === "binance-archive" && /klines/i.test(dataset))) && (
            <label>
              Bar
              <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
                {BAR_INTERVALS.filter((i) => i !== "1s").map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {kind !== "script" && <SymbolInput label="Symbol" source={suggestSource} market={market} dataset={suggestDataset} value={symbol} onChange={setSymbol} />}
      {kind === "script" && (
        <>
          <label className="wide">
            Command
            <input value={command} placeholder="python3 bloomberg_pull.py" spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label>
            Time column
            <input value={timeColumn} spellCheck={false} onChange={(e) => setTimeColumn(e.target.value)} />
          </label>
        </>
      )}
      {kind !== "stream" && (
        <label>
          Every
          <select value={every} onChange={(e) => setEvery(e.target.value)}>
            {EVERY.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        {kind === "stream" ? "Fill past days from" : "Collect from"}
        <input
          type="date"
          value={kind === "stream" ? backfill : from}
          max={today()}
          disabled={kind === "stream" && !archived}
          title={kind === "stream" && !archived ? "Not in Binance's archive; this feed collects from now" : ""}
          onChange={(e) => (kind === "stream" ? setBackfill(e.target.value) : setFrom(e.target.value))}
        />
      </label>
      <label className="wide">
        Title
        <input value={title} placeholder="optional" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <p className="note">
        {kind === "stream"
          ? `Every message from the exchange as it happens, into hourly partitions frozen once each hour closes.${!archived ? ` ${exchange === "coinbase" ? "Coinbase has no archive" : `Binance's archive does not keep ${MARKET_LABEL[market]} ${ch.label}`}, so this feed collects from now.` : backfill ? " Complete past days come from the Binance archive first." : " Leave the date empty to start from now."}`
          : kind === "pull"
            ? "Fetches what is new since the last row on a schedule, into daily partitions."
            : `Runs in ${current ? `the workspace of “${current.title}”` : "the production idea’s workspace"} with your own login shell (so Bloomberg, keys and virtualenvs work). Write CSV or Parquet to $PI_RESEARCH_OUT with rows after $PI_RESEARCH_SINCE; ${timeColumn || "the time column"} keys the daily partitions.`}
      </p>
      {error && <p className="notice error">{error}</p>}
      <div className="actions">
        <button className="btn small primary" disabled={busy || (kind === "script" ? !command.trim() || !timeColumn.trim() : !symbol.trim())} onClick={() => void create()}>
          {busy ? "Creating…" : "Create feed"}
        </button>
        <button className="btn small ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FeedRow({ feed, on, onChanged }: { feed: Feed; on: boolean; onChanged: () => void }) {
  const scope = useResearch();
  const { def, status: s } = feed;
  const [confirming, setConfirming] = useState(false);
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState("");
  const act = async (route: string, body: object) => {
    setError("");
    try {
      await scope.client.write(route, body);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const facts = [
    s.state === "live" && s.lagMs !== undefined ? `lag ${lagText(s.lagMs)}` : "",
    def.kind === "stream" && s.lastEventAt ? `last received ${ago(s.lastEventAt)}` : "",
    `${n(s.rowsToday)} rows today`,
    `${n(s.rowsTotal)} in total`,
    s.partitions ? `${s.partitions} frozen` : "",
    s.state === "waiting" && s.nextRunAt ? `next ${formatTime(s.nextRunAt)?.short ?? s.nextRunAt}` : "",
    s.connections && s.state !== "paused" && s.state !== "stopped" ? `${s.connections.live} of ${s.connections.of} connections` : "",
    s.filledToday ? `${n(s.filledToday)} refetched` : "",
    s.reconnects ? `${n(s.reconnects)} reconnects` : "",
  ].filter(Boolean);
  return (
    <div
      className={`feed-row ${on ? "on" : ""}`}
      role="listitem"
      tabIndex={0}
      aria-label={def.title}
      onClick={() => selectFeed(def.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.metaKey && e.key === "Backspace") (e.preventDefault(), setConfirming(true));
      }}
    >
      <div className="head">
        <StateTag s={s} />
        <span className="t" title={def.title}>
          {def.title}
        </span>
        <button className="btn small ghost" onClick={(e) => (e.stopPropagation(), void act("/native/feeds/update", { id: def.id, paused: !def.paused }))}>
          {def.paused ? "Resume" : "Pause"}
        </button>
        <button className="btn small ghost" onClick={(e) => (e.stopPropagation(), selectFeed(def.id), scope.goToStage?.("data", "explorer"))}>
          Explore
        </button>
        <button className="icon-btn" aria-label={`Delete ${def.title}`} title="Delete (⌘⌫)" onClick={(e) => (e.stopPropagation(), setConfirming(true))}>
          ×
        </button>
      </div>
      <div className="src">{feedSource(def)}</div>
      <div className="detail">
        <span className={s.state === "error" || (def.kind === "stream" && s.state === "waiting") ? "err" : undefined}>{s.detail}</span>
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>
      {s.errors.length > 0 && (
        <details className="feed-history" onClick={(e) => e.stopPropagation()}>
          <summary>Recent issues · last {ago(s.errors[0].at)}</summary>
          <p>Past events; current collection status is shown above. Data gaps are listed in Quality.</p>
          {s.errors.map((issue, i) => (
            <div key={`${issue.at}-${i}`}><time title={issue.at}>{ago(issue.at)}</time> · {issue.message}</div>
          ))}
        </details>
      )}
      {confirming && (
        <div className="confirm" role="alertdialog" aria-label="Delete feed" onClick={(e) => e.stopPropagation()}>
          <span>Delete “{def.title}”?</span>
          <label>
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> keep its collected data ({n(s.rowsTotal)} rows)
          </label>
          <button className="btn small danger" onClick={() => void act("/native/feeds/delete", { id: def.id, keepData: keep }).then(() => setConfirming(false))}>
            Delete
          </button>
          <button className="btn small ghost" autoFocus onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="notice error">{error}</p>}
    </div>
  );
}

export function FeedsPane() {
  const scope = useResearch();
  const { view, error, load } = useFeeds();
  const chosen = useSelectedFeed();
  const [adding, setAdding] = useState(false);
  if (!view) return <div className="data-pane">{error ? <p className="notice error">{error}</p> : <p className="rd-empty">Loading feeds…</p>}</div>;
  const current = scope.view?.production?.current;
  const live = view.feeds.filter((f) => f.status.state === "live").length;
  return (
    <div className="data-pane feeds-pane">
      <ServiceSwitch service={view.service} onChanged={() => void load()} />
      <div className="data-toolbar">
        <button className={`btn small ${adding ? "primary" : "ghost"}`} onClick={() => setAdding((a) => !a)}>
          + New feed
        </button>
        <span className="dim">{view.feeds.length ? `${view.feeds.length} feed${view.feeds.length === 1 ? "" : "s"} · ${live} live` : ""}</span>
      </div>
      {adding && (
        <NewFeed
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            selectFeed(id);
            void load();
          }}
        />
      )}
      {error && <p className="notice error">{error}</p>}
      <div className="feeds-scroll">
        <FromResearch feeds={view.feeds} onCreated={() => void load()} />
        <section aria-label="Feeds">
          {view.feeds.length > 0 && (
            <h3 className="section-title">
              feeds <span className="count">{view.feeds.length}</span>
            </h3>
          )}
          <div className="feed-list" role="list">
            {view.feeds.map((f) => (
              <FeedRow key={f.def.id} feed={f} on={(chosen ?? view.feeds[0]?.def.id) === f.def.id} onChanged={() => void load()} />
            ))}
          </div>
          {!view.feeds.length && (
            <p className="rd-empty">
              {current
                ? "No production feeds yet. Collect the research data live (above), or add a feed: exchange streams, scheduled pulls, or your own script (e.g. Bloomberg)."
                : "No production feeds yet. Send an idea to production from Research Development, then collect its data live here."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/* ── Explorer ─────────────────────────────────────────────────────── */

interface Rows {
  columns: string[];
  types: string[];
  rows: string[][];
  series: [string, number][];
  valueColumn: string;
}
export function FeedExplorerPane() {
  const scope = useResearch();
  const { view, error } = useFeeds(3000);
  const feed = useFeedChoice(view?.feeds);
  const [rows, setRows] = useState<Rows | null>(null);
  const [rowsError, setRowsError] = useState("");
  const id = feed?.def.id;
  useEffect(() => {
    setRows(null);
    if (!id) return;
    let live = true;
    const load = () =>
      scope.client.read<Rows>(`/native/feeds/rows?id=${id}`).then(
        (r) => live && (setRows(r), setRowsError("")),
        (e) => live && setRowsError(errorText(e)),
      );
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  if (!view) return <div className="data-pane">{error ? <p className="notice error">{error}</p> : <p className="rd-empty">Loading…</p>}</div>;
  if (!feed) return <p className="rd-empty">No feeds yet. Create one in Feeds.</p>;
  const s = feed.status;
  const glob = `Data/production/${feed.def.id}/data/**/*.parquet`;
  return (
    <div className="data-pane feed-explorer">
      <div className="data-toolbar">
        <FeedPicker feeds={view.feeds} feed={feed} />
        <StateTag s={s} />
        <span className="dim">{feedSource(feed.def)}</span>
      </div>
      <div className="rd-viewer-body data-detail">
        <dl className="data-meta">
          <dt>status</dt>
          <dd>{s.detail}</dd>
          {s.lastTime && (
            <>
              <dt>latest row</dt>
              <dd>
                {s.lastTime.replace("T", " ").slice(0, 23)} UTC{s.state === "live" && s.lagMs !== undefined ? ` · lag ${lagText(s.lagMs)}` : ""}
              </dd>
            </>
          )}
          <dt>rows</dt>
          <dd>
            {n(s.rowsToday)} today · {n(s.rowsTotal)} in total · {n(s.openRows)} in the open {feed.def.kind === "stream" ? "hour" : "day"}
          </dd>
          <dt>partitions</dt>
          <dd>{s.partitions ? `${s.partitions} frozen (read-only, SHA-256 in Quality)` : "none closed yet"}</dd>
          {rows && (
            <>
              <dt>columns</dt>
              <dd>{rows.columns.map((c, i) => `${c} ${rows.types[i] ?? ""}`).join(" · ")}</dd>
            </>
          )}
        </dl>
        <div className="data-snippet">
          <span>polars</span>
          <code>{`pl.scan_parquet("${glob}")`}</code>
          <button className="btn small ghost" onClick={() => void navigator.clipboard?.writeText(`pl.scan_parquet("${glob}")`)}>
            Copy
          </button>
        </div>
        {rowsError && <p className="notice error">{rowsError}</p>}
        {rows && rows.series.length > 1 && <SeriesChart series={rows.series} label={`${rows.valueColumn} · recent partitions and the open ${feed.def.kind === "stream" ? "hour" : "day"}`} />}
        {rows && (
          <div className="table-wrap rd-table">
            <table>
              <thead>
                <tr>
                  {rows.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.rows.length && <p className="rd-empty">No rows yet{s.state === "stopped" ? "; switch collection on in Feeds." : "."}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Quality ──────────────────────────────────────────────────────── */

export function FeedQualityPane() {
  const scope = useResearch();
  const { view, error } = useFeeds(5000);
  const feed = useFeedChoice(view?.feeds);
  const [parts, setParts] = useState<Partition[] | null>(null);
  const [outages, setOutages] = useState<Outage[]>([]);
  const id = feed?.def.id;
  const count = feed?.status.partitions;
  const lastOutage = (feed?.status as any)?.lastOutage?.to;
  useEffect(() => {
    if (!id) return;
    scope.client.read<{ partitions: Partition[]; outages?: Outage[] }>(`/native/feeds/partitions?id=${id}&limit=500`).then(
      (r) => (setParts(r.partitions), setOutages(r.outages ?? [])),
      () => setParts([]),
    );
  }, [id, count, lastOutage]);
  if (!view) return <div className="data-pane">{error ? <p className="notice error">{error}</p> : <p className="rd-empty">Loading…</p>}</div>;
  if (!feed) return <p className="rd-empty">No feeds yet. Create one in Feeds.</p>;
  const list = parts ?? [];
  const issues = (p: Partition) => p.quality.duplicates + p.quality.outOfOrder + (p.quality.missing ?? 0) + (p.quality.late ?? 0);
  const flagged = list.filter((p) => issues(p) > 0).length;
  const bars = list.some((p) => p.quality.expected !== undefined);
  const q = (v: number | undefined) => (v ? <span className="bad">{n(v)}</span> : <span className="zero">0</span>);
  return (
    <div className="data-pane feed-quality">
      <div className="data-toolbar">
        <FeedPicker feeds={view.feeds} feed={feed} />
        <span className="dim">
          {list.length ? `${list.length} frozen partition${list.length === 1 ? "" : "s"} · ${flagged ? `${flagged} with issues` : "no issues"} · ${size(list.reduce((s, p) => s + p.bytes, 0))}` : ""}
        </span>
      </div>
      <div className="rd-viewer-body">
        <p className="note">
          Each {feed.def.kind === "stream" ? "hour" : "day"} is frozen when it closes: converted to Parquet, made read-only and hashed, so a later run can never change data a result was built on. Rows that arrive after their period closed are counted as late and never rewrite it.
        </p>
        {feed.status.openPeriod && !feed.def.paused && (
          <p className="feed-open" role="status">
            <b>Open {feed.def.kind === "stream" ? "hour" : "day"}</b> {feed.status.openPeriod.replace("T", " ") + (feed.status.openPeriod.includes("T") ? ":00 UTC" : "")} · {n(feed.status.openRows)} rows so far · frozen at{" "}
            {new Date(periodEnd(feed.status.openPeriod)).toLocaleString(undefined, feed.def.kind === "stream" ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" })} your time ({untilText(periodEnd(feed.status.openPeriod))})
          </p>
        )}
        {outages.length > 0 && <Outages outages={outages} />}
        {list.length > 0 ? (
          <div className="table-wrap rd-table">
            <table>
              <thead>
                <tr>
                  <th>period (UTC)</th>
                  <th>rows</th>
                  <th>largest gap</th>
                  <th>duplicates</th>
                  <th>out of order</th>
                  {bars && <th>missing bars</th>}
                  <th>late</th>
                  <th>size</th>
                  <th>sha-256</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.key} className={issues(p) ? "flag" : ""}>
                    <td>{p.key.replace("T", " ") + (p.key.includes("T") ? ":00" : "")}</td>
                    <td>{n(p.rows)}</td>
                    <td>{p.quality.maxGapSeconds === null ? "–" : p.quality.maxGapSeconds < 120 ? `${p.quality.maxGapSeconds} s` : `${Math.round(p.quality.maxGapSeconds / 60)} min`}</td>
                    <td>{q(p.quality.duplicates)}</td>
                    <td>{q(p.quality.outOfOrder)}</td>
                    {bars && <td>{p.quality.expected !== undefined ? q(p.quality.missing) : "–"}</td>}
                    <td>{q(p.quality.late)}</td>
                    <td>{size(p.bytes)}</td>
                    <td title={p.sha256}>
                      <code>{p.sha256.slice(0, 10)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rd-empty">No frozen partitions yet{feed.status.state === "stopped" ? "; collection is not running" : ""}. The first appears here when the open {feed.def.kind === "stream" ? "hour" : "day"} ends.</p>
        )}
      </div>
    </div>
  );
}

const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
/** Stretches the two live connections did not cover by themselves. */
function Outages({ outages }: { outages: Outage[] }) {
  const holes = outages.filter((o) => o.hole || (o.unfilled ?? 0) > 0).length;
  return (
    <section className="feed-outages" aria-label="Outages">
      <h3 className="section-title">
        outages <span className="count">{outages.length}</span>
      </h3>
      <p className="note">
        {holes
          ? `${holes} left data missing. Trades are fetched again by id when the exchange still has them; books and mark prices have no history, so only the second connection protects them.`
          : "Every gap was filled from the exchange; nothing is missing."}
      </p>
      <div className="table-wrap rd-table">
        <table>
          <thead>
            <tr>
              <th>from (UTC)</th>
              <th>length</th>
              <th>cause</th>
              <th>missing</th>
              <th>refetched</th>
              <th>still missing</th>
            </tr>
          </thead>
          <tbody>
            {outages.map((o, i) => {
              const lost = o.hole || (o.unfilled ?? 0) > 0;
              return (
                <tr key={i} className={lost ? "flag" : ""}>
                  <td>{o.from.replace("T", " ").slice(0, 19)}</td>
                  <td>{dur(Date.parse(o.to) - Date.parse(o.from))}</td>
                  <td>{o.cause}</td>
                  <td>{o.hole ? "unknown" : o.missing !== undefined ? n(o.missing) : "–"}</td>
                  <td>{o.filled ? n(o.filled) : <span className="zero">0</span>}</td>
                  <td>{o.hole ? <span className="bad">all of it</span> : o.unfilled ? <span className="bad">{n(o.unfilled)}</span> : <span className="zero">0</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
