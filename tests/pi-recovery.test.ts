import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { PiBindings } from "../server/pi-bindings.ts";
import { definitelyDead } from "../server/pi-coordination.ts";
import type { PiRecoveryRequest } from "../src/pi-protocol.ts";

function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-recovery-"))), sessions = path.join(root, "sessions"), bindings = new PiBindings(path.join(root, "bindings"));
  fs.mkdirSync(sessions); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = { id: "canonical", path: path.join(sessions, "canonical.jsonl") };
  fs.writeFileSync(canonical.path, JSON.stringify({ type: "session", id: canonical.id, cwd: root }) + "\n");
  const { lease } = bindings.acquire("workspace", "Ideas", "logical"); bindings.bind("workspace", "Ideas", lease, canonical, sessions);
  return { root, sessions, bindings, lease, canonical };
}
function deadPid() { const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }); assert.equal(child.status, 0); assert.equal(definitelyDead(child.pid), true); return child.pid; }
function request(bindings: PiBindings, sessions: string): PiRecoveryRequest {
  const inspected = bindings.inspect("workspace", "Ideas", sessions);
  return { expectedGeneration: inspected.binding?.generation ?? 0, lease: inspected.lease ? { nonce: inspected.lease.nonce, pid: inspected.lease.pid, generation: inspected.lease.generation, mode: inspected.lease.mode } : null, coordination: inspected.coordination, submissionId: inspected.binding?.lastSubmission?.id ?? null, historyReviewed: true, unmanagedWritersStopped: true, note: "Reviewed disposable canonical fixture; no unmanaged writer" };
}
test("malformed ownership cannot be acknowledged or silently removed", t => {
  const x = fixture(t), file = x.bindings.file("workspace", "Ideas") + ".lease";
  fs.writeFileSync(file, JSON.stringify({ ...x.lease, pid: "unknown" }));
  const inspection = x.bindings.inspect("workspace", "Ideas", x.sessions);
  assert.match(inspection.leaseError ?? "", /Malformed/);
  const before = fs.readFileSync(file);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, { expectedGeneration: inspection.binding!.generation, lease: null, coordination: inspection.coordination, submissionId: null, historyReviewed: true, unmanagedWritersStopped: true, note: "Unknown is not dead" }), /Malformed/);
  assert.deepEqual(fs.readFileSync(file), before);
});
function unresolved(x: ReturnType<typeof fixture>, status: "pending" | "accepted" | "uncertain" = "uncertain") {
  const receipt = { id: randomUUID(), kind: "prompt" as const, status: "pending" as const, at: new Date().toISOString(), detail: "Fixture intent; never model output" };
  x.bindings.submission("workspace", "Ideas", x.lease, receipt);
  if (status !== "pending") x.bindings.submission("workspace", "Ideas", x.lease, { ...receipt, status });
  return { ...receipt, status };
}

test("reconciliation requires exact CAS, definitely-dead owner and explicit acknowledgements", t => {
  const x = fixture(t); unresolved(x);
  const live = request(x.bindings, x.sessions);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, live), /alive|dead/);
  x.bindings.setPid("workspace", "Ideas", x.lease, deadPid());
  const expected = request(x.bindings, x.sessions);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, { ...expected, historyReviewed: false } as any), /acknowledgements/);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, { ...expected, submissionId: randomUUID() }), /Stale binding/);
  const refreshed = request(x.bindings, x.sessions);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, { ...refreshed, lease: { ...refreshed.lease!, nonce: randomUUID() } }), /Stale lease/);
  const kill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => { if (pid === x.lease.pid) { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; } return kill(pid, signal as any); }) as typeof process.kill;
  try { assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, request(x.bindings, x.sessions)), /alive|dead/); } finally { process.kill = kill; }
  assert.ok(fs.existsSync(x.bindings.file("workspace", "Ideas") + ".lease"));
  fs.unlinkSync(x.canonical.path);
  assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, request(x.bindings, x.sessions)), /missing/);
  assert.ok(fs.existsSync(x.bindings.file("workspace", "Ideas") + ".lease"));
});

for (const status of ["pending", "accepted", "uncertain"] as const) test(`${status} receipt remains gated across restart; explicit reconciliation retains original audit before permitting new input`, t => {
  const x = fixture(t), original = unresolved(x, status);
  x.bindings.release("workspace", "Ideas", x.lease);
  const restarted = new PiBindings(x.bindings.root), fresh = restarted.acquire("workspace", "Ideas", "logical");
  assert.throws(() => restarted.submission("workspace", "Ideas", fresh.lease, { ...original, id: randomUUID(), status: "pending" }), /reconciliation/);
  restarted.release("workspace", "Ideas", fresh.lease);
  assert.throws(() => restarted.acquire("workspace", "Ideas", "logical", "handoff"), /reconciliation/);
  const old = request(restarted, x.sessions), recovered = restarted.reconcile("workspace", "Ideas", "logical", x.sessions, old);
  assert.equal(recovered.lastSubmission?.status, status); assert.ok(recovered.lastSubmission?.acknowledgedAt);
  const auditBytes = fs.readFileSync(recovered.recovery!.auditFile), audit = JSON.parse(auditBytes.toString());
  assert.deepEqual(audit.binding.lastSubmission, original);
  assert.throws(() => restarted.reconcile("workspace", "Ideas", "logical", x.sessions, old), /Stale/);
  const next = restarted.acquire("workspace", "Ideas", "logical");
  restarted.submission("workspace", "Ideas", next.lease, { ...original, id: randomUUID(), status: "pending" });
  assert.deepEqual(fs.readFileSync(recovered.recovery!.auditFile), auditBytes, "Old uncertain receipt remains immutable after new submission");
  restarted.release("workspace", "Ideas", next.lease);
});

