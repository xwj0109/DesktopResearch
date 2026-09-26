import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

/** Research Development workspaces: one folder per idea, each a local git
 * repository the app manages (docs/RESEARCH-FLOW.md).
 *
 * The idea's Pi conversation runs in its folder and writes code and documents
 * there with its own tools; the app only reads files, shows changes (the
 * working tree against the last checkpoint) and records checkpoints (commits).
 * Nothing here executes research code. Git runs with fixed arguments, no
 * shell, no pager, no prompts, and repository-local identity. Paths are
 * confined to the workspace; symlinks are never followed out of it. */

export const RD_FOLDER = "Research-Workspaces";
const MAX_FILES = 2000;
const MAX_TEXT = 1024 * 1024; // text shown in the viewer
const MAX_BINARY = 12 * 1024 * 1024; // PDFs and images sent to the viewer
const MAX_DIFF = 2 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ipynb_checkpoints", ".DS_Store"]);
const GITIGNORE = ["/data", ".venv/", "venv/", "__pycache__/", "*.pyc", ".ipynb_checkpoints/", "node_modules/", ".DS_Store", ""].join("\n");
const TEXT_EXT = /\.(py|ipynb|r|jl|ts|js|mjs|json|toml|ya?ml|cfg|ini|txt|md|markdown|tex|bib|csv|tsv|sql|sh|html?|css|svg|log|rst)$/i;
const DOC_EXT = /\.(md|markdown|pdf|png|jpe?g|gif|svg|csv|tsv|html?|tex|ipynb)$/i;
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const FILE_DIFF_CAP = 512 * 1024; // one file's diff shown at a time
const GIT_FLAGS = ["-c", "core.pager=cat", "-c", "color.ui=false", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false"];
const gitEnv = (dir: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8" });
const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
/** `git … --numstat` → path → added/removed lines ("-" for binary files). */
function parseNumstat(text: string) {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const l of text.split("\n")) {
    const [a, r, ...p] = l.split("\t");
    if (!p.length) continue;
    out.set(unquote(p.join("\t")), { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), binary: a === "-" });
  }
  return out;
}
const totals = (files: { added: number; removed: number }[]) => ({ added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) });
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
export interface RdFile {
  path: string;
  bytes: number;
  modified: string;
  kind: "text" | "pdf" | "image" | "binary";
  document: boolean;
}

const kindOf = (p: string): RdFile["kind"] => {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return TEXT_EXT.test(p) || !ext ? "text" : "binary";
};

