import { installed } from "./installed-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { definitelyDead } from "../server/pi-coordination.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Store, hash } from "../server/store.ts";
import { PiPool } from "../server/pi.ts";
import { PiBindings } from "../server/pi-bindings.ts";
import { discoverPi } from "../server/pi-runtime.ts";
import { handoff } from "../scripts/desktop-pi-handoff.ts";
import { createApp } from "../server/app.ts";
import { Platform } from "../server/platform.ts";

async function fixture(t: any, settings = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "herdr-linked-")),
  );
  const install = installed(root, settings),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = install.agent;
  const store = new Store(path.join(root, "data"));
  const pool = new PiPool(store, install.executable);
  const strategy = store.create("Linked fixture"),
    tab = "Ideas" as const;
  t.after(async () => {
    await pool.close();
    prior === undefined
      ? delete process.env.PI_CODING_AGENT_DIR
      : (process.env.PI_CODING_AGENT_DIR = prior);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, install, store, pool, sid: strategy.id, tab };
}
async function until<T>(
  fn: () => Promise<T>,
  match: (value: T) => boolean,
  timeout = 6000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (match(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for fixture state");
}
const events = (pool: PiPool, sid: string) => pool.snapshot(sid, "Ideas");
function recoveryInput(inspection: ReturnType<PiPool["ownership"]>) {
  return { expectedGeneration: inspection.binding?.generation ?? 0, lease: inspection.lease ? { pid: inspection.lease.pid, nonce: inspection.lease.nonce, generation: inspection.lease.generation, mode: inspection.lease.mode } : null, coordination: inspection.coordination, submissionId: inspection.binding?.lastSubmission?.id ?? null, historyReviewed: true as const, unmanagedWritersStopped: true as const, note: "Reviewed disposable fixture history; no unmanaged writer" };
}

test("filesystem discovery resolves exact CLI realpath and its own SDK/TUI without loading code", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "herdr-discovery-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x = installed(root);
  const result = discoverPi(x.executable);
  assert.equal(result.executable, x.cli);
  assert.equal(result.packageRoot, x.pkg);
  assert.ok(result.tui.startsWith(x.pkg));
  assert.equal(result.version, "0.84.1-fixture");
  assert.throws(() => discoverPi(process.execPath), /not inside/);
});

test("blank linked session keeps logical and canonical IDs/path through Stop/reconnect, no prompts on reads", async (t) => {
  const x = await fixture(t),
    logical = x.store.get(x.sid).tabs.Ideas.sessionId;
  x.store.discussion(x.sid, x.store.get(x.sid).revision, {
    destination: "Ideas",
    instruction: "Immutable fixture snapshot",
  });
  const historical = JSON.stringify(x.store.get(x.sid).batches[0]);
  assert.equal((await x.pool.snapshot(x.sid, x.tab)).connected, false);
  assert.equal(x.pool.info().active, 0);
  const first = await x.pool.handshake(x.sid, x.tab);
  assert.equal(first.sessionId, logical);
  assert.ok(first.canonical);
  assert.notEqual(first.canonical.id, logical);
  const file = first.canonical.path;
  const before = fs.readFileSync(file, "utf8");
  assert.equal(before.trim().split("\n").length, 1);
  await x.pool.stop(x.sid);
  assert.equal(x.pool.info().active, 0);
  assert.equal((await x.pool.snapshot(x.sid, x.tab)).connected, false);
  const second = await x.pool.handshake(x.sid, x.tab);
  assert.deepEqual(second.canonical, first.canonical);
  assert.ok(second.generation! > first.generation!);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(x.store.get(x.sid).tabs.Ideas.sessionId, logical);
  const snapshot = await x.pool.snapshot(x.sid, x.tab);
  assert.ok(snapshot.events.some((e) => e.type === "runtime_ready"));
  assert.equal(JSON.stringify(x.store.get(x.sid).batches[0]), historical);
});

test("startup approval visible before Connect completes; stale/invalid responses rejected; Stop fences startup", async (t) => {
  const x = await fixture(t, { startupDialog: true });
  let connected = false;
  const opening = x.pool.handshake(x.sid, x.tab).then((v) => {
    connected = true;
    return v;
  });
  const snap = await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  assert.equal(connected, false);
  const request = (snap.ui as any).pending[0];
  await x.pool.operate(x.sid, x.tab, { type: "resync_ui" }, snap.generation);
  const resynced = await events(x.pool, x.sid);
  assert.equal(resynced.ui?.pending[0].id, request.id);
  assert.equal(
    resynced.events.some((e) => e.type === "agent_start"),
    false,
  );
  await assert.rejects(
    x.pool.operate(
      x.sid,
      x.tab,
      { type: "ui_response", requestId: request.id, value: true },
      snap.generation + 1,
    ),
    /Stale/,
  );
  await assert.rejects(
    x.pool.operate(x.sid, x.tab, {
      type: "ui_response",
      requestId: request.id,
      value: "yes",
    }),
    /Invalid/,
  );
  await x.pool.operate(
    x.sid,
    x.tab,
    { type: "ui_response", requestId: request.id, value: false },
    snap.generation,
  );
  await opening;
  await x.pool.stop(x.sid);
  const pending = assert.rejects(x.pool.handshake(x.sid, x.tab));
  await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  await x.pool.stop(x.sid);
  await pending;
  assert.equal(x.pool.info().active, 0);
});

test("native stream, command allowlist, model settings overlay and canonical history", async (t) => {
  const x = await fixture(t),
    before = fs.readFileSync(
      path.join(x.install.agent, "settings.json"),
      "utf8",
    );
  await x.pool.handshake(x.sid, x.tab);
  const beforeStale = await events(x.pool, x.sid),
    entry = await x.pool.entry(x.sid, x.tab);
  entry.rpc.emit("event", {
    version: 1,
    generation: beforeStale.generation - 1,
    seq: 999999,
    type: "agent_start",
  });
  entry.rpc.emit("event", {
    version: 1,
    generation: beforeStale.generation - 1,
    seq: 999999,
    type: "binding_request",
    canonical: { id: "bad", path: "/bad.jsonl" },
  });
  assert.equal((await events(x.pool, x.sid)).through, beforeStale.through);
  await assert.rejects(
    x.pool.operate(x.sid, x.tab, { type: "command", name: "unknown" }),
    /Unknown command/,
  );
  await assert.rejects(
    x.pool.operate(x.sid, x.tab, { type: "prompt", message: "/unknown" }),
    /allowlisted/,
  );
  await x.pool.operate(x.sid, x.tab, {
    type: "set_model",
    provider: "fake",
    modelId: "fixture",
  });
  await x.pool.operate(x.sid, x.tab, {
    type: "prompt",
    message: "fixture-only input",
  });
  const s = await until(
    () => events(x.pool, x.sid),
    (s) => s.events.some((e) => e.type === "agent_settled"),
  );
  for (const type of [
    "message_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "message_end",
  ])
    assert.ok(
      s.events.some((e) => e.type === type),
      type,
    );
  assert.equal(
    fs.readFileSync(path.join(x.install.agent, "settings.json"), "utf8"),
    before,
  );
  assert.equal(x.pool.history(x.sid, x.tab).entries.length, 3);
  assert.equal(
    (x.pool.history(x.sid, x.tab).entries[1] as any).type,
    "model_change",
  );
  assert.equal(s.binding?.lastSubmission?.status, "settled");
  assert.equal(s.binding?.lastSubmission?.kind, "prompt");
  assert.ok(
    s.events.some(
      (e) =>
        e.type === "terminal_frame" &&
        String(e.data).includes("TOOL RESULT fake-tool-id"),
    ),
  );
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "renderers" });
  const rendered = await until(
    () => events(x.pool, x.sid),
    (s) =>
      s.events.some((e) => e.type === "command_end" && e.name === "renderers"),
  );
  for (const marker of ["CUSTOM MESSAGE", "CUSTOM ENTRY"])
    assert.ok(
      rendered.events.some(
        (e) => e.type === "terminal_frame" && String(e.data).includes(marker),
      ),
    );
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "noisy" });
  await until(
    () => events(x.pool, x.sid),
    (s) => s.events.some((e) => e.type === "command_end" && e.name === "noisy"),
  );
  assert.equal(x.pool.info().active, 1);
});

