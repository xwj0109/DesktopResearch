import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { MAX_BODY } from "./contracts.ts";

/** Explicit, user-initiated paper retrieval for the Sources pane.
 *
 * The renderer has no network access. This runs in Electron main only when the
 * user asks, and accepts an arXiv identifier/link or an https link to a PDF.
 * Every hop (including redirects) must be https to a public address; bodies are
 * size-capped, time-limited and must be a real PDF. The bytes are then imported
 * through the ordinary immutable-artifact route; nothing is sent to Pi. */

export interface PaperSource {
  kind: "arxiv" | "url";
  /** arXiv identifier (without version unless one was given), or the https URL. */
  ref: string;
}
export interface FetchedPaper {
  name: string;
  bytes: Uint8Array;
  source: string;
  title?: string;
  authors?: string[];
  published?: string;
  arxivId?: string;
}
export interface PaperDeps {
  fetch: typeof fetch;
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

const NEW_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_ID = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);

/** Parse one user-entered reference. Throws with a readable reason. */
export function parsePaperSource(input: string): PaperSource {
  const text = input.trim().replace(/^arxiv:\s*/i, "");
  if (!text || text.length > 2048) throw new Error("Enter an arXiv ID or an https link");
  const id = text.match(NEW_ID) ?? text.match(OLD_ID);
  if (id) return { kind: "arxiv", ref: id[1] + (id[2] ?? "") };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Not an arXiv ID or link: ${text.slice(0, 60)}`);
  }
  if (ARXIV_HOSTS.has(url.hostname)) {
    const m = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/);
    const found = m && (m[1].match(NEW_ID) ?? m[1].match(OLD_ID));
    if (found) return { kind: "arxiv", ref: found[1] + (found[2] ?? "") };
    throw new Error("Unrecognised arXiv link; use an /abs/ or /pdf/ link");
  }
  if (url.protocol !== "https:") throw new Error("Only https links are allowed");
  if (url.username || url.password) throw new Error("Links with credentials are not allowed");
  return { kind: "url", ref: url.href };
}

/** Split a pasted list ("2609.22612, 1206.2305 …" or one per line). */
export function parsePaperList(input: string): PaperSource[] {
  const parts = input.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) throw new Error("Enter an arXiv ID or an https link");
  if (parts.length > 10) throw new Error("Add at most 10 papers at a time");
  return parts.map(parsePaperSource);
}

/** Loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !(
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe8") ||
      v.startsWith("fe9") ||
      v.startsWith("fea") ||
      v.startsWith("feb") ||
      v.startsWith("ff")
    );
  }
  return false;
}

async function assertPublicHost(url: URL, deps: PaperDeps) {
  if (url.protocol !== "https:") throw new Error("Redirected away from https; refused");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await deps.lookup(host);
  if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address)))
    throw new Error(`${url.hostname} is not a public internet address; refused`);
}

/** GET with manual redirects (each hop re-checked), timeout and a byte cap. */
async function get(href: string, deps: PaperDeps, accept: string): Promise<{ url: string; bytes: Uint8Array; type: string }> {
  const max = deps.maxBytes ?? MAX_BODY;
  let url = new URL(href);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30000);
  try {
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicHost(url, deps);
      const response = await deps.fetch(url.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept, "user-agent": "PiResearch/0.1 (paper import; user-initiated)" },
        credentials: "omit",
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        if (!next) throw new Error("Redirect without a location");
        url = new URL(next, url);
        continue;
      }
      if (!response.ok) throw new Error(`${url.hostname} answered ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > max) throw new Error("Paper exceeds the 20 MiB import limit");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel();
          throw new Error("Paper exceeds the 20 MiB import limit");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      return { url: url.href, bytes, type: response.headers.get("content-type") ?? "" };
    }
    throw new Error("Too many redirects");
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error("Download timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const isPdf = (b: Uint8Array) => b.length > 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-";

/** Plain visible filename accepted by the artifact store (≤180 chars, no path characters). */
export function paperFilename(stem: string, suffix = ""): string {
  const clean = stem
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const tail = `${suffix}.pdf`;
  return (clean.slice(0, 180 - tail.length).trim() || "paper") + tail;
}

const safeChar = (n: number) =>
  n > 0x1f && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : undefined;
function decodeXml(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeChar(parseInt(h, 16)) ?? m)
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(Number(d)) ?? m)
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
/** Title, authors and date from an arXiv Atom entry (no XML dependency). */
export function parseArxivEntry(atom: string) {
  const entry = atom.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return undefined;
  const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
  if (!title || /^Error$/i.test(decodeXml(title))) return undefined;
  return {
    title: decodeXml(title),
    authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeXml(m[1])),
    published: entry.match(/<published>([^<]+)<\/published>/)?.[1],
  };
}

