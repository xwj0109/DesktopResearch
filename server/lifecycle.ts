import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Store } from "./store.ts";
import { Platform } from "./platform.ts";
import { PiPool } from "./pi.ts";
import { Workbench } from "./workbench/tools.ts";
import { createApp } from "./app.ts";

// Store durability ownership is process-wide. Closing HTTP is NOT releasing Store.
const consumedRoots = new Set<string>();
export function prospectiveRealpath(value: string): string {
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw new Error("Absolute safe path required");
  const missing: string[] = [];
  let parent = path.resolve(value);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error("No existing path ancestor");
    missing.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...missing);
}
export function directory(value: string, create = false): string {
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw new Error("An absolute directory is required");
  if (create) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error("Expected a directory");
  return real;
}
export function ownedDirectory(root: string, name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error("Invalid owned directory name");
  const target = path.join(root, name);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw new Error("Owned storage cannot be a symlink");
  const real = directory(target, true);
  if (path.dirname(real) !== root)
    throw new Error("Owned storage escapes its root");
  return real;
}
export async function settleCleanup(
  tasks: Array<Promise<unknown> | undefined>,
) {
  const results = await Promise.allSettled(tasks);
  const errors = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (errors.length)
    throw new AggregateError(
      errors.map((r) => r.reason),
      "Service cleanup completed with errors",
    );
}
export interface ServiceOptions {
  root: string;
  assets: string;
  port?: number;
  executable?: string;
  handoffLauncher?: string;
}
export async function startLabService(options: ServiceOptions) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const assets = directory(options.assets);
  const index = fs.realpathSync(path.join(assets, "index.html"));
  if (!index.startsWith(assets + path.sep) || !fs.statSync(index).isFile())
    throw new Error("Built renderer assets unavailable");
  const candidate = prospectiveRealpath(options.root);
  if (candidate === assets || candidate.startsWith(assets + path.sep))
    throw new Error("Data cannot reside in renderer assets");
  const root = directory(candidate, true);
  const runtime = ownedDirectory(root, ".runtime"),
    workspaces = ownedDirectory(root, "workspaces");
  if (consumedRoots.has(root))
    throw new Error(
      "Store ownership is process-wide; exit the backend before reopening this root",
    );
  consumedRoots.add(root);
  let platform: Platform | undefined, pool: PiPool | undefined, workbench: Workbench | undefined;
  let origin = "";
  // Bind first, but do not serve until the exact kernel-selected origin is known.
  let handler: ReturnType<typeof createApp> | undefined;
  const responses = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    responses.add(res);
    res.once("close", () => responses.delete(res));
    if (closing) res.shouldKeepAlive = false;
    if (handler && !closing) handler(req, res);
    else { res.writeHead(503); res.end(); }
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Let active responses finish, but do not leave their sockets alive for
      // another keep-alive timeout after the response is delivered.
      for (const response of responses) response.shouldKeepAlive = false;
      const stopped = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      // Presentation long polls must finish before waiting for HTTP to drain.
      // Their normal timeout otherwise races the desktop shutdown warning.
      workbench?.view.close();
      try {
        await settleCleanup([platform?.close(), pool?.close(), stopped]);
      } finally {
        await workbench?.close();
      }
    })());
  try {
    const store = new Store(runtime, workspaces);
    platform = new Platform(store);
    pool = new PiPool(
      store,
      options.executable,
      undefined,
      options.handoffLauncher,
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1"
    )
      throw new Error("Unexpected backend address");
    origin = `http://127.0.0.1:${address.port}`;
    workbench = new Workbench(store, platform);
    handler = createApp(store, pool, origin, assets, platform, workbench);
    return { origin, rootToken: store.db.rootToken, close };
  } catch (error) {
    await close();
    throw error;
  }
}
