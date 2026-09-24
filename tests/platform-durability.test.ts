import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Store } from "../server/store.ts";
import { Platform } from "../server/platform.ts";
import {
  Journal,
  canonical,
  contentHash,
  digest,
  safePath,
} from "../server/durable.ts";
import {
  fixture,
  pipeline,
  command,
  version,
  spec,
} from "./platform-fixtures.ts";
function temp(t: any) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lab-migrate-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function legacy(t: any) {
  const { store } = fixture(t),
    s = store.create("M1 preserved");
  store.import(s.id, 1, "source.txt", Buffer.from("Immutable source bytes\n"));
  let current = store.get(s.id);
  store.annotate(s.id, current.revision, {
    artifactId: current.artifacts[0].id,
    anchor: {
      page: 2,
      quote: "Immutable",
      rotation: 0,
      rect: [0.1, 0.2, 0.3, 0.4],
    },
    comment: "Original comment",
  });
  current = store.get(s.id);
  store.batch(s.id, current.revision, {
    annotationIds: [current.annotations[0].id],
    destination: "Literature",
    instruction: "Exact original request",
  });
  current = store.get(s.id);
  store.change(s.id, current.revision, (s) => {
    const t = s.tabs.Literature;
    t.open = [s.artifacts[0].id];
    t.selected = s.artifacts[0].id;
    t.commentDraft = "unsaved";
    t.commentAnchor = { page: 2, quote: "Immutable", rotation: 0 };
    t.editingAnnotationId = s.annotations[0].id;
    t.draft = "original draft";
  });
  const db = structuredClone(store.db),
    root = temp(t),
    source = JSON.stringify(db, null, 2);
  fs.writeFileSync(path.join(root, "state.json"), source);
  for (const strategy of Object.values(db.strategies)) {
    fs.mkdirSync(path.join(root, strategy.id));
    for (const a of strategy.artifacts)
      fs.writeFileSync(
        path.join(root, strategy.id, a.hash),
        store.bytes(strategy, a.id),
      );
  }
  return { root, db, source, sid: s.id };
}
test("v1 migration preserves every ID, capability, draft/anchor/edit identity, exact immutable batch and original bytes", (t) => {
  const x = legacy(t),
    migrated = new Store(x.root);
  assert.deepEqual(migrated.db, x.db);
  assert.equal(
    fs.readFileSync(path.join(x.root, "state.json"), "utf8"),
    x.source,
  );
  assert.equal(
    fs.readFileSync(
      path.join(x.root, `migration-v1-${digest(x.source)}.json`),
      "utf8",
    ),
    x.source,
  );
  const s = migrated.get(x.sid);
  assert.equal(
    migrated.bytes(s, s.artifacts[0].id).toString(),
    "Immutable source bytes\n",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(x.root, "catalog.json"), "utf8"),
  );
  assert.equal(manifest.version, 2);
  assert.ok(
    fs.existsSync(
      path.join(
        migrated.storage.strategyRoot(x.sid),
        "meta",
        "companion-blobs",
        manifest.strategies[x.sid],
      ),
    ),
  );
  migrated.change(s.id, s.revision, (s) => {
    s.tabs.Ideas.notes = "new canonical write";
  });
  const restarted = new Store(x.root);
  assert.equal(restarted.get(s.id).tabs.Ideas.notes, "new canonical write");
  assert.equal(
    fs.readFileSync(path.join(x.root, "state.json"), "utf8"),
    x.source,
  );
});
test("migration interruption before switch retries staged blobs safely without touching source or losing M1", (t) => {
  const x = legacy(t),
    rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === path.join(x.root, "catalog.json"))
      throw new Error("Injected interruption before authority publication");
    return rename(from, to);
  };
  try {
    assert.throws(() => new Store(x.root), /Injected interruption/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.existsSync(path.join(x.root, "catalog.json")), false);
  assert.equal(
    fs.readFileSync(path.join(x.root, "state.json"), "utf8"),
    x.source,
  );
  const migrated = new Store(x.root);
  assert.deepEqual(migrated.db, x.db);
  assert.equal(
    fs.readFileSync(path.join(x.root, "state.json"), "utf8"),
    x.source,
  );
});
test("unknown/corrupt v1 versions, identities, batch hashes and original bytes fail before authority switch", (t) => {
  for (const mutation of ["version", "identity", "batch", "bytes"]) {
    const x = legacy(t),
      db = structuredClone(x.db);
    if (mutation === "version") (db as any).version = 99;
    if (mutation === "identity") db.strategies[x.sid].id = randomUUID();
    if (mutation === "batch")
      db.strategies[x.sid].batches[0].prompt += "tamper";
    fs.writeFileSync(path.join(x.root, "state.json"), JSON.stringify(db));
    if (mutation === "bytes")
      fs.writeFileSync(
        path.join(x.root, x.sid, db.strategies[x.sid].artifacts[0].hash),
        "corrupt",
      );
    assert.throws(() => new Store(x.root));
    assert.equal(fs.existsSync(path.join(x.root, "catalog.json")), false);
  }
});
test("journal is authority, snapshots rebuild, committed projection failure is not rolled back and operation retry is idempotent", (t) => {
  const root = temp(t),
    schema = z.object({ value: z.number() }).strict(),
    j = new Journal(root, schema, { value: 0 }),
    op = randomUUID();
  const snapshot = path.join(root, "snapshot.json");
  fs.symlinkSync(path.join(root, "absent"), snapshot);
  j.commit(op, 0, "set", { value: 1 }, { value: 1 });
  assert.equal(j.revision, 1);
  assert.equal(j.state.value, 1);
  assert.match(j.warning!, /committed/);
  j.commit(op, 0, "set", { value: 1 }, { value: 999 });
  assert.equal(j.revision, 1);
  assert.equal(j.state.value, 1);
  assert.throws(
    () => j.commit(op, 0, "set", { value: 2 }, { value: 2 }),
    /reused/,
  );
  fs.unlinkSync(snapshot);
  fs.writeFileSync(snapshot, "manually edited projection");
  const restored = new Journal(root, schema, { value: 0 });
  assert.equal(restored.state.value, 1);
  restored.project();
  assert.equal(JSON.parse(fs.readFileSync(snapshot, "utf8")).projection, true);
  assert.equal(JSON.parse(fs.readFileSync(snapshot, "utf8")).state.value, 1);
});
test("scientific journals reject stale writers, gaps, tampering, dangling symlinks and oversized metadata", (t) => {
  const root = temp(t),
    schema = z.object({ value: z.string() }).strict(),
    a = new Journal(root, schema, { value: "" }),
    b = new Journal(root, schema, { value: "" });
  a.commit(randomUUID(), 0, "set", "a", { value: "a" });
  assert.throws(
    () => b.commit(randomUUID(), 0, "set", "b", { value: "b" }),
    /Another view/,
  );
  assert.throws(
    () =>
      a.commit(
        randomUUID(),
        1,
        "large",
        {},
        { value: "a".repeat(4 * 1024 * 1024) },
      ),
    /4 MiB/,
  );
  const event = path.join(root, "journal", "00000001.json"),
    bytes = fs.readFileSync(event, "utf8");
  const record = JSON.parse(bytes);
  record.type = "tampered";
  fs.writeFileSync(event, JSON.stringify(record));
  assert.throws(() => new Journal(root, schema, { value: "" }), /integrity/);
  fs.writeFileSync(event, bytes);
  fs.renameSync(event, path.join(root, "journal", "00000002.json"));
  assert.throws(() => new Journal(root, schema, { value: "" }), /gap/);
  fs.renameSync(path.join(root, "journal", "00000002.json"), event);
  fs.unlinkSync(event);
  fs.symlinkSync(path.join(root, "dangling"), event);
  assert.throws(() => new Journal(root, schema, { value: "" }), /Symlink/);
});
test("independent process cannot acquire an owned runtime root and stale Store cannot overwrite a newer catalog", (t) => {
  const { root, store } = fixture(t),
    s = store.create("Owner");
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { Store } from './server/store.ts'; new Store(${JSON.stringify(root)});`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Another server owns/);
  const second = new Store(root);
  second.change(s.id, second.get(s.id).revision, (s) => {
    s.tabs.Ideas.notes = "winner";
  });
  assert.throws(
    () =>
      store.change(s.id, s.revision, (s) => {
        s.tabs.Ideas.notes = "stale";
      }),
    /another Store/,
  );
  assert.equal(new Store(root).get(s.id).tabs.Ideas.notes, "winner");
});
test("replayed scientific and portfolio state verifies blobs and preserves immutable outputs/imports", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Persist science"),
    f = pipeline(p, s.id);
  const r = command(p, s.id, { type: "run.queue", config: f.config }).state
    .runs[0];
  await p.idle();
  const e = command(p, s.id, {
    type: "export.create",
    runId: r.id,
    limitations: ["Synthetic fixture"],
  }).state.exports[0];
  const pid = p.createPortfolio("Frozen").id;
  p.portfolioCommand(pid, {
    operationId: randomUUID(),
    revision: 0,
    command: { type: "import.add", package: p.exportPackage(s.id, e.id) },
  });
  await p.close();
  const restored = new Platform(store);
  assert.deepEqual(
    restored.runDetails(s.id, r.id).output,
    p.runDetails(s.id, r.id).output,
  );
  assert.deepEqual(
    restored.exportPackage(s.id, e.id),
    p.exportPackage(s.id, e.id),
  );
  assert.equal(restored.portfolioView(pid).state.imports.length, 1);
  await restored.close();
  const science = path.join(
      store.storage.strategyRoot(s.id),
      "meta",
      "science",
    ),
    v = p.strategyView(s.id).state.versions[0];
  fs.writeFileSync(path.join(science, "blobs", v.blob), "corruption");
  assert.throws(() => new Platform(store), /integrity/);
});
test("Finder metadata in a user-visible data folder does not break journals or blob quotas", (t) => {
  const root = temp(t),
    schema = z.object({ value: z.number() }).strict(),
    j = new Journal(root, schema, { value: 0 });
  j.commit(randomUUID(), 0, "set", { value: 1 }, { value: 1 });
  for (const dir of ["journal", "blobs"]) {
    fs.writeFileSync(path.join(root, dir, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(root, dir, "._00000001.json"), "fork");
  }
  const reopened = new Journal(root, schema, { value: 0 });
  assert.equal(reopened.state.value, 1, "replay ignores OS metadata");
  reopened.commit(randomUUID(), 1, "set", { value: 2 }, { value: 2 });
  assert.equal(reopened.revision, 2, "commit count ignores OS metadata");
  fs.writeFileSync(path.join(root, "journal", "notes.txt"), "stray");
  assert.throws(() => new Journal(root, schema, { value: 0 }), /unknown file/, "real stray files still fail");
});