test("all native dialogs round-trip, Cancel is not Stop, actual custom result stays host", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "ui" });
  for (const [method, value] of [
    ["select", "two"],
    ["confirm", false],
    ["input", "name"],
    ["editor", "line1\nline2"],
  ] as const) {
    const s = await until(
      () => events(x.pool, x.sid),
      (s) => (s.ui as any)?.pending?.some((p: any) => p.method === method),
    );
    const r = (s.ui as any).pending.find((p: any) => p.method === method);
    if (method === "select")
      await assert.rejects(
        x.pool.operate(x.sid, x.tab, {
          type: "ui_response",
          requestId: r.id,
          value: "not-offered",
        }),
        /Selection/,
      );
    await x.pool.operate(x.sid, x.tab, {
      type: "ui_response",
      requestId: r.id,
      value,
    });
  }
  await until(
    () => events(x.pool, x.sid),
    (s) => s.events.some((e) => e.type === "command_end" && e.name === "ui"),
  );
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "custom" });
  const s = await until(
    () => events(x.pool, x.sid),
    (s) =>
      s.events.some((e) => e.type === "terminal_open" && e.kind === "custom"),
  );
  const id = String(
    s.events.find((e) => e.type === "terminal_open" && e.kind === "custom")!
      .surfaceId,
  );
  await x.pool.operate(x.sid, x.tab, {
    type: "terminal_resize",
    surfaceId: id,
    columns: 120,
    rows: 40,
  });
  await x.pool.operate(x.sid, x.tab, {
    type: "terminal_input",
    surfaceId: id,
    data: "y",
  });
  const done = await until(
    () => events(x.pool, x.sid),
    (s) =>
      s.events.some(
        (e) => e.type === "notification" && e.message === "host-only-result",
      ),
  );
  assert.ok(
    done.events.some(
      (e) => e.type === "terminal_frame" && String(e.data).includes("120"),
    ),
  );
  await until(
    () => events(x.pool, x.sid),
    (s) =>
      s.events.some((e) => e.type === "command_end" && e.name === "custom"),
  );
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "slow" });
  await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  await x.pool.operate(x.sid, x.tab, { type: "cancel" });
  assert.equal(x.pool.info().active, 1);
  await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length === 0,
  );
});

test("factory header/footer/widget/editor execute, editor state authoritative, reload disposes", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "factories" });
  const s = await until(
    () => events(x.pool, x.sid),
    (s) =>
      s.events.some((e) => e.type === "command_end" && e.name === "factories"),
  );
  for (const marker of ["HEADER", "FOOTER", "WIDGET", "EDITOR"])
    assert.ok(
      s.events.some(
        (e) => e.type === "terminal_frame" && String(e.data).includes(marker),
      ),
    );
  await x.pool.operate(x.sid, x.tab, {
    type: "terminal_input",
    surfaceId: "editor",
    data: "!",
  });
  assert.equal(((await events(x.pool, x.sid)).ui as any).editor, "seed!");
  await x.pool.operate(x.sid, x.tab, { type: "reload" });
  assert.deepEqual(((await events(x.pool, x.sid)).ui as any).surfaces, []);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "new" });
  const changed = await until(
    () => events(x.pool, x.sid),
    (v) => v.binding?.canonical?.id !== s.binding?.canonical?.id,
  );
  assert.equal(changed.logicalSessionId, s.logicalSessionId);
  await until(
    () => events(x.pool, x.sid),
    (v) => v.events.some((e) => e.type === "command_end" && e.name === "new"),
  );
  await x.pool.stop(x.sid);
  await x.pool.handshake(x.sid, x.tab);
  assert.equal(
    (await events(x.pool, x.sid)).binding?.canonical?.id,
    changed.binding?.canonical?.id,
  );
});

