import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../server/store.ts";
import { contentHash } from "../server/durable.ts";
import { fixture, version } from "./platform-fixtures.ts";

const blobDir = (store: Store, sid: string) => store.storage.artifactBlobs(sid).root;
function source(store: Store, sid: string, name: string, text: string) {
  store.import(sid, store.get(sid).revision, name, Buffer.from(text));
  return store.get(sid).artifacts.at(-1)!;
}
function note(store: Store, sid: string, artifactId: string) {
  store.annotate(sid, store.get(sid).revision, {
    artifactId,
    anchor: { page: 1, quote: "passage", rotation: 0 },
    comment: "comment",
  });
  return store.get(sid).annotations.at(-1)!;
}
const remove = (x: ReturnType<typeof fixture>, sid: string, aid: string) =>
  x.store.removeArtifact(sid, x.store.get(sid).revision, aid, (ids) => x.platform.citations(sid, ids));

test("deleting moves a source and its annotations to recently deleted; undo restores the exact identity", (t) => {
  const x = fixture(t);
  const s = x.store.create("Deletion");
  const a = source(x.store, s.id, "OscarXue_MasterThesis.pdf.txt", "thesis");
  const b = source(x.store, s.id, "b.txt", "paper B");
  const n = note(x.store, s.id, a.id);
  x.store.change(s.id, x.store.get(s.id).revision, (st) => {
    st.tabs.Literature.open = [a.id, b.id];
    st.tabs.Literature.selected = a.id;
  });

  const result = remove(x, s.id, a.id);
  assert.deepEqual([result.removed, result.artifactId, result.annotationsRemoved], [a.name, a.id, 1]);
  let after = x.store.get(s.id);
  assert.deepEqual(after.artifacts.map((v) => v.name), ["b.txt"]);
  assert.equal(after.annotations.length, 0);
  assert.deepEqual(after.tabs.Literature.open, [b.id]);
  assert.equal(after.tabs.Literature.selected, "");
  assert.equal(after.deleted?.[0].artifact.id, a.id);
  assert.equal(fs.existsSync(path.join(blobDir(x.store, s.id), a.hash)), true, "bytes kept while restorable");
  // Restart: recently deleted is validated on load and undo still works from the new instance.
  const reopened = new Store(x.root);
  assert.equal(reopened.get(s.id).deleted?.length, 1, "recently deleted survives restart and validation");

  const restored = reopened.restoreArtifact(s.id, reopened.get(s.id).revision, a.id);
  assert.deepEqual([restored.restored, restored.annotationsRestored], [a.name, 1]);
  after = reopened.get(s.id);
  assert.deepEqual(after.artifacts.find((v) => v.id === a.id), a, "same id, hash and timestamps");
  assert.deepEqual(after.annotations.find((v) => v.id === n.id), n, "annotation identity preserved");
  assert.equal(after.deleted?.length, 0);
  assert.equal(reopened.bytes(after, a.id).toString(), "thesis");
  assert.match(after.events.at(-1)!.text, /Restored project file/);
  assert.throws(() => reopened.restoreArtifact(s.id, after.revision, a.id), /no longer in recently deleted/);
  assert.equal(new Store(x.root).get(s.id).artifacts.length, 2, "store reloads with integrity checks after restore");
});

test("recently deleted keeps the last 20; purged entries lose their bytes unless shared", (t) => {
  const x = fixture(t);
  const s = x.store.create("Purge");
  const first = source(x.store, s.id, "first.txt", "unique first");
  const shared = source(x.store, s.id, "shared.txt", "shared bytes");
  source(x.store, s.id, "shared twin.txt", "shared bytes");
  remove(x, s.id, first.id);
  remove(x, s.id, shared.id);
  for (let i = 0; i < 20; i++) remove(x, s.id, source(x.store, s.id, `n${i}.txt`, `filler ${i}`).id);
  const after = x.store.get(s.id);
  assert.equal(after.deleted?.length, 20);
  assert.equal(after.deleted?.some((d) => d.artifact.id === first.id), false, "oldest purged");
  assert.equal(fs.existsSync(path.join(blobDir(x.store, s.id), first.hash)), false, "purged unique bytes removed");
  assert.equal(fs.existsSync(path.join(blobDir(x.store, s.id), shared.hash)), true, "bytes shared with a live source kept");
});