test("authoritative binding state is read only after exclusive coordination", t => {
  const x = fixture(t); x.bindings.release("workspace", "Ideas", x.lease);
  const get = x.bindings.get.bind(x.bindings); let checked = false;
  x.bindings.get = (workspace, tab) => { const state = x.bindings.coordinator(workspace, tab).inspect(); assert.equal(state?.complete, false); assert.equal(state?.pid, process.pid); checked = true; return get(workspace, tab); };
  const acquired = x.bindings.acquire("workspace", "Ideas", "logical");
  assert.equal(checked, true); x.bindings.get = get; x.bindings.release("workspace", "Ideas", acquired.lease);
});

for (const boundary of ["audit", "binding", "lease"] as const) test(`recovery crash at ${boundary} publication stays blocked and is explicitly recoverable`, t => {
  const x = fixture(t), original = unresolved(x); x.bindings.setPid("workspace", "Ideas", x.lease, deadPid());
  const before = request(x.bindings, x.sessions), rename = fs.renameSync, unlink = fs.unlinkSync, bindingFile = x.bindings.file("workspace", "Ideas");
  fs.renameSync = (from, to) => { if (boundary === "audit" && String(to).endsWith(".recovery.json") || boundary === "binding" && String(to) === bindingFile) throw new Error("Injected crash boundary"); rename(from, to); };
  fs.unlinkSync = file => { if (boundary === "lease" && String(file) === bindingFile + ".lease") throw new Error("Injected crash boundary"); unlink(file); };
  try { assert.throws(() => x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, before), /crash boundary/); } finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
  const restarted = new PiBindings(x.bindings.root);
  assert.equal(restarted.coordinator("workspace", "Ideas").inspect()?.recoveryRequired, true);
  assert.throws(() => restarted.acquire("workspace", "Ideas", "logical"), /reconciliation/);
  const after = restarted.reconcile("workspace", "Ideas", "logical", x.sessions, request(restarted, x.sessions));
  assert.equal(after.lastSubmission?.id, original.id); assert.equal(after.lastSubmission?.status, "uncertain");
  assert.equal(fs.existsSync(bindingFile + ".lease"), false);
  const next = restarted.acquire("workspace", "Ideas", "logical"); restarted.release("workspace", "Ideas", next.lease);
});

