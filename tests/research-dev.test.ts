import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RdWorkspaces } from "../server/workbench/rd.ts";
import { parseDiff } from "../src/workbench/panes/ResearchDev.tsx";

const IDEA = "11111111-1111-4111-8111-111111111111";
function tmp(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an idea's workspace is a git repository: files, changes since the last checkpoint, checkpoints and their diffs", async (t) => {
  const root = tmp(t);
  const rd = new RdWorkspaces(() => root);
  const dir = await rd.ensure("s", IDEA, "Robust Kelly");
  assert.equal(dir, path.join(root, "Research-Workspaces", IDEA));
  assert.equal(await rd.ensure("s", IDEA, "Robust Kelly"), dir, "idempotent");
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /# Robust Kelly/);
  assert.deepEqual((await rd.history(dir)).map((c) => c.message), ["Workspace created"]);
  assert.deepEqual((await rd.changes(dir)).files, []);

  // Pi writes code and a report; the app sees them as changes (new files included).
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "kelly.py"), "def kelly(mu, var):\n    return mu / var\n");
  fs.writeFileSync(path.join(dir, "report.md"), "# Result\n\n$f^* = \\mu/\\sigma^2$\n");
  fs.writeFileSync(path.join(dir, "fig.pdf"), Buffer.from("%PDF-1.4\0\u0001tiny", "latin1"));
  fs.mkdirSync(path.join(dir, "__pycache__"));
  fs.writeFileSync(path.join(dir, "__pycache__", "x.pyc"), "junk");
  const files = rd.files(dir);
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.document]), [
    [".gitignore", "text", false],
    ["fig.pdf", "pdf", true],
    ["README.md", "text", true],
    ["report.md", "text", true],
    ["src/kelly.py", "text", false],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))), "caches are skipped");
  let ch = await rd.changes(dir);
  assert.deepEqual(ch.files.map((f) => [f.path, f.status, f.added, f.removed, f.binary]), [
    ["fig.pdf", "A", 0, 0, true],
    ["report.md", "A", 3, 0, false],
    ["src/kelly.py", "A", 2, 0, false],
  ], "status and line counts per file, not the whole diff");
  assert.deepEqual([ch.added, ch.removed], [5, 0]);
  const one = await rd.fileDiff(dir, "src/kelly.py");
  assert.match(one.diff, /\+def kelly\(mu, var\):/);
  assert.equal(parseDiff(one.diff)[0].added, 2);
  assert.equal((await rd.fileDiff(dir, "fig.pdf")).binary, true);
  await assert.rejects(rd.fileDiff(dir, "../x"), /Invalid path/);
  await assert.rejects(rd.fileDiff(dir, "--output=/tmp/x"), /Invalid path/);

  // Reading: text, and PDFs as base64.
  assert.equal((rd.read(dir, "src/kelly.py") as any).text.split("\n")[0], "def kelly(mu, var):");
  assert.equal(Buffer.from((rd.read(dir, "fig.pdf") as any).base64, "base64").toString("latin1"), "%PDF-1.4\0\u0001tiny");
  assert.throws(() => rd.read(dir, "../outside.txt"), /Invalid path|outside/);
  assert.throws(() => rd.read(dir, ".git/config"), /Invalid path/);
  fs.writeFileSync(path.join(root, "secret.txt"), "no");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "link.txt"));
  assert.throws(() => rd.read(dir, "link.txt"), /outside the workspace/, "symlinks never lead out");
  fs.rmSync(path.join(dir, "link.txt"));

  // Checkpoint, then only later changes show; history and per-checkpoint diffs.
  const cp = await rd.checkpoint(dir, "Kelly fraction and first report");
  assert.equal(cp.message, "Kelly fraction and first report");
  assert.deepEqual((await rd.changes(dir)).files, []);
  await assert.rejects(rd.checkpoint(dir, "again"), /Nothing changed/);
  fs.writeFileSync(path.join(dir, "src", "kelly.py"), "def kelly(mu, var, cap=0.5):\n    return min(cap, mu / var)\n");
  ch = await rd.changes(dir);
  assert.deepEqual(ch.files, [{ path: "src/kelly.py", status: "M", added: 2, removed: 2, binary: false }]);
  const d = (await rd.fileDiff(dir, "src/kelly.py")).diff;
  assert.match(d, /-    return mu \/ var\n/);
  assert.match(d, /\+    return min\(cap, mu \/ var\)\n/);
  const hist = await rd.history(dir);
  assert.deepEqual(hist.map((c) => c.message), ["Kelly fraction and first report", "Workspace created"]);
  assert.match(hist[0].stat, /3 files changed/);
  const shown = await rd.show(dir, hist[0].sha);
  assert.deepEqual(shown.files.map((f) => [f.path, f.status]), [["fig.pdf", "A"], ["report.md", "A"], ["src/kelly.py", "A"]]);
  assert.match((await rd.fileDiff(dir, "report.md", hist[0].sha)).diff, /\+# Result/);
  await assert.rejects(rd.show(dir, "not-a-sha"), /Invalid checkpoint/);
  assert.throws(() => rd.dir("s", "../x"), /Invalid idea id/);
});

test("concurrent requests on a new workspace (panes, the Pi pane, agents) are serialised, not racing git", async (t) => {
  const root = tmp(t);
  const rd = new RdWorkspaces(() => root);
  const dirs = await Promise.all(Array.from({ length: 6 }, () => rd.ensure("s", IDEA, "Robust Kelly")));
  assert.equal(new Set(dirs).size, 1);
  const dir = dirs[0];
  fs.writeFileSync(path.join(dir, "a.py"), "x = 1\n");
  const [changes, cp, hist] = await Promise.all([rd.changes(dir), rd.checkpoint(dir, "a"), rd.history(dir)]);
  assert.deepEqual(changes.files.map((f) => f.path), ["a.py"], "ran before the checkpoint, in order");
  assert.equal(cp.message, "a");
  assert.deepEqual(hist.map((c) => c.message), ["a", "Workspace created"]);
  assert.deepEqual((await rd.history(dir)).map((c) => c.message), ["a", "Workspace created"], "exactly one repository, one creation commit");
});

test("a huge generated file never hides the other changes: counts for all, its own diff capped", async (t) => {
  const root = tmp(t);
  const rd = new RdWorkspaces(() => root);
  const dir = await rd.ensure("s", IDEA, "Walk-forward");
  fs.mkdirSync(path.join(dir, "analysis"));
  // ~3 MB of generated CSV (more than the old whole-diff cap) and small files beside it.
  fs.writeFileSync(path.join(dir, "analysis", "oos_paths.csv"), Array.from({ length: 120_000 }, (_, i) => `${i},${(i * 0.001).toFixed(6)},${Math.sin(i).toFixed(9)}`).join("\n"));
  fs.writeFileSync(path.join(dir, "analysis", "report.md"), "# Walk-forward\n");
  fs.writeFileSync(path.join(dir, "backtest.py"), "print('wf')\n");
  const ch = await rd.changes(dir);
  assert.deepEqual(ch.files.map((f) => [f.path, f.added]), [["analysis/oos_paths.csv", 120000], ["analysis/report.md", 1], ["backtest.py", 1]]);
  const big = await rd.fileDiff(dir, "analysis/oos_paths.csv");
  assert.equal(big.truncated, true);
  assert.ok(big.diff.length <= 512 * 1024 && big.diff.length > 400 * 1024, "capped at 512 KiB");
  assert.ok(big.diff.endsWith("\n"), "cut at a whole line");
  assert.equal((await rd.fileDiff(dir, "backtest.py")).truncated, false);
});