test("sources in frozen batches or cited by scientific records cannot be deleted", (t) => {
  const x = fixture(t);
  const s = x.store.create("Protected");
  const frozen = source(x.store, s.id, "frozen.txt", "frozen paper");
  const n = note(x.store, s.id, frozen.id);
  x.store.batch(s.id, x.store.get(s.id).revision, {
    annotationIds: [n.id],
    destination: "Ideas",
    instruction: "Review",
  });
  assert.throws(() => remove(x, s.id, frozen.id), /frozen review batch/);

  const cited = source(x.store, s.id, "cited.txt", "cited paper");
  const idea1 = version(x.platform, s.id, {
    kind: "idea",
    content: {
      title: "Idea",
      rationale: "Because",
      universe: "BTC",
      horizon: "Daily",
      falsification: "Drawdown floor breached",
      uncertainty: "conjectured",
      evidence: [{ category: "cited", reference: { id: cited.id, hash: cited.hash }, description: "p.4" }],
    },
  });
  assert.throws(() => remove(x, s.id, cited.id), new RegExp(`cited by idea v1 \\(${idea1.id.slice(0, 8)}\\)`));

  const viaNote = source(x.store, s.id, "annotated.txt", "annotated paper");
  const citedNote = note(x.store, s.id, viaNote.id);
  const idea2 = version(x.platform, s.id, {
    kind: "idea",
    content: {
      title: "Idea 2",
      rationale: "Because",
      universe: "BTC",
      horizon: "Daily",
      falsification: "x",
      uncertainty: "cited",
      evidence: [{ category: "cited", reference: { id: citedNote.id, hash: contentHash(citedNote) }, description: "note" }],
    },
  });
  assert.throws(
    () => remove(x, s.id, viaNote.id),
    new RegExp(`cited by idea v1 \\(${idea2.id.slice(0, 8)}\\)`),
    "citing one of its annotations protects the source",
  );

  const before = x.store.get(s.id);
  assert.equal(before.artifacts.length, 3, "refusals change nothing");
  assert.throws(() => x.store.removeArtifact(s.id, before.revision - 1, viaNote.id, () => []), /changed in another view/);
});

