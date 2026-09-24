import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Journal, own, Blobs } from "../server/durable.ts";
import { Store } from "../server/store.ts";
import { simulate } from "../server/reference-engine.ts";
import {
  fixture,
  pipeline,
  command,
  conventions,
} from "./platform-fixtures.ts";
test("published but directory-sync-uncertain catalog keeps old generation blobs and fail-stops further writes", (t) => {
  const { store } = fixture(t),
    s = store.create("Durability"),
    catalog = path.join(store.root, "catalog.json"),
    old = fs.readFileSync(catalog, "utf8"),
    oldHash = JSON.parse(old).strategies[s.id],
    rename = fs.renameSync,
    sync = fs.fsyncSync;
  let published = false;
  fs.renameSync = (a, b) => {
    rename(a, b);
    if (String(b) === catalog) published = true;
  };
  fs.fsyncSync = (fd) => {
    if (published && fs.fstatSync(fd).isDirectory())
      throw new Error("Injected catalog directory fsync failure");
    sync(fd);
  };
  try {
    store.change(s.id, s.revision, (s) => {
      s.tabs.Ideas.notes = "published, not falsely rolled back";
    });
  } finally {
    fs.renameSync = rename;
    fs.fsyncSync = sync;
  }
  assert.equal(
    store.get(s.id).tabs.Ideas.notes,
    "published, not falsely rolled back",
  );
  assert.match(store.storage.warning!, /uncertain/);
  assert.ok(fs.existsSync(path.join(store.storage.blobs(s.id).root, oldHash)));
  assert.throws(
    () =>
      store.change(s.id, store.get(s.id).revision, (s) => {
        s.tabs.Ideas.notes = "must fail-stop";
      }),
    /durability uncertain/,
  );
  assert.equal(
    store.get(s.id).tabs.Ideas.notes,
    "published, not falsely rolled back",
  );
  fs.writeFileSync(catalog, old);
  assert.equal(new Store(store.root).get(s.id).tabs.Ideas.notes, "");
});
test("uncertain journal publication remains committed in memory, retry deduplicates, later mutations fail-stop", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lab-journal-sync-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const j = new Journal(root, z.object({ n: z.number() }).strict(), { n: 0 }),
    op = randomUUID(),
    rename = fs.renameSync,
    sync = fs.fsyncSync;
  let published = false;
  fs.renameSync = (a, b) => {
    rename(a, b);
    if (String(b).endsWith("00000001.json")) published = true;
  };
  fs.fsyncSync = (fd) => {
    if (published && fs.fstatSync(fd).isDirectory())
      throw new Error("Injected sync failure");
    sync(fd);
  };
  try {
    j.commit(op, 0, "increment", {}, { n: 1 });
  } finally {
    fs.renameSync = rename;
    fs.fsyncSync = sync;
  }
  assert.equal(j.state.n, 1);
  assert.equal(j.revision, 1);
  assert.match(j.warning!, /directory sync failed/);
  j.commit(op, 0, "increment", {}, { n: 2 });
  assert.equal(j.state.n, 1);
  assert.throws(
    () => j.commit(randomUUID(), 1, "increment", {}, { n: 2 }),
    /durability uncertain/,
  );
  const restored = new Journal(root, z.object({ n: z.number() }).strict(), {
    n: 0,
  });
  assert.equal(restored.state.n, 1);
});
test("ownership acquisition serializes stale replacement and publication fences lost ownership", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lab-lock-recovery-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = JSON.stringify({ pid: 999999999, nonce: randomUUID() });
  fs.writeFileSync(path.join(root, "writer.lock"), old);
  fs.mkdirSync(path.join(root, "writer-acquisition.lock"));
  assert.throws(() => own(root), /acquisition/);
  assert.equal(fs.readFileSync(path.join(root, "writer.lock"), "utf8"), old);
  fs.rmdirSync(path.join(root, "writer-acquisition.lock"));
  own(root);
  const blobs = new Blobs(path.join(root, "blobs"));
  fs.writeFileSync(
    path.join(root, "writer.lock"),
    JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
  );
  assert.throws(() => blobs.put("must not publish"), /ownership changed/);
  assert.equal(fs.readdirSync(blobs.root).length, 0);
});
test("many malformed CSV rows remain a bounded rejected dataset, not a schema exception", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Malformed CSV"),
    f = pipeline(
      p,
      s.id,
      "date,close,signal\n" + Array(120).fill("invalid,row").join("\n"),
    );
  assert.equal(f.d.status, "rejected");
  assert.ok(f.d.findings.length <= 54);
  assert.ok(f.d.findings.some((f) => f.includes("stopped")));
  assert.equal(p.datasetSource(s.id, f.d.id).csv.split("\n").length, 121);
});
test("moving-average calculations remain correct at large finite prices and nonzero subnormal prices", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Stable MA"),
    f = pipeline(p, s.id);
  const config = {
    ...f.config,
    rule: "moving-average" as const,
    feeBps: 0,
    slippageBps: 0,
    start: "2026-01-01",
    end: "2026-01-03",
  };
  const a = await simulate(
    [
      { date: "2026-01-01", close: 1e308 },
      { date: "2026-01-02", close: 1.1e308 },
      { date: "2026-01-03", close: 1.2e308 },
    ],
    config,
    conventions,
  );
  assert.equal(a.points[1].position, 1);
  assert.ok(Math.abs(a.points[1].return - 1 / 11) < 1e-12);
  const tiny = await simulate(
    [
      { date: "2026-01-01", close: Number.MIN_VALUE },
      { date: "2026-01-02", close: Number.MIN_VALUE },
      { date: "2026-01-03", close: Number.MIN_VALUE },
    ],
    config,
    conventions,
  );
  assert.equal(tiny.points[1].position, 0);
  assert.equal(tiny.metrics.totalReturn, 0);
});
