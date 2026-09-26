import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { finished, runSchema, type Run } from "../../src/run-contract.ts";
import { readManifest, MANIFEST_FILE } from "../../src/research-manifest.ts";
import { materialise } from "./rd.ts";

/** The local executor (docs/WORKFLOW-REDESIGN-PLAN.md §9, phase 2).
 *
 * A run executes one checkpoint of an idea's workspace: the app extracts that
 * commit into <strategy>/Runs/<id>/work/ (data/ linked to the snapshots, as in
 * the workspace), runs the command there with the user's login shell, and
 * records what actually ran and what came out: commit, command, environment
 * files, hardware, data snapshots, exit, wall time, peak memory, the log,
 * outputs/metrics.json and the files in outputs/.
 *
 * Runs are detached processes, so they keep going when the app quits; on the
 * next start their exit file or process says how they ended. At most
 * MAX_RUNNING run at once; the rest wait, in order. */

export const RUNS_FOLDER = "Runs";
const MAX_RUNNING = 2;
const LOG_CHUNK = 64 * 1024;
const MAX_OUTPUTS = 2000;
const ENV_FILES = ["uv.lock", "pyproject.toml", "requirements.txt", "environment.yml", "poetry.lock", ".python-version"];
const TEXT = /\.(py|ipynb|r|jl|ts|js|mjs|sql|md|txt|toml|ya?ml|json|sh|cfg|ini)$/i;
const SKIP = new Set([".git", "data", "outputs", "node_modules", ".venv", "venv", "__pycache__", ".ipynb_checkpoints"]);

/** Runs a detached command and leaves its exit code in a file, with peak memory from /usr/bin/time. */
const WRAPPER = `cd "$PI_RESEARCH_WORK" || exit 97
if [ -x /usr/bin/time ]; then
  /usr/bin/time "$PI_RESEARCH_TIME_FLAG" -o "$PI_RESEARCH_RUN_DIR/time.txt" "$PI_RESEARCH_SHELL" -lc 'cd "$PI_RESEARCH_WORK" && eval "$PI_RESEARCH_COMMAND"' > "$PI_RESEARCH_RUN_DIR/log.txt" 2>&1
else
  "$PI_RESEARCH_SHELL" -lc 'cd "$PI_RESEARCH_WORK" && eval "$PI_RESEARCH_COMMAND"' > "$PI_RESEARCH_RUN_DIR/log.txt" 2>&1
fi
echo $? > "$PI_RESEARCH_RUN_DIR/exit.tmp" && mv "$PI_RESEARCH_RUN_DIR/exit.tmp" "$PI_RESEARCH_RUN_DIR/exit"`;

export interface RunStart {
  idea: string;
  title: string;
  workspace: string;
  commit: string;
  checkpointMessage: string;
  autoCheckpoint: boolean;
  entry: string | null;
  command: string;
  inputs: string[];
  candidate: number | null;
  origin: "user" | "agent";
  wallSeconds: number;
  note?: string;
}
type Snapshot = { name: string; file: string; sha256: string };

