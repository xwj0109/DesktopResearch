import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire as nodeRequire } from "node:module";
import { cleanEnvironment } from "./config.ts";

/** The real Pi CLI in the conversation pane.
 *
 * One PTY per window and stage runs the installed `pi` in the strategy's
 * folder, through the user's login shell, so it behaves exactly like `pi` in
 * a terminal: their settings, extensions, keybindings, themes and selectors.
 * Sessions live in Pi's normal storage with a stable id per stage, so `pi -c`
 * or `pi -r` in that folder reaches the same conversations. The workbench
 * tools are added with `-e`, as a thin MCP client of the backend registry.
 *
 * Output is pushed to the window over IPC and keystrokes come straight back:
 * this is interactive terminal traffic, never journaled as research requests. */

type Pty = {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
};
type PtyModule = { spawn(file: string, args: string[], options: Record<string, unknown>): Pty };
interface Session {
  pty?: Pty;
  replay: string;
  exited: number | null;
  cols: number;
  rows: number;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
}
export interface TerminalTarget {
  key: string;
  label: string;
  cwd: string;
  sessionId: string;
  send: (channel: "output" | "exit", payload: unknown) => void;
  /** Research tools connection for this strategy (absent for portfolios). */
  tools?: () => Promise<{ url: string; token: string } | undefined>;
}

