import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../server/store.ts";
import { Rpc } from "../server/rpc.ts";
import { PiPool } from "../server/pi.ts";
const fixture = path.resolve("tests/fake-rpc.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error("Fixture condition timed out");
}
function setup(t: any, args: string[] = []) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lab-reliability-")),
    ),
    store = new Store(root);
  let prompts = 0,
    launches = 0;
  const p = new PiPool(store, process.execPath, (_exe, _args, cwd, env) => {
    launches++;
    const rpc = new Rpc(
      spawn(process.execPath, [fixture, ...args], { cwd, env, stdio: "pipe" }),
      15000,
      150,
    );
    const request = rpc.request.bind(rpc);
    rpc.request = (type, fields, id) => {
      if (type === "prompt") prompts++;
      return request(type, fields, id);
    };
    return rpc;
  });
  t.after(async () => {
    await p.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = store.create("Reliability");
  store.change(s.id, s.revision, (s) => {
    s.tabs.Ideas.provider = "test";
    s.tabs.Ideas.model = "fixture";
  });
  const draft = (instruction: string) => {
    store.discussion(s.id, store.get(s.id).revision, {
      destination: "Ideas",
      instruction,
    });
    return store.get(s.id).batches.at(-1)!.id;
  };
  return {
    store,
    p,
    s,
    draft,
    prompts: () => prompts,
    launches: () => launches,
  };
}
for (const stage of ["pending", "requestId"] as const)
  test(`published-but-uncertain ${stage} never authorizes a Pi prompt or rollback`, async (t) => {
    const x = setup(t), bid = x.draft("Do not send without durable audit trail");
    await x.p.handshake(x.s.id, "Ideas");
    const rename = fs.renameSync, sync = fs.fsyncSync;
    let published = false;
    fs.renameSync = (from, to) => {
      rename(from, to);
      const b = x.store.get(x.s.id).batches[0];
      if (String(to) === path.join(x.store.root, "catalog.json") &&
          b.status === "pending" && (stage === "pending" || !!b.requestId)) published = true;
    };
    fs.fsyncSync = fd => {
      if (published && fs.fstatSync(fd).isDirectory()) throw new Error("Injected directory fsync uncertainty");
      sync(fd);
    };
    try {
      if (stage === "pending") await assert.rejects(x.p.send(x.s.id, bid), /durability uncertain/);
      else await x.p.send(x.s.id, bid);
      await until(() => published && x.p.info().active === 0);
    } finally { fs.renameSync = rename; fs.fsyncSync = sync; }
    assert.equal(x.prompts(), 0);
    const saved = x.store.get(x.s.id).batches[0];
    assert.equal(saved.status, "pending");
    assert.equal(saved.attempts, 1);
    if (stage === "requestId") assert.ok(saved.requestId);
    assert.match(x.p.warning(x.s.id)!, /persistence failed/);
    await assert.rejects(x.p.send(x.s.id, bid), /durability uncertain/);
    assert.equal(new Store(x.store.root).get(x.s.id).batches[0].status, "delivery-uncertain");
    assert.equal(x.prompts(), 0);
  });
for (const command of [
  "null",
  "scalar",
  "missing_success",
  "string_success",
  "wrong_command",
])
  test(`invalid RPC ${command} fails closed, never accepted`, async (t) => {
    const r = Rpc.launch(process.execPath, [fixture], process.cwd());
    t.after(() => r.close());
    await assert.rejects(r.request(command), /invalid/);
    await r.exited;
    assert.equal(r.didExit, true);
  });
test("throwing closed observers cannot bypass process termination", async (t) => {
  const r = new Rpc(
    spawn(process.execPath, [fixture, "--stubborn"], { stdio: "pipe" }),
    15000,
    100,
  );
  t.after(() => r.close());
  await r.request("get_state");
  r.on("closed", () => {
    throw new Error("Injected observer failure");
  });
  await r.close();
  assert.equal(r.didExit, true);
});
test("duplicate terminal event is idempotent and malformed prompt ACK is uncertain", async (t) => {
  const x = setup(t);
  const a = x.draft("[DUPLICATE]");
  await x.p.send(x.s.id, a);
  await until(() => x.store.get(x.s.id).batches[0].status === "completed");
  assert.equal(
    x.store.get(x.s.id).batches[0].response,
    "Fixture response, not real inference.\n",
  );
  const b = x.draft("[INVALID_ACK]");
  await x.p.send(x.s.id, b);
  await until(
    () => x.store.get(x.s.id).batches[1].status === "delivery-uncertain",
  );
  assert.equal(x.prompts(), 2);
});
test("simultaneous handshakes share startup promise and honor two-process bound", async (t) => {
  const x = setup(t, ["--slow-handshake"]);
  const [a, b, c] = await Promise.all([
    x.p.handshake(x.s.id, "Ideas"),
    x.p.handshake(x.s.id, "Ideas"),
    x.p.handshake(x.s.id, "Literature"),
  ]);
  assert.equal(a.sessionId, b.sessionId);
  assert.notEqual(a.sessionId, c.sessionId);
  assert.equal(x.launches(), 2);
  assert.equal(x.p.info().active, 2);
  assert.equal(x.prompts(), 0);
});
test("terminating stubborn children retain slots until actual SIGKILL exit", async (t) => {
  const x = setup(t, ["--stubborn"]);
  await Promise.all([
    x.p.handshake(x.s.id, "Ideas"),
    x.p.handshake(x.s.id, "Literature"),
  ]);
  const stopping = x.p.stop(x.s.id);
  assert.equal(x.p.info().active, 2);
  assert.equal(x.p.info().terminating, 2);
  await assert.rejects(x.p.handshake(x.s.id, "Ideas"), /terminating/);
  await assert.rejects(x.p.handshake(x.s.id, "Data"), /pool full/);
  assert.equal(x.launches(), 2);
  await stopping;
  assert.equal(x.p.info().active, 0);
  await x.p.handshake(x.s.id, "Ideas");
  assert.equal(x.launches(), 3);
});
for (const stage of ["requestId", "working", "completed", "close"])
  test(`save failure at ${stage} is contained, stops Pi and never resends`, async (t) => {
    const x = setup(t);
    const bid = x.draft("[SLOW]");
    await x.p.handshake(x.s.id, "Ideas");
    const save = x.store.save.bind(x.store);
    let injected = false;
    x.store.save = () => {
      const b = x.store.get(x.s.id).batches[0];
      const trigger =
        stage === "requestId"
          ? !!b.requestId && b.status === "pending"
          : stage === "close"
            ? b.status === "delivery-uncertain"
            : b.status === stage;
      if (trigger) {
        injected = true;
        throw new Error("Injected disk failure");
      }
      save();
    };
    await x.p.send(x.s.id, bid);
    if (stage === "close") {
      await until(
        () => x.store.get(x.s.id).batches[0].status === "accepted/queued",
      );
      await x.p.stop(x.s.id);
    }
    await until(() => injected && x.p.info().active === 0);
    assert.match(x.p.warning(x.s.id) ?? "", /persistence failed/);
    assert.equal(x.prompts(), stage === "requestId" ? 0 : 1);
    await assert.rejects(x.p.send(x.s.id, bid));
    x.store.save = save;
    const reloaded = new Store(x.store.root);
    assert.equal(reloaded.get(x.s.id).batches[0].status, "delivery-uncertain");
  });
test("create and delivery rollback all memory and persisted state on save failure", (t) => {
  const x = setup(t);
  x.store.import(
    x.s.id,
    x.store.get(x.s.id).revision,
    "a.txt",
    Buffer.from("source"),
  );
  let s = x.store.get(x.s.id);
  x.store.annotate(s.id, s.revision, {
    artifactId: s.artifacts[0].id,
    anchor: { page: 1, quote: "source", rotation: 0 },
    comment: "check",
  });
  s = x.store.get(s.id);
  x.store.batch(s.id, s.revision, {
    annotationIds: [s.annotations[0].id],
    destination: "Ideas",
    instruction: "Review",
  });
  const before = JSON.stringify(x.store.db),
    disk = fs.readFileSync(path.join(x.store.root, "catalog.json"), "utf8");
  const save = x.store.save.bind(x.store);
  x.store.save = () => {
    throw new Error("Quota/disk failure");
  };
  assert.throws(() => x.store.create("Must roll back"), /Quota/);
  assert.equal(JSON.stringify(x.store.db), before);
  assert.throws(
    () =>
      x.store.delivery(s.id, x.store.get(s.id).batches[0].id, {
        status: "accepted/queued",
        requestId: "test",
        attempts: 1,
      }),
    /Quota/,
  );
  assert.equal(JSON.stringify(x.store.db), before);
  assert.equal(
    fs.readFileSync(path.join(x.store.root, "catalog.json"), "utf8"),
    disk,
  );
  x.store.save = save;
});
test("dangling symlinks are detected and random exclusive state temporaries never follow fixed state.tmp", (t) => {
  const x = setup(t),
    outside = path.join(x.store.root, "not-created");
  fs.symlinkSync(outside, path.join(x.store.root, "state.tmp"));
  assert.throws(() => x.store.safe("state.tmp"), /Symlink/);
  x.store.save();
  assert.equal(fs.existsSync(outside), false);
  fs.symlinkSync(outside, path.join(x.store.root, "dangling"));
  assert.throws(() => x.store.safe("dangling"), /Symlink/);
});