test("missing configured resources fail before readiness without auto-install or global settings writes", async (t) => {
  const x = await fixture(t, { packages: ["./missing-package"] });
  await assert.rejects(x.pool.handshake(x.sid, x.tab));
  assert.equal(x.pool.info().active, 0);
  const s = await events(x.pool, x.sid);
  assert.ok(
    s.events.some(
      (e) =>
        e.type === "diagnostic" &&
        String(e.message).includes("Missing configured Pi resource"),
    ),
  );
  assert.equal(
    fs.existsSync(path.join(x.install.agent, "missing-package")),
    false,
  );
});

test("oversize substantive projections are reported, bounded history exposes raw continuation", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "large" });
  const s = await until(
    () => events(x.pool, x.sid),
    (s) => s.events.some((e) => e.type === "projection_truncated"),
  );
  assert.equal(s.resyncRequired, true);
  fs.appendFileSync(
    s.binding!.canonical!.path,
    JSON.stringify({ type: "message", text: "x".repeat(900000) }) + "\n",
  );
  const page = x.pool.history(x.sid, x.tab);
  const raw = x.pool.history(x.sid, x.tab, page.next!);
  assert.equal(raw.truncated, true);
  assert.ok(raw.rawChunk);
  assert.ok(raw.rawNext! > raw.cursor);
  const rest = x.pool.history(x.sid, x.tab, raw.rawNext!, 50, true);
  const recovered = Buffer.concat([
    Buffer.from(raw.rawChunk!, "base64"),
    Buffer.from(rest.rawChunk!, "base64"),
  ]).toString("utf8");
  assert.equal(JSON.parse(recovered).text.length, 900000);
});

test("managed CLI handoff uses exact canonical file and excludes desktop until actual CLI exit", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  const target = await x.pool.handoff(x.sid, x.tab);
  const run = handoff(target.bindingFile, target.executable);
  const cwd = x.store.safe("pi-workspaces", hash(x.sid));
  await until(
    async () => fs.existsSync(path.join(cwd, "handoff-args.json")),
    Boolean,
  );
  await assert.rejects(x.pool.handshake(x.sid, x.tab), /handoff.*writer lease/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, "handoff-args.json"), "utf8")),
    ["--session", target.canonical.path, "--session-dir", path.dirname(target.canonical.path), "--extension", path.resolve("server/pi-handoff-guard.mjs")],
  );
  assert.equal(await run, 0);
  await x.pool.handshake(x.sid, x.tab);
  assert.deepEqual(
    (await events(x.pool, x.sid)).binding?.canonical,
    target.canonical,
  );
});

test("existing canonical bindings reject missing, mismatched, escaped and symlink files before host launch", async (t) => {
  const x = await fixture(t);
  const initial = await x.pool.handshake(x.sid, x.tab);
  await x.pool.stop(x.sid);
  const canonical = initial.canonical!,
    original = fs.readFileSync(canonical.path);
  const bindings = new PiBindings(x.store.safe("pi-bindings")),
    bindingFile = bindings.file(x.sid, x.tab),
    saved = fs.readFileSync(bindingFile);
  const assertNoLaunch = async (pattern: RegExp) => {
    await assert.rejects(x.pool.handshake(x.sid, x.tab), pattern);
    assert.equal(x.pool.info().active, 0);
    assert.equal(fs.existsSync(bindingFile + ".lease"), false);
  };
  fs.unlinkSync(canonical.path);
  await assertNoLaunch(/missing/);
  assert.equal(fs.existsSync(canonical.path), false);
  fs.writeFileSync(canonical.path, original);
  const wrong = JSON.parse(original.toString().split("\n")[0]);
  wrong.id = "wrong-id";
  fs.writeFileSync(canonical.path, JSON.stringify(wrong) + "\n");
  await assertNoLaunch(/identity mismatch/);
  fs.writeFileSync(canonical.path, original);
  const outside = path.join(x.root, "outside.jsonl");
  fs.writeFileSync(outside, original);
  const escaped = JSON.parse(saved.toString());
  escaped.canonical.path = outside;
  fs.writeFileSync(bindingFile, JSON.stringify(escaped));
  await assertNoLaunch(/outside/);
  fs.writeFileSync(bindingFile, saved);
  fs.unlinkSync(canonical.path);
  fs.symlinkSync(outside, canonical.path);
  await assertNoLaunch(/Symlink/);
  fs.unlinkSync(canonical.path);
  fs.writeFileSync(canonical.path, original);
  const restored = await x.pool.handshake(x.sid, x.tab);
  assert.deepEqual(restored.canonical, canonical);
});

test("lease pid/nonce/generation fencing and stale owners fail closed", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "herdr-leases-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindings = new PiBindings(root);
  const first = bindings.acquire("w", "Ideas", "logical");
  assert.throws(
    () => bindings.acquire("w", "Ideas", "logical"),
    /lease exists/,
  );
  assert.throws(
    () => bindings.release("w", "Ideas", { ...first.lease, nonce: "stale" }),
    /fenced/,
  );
  assert.throws(
    () =>
      bindings.bind(
        "w",
        "Ideas",
        first.lease,
        { id: "x", path: "/tmp/outside.jsonl" },
        root,
      ),
    /outside/,
  );
  bindings.release("w", "Ideas", first.lease);
  const second = bindings.acquire("w", "Ideas", "logical");
  assert.equal(second.lease.generation, first.lease.generation + 1);
  assert.throws(() => bindings.acquire("w", "Ideas", "changed"), /historical/);
  bindings.release("w", "Ideas", second.lease);
});