const REPLAY_BYTES = 256 * 1024;
/** Stable UUID per strategy and stage, so the pane always reopens the same Pi session. */
export function stageSessionId(scopeId: string, stage: string) {
  const h = createHash("sha256").update(`pi-research:${scopeId}:${stage}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class Terminals {
  private sessions = new Map<string, Session>();
  private pty?: PtyModule;
  constructor(
    private config: { node?: string; pi?: string; extension?: string },
    private loadPty: () => PtyModule = () => nodeRequire(import.meta.url)("node-pty"),
  ) {}

  private module() {
    return (this.pty ??= this.loadPty());
  }
  /** Start (or reattach to) the CLI; returns recent output to redraw. */
  async open(target: TerminalTarget, cols: number, rows: number) {
    let s = this.sessions.get(target.key);
    if (s?.pty && s.exited === null) {
      // A remounted view starts blank: nudge the width so Pi repaints its whole
      // screen (a clean redraw, unlike replaying raw bytes into a new terminal).
      const pty = s.pty;
      s.cols = cols;
      s.rows = rows;
      pty.resize(Math.max(20, cols - 1), rows);
      setTimeout(() => {
        try {
          pty.resize(cols, rows);
        } catch {}
      }, 60);
      return { replay: "", exited: null, cwd: target.cwd, sessionId: target.sessionId, reused: true };
    }
    if (!this.config.pi) throw new Error("Pi is not installed on this computer (no `pi` executable found).");
    if (!this.config.node) throw new Error("System Node is unavailable, so the Pi CLI cannot start.");
    fs.mkdirSync(target.cwd, { recursive: true });
    const tools = await target.tools?.().catch(() => undefined);
    const args = [
      this.config.pi,
      "--session-id",
      target.sessionId,
      "--name",
      target.label,
      ...(this.config.extension && tools ? ["-e", this.config.extension] : []),
    ];
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const env = {
      ...cleanEnvironment(process.env),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "PiResearch",
      NODE_NO_WARNINGS: "1",
      PI_SKIP_VERSION_CHECK: "1",
      ...(tools ? { PI_RESEARCH_MCP_URL: tools.url, PI_RESEARCH_MCP_TOKEN: tools.token } : {}),
    } as Record<string, string>;
    // Login shell: the same PATH and environment as `pi` in the user's terminal.
    const pty = this.module().spawn(shell, ["-l", "-c", 'exec "$0" "$@"', this.config.node!, ...args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: target.cwd,
      env,
    });
    s = { pty, replay: "", exited: null, cols, rows, pending: "" };
    this.sessions.set(target.key, s);
    const session = s;
    pty.onData((data) => {
      session.replay = (session.replay + data).slice(-REPLAY_BYTES);
      // Coalesce bursts into one IPC message per frame.
      session.pending += data;
      session.timer ??= setTimeout(() => {
        session.timer = undefined;
        const chunk = session.pending;
        session.pending = "";
        if (chunk && this.sessions.get(target.key) === session) target.send("output", chunk);
      }, 8);
    });
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(target.key) !== session) return;
      session.exited = exitCode;
      session.pty = undefined;
      if (session.pending) target.send("output", session.pending);
      session.pending = "";
      target.send("exit", exitCode);
    });
    return { replay: "", exited: null, cwd: target.cwd, sessionId: target.sessionId, reused: false };
  }
  running(key: string) {
    const s = this.sessions.get(key);
    return !!s?.pty && s.exited === null;
  }
  /** Stop the pane's CLI and return a script that resumes it in Terminal (never two writers on one session). */
  handoff(target: TerminalTarget) {
    if (!this.config.pi || !this.config.node) throw new Error("Pi is not installed on this computer.");
    this.close(target.key);
    return handoffScript({ node: this.config.node, pi: this.config.pi }, target);
  }
  input(key: string, data: string) {
    this.sessions.get(key)?.pty?.write(data);
  }
  resize(key: string, cols: number, rows: number) {
    const s = this.sessions.get(key);
    if (!s?.pty || (s.cols === cols && s.rows === rows)) return;
    s.cols = cols;
    s.rows = rows;
    s.pty.resize(cols, rows);
  }
  /** Stop one stage's CLI (Pi saves its session as it goes). */
  close(key: string) {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    if (s?.timer) clearTimeout(s.timer);
    const pty = s?.pty;
    if (!pty) return;
    try {
      pty.kill("SIGHUP");
    } catch {}
    // A CLI that ignores hang-up is stopped for good shortly after.
    const timer = setTimeout(() => {
      try {
        process.kill(pty.pid, 0);
        pty.kill("SIGKILL");
      } catch {}
    }, 2000);
    timer.unref?.();
  }
  closeWhere(prefix: string) {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(prefix)) this.close(key);
  }
  closeAll() {
    for (const key of [...this.sessions.keys()]) this.close(key);
  }
}

/** Pi's agent directory, as Pi resolves it. */
export const piAgentDir = () =>
  process.env.PI_CODING_AGENT_DIR ? path.resolve(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");
const sessionPaths = new Map<string, string>();
/** The session file Pi writes for (cwd, session id): its documented location
 * first, then a scan by id in case a Pi version names the folder differently. */
export function sessionFile(cwd: string, sessionId: string, agentDir = piAgentDir()): string | undefined {
  const cached = sessionPaths.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const root = path.join(agentDir, "sessions");
  const find = (dir: string) => {
    try {
      const hit = fs.readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
      return hit ? path.join(dir, hit) : undefined;
    } catch {
      return undefined;
    }
  };
  let file = find(path.join(root, `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\]/g, "-")}--`));
  if (!file)
    try {
      for (const dir of fs.readdirSync(root)) if ((file = find(path.join(root, dir)))) break;
    } catch {}
  if (file) sessionPaths.set(sessionId, file);
  return file;
}
const READ_LIMIT = 4 * 1024 * 1024;
/** Session JSONL from byte `since` (incremental; restarts if the file was rewritten). */
export function readSession(file: string | undefined, since: number) {
  if (!file) return { text: "", offset: 0, reset: since > 0, file: undefined };
  const size = fs.statSync(file).size;
  const reset = since > size;
  let start = reset ? 0 : since;
  if (size - start > READ_LIMIT) start = size - READ_LIMIT; // very long session: newest part
  if (start >= size) return { text: "", offset: size, reset, file };
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Only complete lines; a partial last line is read next time.
    const end = text.lastIndexOf("\n") + 1;
    return { text: text.slice(0, end), offset: start + Buffer.byteLength(text.slice(0, end)), reset: reset || start !== since, file };
  } finally {
    fs.closeSync(fd);
  }
}
/** A `.command` file that continues this stage's session in Terminal.app. */
export function handoffScript(config: { node: string; pi: string }, target: { cwd: string; sessionId: string; label: string }) {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const file = path.join(os.tmpdir(), `pi-research-${target.sessionId}.command`);
  fs.writeFileSync(
    file,
    [
      "#!/bin/zsh -l",
      `cd ${q(target.cwd)} || exit 1`,
      `export NODE_NO_WARNINGS=1 PI_SKIP_VERSION_CHECK=1`,
      `exec ${q(config.node)} ${q(config.pi)} --session-id ${q(target.sessionId)} --name ${q(target.label)}`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return file;
}

/** Where a scope's CLI runs: its folder in the research data root. */
export function scopeFolder(root: string, scope: { kind: "strategy" | "portfolio"; id: string }) {
  return path.join(root, "workspaces", scope.kind === "strategy" ? "strategies" : "portfolios", scope.id);
}
export const homeRelative = (p: string) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);
