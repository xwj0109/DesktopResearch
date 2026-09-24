/** Pure helpers for anchoring quotes in a pdf.js text layer.
 *
 * Matching ignores whitespace, case, hyphens and diacritics, and decomposes
 * ligatures per character (a PDF's "ﬁ" or "num´eraire" matches "fi" or
 * "numeraire" in a quote), while every matched
 * character still maps back to its original text node and offset. That lets a
 * saved quote be re-highlighted precisely across line breaks and spans. */

export interface TextPoint {
  piece: number;
  offset: number;
}
export interface TextRange {
  start: TextPoint;
  /** Exclusive end. */
  end: TextPoint;
}

interface Folded {
  chars: string;
  map: TextPoint[];
}
function fold(pieces: string[]): Folded {
  let chars = "";
  const map: TextPoint[] = [];
  pieces.forEach((text, piece) => {
    for (let offset = 0; offset < text.length; offset++) {
      // NFKD splits ligatures ("ﬁ" → "fi") and accents ("é", or a PDF's
      // separate "´" before "e") into base + combining marks; drop the marks,
      // whitespace and (soft) hyphens that PDFs insert at line breaks.
      const expanded = text[offset]
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[\p{M}\s\-\u00AD\u2010\u2011]/gu, "");
      for (const c of expanded) {
        chars += c;
        map.push({ piece, offset });
      }
    }
  });
  return { chars, map };
}
export const foldText = (text: string) => fold([text]).chars;

/** All non-overlapping occurrences of `needle` across `pieces`. */
export function findAll(pieces: string[], needle: string, limit = 500): TextRange[] {
  const target = foldText(needle);
  if (!target) return [];
  const { chars, map } = fold(pieces);
  const out: TextRange[] = [];
  for (let at = chars.indexOf(target); at >= 0 && out.length < limit; at = chars.indexOf(target, at + target.length)) {
    const last = map[at + target.length - 1];
    out.push({ start: map[at], end: { piece: last.piece, offset: last.offset + 1 } });
  }
  return out;
}
export const locateQuote = (pieces: string[], quote: string) => findAll(pieces, quote, 1)[0];

/** Union of selection rectangles, normalised to the page box as [x, y, w, h]
 * in 0..1 (the annotation anchor format). Undefined for an empty selection. */
export function normaliseRects(
  rects: { left: number; top: number; right: number; bottom: number }[],
  page: { left: number; top: number; width: number; height: number },
): [number, number, number, number] | undefined {
  const usable = rects.filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5);
  if (!usable.length || page.width <= 0 || page.height <= 0) return undefined;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const x0 = clamp((Math.min(...usable.map((r) => r.left)) - page.left) / page.width);
  const y0 = clamp((Math.min(...usable.map((r) => r.top)) - page.top) / page.height);
  const x1 = clamp((Math.max(...usable.map((r) => r.right)) - page.left) / page.width);
  const y1 = clamp((Math.max(...usable.map((r) => r.bottom)) - page.top) / page.height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return [round(x0), round(y0), Math.max(0.0001, round(x1 - x0)), Math.max(0.0001, round(y1 - y0))];
}

/** Clean a raw text-layer selection into a quote: collapse runs of whitespace
 * and re-join words hyphenated across a line break. */
export function cleanQuote(raw: string) {
  return raw
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

/** CSS-pixel scale that fits the widest page into `width` (with a gutter). */
export function fitScale(width: number, pageWidth: number, gutter = 24) {
  if (width <= 0 || pageWidth <= 0) return 1;
  return Math.max(0.25, Math.min(6, (width - gutter) / pageWidth));
}