test("scoped native routes reject forged scope, arbitrary RPC and generation; GET never connects", async (t) => {
  const x = await fixture(t),
    other = x.store.create("Other");
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import("node:net").AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  server.on("request", createApp(x.store, x.pool, origin));
  const request = (route: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Origin: origin,
        Authorization: "Bearer " + x.store.db.tokens[x.sid],
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const base = `/api/strategies/${x.sid}/conversations/Ideas`;
  assert.equal((await request(base)).status, 200);
  assert.equal((await request(base + "/ownership")).status, 200);
  assert.equal(fs.existsSync(x.store.safe("pi-bindings")), false, "Read-only inspection creates no ownership metadata");
  assert.equal((await request(`/api/strategies/${other.id}/conversations/Ideas/ownership`)).status, 403);
  assert.equal((await request(`/api/strategies/${other.id}/conversations/Ideas/reconcile`, "POST", {})).status, 403);
  assert.equal(x.pool.info().active, 0);
  assert.equal(
    (await request(`/api/strategies/${other.id}/conversations/Ideas`)).status,
    403,
  );
  assert.equal(
    (
      await request(base + "/operation", "POST", {
        generation: 1,
        operation: { type: "execute_bash", command: "bad" },
      })
    ).status,
    400,
  );
  assert.equal((await request(base + "/connect", "POST", {})).status, 200);
  assert.equal(
    (
      await request(base + "/operation", "POST", {
        generation: 999,
        operation: { type: "cancel" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(base + "/operation", "POST", {
        generation: 1,
        operation: { type: "cancel", extra: true },
      })
    ).status,
    400,
  );
  const previous = (await events(x.pool, x.sid)).generation;
  await x.pool.stop(x.sid); await x.pool.handshake(x.sid, x.tab);
  const current = (await events(x.pool, x.sid)).generation;
  for (const suffix of ["/stop", "/handoff"]) assert.equal((await request(base + suffix, "POST", { generation: previous })).status, 409);
  assert.equal((await events(x.pool, x.sid)).connected, true);
  assert.equal((await request(base + "/stop", "POST", {})).status, 400);
  assert.equal((await request(`/api/strategies/${x.sid}/pi/Ideas/stop`, "POST", {})).status, 400);
  const owned = await (await request(base + "/ownership")).json() as any;
  assert.equal((await request(base + "/reconcile", "POST", recoveryInput(owned))).status, 409, "Active managed entry cannot be reconciled");
  assert.equal((await request(base + "/operation", "POST", { generation: current, operation: { type: "set_thinking", level: "max" } })).status, 200);
  assert.equal((await (await request(base)).json() as any).runtimeState.thinkingLevel, "max");
  assert.equal((await request(base + "/stop", "POST", { generation: current })).status, 200);
});

test("project trust request works before canonical binding and rejects untrusted local packages without installing", async (t) => {
  const x = await fixture(t),
    cwd = x.store.safe("pi-workspaces", hash(x.sid));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ask-trust"), "");
  fs.writeFileSync(
    path.join(cwd, ".pi/settings.json"),
    '{"packages":["./missing-project-resource"]}',
  );
  const connecting = x.pool.handshake(x.sid, x.tab);
  const s = await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  assert.equal(s.binding?.canonical, undefined);
  await x.pool.operate(
    x.sid,
    x.tab,
    {
      type: "ui_response",
      requestId: (s.ui as any).pending[0].id,
      value: false,
    },
    s.generation,
  );
  await connecting;
  await x.pool.stop(x.sid);
  const trustedAttempt = assert.rejects(x.pool.handshake(x.sid, x.tab));
  const trust = await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  await x.pool.operate(
    x.sid,
    x.tab,
    {
      type: "ui_response",
      requestId: (trust.ui as any).pending[0].id,
      value: true,
    },
    trust.generation,
  );
  await trustedAttempt;
  assert.equal(
    fs.existsSync(path.join(cwd, "missing-project-resource")),
    false,
  );
});

test("starting hosts count against pool bound; stale generation callbacks cannot alter projections", async (t) => {
  const x = await fixture(t, { startupDialog: true }),
    b = x.store.create("B"),
    c = x.store.create("C");
  const aStart = assert.rejects(x.pool.handshake(x.sid, x.tab));
  const bStart = assert.rejects(x.pool.handshake(b.id, x.tab));
  await until(
    () => events(x.pool, x.sid),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  await until(
    () => events(x.pool, b.id),
    (s) => (s.ui as any)?.pending?.length > 0,
  );
  assert.equal(x.pool.info().active, 2);
  await assert.rejects(x.pool.handshake(c.id, x.tab), /pool full/);
  await x.pool.stop(x.sid);
  await x.pool.stop(b.id);
  await Promise.all([aStart, bStart]);
  assert.equal(x.pool.info().active, 0);
});

test("controlled reload reads edited shared resources while retaining field-wise session model overrides", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, {
    type: "set_model",
    provider: "fake",
    modelId: "fixture",
  });
  fs.mkdirSync(path.join(x.install.agent, "new-resource"));
  fs.writeFileSync(path.join(x.install.agent, "updated-extension"), "fixture-extension");
  fs.mkdirSync(path.join(x.install.agent, "updated-skill"));
  fs.writeFileSync(path.join(x.install.agent, "updated-skill/SKILL.md"), "Fixture skill");
  const settings = {
    defaultProvider: "global-provider",
    defaultModel: "global-model",
    packages: ["./new-resource"],
    skills: ["updated-skill"],
    extensions: ["updated-extension"],
  };
  const file = path.join(x.install.agent, "settings.json");
  fs.writeFileSync(file, JSON.stringify(settings));
  await x.pool.operate(x.sid, x.tab, { type: "reload" });
  const connected = await x.pool.handshake(x.sid, x.tab);
  assert.deepEqual(connected.selectedModel, {
    id: "fixture",
    provider: "fake",
  });
  const commands = await x.pool.commandCatalog(x.sid, x.tab);
  assert.ok(commands.some((c: any) => c.name === "skill:updated-skill"));
  assert.ok(commands.some((c: any) => c.name === "updated-extension"));
  const refreshed = await events(x.pool, x.sid),
    ready = refreshed.events.filter((e) => e.type === "runtime_ready").at(-1)!;
  assert.ok(
    (ready.provenance as any[]).some((p) => p.source === "./new-resource"),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), settings);
});

test("native uncertainty receipt survives Stop and read-only pool restoration without replay", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "slow" });
  await until(
    () => events(x.pool, x.sid),
    (s) => !!s.ui?.pending.length,
  );
  await x.pool.stop(x.sid);
  const restarted = new PiPool(x.store, x.install.executable);
  t.after(() => restarted.close());
  const restored = await restarted.snapshot(x.sid, x.tab);
  assert.equal(restored.binding?.lastSubmission?.status, "uncertain");
  assert.equal(restored.connected, false);
  assert.equal(restarted.info().active, 0);
  assert.equal(restored.resyncRequired, true);
  assert.equal(restarted.history(x.sid, x.tab).entries.length, 1);
  await restarted.handshake(x.sid, x.tab);
  await assert.rejects(restarted.operate(x.sid, x.tab, { type: "prompt", message: "must stay gated" }), /reconciliation/);
  await restarted.stop(x.sid);
  const inspected = restarted.ownership(x.sid, x.tab), original = inspected.binding!.lastSubmission!;
  const reconciled = restarted.reconcile(x.sid, x.tab, recoveryInput(inspected));
  assert.equal(reconciled.binding.lastSubmission?.status, "uncertain");
  assert.equal(JSON.parse(fs.readFileSync(reconciled.binding.recovery!.auditFile, "utf8")).binding.lastSubmission.id, original.id);
  assert.equal(restarted.info().active, 0, "Reconciliation never connects or replays");
});

