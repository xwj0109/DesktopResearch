import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Platform } from "../server/platform.ts";
import { Journal } from "../server/durable.ts";
import { scienceSchema } from "../server/platform-schema.ts";
import {
  fixture,
  pipeline,
  command,
  spec,
  version,
} from "./platform-fixtures.ts";
test("cancelling a running job persists cancellation and never publishes partial output", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Cancel running"),
    f = pipeline(p, s.id);
  const run = command(p, s.id, { type: "run.queue", config: f.config }).state
    .runs[0];
  await new Promise((r) => setImmediate(r));
  assert.equal(p.runDetails(s.id, run.id).run.status, "running");
  command(p, s.id, { type: "run.cancel", runId: run.id });
  await p.idle();
  const d = p.runDetails(s.id, run.id);
  assert.deepEqual(
    d.run.history.map((h) => h.status),
    ["queued", "running", "cancelled"],
  );
  assert.equal(d.output, null);
  assert.equal(d.evidence.checksPassedAtVersion, null);
  assert.throws(
    () =>
      command(p, s.id, {
        type: "export.create",
        runId: run.id,
        limitations: ["Cannot export partial data"],
      }),
    /Completed/,
  );
});
test("insolvent experiment fails honestly and remains in trial history without successful output", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Failed trial"),
    f = pipeline(
      p,
      s.id,
      "date,close,signal\n2026-01-01,100,-1\n2026-01-02,1000,-1\n2026-01-03,99,0\n2026-01-04,108.9,1\n2026-01-05,98.01,1",
    );
  const r = command(p, s.id, { type: "run.queue", config: f.config }).state
    .runs[0];
  await p.idle();
  const d = p.runDetails(s.id, r.id);
  assert.equal(d.run.status, "failed");
  assert.match(d.run.history.at(-1)!.detail, /insolvent/);
  assert.equal(d.output, null);
  assert.equal(d.evidence.checksExecuted, true);
  assert.equal(d.evidence.checksPassedAtVersion, null);
});
test("restart converts persisted queued/running uncertainty to interrupted exactly once and never reruns", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Crash recovery"),
    f = pipeline(p, s.id);
  const r = command(p, s.id, { type: "run.queue", config: f.config }).state
    .runs[0];
  await p.idle();
  await p.close();
  const root = path.join(store.storage.strategyRoot(s.id), "meta", "science"),
    j = new Journal(root, scienceSchema, p.strategyView(s.id).state),
    next = structuredClone(j.state);
  next.runs[0].status = "running";
  next.runs[0].history = [
    {
      status: "queued",
      at: new Date().toISOString(),
      detail: "Simulated persisted input",
    },
    {
      status: "running",
      at: new Date().toISOString(),
      detail: "Simulated process death before output publication",
    },
  ];
  next.runs[0].outputHash = null;
  j.commit(randomUUID(), j.revision, "fixture.crash", {}, next);
  const restored = new Platform(store);
  assert.equal(restored.runDetails(s.id, r.id).run.status, "interrupted");
  assert.equal(
    restored.runDetails(s.id, r.id).run.history.at(-1)!.status,
    "interrupted",
  );
  assert.equal(restored.jobStatus().active, 0);
  assert.equal(restored.jobStatus().queued, 0);
  const rev = restored.strategyView(s.id).revision;
  await restored.close();
  const again = new Platform(store);
  assert.equal(again.strategyView(s.id).revision, rev);
  await again.close();
});
test("scientific symlink descendants and UI recovery bounds fail closed", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Boundaries"),
    sr = version(p, s.id, spec);
  const jroot = path.join(store.storage.strategyRoot(s.id), "meta", "science"),
    blob = p.versionContent(s.id, sr).meta.blob;
  fs.unlinkSync(path.join(jroot, "blobs", blob));
  fs.symlinkSync(path.join(jroot, "absent"), path.join(jroot, "blobs", blob));
  assert.throws(() => p.versionContent(s.id, sr), /Symlink/);
  const drafts = Array.from({ length: 5 }, () => ({
    id: randomUUID(),
    kind: "code",
    base: null,
    text: "a".repeat(128000),
  }));
  assert.throws(
    () => p.saveUI(s.id, { revision: 0, layout: [], drafts }),
    /512 KiB/,
  );
  assert.equal(p.readUI(s.id).revision, 0);
});
