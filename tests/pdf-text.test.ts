import test from "node:test";
import assert from "node:assert/strict";
import { cleanQuote, findAll, fitScale, foldText, locateQuote, normaliseRects } from "../src/workbench/pdfText.ts";

test("quotes are found across text-layer spans, line breaks, case and ligatures", () => {
  // pdf.js splits lines into spans; the PDF uses an "ﬁ" ligature.
  const pieces = ["The drawdown-constrained num", "éraire portfolio is given ex", "plicitly through a ", "model-independent trans", "formation. ﬁnite horizons"];
  const r = locateQuote(pieces, "given explicitly through a model-independent")!;
  assert.deepEqual(r.start, { piece: 1, offset: 20 });
  assert.deepEqual(r.end, { piece: 3, offset: 17 });
  assert.ok(locateQuote(pieces, "FINITE horizons"), "ligature and case folded");
  assert.equal(locateQuote(pieces, "not in the document"), undefined);
  assert.equal(foldText("  A  b\nC "), "abc");
  // Real PDF encodings: a spacing acute before "e", a soft hyphen at a line break.
  assert.ok(locateQuote(["strategies with the num´eraire prop", "erty exist"], "the numeraire property exist"));
  assert.ok(locateQuote(["drawdown-con\u00ADstrained"], "drawdown constrained"));
  assert.ok(locateQuote(["numéraire"], "numeraire"));
});

test("findAll returns every non-overlapping hit in order", () => {
  const hits = findAll(["kelly kelly", " Kelly"], "kelly");
  assert.equal(hits.length, 3);
  assert.deepEqual(hits[2].start, { piece: 1, offset: 1 });
  assert.equal(findAll(["abc"], "   ").length, 0);
});

test("selection rectangles become a normalised union anchor", () => {
  const page = { left: 100, top: 50, width: 400, height: 800 };
  const rect = normaliseRects(
    [
      { left: 140, top: 250, right: 480, bottom: 262 },
      { left: 120, top: 264, right: 300, bottom: 276 },
      { left: 0, top: 0, right: 0.2, bottom: 0.2 },
    ],
    page,
  )!;
  assert.deepEqual(rect, [0.05, 0.25, 0.9, 0.0325]);
  assert.equal(normaliseRects([], page), undefined);
});

test("quotes are cleaned and fit-width scale is bounded", () => {
  assert.equal(cleanQuote("draw-\n down con-\nstrained   growth"), "drawdown constrained growth");
  assert.equal(fitScale(636, 612), 1);
  assert.equal(fitScale(0, 612), 1);
  assert.equal(fitScale(100000, 612), 6);
});
