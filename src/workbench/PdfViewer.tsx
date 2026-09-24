import type { SourceNavigation } from "../workbench-contract";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextLayerBuilder } from "pdfjs-dist/web/pdf_viewer.mjs";
import { cleanQuote, findAll, fitScale, locateQuote, normaliseRects, type TextRange } from "./pdfText";

type Rect4 = [number, number, number, number];
export interface PdfSelection {
  page: number;
  quote: string;
  rect?: Rect4;
}
export interface PdfMark {
  id: string;
  page: number;
  quote: string;
  rect?: Rect4;
  comment: string;
}
interface Size {
  w: number;
  h: number;
}
const CSS_PER_PT = 96 / 72;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Text nodes of a rendered pdf.js text layer, in reading order. */
function textNodes(layer: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}
function rangeRects(nodes: Text[], r: TextRange) {
  const range = document.createRange();
  range.setStart(nodes[r.start.piece], r.start.offset);
  range.setEnd(nodes[r.end.piece], r.end.offset);
  return [...range.getClientRects()];
}

/** Copy via a transient textarea: the Clipboard API needs a permission the
 * desktop shell deliberately refuses. */
export function copyText(text: string) {
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  document.execCommand("copy");
  t.remove();
}

/** Continuous, crisp PDF reader: pages render at device pixel density with a
 * selectable pdf.js text layer, lazily as they approach the viewport. Selecting
 * text offers Highlight / Comment / Ask Pi / Copy; saved annotations are drawn
 * back onto the page by re-finding their quote in the text layer. */