export async function fetchPaper(source: PaperSource, deps: PaperDeps): Promise<FetchedPaper> {
  if (source.kind === "arxiv") {
    let meta: ReturnType<typeof parseArxivEntry>;
    try {
      const atom = await get(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(source.ref)}`,
        { ...deps, maxBytes: 1024 * 1024 },
        "application/atom+xml",
      );
      meta = parseArxivEntry(new TextDecoder().decode(atom.bytes));
    } catch {
      meta = undefined; // Metadata is a convenience; the PDF itself is authoritative.
    }
    const pdf = await get(`https://arxiv.org/pdf/${source.ref}`, deps, "application/pdf");
    if (!isPdf(pdf.bytes)) throw new Error(`arXiv ${source.ref} did not return a PDF`);
    const surname = meta?.authors[0]?.split(" ").at(-1);
    const year = meta?.published?.slice(0, 4);
    const stem = meta
      ? `${[surname, meta.authors.length > 1 ? "et al." : "", year].filter(Boolean).join(" ")} - ${meta.title}`
      : `arXiv ${source.ref}`;
    return {
      name: paperFilename(stem, meta ? ` (arXiv ${source.ref.replace("/", "-")})` : ""),
      bytes: pdf.bytes,
      source: pdf.url,
      arxivId: source.ref,
      ...(meta ?? {}),
    };
  }
  const pdf = await get(source.ref, deps, "application/pdf");
  if (!isPdf(pdf.bytes))
    throw new Error("That link did not return a PDF (it may be a landing page; use the direct PDF link)");
  const last = decodeURIComponent(new URL(pdf.url).pathname.split("/").filter(Boolean).at(-1) ?? "paper");
  return { name: paperFilename(last.replace(/\.pdf$/i, "")), bytes: pdf.bytes, source: pdf.url };
}

export const defaultPaperDeps = (): PaperDeps => ({
  fetch: globalThis.fetch,
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
});

/* ── arXiv search suggestions ─────────────────────────────────────────────
 * Typing title or author words in Add papers asks arXiv's public API for
 * matching papers. Only the words (never library contents) go to
 * export.arxiv.org, from main, at most one request every three seconds as
 * arXiv asks; results are cached and a newer query supersedes a waiting one.
 * Picking a suggestion is still an explicit import through fetchPaper. */

export interface PaperHit {
  /** arXiv identifier without version. */
  id: string;
  title: string;
  authors: string[];
  /** Total author count (authors is capped). */
  authorCount: number;
  year?: string;
  category?: string;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from in into is it of on or the to with via its their this that".split(" "),
);
const looksLikeReference = (token: string) =>
  /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(token) ||
  /^[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?$/i.test(token) ||
  /^https?:\/\//i.test(token);

/** Words typed in Add papers → an arXiv `search_query`, or undefined when the
 * text is IDs/links (those are imported, not searched) or too short.
 * Plain words must each match a title or an author; `au:`/`ti:` narrow one. */
export function arxivSearchQuery(text: string): string | undefined {
  const raw = text.trim();
  if (raw.length < 3 || raw.length > 300) return undefined;
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  if (tokens.every(looksLikeReference)) return undefined;
  const clauses: string[] = [];
  for (const token of tokens) {
    if (looksLikeReference(token)) continue;
    const field = token.match(/^(au|ti):(.*)$/i);
    const words = (field ? field[2] : token)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    for (const w of words) {
      if (clauses.length >= 8) break;
      clauses.push(field ? `${field[1].toLowerCase()}:${w}` : `(ti:${w} OR au:${w})`);
    }
  }
  return clauses.length ? clauses.join(" AND ") : undefined;
}

const bounded = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** Every entry of an arXiv Atom feed, bounded for the renderer. */
export function parseArxivFeed(atom: string, limit = 8): PaperHit[] {
  const hits: PaperHit[] = [];
  for (const m of atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (hits.length >= limit) break;
    const entry = m[1];
    const abs = entry.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)\s*<\/id>/)?.[1] ?? "";
    const id = abs.match(NEW_ID) ?? abs.match(OLD_ID);
    const meta = parseArxivEntry(`<entry>${entry}</entry>`);
    if (!id || !meta) continue;
    hits.push({
      id: id[1],
      title: bounded(meta.title, 300),
      authors: meta.authors.slice(0, 6).map((a) => bounded(a, 80)),
      authorCount: meta.authors.length,
      year: meta.published?.match(/^\d{4}/)?.[0],
      category: entry.match(/<arxiv:primary_category[^>]*term="([^"]{1,40})"/)?.[1],
    });
  }
  return hits;
}

export async function searchArxiv(query: string, deps: PaperDeps, limit = 8): Promise<PaperHit[]> {
  const params = new URLSearchParams({
    search_query: query,
    start: "0",
    max_results: String(limit),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const atom = await get(
    `https://export.arxiv.org/api/query?${params}`,
    { ...deps, maxBytes: 1024 * 1024, timeoutMs: deps.timeoutMs ?? 15000 },
    "application/atom+xml",
  );
  return parseArxivFeed(new TextDecoder().decode(atom.bytes), limit);
}

/** Polite shared searcher: one request at a time, `gapMs` apart, cached, and
 * per-caller superseding (a waiting query is dropped, resolving to null, when
 * the same caller asks again). */
export function createPaperSearch(deps: () => PaperDeps, gapMs = 3000, backoffMs = 10000, now = () => Date.now()) {
  const cache = new Map<string, PaperHit[]>();
  const latest = new Map<unknown, object>();
  let chain: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return async (caller: unknown, text: string): Promise<PaperHit[] | null> => {
    const query = arxivSearchQuery(text);
    if (!query) return [];
    const hit = cache.get(query);
    if (hit) return hit;
    const ticket = {};
    latest.set(caller, ticket);
    const run = chain.then(async () => {
      if (latest.get(caller) !== ticket) return null;
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      if (latest.get(caller) !== ticket) return null;
      last = now();
      try {
        const hits = await searchArxiv(query, deps());
        cache.set(query, hits);
        if (cache.size > 100) cache.delete(cache.keys().next().value!);
        last = now();
        return hits;
      } catch (error) {
        // Throttled: back off well beyond the usual gap before asking again.
        const throttled = /answered (429|503)/.test(String((error as Error)?.message));
        last = now() + (throttled ? backoffMs : 0);
        throw throttled ? new Error("arXiv is limiting requests right now; suggestions resume in a few seconds") : error;
      } finally {
        if (latest.get(caller) === ticket) latest.delete(caller);
      }
    });
    chain = run.catch(() => {});
    return run;
  };
}