test("uncertain native intent publication sends nothing and fails closed", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  const rename = fs.renameSync,
    sync = fs.fsyncSync;
  let published = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (
      String(to).includes(path.sep + "pi-bindings" + path.sep) &&
      String(to).endsWith(".json")
    ) {
      const candidate = JSON.parse(fs.readFileSync(String(to), "utf8"));
      if (candidate.lastSubmission?.status === "pending") published = true;
    }
  };
  fs.fsyncSync = (fd) => {
    if (published && fs.fstatSync(fd).isDirectory())
      throw new Error("Injected native intent directory sync failure");
    sync(fd);
  };
  try {
    await assert.rejects(
      x.pool.operate(x.sid, x.tab, {
        type: "prompt",
        message: "must never dispatch",
      }),
      /directory sync failure/,
    );
  } finally {
    fs.renameSync = rename;
    fs.fsyncSync = sync;
  }
  await x.pool.stop(x.sid);
  const snapshot = await events(x.pool, x.sid);
  assert.equal(
    snapshot.events.some((e) => e.type === "agent_start"),
    false,
  );
  assert.equal(x.pool.history(x.sid, x.tab).entries.length, 1);
  assert.match(x.pool.warning(x.sid) ?? "", /persistence failed/i);
  x.pool.reconcile(x.sid, x.tab, recoveryInput(x.pool.ownership(x.sid, x.tab)));
  assert.match(x.pool.warning(x.sid) ?? "", /persistence failed/i, "Ownership acknowledgement must not clear durability failures");
  await assert.rejects(x.pool.handshake(x.sid, x.tab), /persistence failed/i);
});

test("proof mode blocks prompts and commands on the fake installed SDK; no turn is generated", async (t) => {
  const previous = process.env.LAB_PI_NO_INFERENCE;
  process.env.LAB_PI_NO_INFERENCE = "1";
  t.after(() => {
    previous === undefined
      ? delete process.env.LAB_PI_NO_INFERENCE
      : (process.env.LAB_PI_NO_INFERENCE = previous);
  });
  const x = await fixture(t);
  await x.pool.handshake(x.sid, x.tab);
  await assert.rejects(
    x.pool.operate(x.sid, x.tab, { type: "prompt", message: "must not run" }),
    /Inference disabled/,
  );
  await assert.rejects(
    x.pool.operate(x.sid, x.tab, { type: "command", name: "ui" }),
    /disabled in proof mode/,
  );
  const snapshot = await events(x.pool, x.sid);
  assert.equal(
    snapshot.events.some((e) => e.type === "agent_start"),
    false,
  );
  assert.equal(x.pool.history(x.sid, x.tab).entries.length, 1);
});

