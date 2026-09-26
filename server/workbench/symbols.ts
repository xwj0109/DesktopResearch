/** Ticker suggestions for the Data tab's fetch form (and agents via
 * data_symbols): what each source can actually serve.
 * - Binance archive: symbols the archive holds for a market and dataset
 *   (bucket listing, delisted ones included, since their history is there).
 * - Binance bars (API): the spot symbols of the archive's bar folders.
 * - Coinbase: its public product list (online first).
 * - FRED: series search needs an API key, so a curated list of widely used
 *   series with their titles; any other series id can still be typed.
 * Lists are fetched on first use and kept for 12 hours. */

export interface SymbolItem {
  symbol: string;
  label?: string;
  inactive?: boolean;
}
type Loader = () => Promise<SymbolItem[]>;

const TTL = 12 * 60 * 60 * 1000;
const QUOTES = ["USDT", "USD", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "EUR", "TRY"];
const MAJORS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "TON", "DOT", "LTC"];

export const FRED_SERIES: SymbolItem[] = [
  ["DGS10", "10-Year Treasury yield"],
  ["DGS2", "2-Year Treasury yield"],
  ["DGS3MO", "3-Month Treasury yield"],
  ["DGS30", "30-Year Treasury yield"],
  ["T10Y2Y", "10Y minus 2Y Treasury spread"],
  ["T10Y3M", "10Y minus 3M Treasury spread"],
  ["DFF", "Effective federal funds rate (daily)"],
  ["FEDFUNDS", "Effective federal funds rate (monthly)"],
  ["SOFR", "Secured Overnight Financing Rate"],
  ["DFII10", "10-Year TIPS real yield"],
  ["T10YIE", "10-Year breakeven inflation"],
  ["CPIAUCSL", "CPI, all urban consumers"],
  ["CPILFESL", "Core CPI (ex food and energy)"],
  ["PCEPI", "PCE price index"],
  ["PCEPILFE", "Core PCE price index"],
  ["UNRATE", "Unemployment rate"],
  ["PAYEMS", "Nonfarm payrolls"],
  ["ICSA", "Initial jobless claims"],
  ["GDP", "Gross domestic product"],
  ["GDPC1", "Real GDP"],
  ["INDPRO", "Industrial production"],
  ["M2SL", "M2 money stock"],
  ["WALCL", "Fed total assets (balance sheet)"],
  ["RRPONTSYD", "Overnight reverse repo"],
  ["WTREGEN", "Treasury General Account"],
  ["DTWEXBGS", "Broad US dollar index"],
  ["DEXUSEU", "USD per EUR"],
  ["DEXJPUS", "JPY per USD"],
  ["DEXCHUS", "CNY per USD"],
  ["VIXCLS", "CBOE VIX"],
  ["SP500", "S&P 500"],
  ["NASDAQCOM", "NASDAQ Composite"],
  ["DJIA", "Dow Jones Industrial Average"],
  ["BAMLH0A0HYM2", "US high-yield OAS"],
  ["BAMLC0A0CM", "US investment-grade OAS"],
  ["DCOILWTICO", "WTI crude oil"],
  ["DCOILBRENTEU", "Brent crude oil"],
  ["DHHNGSP", "Henry Hub natural gas"],
  ["GOLDAMGBD228NLBM", "Gold price (London AM fix)"],
  ["MORTGAGE30US", "30-year mortgage rate"],
  ["UMCSENT", "University of Michigan consumer sentiment"],
  ["NFCI", "Chicago Fed financial conditions index"],
  ["STLFSI4", "St. Louis Fed financial stress index"],
].map(([symbol, label]) => ({ symbol, label }));

/** Rank a list for a query: exact, then prefix (by preferred quote, then
 * length), then contains, then label matches; inactive last. */
export function rankSymbols(items: SymbolItem[], query: string, limit = 20): SymbolItem[] {
  const q = query.trim().toUpperCase();
  const quoteRank = (s: string) => {
    const i = QUOTES.findIndex((qu) => s.endsWith(qu) || s.endsWith(`-${qu}`) || s.endsWith(`${qu}_PERP`));
    return i < 0 ? QUOTES.length : i;
  };
  const score = (it: SymbolItem) => {
    const s = it.symbol.toUpperCase();
    if (!q) {
      const base = MAJORS.findIndex((m) => s.startsWith(m));
      return base < 0 ? null : 1000 + base * 20 + quoteRank(s);
    }
    if (s === q) return 0;
    // The typed coin with a quote (SOL → SOLUSDT, SOL-USD, SOLUSD_PERP) before other coins that start alike (SOLV…).
    const after = s.slice(q.length);
    const rest = after.replace(/^[-_]/, "").replace(/_PERP$/, "");
    // A separator (ETH-GBP, BTCUSD_PERP) or a known quote right after the typed text means it is that coin.
    if (s.startsWith(q) && (/^[-_]/.test(after) || QUOTES.includes(rest))) return 50 + (QUOTES.includes(rest) ? QUOTES.indexOf(rest) : QUOTES.length);
    if (s.startsWith(q)) return 100 + quoteRank(s) * 10 + Math.min(9, s.length - q.length);
    if (s.includes(q)) return 300 + s.indexOf(q);
    if (it.label?.toUpperCase().includes(q)) return 500;
    return null;
  };
  return items
    .map((it) => ({ it, s: score(it) }))
    .filter((x): x is { it: SymbolItem; s: number } => x.s !== null)
    .sort((a, b) => Number(!!a.it.inactive) - Number(!!b.it.inactive) || a.s - b.s || a.it.symbol.localeCompare(b.it.symbol))
    .slice(0, limit)
    .map((x) => x.it);
}

export class SymbolLists {
  private cache = new Map<string, { at: number; items?: SymbolItem[]; loading?: Promise<SymbolItem[]> }>();
  /** A cached list, loading it once (concurrent callers share the load). */
  async list(key: string, load: Loader): Promise<SymbolItem[]> {
    const hit = this.cache.get(key);
    if (hit?.items && Date.now() - hit.at < TTL) return hit.items;
    if (hit?.loading) return hit.loading;
    const loading = load().then(
      (items) => (this.cache.set(key, { at: Date.now(), items }), items),
      (e) => {
        this.cache.delete(key);
        throw e;
      },
    );
    this.cache.set(key, { at: Date.now(), loading });
    return loading;
  }
}