import { researchRequest } from "../desktop/research-routes.ts";
test("desktop allowlist admits source deletion only for strategies, with exactly a revision", () => {
  const id = "12345678-1234-4234-8234-123456789abc", aid = "87654321-4321-4321-8321-cba987654321";
  const req = (scope: any, body: unknown, tail = `/artifacts/${aid}/delete`) =>
    researchRequest(scope, {
      path: `/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}/${id}${tail}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
  assert.equal(req({ kind: "strategy", id }, { revision: 3 }), true);
  assert.throws(() => req({ kind: "strategy", id }, { revision: 3, force: true }));
  assert.throws(() => req({ kind: "strategy", id }, { revision: -1 }));
  assert.notEqual(req({ kind: "portfolio", id }, { revision: 3 }), true);
  assert.notEqual(req({ kind: "strategy", id }, { revision: 3 }, `/artifacts/../delete`), true);
});

import { researchDTO, sourceRefusal } from "../desktop/protocol.ts";
test("refusal reasons cross the desktop boundary only as strictly shaped data", () => {
  const route = "/api/strategies/12345678-1234-4234-8234-123456789abc/artifacts/87654321-4321-4321-8321-cba987654321/delete";
  const body = (v: unknown) => new TextEncoder().encode(JSON.stringify({ error: "private /Users/x/path detail", refusal: v }));
  assert.deepEqual(sourceRefusal(body({ code: "cited", records: ["idea v1 (1a2b3c4d)"] }), route), { code: "cited", records: ["idea v1 (1a2b3c4d)"] });
  assert.deepEqual(sourceRefusal(body({ code: "frozen-batch", batch: "abcdef0123" }), route), { code: "frozen-batch", batch: "abcdef0123" });
  assert.equal(sourceRefusal(body({ code: "cited", records: ["/Users/oscar/secret.txt"] }), route), undefined);
  assert.equal(sourceRefusal(body({ code: "cited", records: ["idea v1 (1a2b3c4d)"], extra: "x" }), route), undefined);
  assert.equal(sourceRefusal(body({ code: "frozen-batch", batch: "abc" }), route.replace("/delete", "/annotations")), undefined, "other routes never pass refusals");
  assert.deepEqual(researchDTO({ removed: "a.pdf", artifactId: "i", annotationsRemoved: 1, revision: 4, secret: "t" }, route), {
    removed: "a.pdf",
    artifactId: "i",
    annotationsRemoved: 1,
    revision: 4,
  });
});

test("notes can be removed (un-highlighted) and edited unless a scientific record cites them", (t) => {
  const x = fixture(t);
  const s = x.store.create("Notes");
  const paper = source(x.store, s.id, "paper.txt", "paper");
  const hl = note(x.store, s.id, paper.id);
  const removed = x.store.removeAnnotation(s.id, x.store.get(s.id).revision, hl.id, (ids) => x.platform.citations(s.id, ids));
  assert.equal(removed.removed, hl.id);
  assert.deepEqual(removed.annotation, { artifactId: paper.id, anchor: hl.anchor, comment: hl.comment, status: hl.status });
  assert.equal(x.store.get(s.id).annotations.length, 0);
  assert.match(x.store.get(s.id).events.at(-1)!.text, /Removed annotation on paper\.txt, page 1/);
  assert.throws(() => x.store.removeAnnotation(s.id, x.store.get(s.id).revision, hl.id, () => []), /not found/);

  const kept = note(x.store, s.id, paper.id);
  version(x.platform, s.id, {
    kind: "idea",
    content: {
      title: "Idea",
      rationale: "r",
      universe: "u",
      horizon: "h",
      falsification: "f",
      uncertainty: "cited",
      evidence: [{ category: "cited", reference: { id: kept.id, hash: contentHash(kept) }, description: "note" }],
    },
  });
  const cite = (ids: Set<string>) => x.platform.citations(s.id, ids);
  assert.throws(() => x.store.removeAnnotation(s.id, x.store.get(s.id).revision, kept.id, cite), /cited by idea v1/);
  assert.throws(
    () =>
      x.store.annotate(s.id, x.store.get(s.id).revision, { id: kept.id, artifactId: paper.id, anchor: kept.anchor, comment: "edited", status: "draft" }, cite),
    /save a new note instead/,
  );
  assert.equal(x.store.get(s.id).annotations[0].comment, kept.comment, "refused edit changes nothing");

  const free = note(x.store, s.id, paper.id);
  x.store.annotate(s.id, x.store.get(s.id).revision, { id: free.id, artifactId: paper.id, anchor: free.anchor, comment: "now a comment", status: "addressed" }, cite);
  const edited = x.store.get(s.id).annotations.find((n) => n.id === free.id)!;
  assert.deepEqual([edited.comment, edited.status, edited.version, edited.created], ["now a comment", "addressed", 2, free.created]);
});

test("annotation refusals pass the desktop boundary; the delete route is allowlisted", () => {
  const sid = "12345678-1234-4234-8234-123456789abc", nid = "87654321-4321-4321-8321-cba987654321";
  const route = `/api/strategies/${sid}/annotations/${nid}/delete`;
  const body = new TextEncoder().encode(JSON.stringify({ refusal: { code: "cited", records: ["idea v1 (1a2b3c4d)"] } }));
  assert.deepEqual(sourceRefusal(body, route), { code: "cited", records: ["idea v1 (1a2b3c4d)"] });
  assert.deepEqual(sourceRefusal(body, `/api/strategies/${sid}/annotations`), { code: "cited", records: ["idea v1 (1a2b3c4d)"] }, "edit refusal");
  assert.equal(
    researchRequest({ kind: "strategy", id: sid }, {
      path: route,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ revision: 2 })),
    }),
    true,
  );
});
