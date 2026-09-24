import test from "node:test";
import assert from "node:assert/strict";
import {
  arxivSearchQuery,
  createPaperSearch,
  fetchPaper,
  isPublicAddress,
  paperFilename,
  parseArxivEntry,
  parseArxivFeed,
  parsePaperList,
  parsePaperSource,
  type PaperDeps,
} from "../desktop/papers.ts";

const PDF = new TextEncoder().encode("%PDF-1.7\n% fixture paper\n%%EOF");
const ATOM = `<feed><entry><id>http://arxiv.org/abs/1206.2305v2</id><published>2012-06-11T00:00:00Z</published>
<title>The numeraire property and long-term growth optimality for
  drawdown-constrained investments</title><author><name>Constantinos Kardaras</name></author>
<author><name>Jan Obloj</name></author><author><name>Eckhard Platen</name></author></entry></feed>`;

/** Scripted network: url → response; every request is recorded. */
function net(routes: Record<string, { status?: number; body?: Uint8Array | string; location?: string; type?: string }>, addresses: Record<string, string> = {}) {
  const seen: string[] = [];
  const deps: PaperDeps = {
    lookup: async (host) => [{ address: addresses[host] ?? "151.101.1.42", family: 4 }],
    fetch: (async (url: string) => {
      seen.push(url);
      const r = routes[url];
      if (!r) return new Response("missing", { status: 404 });
      const headers = new Headers();
      if (r.location) headers.set("location", r.location);
      if (r.type) headers.set("content-type", r.type);
      return new Response((r.body ?? null) as BodyInit | null, { status: r.status ?? 200, headers });
    }) as typeof fetch,
  };
  return { deps, seen };
}

test("paper references: arXiv IDs and links normalise; only https links are accepted", () => {
  assert.deepEqual(parsePaperSource("2609.22612"), { kind: "arxiv", ref: "2609.22612" });
  assert.deepEqual(parsePaperSource("arXiv:1206.2305v2"), { kind: "arxiv", ref: "1206.2305v2" });
  assert.deepEqual(parsePaperSource("https://arxiv.org/abs/1611.07843"), { kind: "arxiv", ref: "1611.07843" });
  assert.deepEqual(parsePaperSource("https://arxiv.org/pdf/1603.06183v1.pdf"), { kind: "arxiv", ref: "1603.06183v1" });
  assert.deepEqual(parsePaperSource("hep-th/9901001"), { kind: "arxiv", ref: "hep-th/9901001" });
  assert.equal(parsePaperSource("https://example.org/papers/x.pdf").kind, "url");
  assert.throws(() => parsePaperSource("http://example.org/x.pdf"), /https/);
  assert.throws(() => parsePaperSource("https://user:pw@example.org/x.pdf"), /credentials/);
  assert.throws(() => parsePaperSource("file:///etc/passwd"), /https/);
  assert.throws(() => parsePaperSource("momentum paper"), /Not an arXiv ID/);
  assert.equal(parsePaperList("2609.22612, 1206.2305\n1611.07843 1603.06183").length, 4);
  assert.throws(() => parsePaperList(Array(11).fill("2609.22612").join(" ")), /at most 10/);
});

