import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fixture } from "./platform-fixtures.ts";
import { Workbench } from "../server/workbench/tools.ts";
import { RunService } from "../server/workbench/runs.ts";
import { mcpHandle } from "../server/workbench/mcp.ts";
import { parseToml, readManifest } from "../src/research-manifest.ts";

// Runs use the login shell; a plain sh keeps the tests independent of the user's profile.
process.env.SHELL = "/bin/sh";
const idea = { rationale: "Carry", universe: "BTC perp", horizon: "8h", falsification: "No net carry", uncertainty: "conjectured" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(t: any) {
  const x = fixture(t);
  const s = x.store.create("Runs");
  const wb = new Workbench(x.store, x.platform, undefined, 0);
  t.after(() => wb.close());
  const call = (name: string, input: unknown = {}) => wb.call(s.id, name, input) as Promise<any>;
  const agent = async (name: string, args: unknown) => {
    const r: any = await mcpHandle(wb, s.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "research");
    return { error: r.result.isError as boolean, text: r.result.content[0].text as string, value: r.result.structuredContent };
  };
  const until = async (id: string, done: (r: any) => boolean, ms = 15000): Promise<any> => {
    for (let i = 0; i < ms / 50; i++) {
      wb.runs.tick();
      const r = wb.runs.read(s.id, id);
      if (done(r)) return r;
      await sleep(50);
    }
    throw new Error(`Run ${id} stayed ${wb.runs.read(s.id, id).status}: ${wb.runs.log(s.id, id).text}`);
  };
  const ended = (id: string) => until(id, (r) => ["succeeded", "failed", "cancelled", "lost"].includes(r.status));
  return { ...x, sid: s.id, wb, call, agent, until, ended };
}
async function pursued(call: (n: string, i?: unknown) => Promise<any>, title: string) {
  const d = await call("idea_create", { title });
  await call("idea_update", { target: d.created, patch: idea });
  const saved = (await call("idea_save", { target: d.created })).saved as string;
  await call("idea_decide", { target: saved, decision: "pursue", reason: "Test it" });
  return saved;
}
const MANIFEST = `# research.toml
[env]

[run.train]
command = "sh train.sh"   # writes outputs/metrics.json
description = "Fit and score"
inputs = [
  "prices",
]

[run.validate]
command = 'sh train.sh holdout'

[[feature]]
name = "funding_z"
lookback = "30d"
`;
const TRAIN = (sharpe: number) => `set -e
echo "reading data/prices.csv"; head -1 data/prices.csv
mkdir -p "$PI_RESEARCH_OUTPUTS/figs"
printf '{"sharpe": ${sharpe}, "split": "%s", "stats": {"n": 3}}' "\${1:-train}" > "$PI_RESEARCH_OUTPUTS/metrics.json"
echo png > "$PI_RESEARCH_OUTPUTS/figs/equity.png"
`;

test("research.toml: the subset the manifest needs, with line-numbered refusals", () => {
  const t = parseToml(MANIFEST);
  assert.deepEqual(t, {
    env: {},
    run: { train: { command: "sh train.sh", description: "Fit and score", inputs: ["prices"] }, validate: { command: "sh train.sh holdout" } },
    feature: [{ name: "funding_z", lookback: "30d" }],
  });
  assert.equal(parseToml('a = "x # not a comment" # comment').a, "x # not a comment");
  assert.deepEqual(parseToml("n = 1_000\nf = -2.5e3\nb = true\nxs = [1, 2]"), { n: 1000, f: -2500, b: true, xs: [1, 2] });
  assert.throws(() => parseToml("a = {x = 1}"), /line 1: unsupported value/);
  assert.throws(() => parseToml("a = 1\na = 2"), /line 2: a is defined twice/);
  assert.match(readManifest("[run.Train]\ncommand = 'x'").error!, /run\.Train: entry names are lower-case/);
  assert.match(readManifest("[run.x]\n").error!, /command/);
  assert.deepEqual(readManifest(null), { manifest: null, error: null });
  assert.equal(readManifest("[extra]\nkeep = 1\n[run.x]\ncommand='y'\nlater = 2").manifest!.run!.x.command, "y", "unknown keys are kept and ignored");
});

test("a run executes one checkpoint and records what ran and what came out; two runs compare", async (t) => {
  const { call, wb, sid, store, ended } = setup(t);
  const a = await pursued(call, "Funding carry");
  await call("rd_files", { idea: a });
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", a.slice(2));
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n");
  await call("data_register", { idea: a, path: "px.csv", title: "Prices" });
  fs.writeFileSync(path.join(dir, "research.toml"), MANIFEST);
  fs.writeFileSync(path.join(dir, "train.sh"), TRAIN(1.2));
  fs.writeFileSync(path.join(dir, "uv.lock"), "version = 1\n");

  const overview = await call("runs_list", { idea: a });
  assert.deepEqual(overview.entries.map((e: any) => e.name), ["train", "validate"]);
  assert.deepEqual([overview.limit, overview.agentUsage], [{ runs: 5, minutes: 60 }, { runs: 0, minutes: 0 }]);
  await assert.rejects(call("run_submit", { idea: a, entry: "nope" }), /no \[run\.nope\]; its entries are train, validate/);

  // Uncheckpointed work is checkpointed first, so the run records exactly what ran.
  const s1 = await call("run_submit", { idea: a, entry: "train", note: "first fit" });
  assert.equal(s1.autoCheckpoint, true);
  const history = await call("rd_history", { idea: a });
  assert.equal(history.checkpoints[0].message, "Before run: train");
  assert.equal(s1.commit, history.checkpoints[0].sha);
  // Editing the workspace while it runs changes nothing that runs.
  fs.writeFileSync(path.join(dir, "train.sh"), TRAIN(9.9));
  const r1 = await ended(s1.id);
  assert.equal(r1.status, "succeeded", wb.runs.log(sid, s1.id).text);
  assert.deepEqual(r1.metrics, { sharpe: 1.2, split: "train", "stats.n": 3 });
  assert.deepEqual(r1.outputs.map((o: any) => o.path), ["figs/equity.png", "metrics.json"]);
  assert.match(r1.outputs[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r1.snapshots.map((s: any) => s.name), ["prices"], "the data it used, from the entry's inputs and the code");
  assert.deepEqual(r1.environment.lock?.file, "uv.lock");
  assert.ok(r1.environment.files.includes("uv.lock"));
  assert.equal(r1.exitCode, 0);
  assert.ok(r1.usage.wallSeconds >= 0);
  if (process.platform === "darwin") assert.ok(r1.usage.peakMemoryBytes > 0, "peak memory from /usr/bin/time");
  assert.match(wb.runs.log(sid, s1.id).text, /reading data\/prices\.csv\s+date,close/);
  assert.ok(r1.hardware.cores > 0);

  // A second run of the edited code; compare says what changed and by how much.
  const s2 = await call("run_submit", { idea: a, entry: "train" });
  const r2 = await ended(s2.id);
  assert.equal(r2.metrics.sharpe, 9.9);
  const cmp = await call("run_compare", { a: s1.id, b: s2.id });
  assert.deepEqual(cmp.differences.map((d: any) => d.field), ["checkpoint"]);
  assert.deepEqual(cmp.warnings, [], "same data, command and environment: like for like");
  assert.deepEqual(cmp.metrics.find((m: any) => m.name === "sharpe"), { name: "sharpe", a: 1.2, b: 9.9, delta: 9.9 - 1.2 });

  // A failing command says so; the list shows both, newest first.
  const s3 = await call("run_submit", { idea: a, command: "echo oops >&2; exit 3" });
  const r3 = await ended(s3.id);
  assert.deepEqual([r3.status, r3.exitCode, r3.reason], ["failed", 3, "Exited with code 3; see the log"]);
  assert.equal(s3.autoCheckpoint, false, "nothing to checkpoint");
  const cmp2 = await call("run_compare", { a: s1.id, b: s3.id });
  assert.ok(cmp2.warnings.some((w: string) => /different commands/.test(w)) && cmp2.warnings.some((w: string) => /did not succeed/.test(w)));
  assert.deepEqual((await call("runs_list", { idea: a })).runs.map((r: any) => r.id), [s3.id, s2.id, s1.id]);
});

test("runs can be cancelled; the time limit stops them; a restart reconciles what happened meanwhile", async (t) => {
  const { call, wb, sid, store, ended } = setup(t);
  const a = await pursued(call, "Slow idea");
  await call("rd_files", { idea: a });
  const long = await call("run_submit", { idea: a, command: "echo started; sleep 30" });
  const running = await (async () => {
    for (let i = 0; i < 200; i++) {
      wb.runs.tick();
      if (wb.runs.read(sid, long.id).status === "running") return true;
      await sleep(25);
    }
    return false;
  })();
  assert.ok(running);
  await call("run_cancel", { run: long.id });
  const c = await ended(long.id);
  assert.deepEqual([c.status, c.reason], ["cancelled", "Cancelled"]);
  await assert.rejects(call("run_cancel", { run: long.id }), /already ended/);

  // Time limit: a run past its limit is stopped at the next check (here a 10 s limit).
  const slow = await call("run_submit", { idea: a, command: "sleep 30", wallMinutes: 1 });
  for (let i = 0; i < 200 && wb.runs.read(sid, slow.id).status !== "running"; i++) (wb.runs.tick(), await sleep(25));
  const file = path.join(wb.runs.dir(sid), slow.id, "run.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wallSeconds: 10 }));
  const stopped = await ended(slow.id);
  assert.deepEqual([stopped.status, stopped.reason], ["failed", "Stopped at its time limit (10 s)"]);

  // A run that finished while the app was closed; and one whose process vanished.
  const quick = await call("run_submit", { idea: a, command: "echo done" });
  for (let i = 0; i < 200 && wb.runs.read(sid, quick.id).status !== "running"; i++) (wb.runs.tick(), await sleep(25));
  wb.runs.close();
  await sleep(500);
  // And one recorded as running under a process that no longer exists (no exit file).
  const ghost = spawn("/bin/sh", ["-c", "exit 0"]);
  await new Promise((r) => ghost.on("close", r));
  const lostId = "00000000-0000-4000-8000-00000000abcd";
  const q = JSON.parse(fs.readFileSync(path.join(wb.runs.dir(sid), quick.id, "run.json"), "utf8"));
  fs.mkdirSync(path.join(wb.runs.dir(sid), lostId));
  fs.writeFileSync(path.join(wb.runs.dir(sid), lostId, "run.json"), JSON.stringify({ ...q, id: lostId, status: "running", pid: ghost.pid, startedAt: new Date().toISOString() }));
  const next = new RunService((s) => store.storage.strategyRoot(s), () => [sid], () => []);
  t.after(() => next.close());
  for (let i = 0; i < 100 && !["succeeded", "lost"].every((st, k) => next.read(sid, [quick.id, lostId][k]).status === st); i++) (next.tick(), await sleep(50));
  assert.equal(next.read(sid, quick.id).status, "succeeded", "its exit file says how it ended");
  const lost = next.read(sid, lostId);
  assert.equal(lost.status, "lost");
  assert.match(lost.reason!, /without reporting how it ended/);
});

test("agents have a run limit per hour that only the user can change", async (t) => {
  const { call, agent, sid, store } = setup(t);
  const a = await pursued(call, "Agent runs");
  await call("rd_files", { idea: a });
  assert.equal((await agent("run_limit_set", { runs: 50, minutes: 600 })).error, true);
  await call("run_limit_set", { runs: 2, minutes: 90 });
  assert.deepEqual(store.get(sid).runLimit, { runs: 2, minutes: 90 });
  const first = await agent("run_submit", { idea: a, command: "true", wallMinutes: 60 });
  assert.equal(first.error, false, first.text);
  assert.equal(first.value.origin, "agent");
  const tooLong = await agent("run_submit", { idea: a, command: "true", wallMinutes: 45 });
  assert.match(tooLong.text, /exceed the agent limit of 90 run minutes per hour \(60 used\)\. Give a shorter wallMinutes \(at most 30\)/);
  assert.equal((await agent("run_submit", { idea: a, command: "true", wallMinutes: 30 })).error, false);
  const third = await agent("run_submit", { idea: a, command: "true", wallMinutes: 1 });
  assert.match(third.text, /run limit is reached: 2 runs per hour \(2 used\)/);
  // The user is never limited.
  await call("run_submit", { idea: a, command: "true" });
  assert.deepEqual((await call("runs_list", { idea: a })).agentUsage, { runs: 2, minutes: 90 });
});

test("a release candidate is validated on exactly its checkpoint, with its entry", async (t) => {
  const { call, wb, sid, store, ended } = setup(t);
  const a = await pursued(call, "Candidate idea");
  await call("rd_files", { idea: a });
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", a.slice(2));
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n");
  await call("data_register", { idea: a, path: "px.csv", title: "Prices" });
  fs.writeFileSync(path.join(dir, "research.toml"), MANIFEST);
  fs.writeFileSync(path.join(dir, "train.sh"), TRAIN(1.5));
  await call("rd_checkpoint", { idea: a, message: "Ready" });
  assert.deepEqual(await call("candidate_status"), { current: null, earlier: 0 });
  const c = await call("production_commit", { idea: a });
  assert.deepEqual([c.number, c.entry], [1, "validate"], "the entry named validate is the default");
  // Research goes on; the candidate stays what it was.
  fs.writeFileSync(path.join(dir, "train.sh"), "exit 1\n");
  let st = await call("candidate_status");
  assert.equal(st.state, "not validated");
  assert.equal(st.checks.entry, "validate");
  const v = await call("candidate_validate");
  assert.deepEqual([v.candidate, v.commit, v.entry], [1, c.checkpoint, "validate"]);
  const r = await ended(v.id);
  assert.equal(r.status, "succeeded", wb.runs.log(sid, v.id).text);
  assert.deepEqual([r.metrics.sharpe, r.metrics.split], [1.5, "holdout"]);
  assert.deepEqual(r.snapshots.map((s: any) => s.name), ["prices"]);
  st = await call("candidate_status");
  assert.deepEqual([st.state, st.validationRuns.length], ["passed", 1]);
  assert.equal(execFileSync("git", ["rev-parse", "candidate/1^{commit}"], { cwd: dir, encoding: "utf8" }).trim(), c.checkpoint);
});
