import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, hash } from "../server/store.ts";
function setup(t: any) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "herdr-lab-test-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new Store(root);
}
function annotate(
  store: Store,
  sid: string,
  aid: string,
  quote = "Selected source",
) {
  const s = store.get(sid);
  store.annotate(sid, s.revision, {
    artifactId: aid,
    anchor: { page: 2, quote, rect: [0.1, 0.2, 0.3, 0.4], rotation: 0 },
    comment: "Check timing assumption",
  });
  return store.get(sid).annotations.at(-1)!;
}
test("strategy capabilities isolate every resource and launcher is not a strategy key", (t) => {
  const db = setup(t),
    a = db.create("A"),
    b = db.create("B");
  assert.throws(() => db.auth(db.db.tokens[a.id], b.id));
  assert.throws(() => db.auth(db.db.rootToken, a.id));
  assert.throws(() => db.auth(db.db.tokens[a.id]));
  db.import(a.id, a.revision, "paper.txt", Buffer.from("secret"));
  const artifact = db.get(a.id).artifacts[0];
  assert.throws(() => db.artifact(b, artifact.id));
  assert.throws(() => db.bytes(b, artifact.id));
  assert.throws(() =>
    db.annotate(b.id, b.revision, {
      artifactId: artifact.id,
      anchor: { page: 1, quote: "secret", rotation: 0 },
      comment: "x",
    }),
  );
});
test("all seven scopes persist with stable sessions, page/layout/drafts and park", (t) => {
  const db = setup(t),
    s = db.create("Persist");
  const ids = Object.values(s.tabs).map((t) => t.sessionId);
  assert.equal(new Set(ids).size, 7);
  db.change(s.id, s.revision, (s) => {
    s.lifecycle = "parked";
    s.tabs.Literature.page = 4;
    s.tabs.Literature.notes = "durable";
    s.tabs.Literature.width = 51;
    s.tabs.Literature.draft = "question";
  });
  const restored = new Store(db.root).get(s.id);
  assert.equal(restored.lifecycle, "parked");
  assert.equal(restored.tabs.Literature.notes, "durable");
  assert.equal(restored.tabs.Literature.page, 4);
  assert.equal(restored.tabs.Literature.width, 51);
  assert.equal(restored.tabs.Literature.draft, "question");
  assert.deepEqual(
    Object.values(restored.tabs).map((t) => t.sessionId),
    ids,
  );
});
test("optimistic conflicts cannot overwrite notes or annotation edits", (t) => {
  const db = setup(t),
    s = db.create("Conflict");
  db.change(s.id, 1, (s) => {
    s.tabs.Ideas.notes = "first";
  });
  assert.throws(
    () =>
      db.change(s.id, 1, (s) => {
        s.tabs.Ideas.notes = "stale";
      }),
    /changed in another view/,
  );
  assert.equal(db.get(s.id).tabs.Ideas.notes, "first");
});
test("originals remain byte-identical and multi-document batches freeze versions/anchors", (t) => {
  const db = setup(t),
    s = db.create("Review");
  const bytes = Buffer.from("First paper bytes");
  db.import(s.id, s.revision, "a.txt", bytes);
  db.import(s.id, db.get(s.id).revision, "b.txt", Buffer.from("Second paper"));
  let state = db.get(s.id);
  const [a, b] = state.artifacts;
  const n1 = annotate(db, s.id, a.id),
    n2 = annotate(db, s.id, b.id, "Second quote");
  db.batch(s.id, db.get(s.id).revision, {
    annotationIds: [n1.id, n2.id],
    destination: "Literature",
    instruction: "Compare",
  });
  state = db.get(s.id);
  const batch = structuredClone(state.batches[0]);
  assert.equal(batch.documents.length, 2);
  assert.equal(batch.behavior, "followUp");
  assert.equal(batch.annotations[1].anchor.page, 2);
  assert.deepEqual(batch.annotations[0].anchor.rect, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(batch.hash, hash(batch.prompt));
  db.annotate(s.id, state.revision, {
    id: n1.id,
    artifactId: a.id,
    anchor: { page: 1, quote: "changed", rotation: 0 },
    comment: "new version",
  });
  assert.deepEqual(db.get(s.id).batches[0], batch);
  assert.equal(db.get(s.id).annotations[0].version, 2);
  assert.deepEqual(db.bytes(db.get(s.id), a.id), bytes);
  assert.equal(a.hash, hash(bytes));
  assert.deepEqual(new Store(db.root).get(s.id).batches[0], batch);
});
test("traversal, hidden names and symlink blobs are denied", (t) => {
  const db = setup(t),
    s = db.create("Safe");
  for (const name of ["../x", "x/y", "x\\y", ".runtime", "bad\0name"])
    assert.throws(() => db.import(s.id, s.revision, name, Buffer.from("x")));
  for (const parts of [[".."], ["/tmp"], ["hello/../../"]])
    assert.throws(() => db.safe(...parts));
  db.import(s.id, s.revision, "safe.txt", Buffer.from("x"));
  const a = db.get(s.id).artifacts[0];
  const blob = path.join(db.storage.artifactBlobs(s.id).root, a.hash);
  fs.unlinkSync(blob);
  fs.symlinkSync("/etc/passwd", blob);
  assert.throws(() => db.bytes(db.get(s.id), a.id), /Symlink/);
});
test("symlink strategy directories and state file denied", (t) => {
  const db = setup(t),
    s = db.create("Safe");
  const referenceRoot = path.join(
    db.storage.strategyRoot(s.id),
    "Reference-Papers",
  );
  fs.rmdirSync(referenceRoot);
  fs.symlinkSync(os.tmpdir(), referenceRoot);
  assert.throws(
    () => db.import(s.id, s.revision, "test.txt", Buffer.from("x")),
    /Symlink/,
  );
  fs.unlinkSync(path.join(db.root, "state.json"));
  fs.symlinkSync("/etc/passwd", path.join(db.root, "state.json"));
  assert.throws(() => new Store(db.root), /Symlink/);
});
test("integrity mismatch, oversized input and invalid rectangles reject visibly", (t) => {
  const db = setup(t),
    s = db.create("Limits");
  assert.throws(
    () => db.import(s.id, s.revision, "big.txt", Buffer.alloc(1024 * 1024 + 1)),
    /1 MiB/,
  );
  db.import(s.id, s.revision, "a.txt", Buffer.from("test"));
  const a = db.get(s.id).artifacts[0];
  assert.throws(() =>
    db.annotate(s.id, db.get(s.id).revision, {
      artifactId: a.id,
      anchor: { page: 1, quote: "", rect: [0.8, 0.8, 0.5, 0.5], rotation: 0 },
      comment: "bad",
    }),
  );
  fs.writeFileSync(
    path.join(db.storage.artifactBlobs(s.id).root, a.hash),
    "tampered",
  );
  assert.throws(() => db.bytes(db.get(s.id), a.id), /integrity/);
});
test("restart never replays pending or accepted submissions", (t) => {
  const db = setup(t),
    s = db.create("Restart");
  db.discussion(s.id, s.revision, {
    destination: "Ideas",
    instruction: "/llama not a command",
  });
  const batch = db.get(s.id).batches[0];
  assert.match(batch.prompt, /RESEARCH DISCUSSION/);
  assert.ok(!batch.prompt.startsWith("/"));
  db.delivery(s.id, batch.id, { status: "accepted/queued" });
  const restored = new Store(db.root).get(s.id).batches[0];
  assert.equal(restored.status, "delivery-uncertain");
  assert.equal(restored.attempts, 0);
});
test("unsafe active formats are download-only and event history is bounded", (t) => {
  const db = setup(t),
    s = db.create("Formats");
  db.import(
    s.id,
    s.revision,
    "danger.svg",
    Buffer.from('<svg onload="alert(1)"/>'),
  );
  assert.equal(db.get(s.id).artifacts[0].kind, "unsupported");
  for (let i = 0; i < 500; i++) db.event(db.get(s.id), "test");
  assert.equal(db.get(s.id).events.length, 250);
});
