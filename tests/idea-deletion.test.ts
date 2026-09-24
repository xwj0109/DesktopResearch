import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { command, fixture, spec, version } from "./platform-fixtures.ts";
import { sourceRefusal } from "../desktop/protocol.ts";

const idea = (title: string, evidence: any[] = []) => ({
  kind: "idea" as const,
  content: { title, rationale: "r", universe: "BTC", horizon: "daily", falsification: "f", uncertainty: "conjectured" as const, evidence },
});
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e;
  }
  assert.fail("expected a refusal");
};

test("archived ideas can be deleted for good: versions, decisions and stored text go; citations block it", (t) => {
  const x = fixture(t);
  const s = x.store.create("Ideas");
  const j = () => (x.platform as any).science(s.id);
  const blobPath = (h: string) => path.join(j().blobs.root, h);

  const a1 = version(x.platform, s.id, idea("Kelly with a drawdown cap"));
  const a2 = version(x.platform, s.id, idea("Kelly with a 30% drawdown cap"), a1.id);
  command(x.platform, s.id, { type: "idea.decide", target: a2, decision: "pursue", reason: "clean test" });
  // Another idea cites A's exact version as evidence.
  const b = version(x.platform, s.id, idea("Kelly on ETH", [{ category: "derived", reference: a2, description: "same rule" }]));

  const cited = refused(() => command(x.platform, s.id, { type: "idea.delete", id: a1.id }));
  assert.equal(cited.status, 409);
  assert.deepEqual(cited.refusal, { code: "cited", records: [`idea v1 (${b.id.slice(0, 8)})`] });
  assert.equal(j().state.versions.length, 3, "refusal changes nothing");

  command(x.platform, s.id, { type: "idea.delete", id: b.id });
  assert.equal(fs.existsSync(blobPath(b.hash)), false, "B's text is erased");

  const before = j().revision;
  command(x.platform, s.id, { type: "idea.delete", id: a1.id });
  const st = j().state;
  assert.deepEqual(st.versions, []);
  assert.deepEqual(st.decisions, []);
  assert.equal(fs.existsSync(blobPath(a1.hash)) || fs.existsSync(blobPath(a2.hash)), false, "all of A's versions are erased");
  assert.equal(j().revision, before + 1);
  assert.equal(j().events.at(-1).type, "idea.delete", "the deletion itself is journaled");
  j().replay();
  assert.deepEqual(j().state.versions, [], "journal still replays after the text is erased");

  // Only ideas, only this strategy's.
  const sp = version(x.platform, s.id, spec);
  assert.equal(refused(() => command(x.platform, s.id, { type: "idea.delete", id: sp.id })).status, 400);
  assert.equal(refused(() => command(x.platform, s.id, { type: "idea.delete", id: a1.id })).status, 404);

  // Identical content in two records shares one blob: deleting one keeps it for the other.
  const c = version(x.platform, s.id, idea("Twin"));
  const d = version(x.platform, s.id, idea("Twin"));
  assert.equal(c.hash, d.hash);
  command(x.platform, s.id, { type: "idea.delete", id: c.id });
  assert.equal(fs.existsSync(blobPath(d.hash)), true);
  assert.equal((x.platform.versionContent(s.id, d).value.content as { title: string }).title, "Twin");
});

test("idea deletion refusals cross the desktop boundary only as validated data", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const route = "/api/strategies/12345678-1234-4234-8234-123456789abc/science/commands";
  assert.deepEqual(sourceRefusal(enc({ error: "x", refusal: { code: "cited", records: ["idea v1 (1a2b3c4d)", "handoffs (0f0f0f0f)"] } }), route), {
    code: "cited",
    records: ["idea v1 (1a2b3c4d)", "handoffs (0f0f0f0f)"],
  });
  assert.equal(sourceRefusal(enc({ refusal: { code: "cited", records: ["/Users/secret path"] } }), route), undefined);
});