test("portfolio native routes retain exact capabilities and canonical ownership independent of strategies", async (t) => {
  const x = await fixture(t),
    platform = new Platform(x.store),
    a = platform.createPortfolio("Native A"),
    b = platform.createPortfolio("Native B");
  t.after(() => platform.close());
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  server.on(
    "request",
    createApp(x.store, x.pool, origin, path.join(x.root, "public"), platform),
  );
  const fresh = platform.createPortfolio(
    "Created after service initialization",
  );
  const ledger = x.store.safe("portfolio-conversations", fresh.id + ".json");
  assert.equal(fs.existsSync(ledger), false);
  for (const suffix of ["", "/events", "/commands", "/history"]) {
    const response = await fetch(
      origin + `/api/portfolios/${fresh.id}/conversations/Portfolio` + suffix,
      { headers: { Origin: origin, Authorization: "Bearer " + fresh.token } },
    );
    assert.equal(response.status, 200);
    if (suffix === "")
      assert.equal(((await response.json()) as any).logicalSessionId, null);
  }
  assert.equal(
    fs.existsSync(ledger),
    false,
    "Native GET must not trigger legacy lazy conversation initialization",
  );
  assert.equal(x.pool.info().active, 0);
  const route = `/api/portfolios/${a.id}/conversations/Portfolio`;
  const call = (
    suffix: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) =>
    fetch(origin + route + suffix, {
      method,
      headers: {
        Origin: origin,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (const token of [
    b.token,
    x.store.db.rootToken,
    x.store.db.tokens[x.sid],
  ]) {
    for (const [suffix, method] of [
      ["", "GET"],
      ["/history", "GET"],
      ["/commands", "GET"],
      ["/ownership", "GET"],
      ["/reconcile", "POST"],
      ["/events", "GET"],
      ["/connect", "POST"],
      ["/operation", "POST"],
      ["/stop", "POST"],
      ["/handoff", "POST"],
    ])
      assert.equal(
        (await call(suffix, token, method, method === "POST" ? {} : undefined))
          .status,
        403,
      );
  }
  assert.equal((await call("", a.token)).status, 200);
  assert.equal(x.pool.info().active, 0);
  assert.equal((await call("/connect", a.token, "POST", {})).status, 200);
  const snapshot = (await (await call("", a.token)).json()) as any;
  assert.ok(
    snapshot.binding.canonical.path.includes(
      path.join("portfolio-sessions", a.id),
    ),
  );
  assert.equal(snapshot.binding.workspace, "portfolio:" + a.id);
  assert.equal(
    (
      await call("/operation", a.token, "POST", {
        generation: snapshot.generation,
        operation: { type: "editor_state", text: "portfolio only" },
      })
    ).status,
    200,
  );
  assert.equal((await x.pool.snapshot(x.sid, "Ideas")).connected, false);
  assert.equal((await call("/stop", a.token, "POST", { generation: snapshot.generation })).status, 200);
  assert.equal(x.pool.info().active, 0);
});

test("shutdown awaits abort and idle persistence before installed-style dispose", async t => {
  const x = await fixture(t, { fixtureAbortPersistence: true });
  await x.pool.handshake(x.sid, x.tab); await x.pool.stop(x.sid);
  const entries = x.pool.history(x.sid, x.tab).entries.filter((entry: any) => entry.type === "custom");
  assert.deepEqual(entries.map((entry: any) => entry.customType), ["fixture-abort", "fixture-idle", "fixture-dispose"]);
  assert.equal((entries.at(-1) as any).data.abortComplete, true);
});

for (const malformed of ["{malformed", "[]"]) test(`malformed settings ${malformed} cannot construct services or become ready`, async t => {
  const x = await fixture(t); fs.writeFileSync(path.join(x.install.agent, "settings.json"), malformed);
  await assert.rejects(x.pool.handshake(x.sid, x.tab), /settings failed|Pi exited/);
  assert.ok((await events(x.pool, x.sid)).events.some(event => event.code === "startup_failed" && String(event.message).includes("settings failed")));
  assert.equal(fs.existsSync(path.join(x.install.agent, "fixture-services.log")), false);
  assert.equal(fs.readFileSync(path.join(x.install.agent, "settings.json"), "utf8"), malformed);
  assert.equal(x.pool.info().active, 0);
});

test("Reload uses the same session/services and loaded resource cache, emits reload once, and sees edited same-path factories", async t => {
  const x = await fixture(t, { extensions: ["versioned.js"], fixtureEmitFactoryVersions: true });
  const file = path.join(x.install.agent, "versioned.js"); fs.writeFileSync(file, "factory-v1");
  const first = await x.pool.handshake(x.sid, x.tab);
  fs.writeFileSync(file, "factory-v2");
  await x.pool.operate(x.sid, x.tab, { type: "reload" });
  const state = await events(x.pool, x.sid);
  assert.deepEqual(state.binding?.canonical, first.canonical);
  assert.ok(state.events.some(event => event.type === "notification" && event.message === "factory:factory-v2"));
  assert.deepEqual(state.events.filter(event => event.type === "fixture_lifecycle").map(event => [event.phase, event.reason]), [["start", "resume"], ["shutdown", "reload"], ["start", "reload"]]);
  assert.equal(fs.readFileSync(path.join(x.install.agent, "fixture-services.log"), "utf8").trim().split("\n").length, 1);
});

test("foreign cwd/agentDir, managed-directory symlink and foreign header are refused before any replacement resources", async t => {
  const x = await fixture(t), foreign = path.join(x.root, "foreign-fixture"); fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(x.install.agent, "settings.json"), JSON.stringify({ fixtureForeignCwd: foreign }));
  const first = await x.pool.handshake(x.sid, x.tab), canonical = first.canonical!;
  const foreignFile = path.join(foreign, "foreign.jsonl"); fs.writeFileSync(foreignFile, JSON.stringify({ type: "session", id: randomUUID(), cwd: foreign }) + "\n");
  fs.symlinkSync(foreignFile, path.join(path.dirname(canonical.path), "outside-link.jsonl"));
  fs.copyFileSync(foreignFile, path.join(path.dirname(canonical.path), "foreign.jsonl"));
  for (const name of ["foreign-cwd", "foreign-agent", "symlink-session", "foreign-header"]) {
    await x.pool.operate(x.sid, x.tab, { type: "command", name });
    const state = await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === name));
    assert.match(String(state.events.find(event => event.type === "command_end" && event.name === name)!.error), /forbids changing|Symlink|identity\/cwd mismatch/);
    assert.deepEqual(state.binding?.canonical, canonical);
  }
  assert.equal(fs.readFileSync(path.join(x.install.agent, "fixture-services.log"), "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(path.join(foreign, "fixture-services.log")), false);
});

test("renderer invalidate rebuilds async call, result refreshes call context, and expansion refreshes existing slots", async t => {
  const x = await fixture(t, { fixtureAsyncRenderer: true, fixtureToolError: true });
  await x.pool.handshake(x.sid, x.tab); await x.pool.operate(x.sid, x.tab, { type: "prompt", message: "authored fake only" });
  let state = await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "terminal_frame" && String(event.data).includes("error=true async=true")));
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "expanded" });
  state = await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === "expanded"));
  assert.ok(state.events.some(event => event.type === "terminal_frame" && String(event.data).includes("TOOL CALL fake-tool-id expanded=true")));
  assert.ok(state.events.some(event => event.type === "terminal_frame" && String(event.data).includes("partial=false expanded=true")));
});

test("late old-session renderer invalidation cannot populate replacement UI; display:false never invokes renderer", async t => {
  const x = await fixture(t, { fixtureAsyncRenderer: true, fixtureDeferredRenderer: true });
  await x.pool.handshake(x.sid, x.tab); await x.pool.operate(x.sid, x.tab, { type: "prompt", message: "fake deferred renderer" });
  await until(() => events(x.pool, x.sid), value => value.binding?.lastSubmission?.status === "settled");
  await x.pool.operate(x.sid, x.tab, { type: "reload" });
  const before = await events(x.pool, x.sid);
  for (const name of ["release-renderer", "hidden-message"]) {
    await x.pool.operate(x.sid, x.tab, { type: "command", name });
    await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === name));
  }
  const after = await x.pool.snapshot(x.sid, x.tab, before.through);
  assert.deepEqual(after.ui?.surfaces, []);
  assert.equal(after.events.some(event => event.type === "terminal_open" || event.code === "renderer_error"), false);
});