export function PdfViewer({
  bytes,
  initialPage = 1,
  navigation,
  onNavigation,
  marks,
  focusMark,
  onPage,
  onAnnotate,
  onAsk,
  onMarkClick,
  onEditMark,
  onRemoveMark,
  readOnly = false,
}: {
  bytes: Uint8Array;
  initialPage?: number;
  navigation?: SourceNavigation;
  onNavigation?: (id: string) => void;
  marks: PdfMark[];
  /** Mark to reveal (scroll to and flash); changes trigger a jump. */
  focusMark?: { id: string; nonce: number };
  onPage?: (page: number) => void;
  onAnnotate: (selection: PdfSelection, comment: string) => Promise<void>;
  onAsk?: (selection: PdfSelection) => void;
  onMarkClick?: (id: string) => void;
  /** Replace a note's comment ("Highlight" when left empty). */
  onEditMark?: (id: string, comment: string) => Promise<void>;
  onRemoveMark?: (id: string) => Promise<void>;
  /** Preview mode (Quick Look): read, select and copy only; no note menus. */
  readOnly?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const pdfjs = useRef<any>(null);
  const textLayerBuilder = useRef<typeof TextLayerBuilder | null>(null);
  const rendered = useRef(new Map<number, { scale: number; task?: any; layer?: TextLayerBuilder; token: number; ready?: boolean }>());
  const tokens = useRef(0);
  const [doc, setDoc] = useState<any>();
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [dark, setDark] = useState(false);
  const [menu, setMenu] = useState<{ sel: PdfSelection; x: number; y: number; commenting: boolean; overlaps: string[] } | null>(null);
  const [markMenu, setMarkMenu] = useState<{ id: string; x: number; y: number; editing: boolean } | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState({ query: "", hits: [] as { page: number; index: number }[], current: -1 });
  const [query, setQuery] = useState("");
  const findState = useRef(find);
  const findRequest = useRef(0);
  const requestedOccurrence = useRef<number | undefined>(undefined);
  const appliedNavigation = useRef<string | undefined>(undefined);
  const findTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchPages = useRef(new Map<number, Promise<string[]>>());
  const paintLatest = useRef<(n: number) => void>(() => {});
  const [flash, setFlash] = useState<string>();
  /** Find hit waiting to be scrolled to once its page is painted. */
  const reveal = useRef<{ page: number; index: number } | null>(null);
  const revealHit = useRef(() => {});
  const anchor = useRef<{ page: number; fraction: number } | null>(null);
  const didInitialJump = useRef(false);

  const maxW = sizes.length ? Math.max(...sizes.map((s) => s.w)) : 612;
  const scale = zoom === "fit" ? fitScale(width, maxW) : zoom * CSS_PER_PT;
  const percent = Math.round((scale / CSS_PER_PT) * 100);

  // Load once per document.
  useEffect(() => {
    searchPages.current.clear();
    let cancelled = false,
      task: any;
    (async () => {
      const [lib, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      if (cancelled) return;
      // The distributed viewer component resolves its PDF.js API through this
      // global; load it only after installing the matching library version.
      (globalThis as typeof globalThis & { pdfjsLib?: typeof lib }).pdfjsLib = lib;
      const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");
      if (cancelled) return;
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
      const pdf = await task.promise;
      const out: Size[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const v = (await pdf.getPage(i)).getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
      }
      if (cancelled) return;
      pdfjs.current = lib;
      textLayerBuilder.current = viewer.TextLayerBuilder;
      setSizes(out);
      setDoc(pdf);
    })().catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      ++findRequest.current;
      clearTimeout(findTimer.current);
      void task?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Debounced: dragging the pane splitter must not re-render every pixel.
    let timer: ReturnType<typeof setTimeout> | undefined,
      first = true;
    const ro = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      const w = entry.contentRect.width;
      timer = setTimeout(() => setWidth(w), first ? 0 : 160);
      first = false;
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const pageTop = (n: number) => pageEls.current[n - 1]?.offsetTop ?? 0;
  const goTo = useCallback((n: number, smooth = false) => {
    const el = scroller.current,
      target = pageEls.current[n - 1];
    if (el && target) {
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTo({ top: top - 8, behavior: smooth ? "smooth" : "instant" });
    }
  }, []);

  // Keep the reading position when the scale changes.
  const setScaleKeepingPlace = (next: "fit" | number) => {
    const el = scroller.current;
    if (el) {
      const n = page,
        top = pageTop(n),
        h = pageEls.current[n - 1]?.offsetHeight || 1;
      anchor.current = { page: n, fraction: (el.scrollTop - top) / h };
    }
    setZoom(next);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    if (!didInitialJump.current) {
      didInitialJump.current = true;
      if (initialPage > 1) goTo(Math.min(initialPage, sizes.length));
      return;
    }
    const a = anchor.current;
    if (a) {
      el.scrollTop = pageTop(a.page) + a.fraction * (pageEls.current[a.page - 1]?.offsetHeight ?? 0);
      anchor.current = null;
    }
  }, [scale, sizes.length]);

  /** Paint saved highlights and find hits on one rendered page. */
  const paint = useCallback(
    (n: number) => {
      const el = pageEls.current[n - 1];
      const layer = el?.querySelector(".pdf-marks");
      const text = el?.querySelector(".textLayer");
      if (!el || !layer || !text) return;
      layer.replaceChildren();
      const nodes = textNodes(text);
      const pieces = nodes.map((t) => t.data);
      const box = el.getBoundingClientRect();
      const draw = (rects: DOMRect[] | { left: number; top: number; width: number; height: number }[], cls: string, title?: string, id?: string) => {
        for (const r of rects) {
          const d = document.createElement("div");
          d.className = cls;
          d.style.left = `${r.left - box.left}px`;
          d.style.top = `${r.top - box.top}px`;
          d.style.width = `${r.width}px`;
          d.style.height = `${r.height}px`;
          if (title) d.title = title;
          if (id) d.dataset.mark = id;
          layer.appendChild(d);
        }
      };
      for (const m of marks.filter((m) => m.page === n)) {
        const found = m.quote.trim() ? locateQuote(pieces, m.quote) : undefined;
        const cls = `pdf-mark ${m.comment === "Highlight" ? "plain" : "noted"} ${flash === m.id ? "flash" : ""}`;
        if (found) draw(rangeRects(nodes, found), cls, m.comment, m.id);
        else if (m.rect) {
          const [x, y, w, h] = m.rect;
          draw([{ left: box.left + x * box.width, top: box.top + y * box.height, width: w * box.width, height: h * box.height }], cls + " boxed", m.comment, m.id);
        }
      }
      if (find.query) {
        const hits = findAll(pieces, find.query);
        const currentHit = find.hits[find.current];
        hits.forEach((h, i) =>
          draw(rangeRects(nodes, h), `pdf-find ${currentHit && currentHit.page === n && currentHit.index === i ? "current" : ""}`),
        );
      }
    },
    [marks, find, flash],
  );

  paintLatest.current = paint;

  const releasePage = useCallback((n: number) => {
    const previous = rendered.current.get(n);
    previous?.task?.cancel?.();
    previous?.layer?.cancel();
    rendered.current.delete(n);
  }, []);
  useEffect(() => () => {
    for (const n of rendered.current.keys()) releasePage(n);
  }, [releasePage]);

  const renderPage = useCallback(
    async (n: number) => {
      const el = pageEls.current[n - 1];
      if (!doc || !el) return;
      const prev = rendered.current.get(n);
      if (prev?.scale === scale) return;
      releasePage(n);
      const token = ++tokens.current;
      rendered.current.set(n, { scale, token });
      try {
        const p = await doc.getPage(n);
        if (rendered.current.get(n)?.token !== token) return;
        const viewport = p.getViewport({ scale });
        const host = el.querySelector(".pdf-canvas")!;
        // Render at device pixel density (capped) so text is crisp on Retina.
        let ratio = Math.min(window.devicePixelRatio || 1, 3);
        const max = 16_000_000;
        if (viewport.width * viewport.height * ratio * ratio > max)
          ratio = Math.sqrt(max / (viewport.width * viewport.height));
        const next = document.createElement("canvas");
        next.width = Math.floor(viewport.width * ratio);
        next.height = Math.floor(viewport.height * ratio);
        next.style.width = `${viewport.width}px`;
        next.style.height = `${viewport.height}px`;
        const task = p.render({ canvas: next, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        rendered.current.set(n, { scale, task, token });
        await task.promise;
        if (rendered.current.get(n)?.token !== token) return;
        host.replaceChildren(next); // swap only when finished: no blank flash
        const TextLayer = textLayerBuilder.current;
        const textHost = el.querySelector(".pdf-text") as HTMLDivElement;
        if (!TextLayer || !textHost) return;
        const layer = new TextLayer({ pdfPage: p });
        layer.div.style.setProperty("--total-scale-factor", String(scale));
        layer.div.style.setProperty("--scale-round-x", "1px");
        layer.div.style.setProperty("--scale-round-y", "1px");
        textHost.replaceChildren(layer.div);
        rendered.current.set(n, { scale, token, layer });
        await layer.render({ viewport });
        if (rendered.current.get(n)?.token !== token) return;
        rendered.current.set(n, { scale, token, layer, ready: true });
        paintLatest.current(n);
        revealHit.current();
      } catch (e: any) {
        if (rendered.current.get(n)?.token === token) releasePage(n);
      }
    },
    [doc, scale, releasePage],
  );

  // Lazily render pages near the viewport; release far ones to bound memory.
  useEffect(() => {
    const root = scroller.current;
    if (!doc || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) void renderPage(n);
          else if (rendered.current.has(n)) {
            releasePage(n);
            const el = e.target as HTMLElement;
            el.querySelector(".pdf-canvas")?.replaceChildren();
            el.querySelector(".pdf-text")?.replaceChildren();
            el.querySelector(".pdf-marks")?.replaceChildren();
          }
        }
      },
      { root, rootMargin: "1200px 0px" },
    );
    pageEls.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [doc, renderPage, releasePage, sizes.length]);

  // Repaint overlays when annotations or find results change.
  useEffect(() => {
    for (const n of rendered.current.keys()) paint(n);
    revealHit.current();
  }, [paint]);

  // Explicitly render the destination as well as scrolling to it. A distant
  // page must not depend on a prefetch observer callback to reveal its match.
  useEffect(() => {
    const hit = find.hits[find.current];
    if (!hit) return;
    reveal.current = hit;
    revealHit.current();
    void renderPage(hit.page).then(() => revealHit.current());
  }, [find, renderPage, goTo]);

  // Scroll the current find hit to the reading line (not just its page top).
  // An unrendered page is brought in first; painting it calls back here.
  revealHit.current = () => {
    const want = reveal.current,
      el = scroller.current,
      pageEl = pageEls.current[(want?.page ?? 0) - 1];
    if (!want || !el || !pageEl) return;
    const hit = pageEl.querySelector<HTMLElement>(".pdf-find.current");
    if (!hit) {
      // A prefetched page may already be rendering while still off-screen.
      // Bring it into view immediately, then locate the word after painting.
      if (!rendered.current.get(want.page)?.ready) goTo(want.page);
      else {
        // Text layer disagrees with the search index: settle for the page.
        reveal.current = null;
        goTo(want.page, true);
      }
      return;
    }
    reveal.current = null;
    const view = el.getBoundingClientRect(),
      r = hit.getBoundingClientRect();
    const top = r.top - view.top,
      left = r.left - view.left;
    const inView = top >= el.clientHeight * 0.1 && top + r.height <= el.clientHeight * 0.85;
    const inViewX = left >= 0 && left + r.width <= el.clientWidth;
    if (inView && inViewX) return;
    el.scrollTo({
      top: inView ? el.scrollTop : el.scrollTop + top - el.clientHeight * 0.35,
      left: inViewX ? el.scrollLeft : el.scrollLeft + left - el.clientWidth * 0.3,
      behavior: "instant",
    });
  };

  // Reveal a mark chosen from the notes list.
  useEffect(() => {
    if (!focusMark) return;
    const m = marks.find((x) => x.id === focusMark.id);
    if (!m) return;
    goTo(m.page, true);
    setFlash(m.id);
    const t = setTimeout(() => setFlash(undefined), 1600);
    return () => clearTimeout(t);
  }, [focusMark?.nonce]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const y = el.scrollTop + el.clientHeight * 0.3;
    let n = 1;
    for (let i = 0; i < pageEls.current.length; i++) {
      const p = pageEls.current[i];
      if (p && p.offsetTop <= y) n = i + 1;
      else break;
    }
    if (n !== page) {
      setPage(n);
      onPage?.(n);
    }
  };

  /** Turn the current text-layer selection into an anchored selection. */
  const captureSelection = () => {
    if (readOnly) return;
    const sel = window.getSelection();
    const root = scroller.current;
    if (!sel || sel.isCollapsed || !root || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(".pdf-page") as HTMLElement | null;
    if (!start || !root.contains(start)) return;
    const quote = cleanQuote(sel.toString());
    if (!quote) return;
    const box = start.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((r) => r.top < box.bottom && r.bottom > box.top);
    const rect = normaliseRects(rects, box);
    const last = rects.at(-1) ?? range.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    // Existing highlights under the selection can be removed from here.
    const overlaps = [
      ...new Set(
        [...start.querySelectorAll<HTMLElement>("[data-mark]")]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return rects.some((r) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top);
          })
          .map((el) => el.dataset.mark!),
      ),
    ];
    setComment("");
    setMarkMenu(null);
    setMenu({
      sel: { page: Number(start.dataset.page), quote, ...(rect ? { rect } : {}) },
      x: Math.min(Math.max(8, last.left - host.left + root.scrollLeft), root.scrollWidth - 330),
      y: last.bottom - host.top + root.scrollTop + 6,
      commenting: false,
      overlaps,
    });
  };
  const save = async (note: string) => {
    if (!menu) return;
    setBusy(true);
    try {
      await onAnnotate(menu.sel, note);
      window.getSelection()?.removeAllRanges();
      setMenu(null);
    } catch {
      // The pane shows why; keep the menu (and the typed comment) open.
    } finally {
      setBusy(false);
    }
  };

  const commitFind = (next: typeof find) => {
    findState.current = next;
    reveal.current = next.hits[next.current] ?? null;
    setFind(next);
  };

  const runFind = async (text: string, step = 1, occurrence?: number) => {
    clearTimeout(findTimer.current);
    const request = ++findRequest.current;
    if (!doc) return;
    const previous = findState.current;
    if (occurrence === undefined && text === previous.query && previous.hits.length) {
      const current = (previous.current + step + previous.hits.length) % previous.hits.length;
      commitFind({ ...previous, current });
      return;
    }
    const hits: { page: number; index: number }[] = [];
    try {
      if (text.trim()) {
        for (let n = 1; n <= doc.numPages && hits.length < 500; n++) {
          let content = searchPages.current.get(n);
          if (!content) {
            content = doc.getPage(n).then((p: any) => p.getTextContent())
              .then((c: any) => c.items.map((i: any) => i.str ?? ""));
            searchPages.current.set(n, content!);
          }
          const pieces = await content!;
          // Typing, clearing or switching documents invalidates older work.
          if (request !== findRequest.current) return;
          const count = findAll(pieces, text, 500 - hits.length).length;
          for (let index = 0; index < count; index++) hits.push({ page: n, index });
        }
      }
      if (request === findRequest.current)
        commitFind({ query: text, hits, current: hits.length ? Math.min(occurrence ?? (step < 0 ? hits.length - 1 : 0), hits.length - 1) : -1 });
    } catch (e) {
      if (request === findRequest.current) setError(`PDF search failed: ${String(e)}`);
    }
  };

  // A short pause avoids scanning the document for every intermediate keystroke.
  useEffect(() => {
    const occurrence = requestedOccurrence.current;
    findTimer.current = setTimeout(() => {
      requestedOccurrence.current = undefined;
      void runFind(query, 1, occurrence);
    }, 150);
    return () => clearTimeout(findTimer.current);
  }, [query, doc]);

  const changeQuery = (text: string) => {
    ++findRequest.current;
    clearTimeout(findTimer.current);
    setQuery(text);
    commitFind({ query: "", hits: [], current: -1 });
  };

  // ⌘F focuses find; ⌘G / ⇧⌘G step through matches (macOS conventions). Only
  // the reader you are working in answers: a visible one, the Quick Look
  // preview when it is open, the focused one when several are visible.
  const latestFind = useRef({ query, runFind });
  latestFind.current = { query, runFind };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "g" && !(k === "f" && !e.shiftKey)) return;
      const self = root.current;
      if (!self || !self.getClientRects().length) return;
      const preview = document.querySelector(".quicklook");
      const readers = [...document.querySelectorAll(".pdf-viewer")].filter(
        (v) => v.getClientRects().length && (!preview || preview.contains(v)),
      );
      const owner = readers.find((v) => v.contains(document.activeElement)) ?? readers[0];
      if (owner !== self) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "f") {
        findInput.current?.focus();
        findInput.current?.select();
      } else if (latestFind.current.query.trim()) void latestFind.current.runFind(latestFind.current.query, e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!doc || !navigation || appliedNavigation.current === navigation.id) return;
    appliedNavigation.current = navigation.id;
    if (navigation.query) {
      if (query === navigation.query) void runFind(query, 1, navigation.occurrence ?? 0);
      else {
        requestedOccurrence.current = navigation.occurrence ?? 0;
        changeQuery(navigation.query);
      }
    } else if (navigation.page) {
      changeQuery("");
      goTo(navigation.page);
      setPage(navigation.page);
      onPage?.(navigation.page);
    }
    onNavigation?.(navigation.id);
  }, [navigation?.id, doc]);

  const zoomStep = (dir: 1 | -1) => {
    const now = scale / CSS_PER_PT;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) setScaleKeepingPlace(next);
  };

  return (
    <div className="pdf-viewer" ref={root}>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div
        ref={scroller}
        className={`pdf-scroll ${dark ? "dark-paper" : ""}`}
        tabIndex={0}
        aria-label="PDF document"
        onScroll={onScroll}
        onMouseUp={(e) => {
          const x = e.clientX,
            y = e.clientY;
          setTimeout(() => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return captureSelection();
            // Highlights sit under the text layer; hit-test the click position instead.
            const hit = document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.mark) as HTMLElement | undefined;
            const root = scroller.current;
            if (hit?.dataset.mark && root && !readOnly) {
              const host = root.getBoundingClientRect();
              const b = hit.getBoundingClientRect();
              setMenu(null);
              setComment("");
              setMarkMenu({
                id: hit.dataset.mark,
                x: Math.min(Math.max(8, b.left - host.left + root.scrollLeft), root.scrollWidth - 330),
                y: b.bottom - host.top + root.scrollTop + 6,
                editing: false,
              });
              onMarkClick?.(hit.dataset.mark);
            } else if (!(e.target as HTMLElement).closest?.(".pdf-menu")) setMarkMenu(null);
          }, 0);
        }}
        onKeyUp={(e) => {
          if (e.shiftKey) captureSelection();
        }}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest(".pdf-menu")) {
            if (menu) setMenu(null);
          }
        }}
        onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
          if (e.key === "Escape" && (menu || markMenu)) {
            setMenu(null);
            setMarkMenu(null);
          }
          else if (!e.metaKey && !e.ctrlKey && (e.key === "+" || e.key === "=")) zoomStep(1);
          else if (!e.metaKey && !e.ctrlKey && e.key === "-") zoomStep(-1);
          else if (!e.metaKey && !e.ctrlKey && e.key === "0") setScaleKeepingPlace("fit");
          else return;
          e.preventDefault();
        }}
      >
        {!sizes.length && !error && <p className="note pdf-loading">Loading PDF…</p>}
        <div className="pdf-pages">
          {sizes.map((s, i) => (
            <div
              key={i}
              ref={(el) => {
                pageEls.current[i] = el;
              }}
              className="pdf-page"
              data-page={i + 1}
              style={{ width: s.w * scale, height: s.h * scale }}
              aria-label={`Page ${i + 1}`}
            >
              {/* Children of these three are managed imperatively, never by React. */}
              <div className="pdf-canvas" />
              <div className="pdf-marks" />
              <div className="pdf-text" />
            </div>
          ))}
        </div>
        {menu && (
          <div className="pdf-menu" style={{ left: menu.x, top: menu.y }} role="dialog" aria-label="Selection actions">
            {!menu.commenting ? (
              <>
                {menu.overlaps.length > 0 && onRemoveMark && (
                  <button
                    disabled={busy}
                    className="danger"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        for (const id of menu.overlaps) await onRemoveMark(id);
                        window.getSelection()?.removeAllRanges();
                        setMenu(null);
                      } catch {
                        // Reason shown by the pane; the highlight stays.
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Remove highlight{menu.overlaps.length > 1 ? `s (${menu.overlaps.length})` : ""}
                  </button>
                )}
                <button disabled={busy} onClick={() => void save("Highlight")}>
                  Highlight
                </button>
                <button disabled={busy} onClick={() => setMenu({ ...menu, commenting: true })}>
                  Comment…
                </button>
                {onAsk && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      onAsk(menu.sel);
                      setMenu(null);
                    }}
                  >
                    Ask Pi
                  </button>
                )}
                <button
                  onClick={() => {
                    document.execCommand("copy");
                    setMenu(null);
                  }}
                >
                  Copy
                </button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) void save(comment.trim());
                }}
              >
                <blockquote>“{menu.sel.quote.slice(0, 160)}{menu.sel.quote.length > 160 ? "…" : ""}”</blockquote>
                <textarea
                  autoFocus
                  rows={3}
                  value={comment}
                  placeholder="Research comment on this passage"
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      if (comment.trim()) void save(comment.trim());
                    } else if (e.key === "Escape") setMenu(null);
                  }}
                />
                <div className="row-actions">
                  <button type="button" className="btn small ghost" onClick={() => setMenu(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn small primary" disabled={busy || !comment.trim()}>
                    Save comment
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
        {markMenu &&
          (() => {
            const m = marks.find((x) => x.id === markMenu.id);
            if (!m) return null;
            const plain = m.comment === "Highlight";
            const run = async (fn: () => Promise<void>) => {
              setBusy(true);
              try {
                await fn();
                setMarkMenu(null);
              } catch {
                // Reason shown by the pane; keep the note card open.
              } finally {
                setBusy(false);
              }
            };
            return (
              <div className="pdf-menu note-card" style={{ left: markMenu.x, top: markMenu.y }} role="dialog" aria-label="Note">
                <blockquote>“{m.quote.slice(0, 220)}{m.quote.length > 220 ? "…" : ""}”</blockquote>
                {markMenu.editing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (onEditMark) void run(() => onEditMark(m.id, comment.trim() || "Highlight"));
                    }}
                  >
                    <textarea
                      autoFocus
                      rows={3}
                      value={comment}
                      placeholder="Comment (leave empty to keep it a plain highlight)"
                      onChange={(e) => setComment(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          if (onEditMark) void run(() => onEditMark(m.id, comment.trim() || "Highlight"));
                        } else if (e.key === "Escape") setMarkMenu({ ...markMenu, editing: false });
                      }}
                    />
                    <div className="row-actions">
                      <button type="button" className="btn small ghost" onClick={() => setMarkMenu({ ...markMenu, editing: false })}>
                        Cancel
                      </button>
                      <button type="submit" className="btn small primary" disabled={busy}>
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {!plain && <p className="note-text">{m.comment}</p>}
                    <div className="note-actions">
                      {onEditMark && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setComment(plain ? "" : m.comment);
                            setMarkMenu({ ...markMenu, editing: true });
                          }}
                        >
                          {plain ? "Add comment" : "Edit"}
                        </button>
                      )}
                      {onRemoveMark && (
                        <button disabled={busy} className="danger" onClick={() => void run(() => onRemoveMark(m.id))}>
                          {plain ? "Remove highlight" : "Remove"}
                        </button>
                      )}
                      {onAsk && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            onAsk({ page: m.page, quote: m.quote, ...(m.rect ? { rect: m.rect } : {}) });
                            setMarkMenu(null);
                          }}
                        >
                          Ask Pi
                        </button>
                      )}
                      <button
                        onClick={() => {
                          copyText(m.quote);
                          setMarkMenu(null);
                        }}
                      >
                        Copy quote
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
      </div>
      <div className="doc-toolbar pdf-toolbar">
        <button className="icon-btn" aria-label="Zoom out" onClick={() => zoomStep(-1)}>
          −
        </button>
        <span className="zoom-label">{percent}%</span>
        <button className="icon-btn" aria-label="Zoom in" onClick={() => zoomStep(1)}>
          +
        </button>
        <button
          className={`btn small ${zoom === "fit" ? "primary" : "ghost"}`}
          onClick={() => setScaleKeepingPlace("fit")}
          title="Fit width  (0)"
        >
          fit
        </button>
        <button
          className={`icon-btn ${dark ? "on" : ""}`}
          aria-label={dark ? "Light pages" : "Dark pages"}
          title="Invert page colours for dark themes"
          onClick={() => setDark((d) => !d)}
        >
          ◐
        </button>
        <span className="sep" />
        <form
          className="pdf-findbar"
          onSubmit={(e) => {
            e.preventDefault();
            void runFind(query, 1);
          }}
        >
          <input
            ref={findInput}
            name="q"
            aria-label="Find in document"
            placeholder="find  ⌘F"
            value={query}
            onChange={(e) => changeQuery(e.currentTarget.value)}
            title="⌘F find · ⏎ or ⌘G next match · ⇧⏎ or ⇧⌘G previous · Esc clear, again to return to the paper"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                // First Esc clears; Esc on an empty box returns to the paper.
                if (e.currentTarget.value) changeQuery("");
                else scroller.current?.focus();
              } else if (e.key === "Enter" && e.nativeEvent.isComposing) {
                e.preventDefault();
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                void runFind(e.currentTarget.value, -1);
              }
            }}
          />
          {find.query && (
            <span className="dim">
              {find.hits.length ? `${find.current + 1}/${find.hits.length}` : "0"}
            </span>
          )}
        </form>
      </div>
    </div>
  );
}