async function child(root: string, mode: string) {
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/pi-binding-race-child.ts"), root, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const [ready] = await once(child, "message"); assert.equal((ready as any).ready, true);
  return { child, closed };
}
test("two processes cannot acquire concurrently; dead immutable coordination owners require explicit recovery", async t => {
  const x = fixture(t); x.bindings.release("workspace", "Ideas", x.lease);
  const a = await child(x.root, "acquire"), b = await child(x.root, "acquire");
  t.after(async () => { for (const c of [a, b]) { if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL"); await c.closed; } });
  const answers = [once(a.child, "message"), once(b.child, "message")]; a.child.send({ type: "go" }); b.child.send({ type: "go" });
  const results = (await Promise.all(answers)).map(([message]) => message as any); assert.equal(results.filter(r => r.ok).length, 1);
  const winner = results[0].ok ? a : b; winner.child.send({ type: "release" }); await Promise.all([a.closed, b.closed]);
  const crashed = await child(x.root, "crash-coordination"); crashed.child.send({ type: "go" }); await crashed.closed;
  const pending = x.bindings.coordinator("workspace", "Ideas").inspect(); assert.equal(pending?.complete, false); assert.equal(definitelyDead(pending!.pid), true);
  assert.throws(() => x.bindings.acquire("workspace", "Ideas", "logical"), /reconciliation/);
  x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, request(x.bindings, x.sessions));
  const lease = x.bindings.acquire("workspace", "Ideas", "logical").lease; x.bindings.release("workspace", "Ideas", lease);
});

test("crash after durable recovery and lease removal but before completion marker remains blocked without replay", async t => {
  const x = fixture(t); unresolved(x); x.bindings.setPid("workspace", "Ideas", x.lease, deadPid());
  const crashed = await child(x.root, "recover-crash-done"); crashed.child.send({ type: "go", request: request(x.bindings, x.sessions) }); await crashed.closed;
  assert.equal(fs.existsSync(x.bindings.file("workspace", "Ideas") + ".lease"), false);
  assert.equal(x.bindings.coordinator("workspace", "Ideas").inspect()?.complete, false);
  assert.throws(() => x.bindings.acquire("workspace", "Ideas", "logical"), /reconciliation/);
  const state = x.bindings.reconcile("workspace", "Ideas", "logical", x.sessions, request(x.bindings, x.sessions));
  assert.equal(state.lastSubmission?.status, "uncertain"); assert.ok(state.lastSubmission?.acknowledgedAt);
});

/** A real data-root move: runtime tree renamed wholesale to a new parent. */
function movedRoot(t: any) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-relocate-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const oldRoot = path.join(base, "Library", "Research Data"), newRoot = path.join(base, "Pi Research Data");
  const rt = (root: string) => path.join(root, ".runtime");
  const sessions = (root: string) => path.join(rt(root), "sessions", "strategy-1", "logical");
  const cwd = (root: string) => path.join(rt(root), "pi-workspaces", "abc123");
  fs.mkdirSync(sessions(oldRoot), { recursive: true });
  fs.mkdirSync(cwd(oldRoot), { recursive: true });
  const canonical = { id: "sess-1", path: path.join(sessions(oldRoot), "2026_sess-1.jsonl"), cwd: cwd(oldRoot) };
  const body = '{"type":"model_change","id":"m1"}\n{"type":"message","id":"u1","message":{"role":"user","content":"hello"}}\n';
  fs.writeFileSync(canonical.path, JSON.stringify({ type: "session", version: 3, id: canonical.id, timestamp: "t", cwd: canonical.cwd }) + "\n" + body);
  const before = new PiBindings(path.join(rt(oldRoot), "pi-bindings"));
  const { lease } = before.acquire("strategy-1", "Ideas", "logical");
  before.bind("strategy-1", "Ideas", lease, canonical, sessions(oldRoot));
  before.release("strategy-1", "Ideas", lease);
  fs.renameSync(oldRoot, newRoot);
  return { oldRoot, newRoot, sessions, cwd, canonical, body, bindings: new PiBindings(path.join(rt(newRoot), "pi-bindings")) };
}

test("a moved data root keeps Pi history readable and is reconciled only on evidence of a move", (t) => {
  const x = movedRoot(t);
  const dir = x.sessions(x.newRoot), cwd = x.cwd(x.newRoot);
  assert.throws(() => x.bindings.validateCanonical("strategy-1", "Ideas", dir, cwd), /outside its managed directory/);
  assert.equal(x.bindings.history("strategy-1", "Ideas", 0, 50).entries.length, 3, "history resolves the moved file read-only");
  assert.equal(fs.existsSync(path.join(x.newRoot, ".runtime", "relocations")), false, "reading never writes");

  const moved = x.bindings.relocate("strategy-1", "Ideas", dir, cwd)!;
  assert.equal(moved.from, x.canonical.path);
  assert.equal(moved.to, path.join(dir, "2026_sess-1.jsonl"));
  const text = fs.readFileSync(moved.to, "utf8");
  assert.equal(JSON.parse(text.split("\n")[0]).cwd, cwd, "header cwd rewritten");
  assert.equal(text.slice(text.indexOf("\n") + 1), x.body, "every byte after the header preserved");
  assert.deepEqual(x.bindings.validateCanonical("strategy-1", "Ideas", dir, cwd)?.path, moved.to);
  const audit = fs.readdirSync(path.join(x.newRoot, ".runtime", "relocations"));
  assert.equal(audit.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(x.newRoot, ".runtime", "relocations", audit[0]), "utf8"));
  assert.equal(record.previous.canonical.path, x.canonical.path);
  assert.equal(JSON.parse(record.previous.header).cwd, x.canonical.cwd, "original header kept for audit");
  assert.equal(x.bindings.relocate("strategy-1", "Ideas", dir, cwd), undefined, "idempotent once reconciled");
});

test("relocation refuses copies, foreign locations and live writers", (t) => {
  const copy = movedRoot(t);
  fs.mkdirSync(path.dirname(copy.canonical.path), { recursive: true });
  fs.copyFileSync(path.join(copy.sessions(copy.newRoot), "2026_sess-1.jsonl"), copy.canonical.path);
  assert.throws(
    () => copy.bindings.relocate("strategy-1", "Ideas", copy.sessions(copy.newRoot), copy.cwd(copy.newRoot)),
    /still exists/,
  );

  const foreign = movedRoot(t);
  assert.throws(
    () => foreign.bindings.relocate("strategy-1", "Ideas", foreign.sessions(foreign.newRoot), path.join(foreign.newRoot, ".runtime", "pi-workspaces", "other")),
    /working directory/,
  );

  const live = movedRoot(t);
  fs.writeFileSync(live.bindings.file("strategy-1", "Ideas") + ".lease", JSON.stringify({ version: 1, pid: process.pid, nonce: "n", generation: 9, mode: "desktop", acquiredAt: "t" }));
  assert.throws(
    () => live.bindings.relocate("strategy-1", "Ideas", live.sessions(live.newRoot), live.cwd(live.newRoot)),
    /lease exists/,
  );
  const header = JSON.parse(fs.readFileSync(path.join(live.sessions(live.newRoot), "2026_sess-1.jsonl"), "utf8").split("\n")[0]);
  assert.equal(header.cwd, live.canonical.cwd, "refused relocation changes nothing");
});