export class RunService {
  private timer?: ReturnType<typeof setInterval>;
  private preparing = new Set<string>();
  constructor(
    private folderOf: (sid: string) => string,
    private strategies: () => string[],
    private snapshots: (sid: string) => Snapshot[],
    private opts: { shell?: string; tickMs?: number; onChange?: (sid: string, run: Run) => void } = {},
  ) {
    // Runs left by an earlier backend: queued ones start, others are reconciled.
    for (const sid of this.strategies())
      for (const r of this.list(sid))
        if (r.status === "preparing") this.save(sid, { ...r, status: "queued" });
    this.tick();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dir(sid: string) {
    return path.join(this.folderOf(sid), RUNS_FOLDER);
  }
  private runDir(sid: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid run id");
    return path.join(this.dir(sid), id);
  }
  read(sid: string, id: string): Run {
    const f = path.join(this.runDir(sid, id), "run.json");
    if (!fs.existsSync(f)) throw new Error(`Run ${id} not found. Use runs_list for ids.`);
    return runSchema.parse(JSON.parse(fs.readFileSync(f, "utf8")));
  }
  list(sid: string, idea?: string): Run[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.dir(sid)).filter((d) => /^[0-9a-f-]{36}$/.test(d));
    } catch {
      return [];
    }
    return ids
      .flatMap((id) => {
        try {
          return [this.read(sid, id)];
        } catch {
          return [];
        }
      })
      .filter((r) => !idea || r.idea === idea)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private save(sid: string, run: Run) {
    const d = this.runDir(sid, run.id);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const tmp = path.join(d, `run.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(runSchema.parse(run), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(d, "run.json"));
    this.opts.onChange?.(sid, run);
    return run;
  }

  /** Record a run and queue it; it starts as soon as a slot is free. */
  start(sid: string, s: RunStart): Run {
    const run: Run = {
      version: 1,
      id: randomUUID(),
      idea: s.idea,
      title: s.title,
      entry: s.entry,
      command: s.command,
      commit: s.commit,
      checkpointMessage: s.checkpointMessage,
      autoCheckpoint: s.autoCheckpoint,
      candidate: s.candidate,
      ...(s.note ? { note: s.note } : {}),
      origin: s.origin,
      wallSeconds: s.wallSeconds,
      status: "queued",
      createdAt: new Date().toISOString(),
      environment: { lock: null, files: [], shell: this.shell() },
      hardware: hardware(),
      snapshots: [],
    };
    // Where to find the workspace later (the run keeps its own copy of the code).
    fs.mkdirSync(this.runDir(sid, run.id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.runDir(sid, run.id), "source.json"), JSON.stringify({ workspace: s.workspace, inputs: s.inputs }), { mode: 0o600 });
    this.save(sid, run);
    this.tick();
    return this.read(sid, run.id);
  }
  cancel(sid: string, id: string) {
    const r = this.read(sid, id);
    if (finished(r.status)) throw new Error(`Run ${id} has already ended (${r.status}).`);
    if (r.status === "queued" || r.status === "preparing") return this.save(sid, { ...r, status: "cancelled", reason: "Cancelled before it started", endedAt: new Date().toISOString() });
    this.stop(sid, r, "Cancelled");
    return this.read(sid, id);
  }
  /** A chunk of the run's log (stdout and stderr together), from `offset`. */
  log(sid: string, id: string, offset?: number) {
    this.read(sid, id);
    const f = path.join(this.runDir(sid, id), "log.txt");
    const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    const from = Math.max(0, Math.min(offset ?? Math.max(0, size - LOG_CHUNK), size));
    const len = Math.min(LOG_CHUNK, size - from);
    const buf = Buffer.alloc(len);
    if (len) {
      const fd = fs.openSync(f, "r");
      fs.readSync(fd, buf, 0, len, from);
      fs.closeSync(fd);
    }
    return { text: buf.toString("utf8"), offset: from, next: from + len, size };
  }
  /** The run's outputs folder (for reading one output file). */
  outputsDir(sid: string, id: string) {
    this.read(sid, id);
    return path.join(this.runDir(sid, id), "work", "outputs");
  }

  /** Start queued runs, notice ended ones, enforce time limits. */
  tick() {
    let active = false;
    for (const sid of this.strategies()) {
      const runs = this.list(sid);
      for (const r of runs.filter((x) => x.status === "running")) {
        active = true;
        this.check(sid, r);
      }
      if (runs.some((x) => x.status === "queued" || x.status === "preparing")) active = true;
    }
    const all = this.strategies().flatMap((sid) => this.list(sid).map((r) => ({ sid, r })));
    let running = all.filter(({ r }) => r.status === "running").length + this.preparing.size;
    for (const { sid, r } of all.filter(({ r }) => r.status === "queued").sort((a, b) => a.r.createdAt.localeCompare(b.r.createdAt))) {
      if (running >= MAX_RUNNING) break;
      if (this.preparing.has(r.id)) continue;
      running++;
      void this.prepare(sid, r);
    }
    if (active && !this.timer) this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 2000);
    if (!active && this.timer) this.close();
  }

  /** Extract the commit, note the environment and data, and launch. */
  private async prepare(sid: string, queued: Run) {
    this.preparing.add(queued.id);
    const d = this.runDir(sid, queued.id);
    let r: Run = this.save(sid, { ...queued, status: "preparing" });
    try {
      const { workspace, inputs } = JSON.parse(fs.readFileSync(path.join(d, "source.json"), "utf8")) as { workspace: string; inputs: string[] };
      const snapshotsDir = path.join(this.folderOf(sid), "Data", "snapshots");
      const work = await materialise(workspace, r.commit, path.join(d, "work"), snapshotsDir);
      fs.mkdirSync(path.join(work, "outputs"), { recursive: true });
      const files = ENV_FILES.filter((f) => fs.existsSync(path.join(work, f)));
      const manifest = readManifest(fs.existsSync(path.join(work, MANIFEST_FILE)) ? fs.readFileSync(path.join(work, MANIFEST_FILE), "utf8") : null).manifest;
      const lockFile = manifest?.env?.lock ?? (files.includes("uv.lock") ? "uv.lock" : null);
      if (lockFile && !fs.existsSync(path.join(work, lockFile))) throw new Error(`${MANIFEST_FILE} names the lock ${lockFile}, but checkpoint ${r.commit.slice(0, 8)} has no such file.`);
      const lock = lockFile ? { file: lockFile, sha256: sha256File(path.join(work, lockFile)) } : null;
      const all = this.snapshots(sid);
      const mentioned = mentions(work, all.map((s) => s.file.replace(/\/$/, "")));
      const used = all.filter((s) => inputs.includes(s.name) || mentioned.has(s.file.replace(/\/$/, ""))).map((s) => ({ name: s.name, sha256: s.sha256 }));
      r = this.read(sid, r.id);
      if (r.status !== "preparing") return; // cancelled meanwhile
      const child = spawn("/bin/sh", ["-c", WRAPPER], {
        cwd: work,
        detached: true,
        stdio: "ignore",
        env: {
          ...cleanEnv(),
          PI_RESEARCH_WORK: work,
          PI_RESEARCH_RUN_DIR: d,
          PI_RESEARCH_SHELL: r.environment.shell,
          PI_RESEARCH_COMMAND: r.command,
          PI_RESEARCH_TIME_FLAG: process.platform === "darwin" ? "-l" : "-v",
          PI_RESEARCH_RUN: r.id,
          PI_RESEARCH_OUTPUTS: path.join(work, "outputs"),
        },
      });
      child.unref();
      if (!child.pid) throw new Error("The run could not be started");
      this.save(sid, { ...r, status: "running", pid: child.pid, startedAt: new Date().toISOString(), environment: { ...r.environment, lock, files }, snapshots: used });
    } catch (e) {
      try {
        this.save(sid, { ...this.read(sid, queued.id), status: "failed", reason: String((e as Error)?.message ?? e).slice(0, 500), endedAt: new Date().toISOString() });
      } catch {
        /* the strategy or run folder is gone */
      }
    } finally {
      this.preparing.delete(queued.id);
      try {
        this.tick();
      } catch {}
    }
  }

  private check(sid: string, r: Run) {
    const d = this.runDir(sid, r.id);
    const exit = path.join(d, "exit");
    if (fs.existsSync(exit)) return this.finish(sid, r, Number(fs.readFileSync(exit, "utf8").trim()));
    if (!r.pid || !alive(r.pid, r.startedAt)) {
      // Stopped by the app (cancel, time limit): the wrapper went with it, so no exit file.
      if (r.reason) return this.finish(sid, r, NaN);
      return this.save(sid, { ...r, status: "lost", reason: "The run stopped without reporting how it ended (the computer restarted, or its process was killed).", endedAt: new Date().toISOString() });
    }
    if (r.startedAt && Date.now() - Date.parse(r.startedAt) > r.wallSeconds * 1000 && !r.reason)
      this.stop(sid, r, `Stopped at its time limit (${r.wallSeconds < 60 ? `${r.wallSeconds} s` : `${Math.round(r.wallSeconds / 60)} min`})`);
  }
  private stop(sid: string, r: Run, reason: string) {
    this.save(sid, { ...r, reason });
    if (!r.pid || !alive(r.pid, r.startedAt)) return;
    try {
      process.kill(-r.pid, "SIGTERM");
    } catch {}
    const pid = r.pid;
    setTimeout(() => {
      try {
        if (alive(pid, r.startedAt)) process.kill(-pid, "SIGKILL");
      } catch {}
    }, 10_000).unref();
  }
  private finish(sid: string, r: Run, code: number) {
    const d = this.runDir(sid, r.id);
    const outputs = path.join(d, "work", "outputs");
    const endedAt = new Date().toISOString();
    const usage = { wallSeconds: r.startedAt ? Math.round((Date.parse(endedAt) - Date.parse(r.startedAt)) / 100) / 10 : 0, ...peakMemory(path.join(d, "time.txt")) };
    const listed = listOutputs(outputs);
    const stopped = r.reason; // set when the app stopped it
    const status: Run["status"] = stopped === "Cancelled" ? "cancelled" : stopped ? "failed" : code === 0 ? "succeeded" : "failed";
    return this.save(sid, {
      ...r,
      status,
      ...(Number.isFinite(code) ? { exitCode: code } : {}),
      reason: stopped ?? (code === 0 ? undefined : `Exited with code ${code}; see the log`),
      endedAt,
      usage,
      ...metricsOf(outputs),
      outputs: listed.files,
      ...(listed.truncated ? { outputsTruncated: true } : {}),
    });
  }
  private shell() {
    if (this.opts.shell) return this.opts.shell;
    const s = process.env.SHELL;
    return s && fs.existsSync(s) ? s : "/bin/zsh";
  }
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PI_RESEARCH_MCP_TOKEN", "PI_RESEARCH_MCP_URL"]) delete env[k];
  return env;
}
function hardware() {
  const cpus = os.cpus();
  return { platform: process.platform, arch: process.arch, cpu: cpus[0]?.model ?? "unknown", cores: cpus.length, memoryBytes: os.totalmem() };
}
/** Is this still the process the run started (not a reused pid)? */
function alive(pid: number, startedAt?: string) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!startedAt) return true;
  try {
    const etime = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
    if (!m) return true;
    const secs = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    return Math.abs(Date.now() - secs * 1000 - Date.parse(startedAt)) < 60_000;
  } catch {
    return false;
  }
}
/** Peak memory from /usr/bin/time (bytes on macOS, kbytes with GNU time). */
function peakMemory(file: string) {
  try {
    const t = fs.readFileSync(file, "utf8");
    const mac = /(\d+)\s+maximum resident set size/.exec(t);
    if (mac) return { peakMemoryBytes: Number(mac[1]) };
    const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(t);
    if (gnu) return { peakMemoryBytes: Number(gnu[1]) * 1024 };
  } catch {}
  return {};
}
/** outputs/metrics.json: flat numbers or short strings (nested objects become a.b). */
function metricsOf(outputs: string): { metrics?: Record<string, number | string> } {
  const f = path.join(outputs, "metrics.json");
  try {
    if (!fs.existsSync(f) || fs.statSync(f).size > 1024 * 1024) return {};
    const out: Record<string, number | string> = {};
    const walk = (v: unknown, prefix: string) => {
      if (Object.keys(out).length >= 200) return;
      if (typeof v === "number" && Number.isFinite(v)) out[prefix] = v;
      else if (typeof v === "string") out[prefix] = v.slice(0, 200);
      else if (typeof v === "boolean") out[prefix] = String(v);
      else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}`.slice(0, 80) : k.slice(0, 80));
    };
    walk(JSON.parse(fs.readFileSync(f, "utf8")), "");
    return Object.keys(out).length ? { metrics: out } : {};
  } catch {
    return {};
  }
}
function listOutputs(dir: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  let truncated = false;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        if (files.length >= MAX_OUTPUTS) return void (truncated = true);
        const full = path.join(dir, p);
        files.push({ path: p, bytes: fs.statSync(full).size, sha256: sha256File(full) });
      }
    }
  };
  try {
    walk("");
  } catch {}
  return { files, truncated };
}
function sha256File(file: string) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
/** Which of these strings appear in the code (text files up to 1 MiB, outside data/ and caches). */
function mentions(root: string, needles: string[]) {
  const found = new Set<string>();
  if (!needles.length) return found;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name)) {
        const full = path.join(root, p);
        if (fs.statSync(full).size > 1024 * 1024) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const n of needles) if (text.includes(n)) found.add(n);
      }
    }
  };
  try {
    walk("");
  } catch {}
  return found;
}