test("over 512 events evict projection history without starving approval or permanently requiring caught-up resync", async t => {
  const x = await fixture(t); await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "tool-flood" });
  const initial = await until(() => events(x.pool, x.sid), state => state.events.some(event => event.type === "command_end" && event.name === "tool-flood"));
  assert.ok(initial.through > 512); assert.equal(initial.truncated, true); assert.ok(initial.events.length <= 512); assert.ok(initial.ui!.surfaces.length <= 48);
  const caughtUp = await x.pool.snapshot(x.sid, x.tab, initial.through, initial.generation);
  assert.equal(caughtUp.truncated, true); assert.equal(caughtUp.resyncRequired, false);
  assert.equal((await x.pool.snapshot(x.sid, x.tab, 1, initial.generation)).resyncRequired, true);
  assert.equal((await x.pool.snapshot(x.sid, x.tab, initial.through + 99, initial.generation)).resyncRequired, true);
  assert.equal((await x.pool.snapshot(x.sid, x.tab, initial.through, initial.generation + 1)).resyncRequired, true);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "custom" });
  const pending = await until(() => events(x.pool, x.sid), state => !!state.ui?.surfaces.some(surface => surface.kind === "custom"));
  const custom = pending.ui!.surfaces.find(surface => surface.kind === "custom")!;
  await x.pool.operate(x.sid, x.tab, { type: "terminal_input", surfaceId: custom.surfaceId, data: "y" });
  await until(() => events(x.pool, x.sid), state => state.events.some(event => event.type === "command_end" && event.name === "custom"));
});

test("SDK-advertised max/future thinking levels and actual effective level are read-only runtime state", async t => {
  const x = await fixture(t, { defaultThinkingLevel: "max", fixtureThinkingLevels: ["off", "max", "future-level"], fixtureEffectiveThinking: "max" });
  const file = path.join(x.install.agent, "settings.json"), original = fs.readFileSync(file);
  const connected = await x.pool.handshake(x.sid, x.tab); assert.equal(connected.thinkingLevel, "max");
  assert.deepEqual(connected.availableThinkingLevels, ["off", "max", "future-level"]);
  const result = await x.pool.operate(x.sid, x.tab, { type: "set_thinking", level: "future-level" });
  assert.equal(result.thinkingLevel, "max", "Report SDK effective value, not requested value");
  const snapshot = await events(x.pool, x.sid); assert.equal(snapshot.runtimeState?.thinkingLevel, "max"); assert.equal(snapshot.runtimeState?.model?.provider, "fake");
  await assert.rejects(x.pool.operate(x.sid, x.tab, { type: "set_thinking", level: "high" }), /not available/);
  assert.deepEqual(fs.readFileSync(file), original);
});

test("managed launcher uses canonical identity acquired after a competing writer changes it", async t => {
  const x = await fixture(t); await x.pool.handshake(x.sid, x.tab); const target = await x.pool.handoff(x.sid, x.tab);
  const acquire = PiBindings.prototype.acquire, replacement = { id: randomUUID(), path: path.join(path.dirname(target.canonical.path), "replacement.jsonl"), cwd: target.canonical.cwd };
  let changed = false;
  PiBindings.prototype.acquire = function(workspace, tab, logical, mode) {
    if (mode === "handoff" && !changed) {
      changed = true;
      const writer = acquire.call(this, workspace, tab, logical, "desktop");
      const header = JSON.parse(fs.readFileSync(target.canonical.path, "utf8").split("\n")[0]);
      fs.writeFileSync(replacement.path, JSON.stringify({ ...header, id: replacement.id }) + "\n");
      this.bind(workspace, tab, writer.lease, replacement, path.dirname(replacement.path)); this.release(workspace, tab, writer.lease);
    }
    return acquire.call(this, workspace, tab, logical, mode);
  };
  try { assert.equal(await handoff(target.bindingFile, target.executable), 0); } finally { PiBindings.prototype.acquire = acquire; }
  const args = JSON.parse(fs.readFileSync(path.join(x.store.safe("pi-workspaces", hash(x.sid)), "handoff-args.json"), "utf8"));
  assert.equal(args[1], replacement.path); assert.notEqual(args[1], target.canonical.path);
});

for (const mode of ["sdk", "cli"]) test(`${mode} child cannot import SDK/CLI or write canonical history before its PID is durably published`, async t => {
  const x = await fixture(t), first = await x.pool.handshake(x.sid, x.tab); await x.pool.stop(x.sid);
  const bindingFile = new PiBindings(x.store.safe("pi-bindings")).file(x.sid, x.tab), pidFile = path.join(x.root, "gated-child.pid"), importProbe = path.join(x.root, "unexpected-sdk-import");
  const before = fs.readFileSync(first.canonical!.path), services = fs.readFileSync(path.join(x.install.agent, "fixture-services.log"));
  const helper = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/pi-activation-crash-child.ts"), JSON.stringify({ mode, bindingFile, pidFile, importProbe, agentDir: x.install.agent, workspace: x.sid, executable: x.install.executable })], { stdio: "ignore" });
  const closed = new Promise<void>(resolve => helper.once("close", () => resolve()));
  t.after(async () => { if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL"); await closed; });
  await closed; assert.equal(helper.signalCode, "SIGKILL");
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  await until(async () => definitelyDead(childPid), Boolean);
  assert.equal(fs.existsSync(importProbe), false, "No installed module import happened before activation");
  assert.equal(fs.existsSync(path.join(x.store.safe("pi-workspaces", hash(x.sid)), "handoff-args.json")), false);
  assert.deepEqual(fs.readFileSync(first.canonical!.path), before);
  assert.deepEqual(fs.readFileSync(path.join(x.install.agent, "fixture-services.log")), services);
  x.pool.reconcile(x.sid, x.tab, recoveryInput(x.pool.ownership(x.sid, x.tab)));
  assert.equal(x.pool.info().active, 0);
});

test("input-consumed native prompts settle before ACK without agent events and cannot be downgraded or leave busy gate stuck", async t => {
  const x = await fixture(t, { fixtureHandledInput: true }); await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "prompt", message: "consumed by fake input hook" });
  const first = await events(x.pool, x.sid), receipt = first.binding!.lastSubmission!;
  assert.equal(receipt.status, "settled"); assert.equal(first.runtimeState?.isStreaming, false);
  assert.ok(first.events.some(event => event.type === "prompt_end" && event.requestId === receipt.id));
  assert.equal(first.events.some(event => event.type === "agent_start" || event.type === "agent_settled"), false);
  await x.pool.operate(x.sid, x.tab, { type: "prompt", message: "second explicit consumed input" });
  const second = await events(x.pool, x.sid);
  assert.equal(second.binding?.lastSubmission?.status, "settled"); assert.notEqual(second.binding?.lastSubmission?.id, receipt.id);
});

