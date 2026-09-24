import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { Rpc } from "../server/rpc.ts";
import { PiPool } from "../server/pi.ts";
import { Store } from "../server/store.ts";
const fixture = path.resolve("tests/fake-rpc.mjs");
function rpc(t: any) {
  const r = Rpc.launch(process.execPath, [fixture], process.cwd());
  t.after(() => r.close());
  return r;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error("Fixture condition timed out");
}
function pool(t: any, fixtureArgs: string[] = []) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lab-rpc-test-")),
  );
  const store = new Store(root);
  let launches = 0,
    prompts = 0;
  const p = new PiPool(store, process.execPath, (_exe, args, cwd, env) => {
    launches++;
    for (const flag of [
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--offline",
      "--no-approve",
    ])
      assert.ok(args.includes(flag));
    assert.ok(args.includes("--session-id") || args.includes("--session"));
    assert.equal(env?.PI_CODING_AGENT_DIR, path.join(root, "pi-agent"));
    assert.equal(env?.PI_OFFLINE, "1");
    assert.equal(env?.PI_TELEMETRY, "0");
    const rpc = new Rpc(
      spawn(process.execPath, [fixture, ...fixtureArgs], {
        cwd,
        stdio: "pipe",
        env,
      }),
      15000,
      120,
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
  const s = store.create("RPC tests");
  store.change(s.id, s.revision, (s) => {
    s.tabs.Ideas.model = "fixture";
    s.tabs.Ideas.provider = "test-only";
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
    launches: () => launches,
    prompts: () => prompts,
  };
}
test("strict LF framing preserves split UTF8 and Unicode paragraph separators", async (t) => {
  const r = rpc(t);
  const out = await r.request("unicode");
  assert.equal(out.text, "雪\u2028line\u2029end");
});
test("multiple response IDs correlate independently and unknown ACK ignored", async (t) => {
  const r = rpc(t);
  const [a, b] = await Promise.all([
    r.request("get_state"),
    r.request("get_available_models"),
  ]);
  assert.equal(a.isStreaming, false);
  assert.equal(b.models[0].provider, "test-only");
});
test("RPC timeout does not auto retry", async (t) => {
  const r = new Rpc(spawn(process.execPath, [fixture], { stdio: "pipe" }), 60);
  t.after(() => r.close());
  await assert.rejects(r.request("no_reply"), /timeout/);
});
test("process exit rejects pending requests", async (t) => {
  const r = rpc(t);
  await assert.rejects(r.request("exit"), /exited/);
});
test("invalid JSON frame fails closed", async (t) => {
  const r = rpc(t);
  await assert.rejects(r.request("bad_frame"), /invalid JSONL/);
});
test("oversized frame fails closed without truncation", async (t) => {
  const r = rpc(t);
  await assert.rejects(r.request("big_frame"), /exceeds/);
});
test("restore starts zero processes and explicit handshake starts one without prompts", async (t) => {
  const x = pool(t);
  assert.equal(x.launches(), 0);
  const out = await x.p.handshake(x.s.id, "Ideas");
  assert.equal(x.launches(), 1);
  assert.equal(out.models[0].id, "fixture");
  assert.equal(x.store.get(x.s.id).batches.length, 0);
});
test("ACK is only acceptance; full settlement and final response required", async (t) => {
  const x = pool(t),
    bid = x.draft("[SLOW] compare");
  await x.p.send(x.s.id, bid);
  await until(
    () => x.store.get(x.s.id).batches[0].status === "accepted/queued",
  );
  assert.notEqual(x.store.get(x.s.id).batches[0].status, "completed");
  await until(() => x.store.get(x.s.id).batches[0].status === "completed");
  const b = x.store.get(x.s.id).batches[0];
  assert.ok(b.requestId);
  assert.equal(b.attempts, 1);
  assert.match(b.response, /not real inference/);
  await assert.rejects(x.p.send(x.s.id, bid), /Already attempted/);
});
test("busy session uses bounded local follow-up queue with correct batch correlation", async (t) => {
  const x = pool(t),
    a = x.draft("[SLOW] first"),
    b = x.draft("second");
  await x.p.send(x.s.id, a);
  await x.p.send(x.s.id, b);
  assert.equal(x.store.get(x.s.id).batches[1].status, "pending");
  await until(() =>
    x.store.get(x.s.id).batches.every((b) => b.status === "completed"),
  );
  assert.notEqual(
    x.store.get(x.s.id).batches[0].requestId,
    x.store.get(x.s.id).batches[1].requestId,
  );
  assert.equal(x.launches(), 1);
});
test("settled with terminal provider error is failed, never completed", async (t) => {
  const x = pool(t),
    b = x.draft("[FAIL]");
  await x.p.send(x.s.id, b);
  await until(() => x.store.get(x.s.id).batches[0].status === "failed");
  assert.match(x.store.get(x.s.id).batches[0].detail, /Fixture provider error/);
});
test("explicit rejected prompt is failed; process exit after ACK is uncertain", async (t) => {
  const x = pool(t),
    b = x.draft("[REJECT]");
  await x.p.send(x.s.id, b);
  await until(() => x.store.get(x.s.id).batches[0].status === "failed");
  const c = x.draft("[EXIT]");
  await x.p.send(x.s.id, c);
  await until(
    () => x.store.get(x.s.id).batches[1].status === "delivery-uncertain",
  );
});
test("empty settlement cannot masquerade as successful completion", async (t) => {
  const x = pool(t),
    b = x.draft("[EMPTY]");
  await x.p.send(x.s.id, b);
  await until(
    () => x.store.get(x.s.id).batches[0].status === "delivery-uncertain",
  );
});
test("parking prevents process creation", async (t) => {
  const x = pool(t);
  x.store.change(x.s.id, x.store.get(x.s.id).revision, (s) => {
    s.lifecycle = "parked";
  });
  await assert.rejects(x.p.handshake(x.s.id, "Ideas"), /Resume/);
  assert.equal(x.launches(), 0);
});