export class RdWorkspaces {
  constructor(private folderOf: (sid: string) => string) {}
  /** Git work on one workspace runs one operation at a time: panes, the Pi pane
   * and agents ask at once (creating the repository, refreshing changes while a
   * checkpoint commits), and git's index lock refuses concurrent writers. */
  private queues = new Map<string, Promise<unknown>>();
  private serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(dir) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this.queues.set(dir, settled);
    void settled.then(() => this.queues.get(dir) === settled && this.queues.delete(dir));
    return run;
  }

  dir(sid: string, ideaId: string) {
    if (!/^[0-9a-f-]{36}$/.test(ideaId)) throw new Error("Invalid idea id");
    return path.join(this.folderOf(sid), RD_FOLDER, ideaId);
  }
  private git(dir: string, args: string[], maxBuffer = MAX_DIFF) {
    return new Promise<string>((resolve, reject) =>
      execFile(
        "git",
        [...GIT_FLAGS, ...args],
        { cwd: dir, timeout: 15000, maxBuffer, env: gitEnv(dir) },
        (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim().slice(0, 400))) : resolve(stdout)),
      ),
    );
  }
  /** Create the idea's folder and repository once (idempotent). */
  ensure(sid: string, ideaId: string, title: string) {
    const dir = this.dir(sid, ideaId);
    return this.serial(dir, () => this.create(dir, title));
  }
  private async create(dir: string, title: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Workspace folder is a symlink");
    if (!fs.existsSync(path.join(dir, ".git"))) {
      if (!fs.existsSync(path.join(dir, "README.md")))
        fs.writeFileSync(path.join(dir, "README.md"), `# ${title || "Untitled idea"}\n\nResearch Development workspace for this idea. Code, scripts and documents produced here are checkpointed with git by Pi Research.\n`);
      if (!fs.existsSync(path.join(dir, ".gitignore"))) fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE);
      await this.git(dir, ["init", "-q"]);
      await this.git(dir, ["config", "user.name", "Pi Research"]);
      await this.git(dir, ["config", "user.email", "research@localhost"]);
      await this.git(dir, ["add", "-A"]);
      await this.git(dir, ["commit", "-q", "--allow-empty", "-m", "Workspace created"]);
    }
    this.linkData(dir);
    return dir;
  }
  /** data/ → the strategy's shared, frozen snapshots (read-only for the work; never committed). */
  private linkData(dir: string) {
    const link = path.join(dir, "data");
    fs.mkdirSync(path.join(dir, "..", "..", "Data", "snapshots"), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(link) && !isLink(link)) fs.symlinkSync(path.join("..", "..", "Data", "snapshots"), link);
    const ignore = path.join(dir, ".gitignore");
    const text = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
    if (!/^\/data$/m.test(text)) fs.writeFileSync(ignore, `/data\n${text}`);
  }
  /** A workspace file's real path (confined to the workspace). */
  resolve(dir: string, rel: string) {
    return this.within(dir, rel);
  }
  private within(dir: string, rel: string) {
    const clean = rel.replace(/^\/+/, "");
    if (!clean || clean.split(/[\\/]/).some((p) => p === ".." || p === ".git")) throw new Error("Invalid path");
    const full = path.resolve(dir, clean);
    if (!full.startsWith(dir + path.sep)) throw new Error("Path outside the workspace");
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(dir) + path.sep)) throw new Error("Path outside the workspace");
    return real;
  }
  /** Every file in the workspace (skipping caches and the repository itself). */
  files(dir: string): RdFile[] {
    const out: RdFile[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (out.length >= MAX_FILES || SKIP.has(e.name)) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const st = fs.statSync(path.join(dir, p));
          out.push({ path: p, bytes: st.size, modified: st.mtime.toISOString(), kind: kindOf(p), document: DOC_EXT.test(p) });
        }
      }
    };
    walk("");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  /** A file for the viewer: text (bounded) or base64 for PDFs and images. */
  read(dir: string, rel: string) {
    const full = this.within(dir, rel);
    const st = fs.statSync(full);
    const kind = kindOf(rel);
    if (kind === "pdf" || kind === "image") {
      if (st.size > MAX_BINARY) return { path: rel, kind, bytes: st.size, tooLarge: true };
      return { path: rel, kind, bytes: st.size, mime: MIME[path.extname(rel).slice(1).toLowerCase()], base64: fs.readFileSync(full).toString("base64") };
    }
    if (kind === "binary") return { path: rel, kind, bytes: st.size };
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { path: rel, kind, bytes: st.size, text: buf.toString("utf8"), truncated: st.size > MAX_TEXT };
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Changes since the last checkpoint: each file's status and line counts
   * (never the whole diff, which large generated outputs would blow up; ask
   * fileDiff for one file). New files are marked through the index only. */
  changes(dir: string) {
    return this.serial(dir, () => this.diffWorkingTree(dir));
  }
  private async diffWorkingTree(dir: string) {
    await this.git(dir, ["add", "-A", "--intent-to-add"]);
    const status = new Map(
      (await this.git(dir, ["status", "--porcelain=v1", "-uall", "--no-renames"]))
        .split("\n")
        .filter(Boolean)
        .map((l) => [unquote(l.slice(3)), l.slice(0, 2).trim() || "M"] as const),
    );
    const stats = parseNumstat(await this.git(dir, ["diff", "HEAD", "--numstat", "--no-renames"]));
    const files = [...status].map(([path, st]) => ({ path, status: st === "??" ? "A" : st[0], ...(stats.get(path) ?? { added: 0, removed: 0, binary: false }) }));
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), ...totals(files) };
  }
  /** One file's diff, for the current changes or for a checkpoint (sha), capped
   * per file so a huge output cannot hide the rest. */
  async fileDiff(dir: string, file: string, sha?: string) {
    if (!file || file.startsWith("-") || file.split("/").some((p) => p === ".." || p === ".git")) throw new Error("Invalid path");
    if (sha && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Invalid checkpoint id");
    const args = sha ? ["show", "--format=", "--no-ext-diff", "--no-renames", sha, "--", file] : ["diff", "HEAD", "--no-ext-diff", "--no-renames", "--", file];
    return this.serial(dir, async () => {
      const { out, truncated } = await this.gitCapped(dir, args, FILE_DIFF_CAP);
      return { path: file, ...(sha ? { sha } : {}), diff: out, truncated, binary: /^Binary files /m.test(out) };
    });
  }
  private gitCapped(dir: string, args: string[], cap: number) {
    return new Promise<{ out: string; truncated: boolean }>((resolve, reject) => {
      const child = spawn("git", [...GIT_FLAGS, ...args], { cwd: dir, env: gitEnv(dir) });
      const chunks: Buffer[] = [];
      let size = 0,
        truncated = false,
        err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.stdout.on("data", (b: Buffer) => {
        if (truncated) return;
        chunks.push(b);
        size += b.length;
        if (size > cap) {
          truncated = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (b: Buffer) => (err += b.toString()).length > 2000 && (err = err.slice(-2000)));
      child.on("error", (e) => (clearTimeout(timer), reject(e)));
      child.on("close", (code) => {
        clearTimeout(timer);
        let out = Buffer.concat(chunks).toString("utf8");
        if (truncated) out = out.slice(0, cap).replace(/\n[^\n]*$/, "\n");
        if (code && !truncated) reject(new Error(err.trim().slice(0, 400) || `git exited ${code}`));
        else resolve({ out, truncated });
      });
    });
  }
  /** Record the current state as a checkpoint (a commit). */
  checkpoint(dir: string, message: string) {
    return this.serial(dir, async () => {
      await this.git(dir, ["add", "-A"]);
      const pending = (await this.git(dir, ["status", "--porcelain=v1"])).trim();
      if (!pending) throw new Error("Nothing changed since the last checkpoint.");
      await this.git(dir, ["commit", "-q", "-m", message]);
      return (await this.log(dir, 1))[0];
    });
  }
  /** Keep a checkpoint reachable whatever later happens in the workspace
   * (reset, amend, rebase): a tag such as candidate/2 pointing at it. */
  tag(dir: string, name: string, sha: string) {
    if (!/^candidate\/\d{1,6}$/.test(name) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid tag");
    return this.serial(dir, async () => {
      const existing = (await this.git(dir, ["tag", "-l", name])).trim();
      if (!existing) return void (await this.git(dir, ["tag", name, sha]));
      const at = (await this.git(dir, ["rev-parse", `${name}^{commit}`])).trim();
      if (at !== sha) throw new Error(`Tag ${name} already names another checkpoint.`);
    });
  }
  /** One file's text as it is in a checkpoint (null when it isn't there). */
  fileAt(dir: string, sha: string, rel: string) {
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !/^[A-Za-z0-9_./-]{1,200}$/.test(rel) || rel.split("/").includes("..")) throw new Error("Invalid path");
    return this.serial(dir, () => this.git(dir, ["show", `${sha}:${rel}`], MAX_TEXT).catch(() => null));
  }
  /** The full id of a checkpoint in this workspace, or null if there is none such. */
  commit(dir: string, rev: string) {
    if (!/^([0-9a-f]{7,40}|HEAD|candidate\/\d{1,6})$/.test(rev)) throw new Error("Invalid checkpoint id");
    return this.serial(dir, () => this.git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).then((s) => s.trim() || null, () => null));
  }
  history(dir: string, limit = 50) {
    return this.serial(dir, () => this.log(dir, limit));
  }
  private async log(dir: string, limit: number) {
    const log = await this.git(dir, ["log", `-n${limit}`, "--pretty=format:%H%x1f%aI%x1f%s", "--shortstat"]);
    const out: { sha: string; at: string; message: string; stat: string }[] = [];
    for (const block of log.split(/\n(?=[0-9a-f]{40}\x1f)/)) {
      const [head, ...rest] = block.split("\n");
      const [sha, at, message] = head.split("\x1f");
      if (sha) out.push({ sha, at, message, stat: rest.join(" ").trim() });
    }
    return out;
  }
  /** One checkpoint's files (status and line counts); fileDiff(…, sha) for a file. */
  async show(dir: string, sha: string) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Invalid checkpoint id");
    return this.serial(dir, async () => {
      const status = new Map(
        (await this.git(dir, ["show", "--name-status", "--format=", "--no-renames", sha]))
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [st, ...rest] = l.split("\t");
            return [unquote(rest.join("\t")), st[0]] as const;
          }),
      );
      const stats = parseNumstat(await this.git(dir, ["show", "--numstat", "--format=", "--no-renames", sha]));
      const files = [...status].map(([path, st]) => ({ path, status: st, ...(stats.get(path) ?? { added: 0, removed: 0, binary: false }) }));
      return { sha, files: files.sort((a, b) => a.path.localeCompare(b.path)), ...totals(files) };
    });
  }
}

