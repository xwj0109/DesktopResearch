import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SERVICE_FILE } from "./daemon.ts";

/** Switching production collection on and off. On macOS the service is a
 * user LaunchAgent (~/Library/LaunchAgents/com.piresearch.feeds.<root>.plist,
 * started at login and restarted if it crashes) so feeds keep collecting when
 * the app is closed; switching off unloads and removes it. With
 * PI_RESEARCH_FEEDS_MODE=child (development, tests) the same service runs as
 * a child of the backend instead and nothing is installed. */

export interface ServiceStatus {
  mode: "launchd" | "child";
  enabled: boolean;
  running: boolean;
  heartbeatAt: string | null;
  pid: number | null;
  feeds: number;
  label: string;
  log: string;
}
const ALIVE_MS = 20_000;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out))));

/** The service program: the bundled backend/feeds-daemon.mjs next to this
 * backend, or (development) the TypeScript entry through tsx. */
export function defaultDaemonCommand(node = process.execPath): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "feeds-daemon.mjs");
  if (fs.existsSync(bundled)) return [node, bundled];
  return [node, "--import", "tsx", path.join(here, "daemon.ts")];
}

export class FeedService {
  private child?: ChildProcess;
  readonly label: string;
  readonly mode: "launchd" | "child";
  constructor(
    readonly root: string,
    private command: string[] = defaultDaemonCommand(),
    mode = (process.env.PI_RESEARCH_FEEDS_MODE === "child" || process.platform !== "darwin" ? "child" : "launchd") as "launchd" | "child",
    private agentsDir = path.join(os.homedir(), "Library", "LaunchAgents"),
  ) {
    this.mode = mode;
    this.label = `com.piresearch.feeds.${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
  }
  get plist() {
    return path.join(this.agentsDir, `${this.label}.plist`);
  }
  get logFile() {
    return path.join(this.root, ".runtime", "feeds", "daemon.log");
  }
  status(): ServiceStatus {
    let beat: any = null;
    try {
      beat = JSON.parse(fs.readFileSync(SERVICE_FILE(this.root), "utf8"));
    } catch {}
    const fresh = !!beat?.heartbeatAt && !beat.stoppedAt && Date.now() - Date.parse(beat.heartbeatAt) < ALIVE_MS;
    const enabled = this.mode === "launchd" ? fs.existsSync(this.plist) : !!this.child && this.child.exitCode === null;
    return { mode: this.mode, enabled, running: fresh, heartbeatAt: beat?.heartbeatAt ?? null, pid: fresh ? beat.pid : null, feeds: fresh ? beat.feeds : 0, label: this.label, log: this.logFile };
  }
  async enable() {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    const args = [...this.command.slice(1), "--root", this.root];
    if (this.mode === "child") {
      if (this.child && this.child.exitCode === null) return this.status();
      const out = fs.openSync(this.logFile, "a", 0o600);
      this.child = spawn(this.command[0], args, { stdio: ["ignore", out, out], env: process.env });
      this.child.on("exit", () => (this.child = undefined));
      return this.status();
    }
    fs.mkdirSync(this.agentsDir, { recursive: true });
    const program = [this.command[0], ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
    fs.writeFileSync(
      this.plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(this.label)}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(this.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(this.logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")}</string>
    <key>SHELL</key><string>${xml(process.env.SHELL ?? "/bin/zsh")}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
</dict>
</plist>
`,
      { mode: 0o644 },
    );
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await run("launchctl", ["bootout", `${domain}/${this.label}`]).catch(() => {});
    await run("launchctl", ["bootstrap", domain, this.plist]);
    return this.status();
  }
  async disable() {
    if (this.mode === "child") {
      const c = this.child;
      this.child = undefined;
      if (c && c.exitCode === null) {
        c.kill("SIGTERM");
        await new Promise((r) => c.once("exit", r));
      }
      return this.status();
    }
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${this.label}`]).catch(() => {});
    fs.rmSync(this.plist, { force: true });
    return this.status();
  }
  /** Backend shutdown: a child service stops with it; the LaunchAgent keeps running by design. */
  dispose() {
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}
