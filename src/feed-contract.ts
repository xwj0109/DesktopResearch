import { z } from "zod";

/** Production feed requests shared by the backend, the desktop allowlist and
 * the window (server/feeds for the service itself). */
export const FEED_MARKETS = ["spot", "um", "cm"] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const streamFeed = z
  .object({
    kind: z.literal("stream"),
    exchange: z.enum(["binance", "coinbase"]),
    market: z
      .enum(FEED_MARKETS)
      .optional()
      .describe("Binance: spot, um (USDⓈ-M futures) or cm (COIN-M futures)."),
    channel: z
      .string()
      .max(40)
      .describe(
        "Binance: trades (spot), aggTrades, klines, bookTicker, depth10, markPrice, liquidations. Coinbase: trades, ticker.",
      ),
    symbol: z.string().trim().min(2).max(30),
    interval: z
      .string()
      .max(4)
      .optional()
      .describe("For klines: 1s (spot), 1m, 5m, 15m, 1h, 4h, 1d."),
    backfillFrom: day
      .optional()
      .describe(
        "Fill complete past days from the Binance archive first (where it has the channel).",
      ),
    title: z.string().trim().max(200).optional(),
    seededFrom: z.string().max(120).optional(),
  })
  .strict();
const pullFeed = z
  .object({
    kind: z.literal("pull"),
    provider: z.enum(["binance-archive", "binance", "coinbase", "fred"]),
    market: z.enum(["spot", "um", "cm", "option"]).optional(),
    dataset: z.string().max(40).optional(),
    symbol: z.string().trim().min(1).max(40),
    interval: z.string().max(4).optional(),
    every: z.enum(["15m", "1h", "6h", "1d"]),
    backfillFrom: day,
    title: z.string().trim().max(200).optional(),
    seededFrom: z.string().max(120).optional(),
  })
  .strict();
const scriptFeed = z
  .object({
    kind: z.literal("script"),
    command: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        "Your own command, run in the idea workspace; it writes CSV or Parquet to $PI_RESEARCH_OUT with rows after $PI_RESEARCH_SINCE (ISO time).",
      ),
    workspace: z
      .string()
      .regex(/^r:[0-9a-f-]{36}$/)
      .optional()
      .describe(
        "Idea whose workspace the command runs in (default: the idea in production).",
      ),
    every: z.enum(["15m", "1h", "6h", "1d"]),
    timeColumn: z.string().trim().min(1).max(80),
    backfillFrom: day,
    title: z.string().trim().max(200).optional(),
  })
  .strict();
export const feedCreateSchema = z.discriminatedUnion("kind", [
  streamFeed,
  pullFeed,
  scriptFeed,
]);
export type FeedCreate = z.infer<typeof feedCreateSchema>;
/** The same request as one flat object (tool inputs must be JSON Schema
 * objects); feedCreateSchema then checks the fields for its kind. */
const [stream, pull, script] = [
  streamFeed.shape,
  pullFeed.shape,
  scriptFeed.shape,
];
export const feedCreateToolSchema = z
  .object({
    ...script,
    ...pull,
    ...stream,
    kind: z
      .enum(["stream", "pull", "script"])
      .describe(
        "stream: a live exchange stream; pull: scheduled pulls; script: the user's own command.",
      ),
    market: pull.market.describe(stream.market.description!),
    symbol: pull.symbol.optional(),
    exchange: stream.exchange.optional(),
    channel: stream.channel.optional(),
    provider: pull.provider.optional(),
    every: pull.every.optional(),
    backfillFrom: pull.backfillFrom
      .optional()
      .describe(
        "Streams: fill complete past days from the Binance archive first. Pulls and scripts (required): collect from this day.",
      ),
    command: script.command.optional(),
    timeColumn: script.timeColumn.optional(),
  })
  .strict();
export const feedUpdateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/),
    paused: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const feedDeleteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/),
    keepData: z.boolean().optional(),
  })
  .strict();
export const feedServiceSchema = z.object({ on: z.boolean() }).strict();
