import fs from "node:fs";
import path from "node:path";
import { dnsLookupDefault } from "./net-defaults.ts";
import { feedDefSchema, feedsDefDir, type FeedDef } from "./model.ts";
import { workerFor, type Worker, type WorkerContext } from "./workers.ts";

/** The background feed service: keeps every enabled production feed of every
 * strategy in a data root collecting, whether or not the app is open. It
 * rescans the feed definitions every few seconds, so the app controls it by
 * writing definitions (create, pause, resume, delete); a heartbeat file says
 * it is alive. Run by launchd (a user LaunchAgent the app installs when the
 * user switches collection on) or, in development and tests, as a child. */

export const SERVICE_FILE = (root: string) => path.join(root, ".runtime", "feeds", "service.json");

export class FeedDaemon {
  private workers = new Map<string, { worker: Worker; hash: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = new Date().toISOString();
  constructor(
    readonly root: string,
    private ctx: WorkerContext,
    private scanMs = 5000,
  ) {}
  private heartbeat(extra: Record<string, unknown> = {}) {
    const f = SERVICE_FILE(this.root);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f + ".tmp", JSON.stringify({ version: 1, pid: process.pid, startedAt: this.startedAt, heartbeatAt: new Date().toISOString(), feeds: this.workers.size, ...extra }), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  }
  /** Every feed definition in the root: strategy folder → definitions. */
  private definitions() {
    const out: { strategyRoot: string; def: FeedDef; key: string }[] = [];
    const strategies = path.join(this.root, "workspaces", "strategies");
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(strategies).filter((d) => /^[0-9a-f-]{36}$/.test(d));
    } catch {
      return out;
    }
    for (const sid of ids) {
      const strategyRoot = path.join(strategies, sid);
      let files: string[] = [];
      try {
        files = fs.readdirSync(feedsDefDir(strategyRoot)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const def = feedDefSchema.parse(JSON.parse(fs.readFileSync(path.join(feedsDefDir(strategyRoot), f), "utf8")));
          out.push({ strategyRoot, def, key: `${sid}/${def.id}` });
        } catch (e) {
          this.ctx.log(`Skipping invalid feed ${sid}/${f}: ${(e as Error).message}`);
        }
      }
    }
    return out;
  }
  async scan() {
    const wanted = this.definitions();
    const keys = new Set(wanted.map((w) => w.key));
    for (const [key, w] of this.workers)
      if (!keys.has(key)) {
        this.workers.delete(key);
        await w.worker.stop();
      }
    for (const { strategyRoot, def, key } of wanted) {
      const hash = JSON.stringify({ ...def, title: "" });
      const running = this.workers.get(key);
      if (running && running.hash === hash) continue;
      if (running) {
        this.workers.delete(key);
        await running.worker.stop();
      }
      const worker = workerFor(strategyRoot, def, this.ctx);
      if (def.paused) {
        await worker.stop(); // writes the paused status
        continue;
      }
      this.workers.set(key, { worker, hash });
      void worker.start().catch((e) => worker.error(e));
    }
    this.heartbeat();
  }
  async start() {
    await this.scan();
    this.timer = setInterval(() => void this.scan().catch((e) => this.ctx.log(String(e))), this.scanMs);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const [, w] of this.workers) await w.worker.stop();
    this.workers.clear();
    this.heartbeat({ stoppedAt: new Date().toISOString() });
  }
}

/** Entry point (backend/feeds-daemon.mjs): --root <data root>. */
export async function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : undefined;
  if (!root || !path.isAbsolute(root)) throw new Error("Usage: feeds-daemon --root <absolute data root>");
  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
  const daemon = new FeedDaemon(root, { deps: dnsLookupDefault, socket: (url) => new WebSocket(url), log });
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await daemon.start();
  log(`Pi Research feed service running for ${root}`);
}

if (process.argv[1] && /(feeds-daemon\.mjs|feeds[\\/]daemon\.ts)$/.test(process.argv[1])) void main().catch((e) => (console.error(e), process.exit(1)));