test("input-consumed immutable batch ends conservatively without an assistant rather than hanging accepted forever", async t => {
  const x = await fixture(t, { fixtureHandledInput: true });
  x.store.change(x.sid, x.store.get(x.sid).revision, state => { state.tabs.Ideas.provider = "fake"; state.tabs.Ideas.model = "fixture"; });
  x.store.discussion(x.sid, x.store.get(x.sid).revision, { destination: "Ideas", instruction: "fake intercepted input" });
  const batch = x.store.get(x.sid).batches.at(-1)!;
  await x.pool.send(x.sid, batch.id);
  await until(async () => x.store.get(x.sid).batches.at(-1)!.status, value => value === "delivery-uncertain");
  assert.equal(x.store.get(x.sid).batches.at(-1)!.id, batch.id);
  assert.equal(x.store.get(x.sid).batches.at(-1)!.response, "");
});

test("Reload disposes header/footer/widget/editor before old runner invalidation and retains the draft", async t => {
  const x = await fixture(t, { fixtureReloadOrder: true });
  const connected = await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "factories" });
  await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === "factories"));
  const text = "unsent expanded draft ".repeat(80);
  await x.pool.operate(x.sid, x.tab, { type: "editor_state", text });
  await x.pool.operate(x.sid, x.tab, { type: "reload" });
  const disposed = x.pool.history(x.sid, x.tab).entries.filter((entry: any) => entry.customType === "fixture-component-dispose") as any[];
  assert.deepEqual(disposed.map(entry => entry.data.kind).sort(), ["editor", "footer", "header", "widget"]);
  assert.ok(disposed.every(entry => entry.data.stale === false), "All component disposal must precede invalidation, not merely session_start");
  const state = await events(x.pool, x.sid);
  assert.equal(state.ui?.editor, text);
  assert.deepEqual(state.binding?.canonical, connected.canonical);
});

test("tool renderer contexts are fresh invocation snapshots with slot-local lastComponent and shared state", async t => {
  const x = await fixture(t, { fixtureRendererContexts: true });
  await x.pool.handshake(x.sid, x.tab);
  await x.pool.operate(x.sid, x.tab, { type: "prompt", message: "authored renderer context probe only" });
  await until(() => events(x.pool, x.sid), value => value.binding?.lastSubmission?.status === "settled");
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "expanded" });
  await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === "expanded"));
  await x.pool.operate(x.sid, x.tab, { type: "command", name: "inspect-renderer-contexts" });
  const state = await until(() => events(x.pool, x.sid), value => value.events.some(event => event.type === "command_end" && event.name === "inspect-renderer-contexts"));
  const notification = state.events.find(event => event.type === "notification" && String(event.message).startsWith('{"contexts":'))!;
  const proof = JSON.parse(String(notification.message));
  assert.ok(proof.contexts >= 5);
  assert.equal(proof.uniqueContexts, proof.contexts);
  assert.equal(proof.stableLastComponent, true, "Later call/result rebuilds must not mutate captured contexts");
  assert.equal(proof.correctSlot, true);
  assert.equal(proof.sharedState, true);
});

for (const outcome of ["settled", "failed"] as const) test(`lost prompt ACK after durable ${outcome} receipt does not create an unrecoverable workspace warning`, async t => {
  const x = await fixture(t, { fixtureHandledInput: outcome === "failed" ? "fail" : true });
  const connected = await x.pool.handshake(x.sid, x.tab);
  const rpc = (x.pool as any).entries.get(x.sid + ":" + x.tab).rpc;
  const consume = rpc.consume, timeout = rpc.timeout;
  let droppedId: string | undefined;
  rpc.timeout = 300;
  // Private IPC delivers one complete envelope per consume call. Drop the actual
  // correlated ACK, not a wrapper rejection, while letting prompt_end through.
  rpc.consume = function(bytes: Buffer) {
    const frame = JSON.parse(bytes.toString("utf8"));
    if (frame.type === "response" && frame.command === "prompt") {
      droppedId = frame.id;
      return;
    }
    consume.call(this, bytes);
  };
  try {
    await assert.rejects(x.pool.operate(x.sid, x.tab, { type: "prompt", message: "exactly once despite ACK loss" }), /RPC prompt timeout/);
  } finally {
    rpc.consume = consume;
    rpc.timeout = timeout;
  }
  const state = await events(x.pool, x.sid), receipt = state.binding!.lastSubmission!;
  assert.ok(droppedId);
  assert.equal(receipt.id, droppedId);
  assert.equal(receipt.status, outcome);
  assert.equal(state.connected, true, "A lost ACK alone need not stop an already-settled healthy host");
  assert.deepEqual((await x.pool.handshake(x.sid, x.tab)).canonical, connected.canonical);
  await x.pool.stop(x.sid, x.tab);
  // Inspection includes live ownership in recoveryRequired; after explicit Stop
  // there must be neither a lease nor any unresolved submission/recovery gate.
  assert.equal(x.pool.ownership(x.sid, x.tab).recoveryRequired, false);
  assert.deepEqual((await x.pool.handshake(x.sid, x.tab)).canonical, connected.canonical);
  assert.equal(x.pool.history(x.sid, x.tab).entries.filter((entry: any) => entry.customType === "fixture-input-handled").length, 1, "Never replay on lost ACK or reconnect");
  assert.equal(x.pool.ownership(x.sid, x.tab).binding!.lastSubmission!.id, receipt.id);
});