test("only public addresses are reachable", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["151.101.1.42", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("arXiv import fetches metadata and PDF, and names the file by author, year and title", async () => {
  const { deps, seen } = net({
    "https://export.arxiv.org/api/query?id_list=1206.2305": { body: ATOM },
    "https://arxiv.org/pdf/1206.2305": { body: PDF, type: "application/pdf" },
  });
  const paper = await fetchPaper(parsePaperSource("1206.2305"), deps);
  assert.equal(paper.name, "Kardaras et al. 2012 - The numeraire property and long-term growth optimality for drawdown-constrained investments (arXiv 1206.2305).pdf");
  assert.deepEqual(paper.authors, ["Constantinos Kardaras", "Jan Obloj", "Eckhard Platen"]);
  assert.deepEqual(paper.bytes, PDF);
  assert.deepEqual(seen, ["https://export.arxiv.org/api/query?id_list=1206.2305", "https://arxiv.org/pdf/1206.2305"]);
});

test("metadata failure still imports the PDF under a plain name", async () => {
  const { deps } = net({ "https://arxiv.org/pdf/2609.22612": { body: PDF } });
  assert.equal((await fetchPaper(parsePaperSource("2609.22612"), deps)).name, "arXiv 2609.22612.pdf");
  assert.equal(parseArxivEntry("<feed><entry><title>Error</title></entry></feed>"), undefined);
});

test("redirects are followed only to public https hosts; non-PDFs and oversize bodies are refused", async () => {
  const ok = net({
    "https://journal.example/p/42": { status: 302, location: "https://cdn.example/files/Optimal%20Paper.pdf" },
    "https://cdn.example/files/Optimal%20Paper.pdf": { body: PDF },
  });
  assert.equal((await fetchPaper(parsePaperSource("https://journal.example/p/42"), ok.deps)).name, "Optimal Paper.pdf");

  const toHttp = net({ "https://journal.example/p/1": { status: 301, location: "http://journal.example/p/1.pdf" } });
  await assert.rejects(fetchPaper(parsePaperSource("https://journal.example/p/1"), toHttp.deps), /https/);

  const toLocal = net(
    { "https://journal.example/p/2": { status: 302, location: "https://internal.example/admin" } },
    { "internal.example": "127.0.0.1" },
  );
  await assert.rejects(fetchPaper(parsePaperSource("https://journal.example/p/2"), toLocal.deps), /not a public/);
  assert.deepEqual(toLocal.seen, ["https://journal.example/p/2"], "private host is never contacted");

  const metadataService = net({}, { "169.254.169.254": "169.254.169.254" });
  await assert.rejects(fetchPaper(parsePaperSource("https://169.254.169.254/latest"), metadataService.deps), /not a public/);
  assert.deepEqual(metadataService.seen, []);

  const html = net({ "https://journal.example/landing": { body: "<html>landing page</html>" } });
  await assert.rejects(fetchPaper(parsePaperSource("https://journal.example/landing"), html.deps), /did not return a PDF/);

  const big = net({ "https://cdn.example/big.pdf": { body: new Uint8Array(4096) } });
  await assert.rejects(fetchPaper(parsePaperSource("https://cdn.example/big.pdf"), { ...big.deps, maxBytes: 1024 }), /20 MiB/);
});

test("filenames are plain and bounded for the artifact store", () => {
  assert.equal(paperFilename("a/b\\c: d?"), "a b c d.pdf");
  assert.equal(paperFilename("...hidden"), "hidden.pdf");
  const long = paperFilename("x".repeat(400), " (arXiv 1)");
  assert.ok(long.length <= 180 && long.endsWith(" (arXiv 1).pdf"));
});

const FEED = `<feed xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/1206.2305v2</id><published>2012-06-11T00:00:00Z</published>
<title>The numeraire property and long-term growth optimality for
  drawdown-constrained investments</title><author><name>Constantinos Kardaras</name></author>
<author><name>Jan Ob&#322;&#243;j</name></author><author><name>Eckhard Platen</name></author>
<arxiv:primary_category term="q-fin.PM" scheme="http://arxiv.org/schemas/atom"/></entry>
<entry><id>http://arxiv.org/abs/math/0512529v1</id><published>2005-12-22T00:00:00Z</published>
<title>A benchmark approach to &amp; finance</title><author><name>Eckhard Platen</name></author></entry>
<entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title></entry></feed>`;

test("arXiv suggestions: typed words become a title-or-author query; IDs and links are not searched", () => {
  assert.equal(arxivSearchQuery("kardaras numeraire"), "(ti:kardaras OR au:kardaras) AND (ti:numeraire OR au:numeraire)");
  assert.equal(arxivSearchQuery("Obłój, the Numéraire"), "(ti:obloj OR au:obloj) AND (ti:numeraire OR au:numeraire)");
  assert.equal(arxivSearchQuery("au:platen ti:benchmark"), "au:platen AND ti:benchmark");
  assert.equal(arxivSearchQuery("drawdown-constrained"), "(ti:drawdown OR au:drawdown) AND (ti:constrained OR au:constrained)");
  for (const skip of ["2609.22612", "arXiv:1206.2305v2 1611.07843", "https://arxiv.org/abs/1611.07843", "hep-th/9901001", "ab", "the of"])
    assert.equal(arxivSearchQuery(skip), undefined, skip);
  // Operators and syntax are stripped: only [a-z0-9] words reach arXiv.
  assert.equal(arxivSearchQuery('") OR au:* (x'), undefined);
  assert.doesNotMatch(arxivSearchQuery('kelly") OR (all:*') ?? "", /["*]|all:/);
  assert.equal(arxivSearchQuery(Array(20).fill("growth").join(" "))!.split(" AND ").length, 8);
});

test("arXiv feed parsing keeps id without version, authors, year and category; skips error entries", () => {
  const hits = parseArxivFeed(FEED);
  assert.deepEqual(hits, [
    {
      id: "1206.2305",
      title: "The numeraire property and long-term growth optimality for drawdown-constrained investments",
      authors: ["Constantinos Kardaras", "Jan Obłój", "Eckhard Platen"],
      authorCount: 3,
      year: "2012",
      category: "q-fin.PM",
    },
    { id: "math/0512529", title: "A benchmark approach to & finance", authors: ["Eckhard Platen"], authorCount: 1, year: "2005", category: undefined },
  ]);
});

test("arXiv search is polite: one request at a time, spaced, cached, and superseded queries never hit the network", async () => {
  const seen: string[] = [];
  const deps: PaperDeps = {
    lookup: async () => [{ address: "151.101.1.42", family: 4 }],
    fetch: (async (url: string) => {
      seen.push(url);
      return new Response(FEED, { status: 200 });
    }) as typeof fetch,
  };
  const search = createPaperSearch(() => deps, 40);
  const a = await search("window-1", "kardaras numeraire");
  assert.equal(a?.[0].id, "1206.2305");
  const url = new URL(seen[0]);
  assert.equal(url.origin + url.pathname, "https://export.arxiv.org/api/query");
  assert.equal(url.searchParams.get("search_query"), "(ti:kardaras OR au:kardaras) AND (ti:numeraire OR au:numeraire)");
  assert.equal(url.searchParams.get("max_results"), "8");

  assert.deepEqual(await search("window-1", "kardaras numeraire"), a, "cached");
  assert.equal(seen.length, 1);

  // Typing on: the first pending query is dropped once the window asks again.
  const started = Date.now();
  const [stale, fresh] = await Promise.all([search("window-1", "platen growth"), search("window-1", "platen benchmark")]);
  assert.equal(stale, null);
  assert.ok(fresh?.length);
  assert.equal(seen.length, 2, "superseded query was never sent");
  assert.match(decodeURIComponent(seen[1]), /benchmark/);
  assert.ok(Date.now() - started >= 30, "requests are spaced by the gap");
  assert.deepEqual(await search("window-2", "2609.22612"), [], "IDs are not searched");

  // Throttling (429) gives a readable reason, is not cached, and backs off.
  let status = 429;
  const throttled: string[] = [];
  const slow = createPaperSearch(
    () => ({ ...deps, fetch: (async (u: string) => (throttled.push(u), new Response(FEED, { status }))) as typeof fetch }),
    0,
    60,
  );
  await assert.rejects(slow("w", "platen growth"), /limiting requests/);
  status = 200;
  const retryStart = Date.now();
  assert.ok((await slow("w", "platen growth"))?.length, "retried, not cached as a failure");
  assert.ok(Date.now() - retryStart >= 50, "backed off after 429");
  assert.equal(throttled.length, 2);
});