/** A clean copy of one checkpoint in `dest` (git archive, nothing of the live
 * working tree), with data/ linked to the strategy's snapshots as in the
 * workspace. Reused when `dest` already holds that checkpoint. Production runs
 * from here, so editing the research workspace cannot change what runs. */
export async function materialise(workspace: string, sha: string, dest: string, snapshots: string) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid checkpoint id");
  const marker = path.join(dest, ".pi-research-checkpoint");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === sha) return dest;
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const git = spawn("git", [...GIT_FLAGS, "archive", "--format=tar", sha], { cwd: workspace, env: gitEnv(workspace) });
  const tar = spawn("tar", ["-x", "-f", "-", "-C", tmp], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  let err = "";
  git.stderr.on("data", (d) => (err += d));
  git.stdout.pipe(tar.stdin);
  const exit = (p: typeof git) => new Promise<number>((resolve) => (p.on("error", () => resolve(-1)), p.on("close", (c) => resolve(c ?? -1))));
  const [g, t] = await Promise.all([exit(git), exit(tar)]);
  if (g !== 0 || t !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(g !== 0 ? `Checkpoint ${sha.slice(0, 7)} could not be read: ${err.trim().slice(0, 200)}` : "Checkpoint files could not be extracted");
  }
  fs.symlinkSync(snapshots, path.join(tmp, "data"));
  fs.writeFileSync(path.join(tmp, ".pi-research-checkpoint"), sha + "\n");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return dest;
}
