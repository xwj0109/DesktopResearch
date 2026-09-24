#!/usr/bin/env -S node --import tsx
/** Local trusted launcher. Never attaches to, discovers, or kills another CLI process. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PiBindings } from "../server/pi-bindings.ts";
import { discoverPi } from "../server/pi-runtime.ts";

export async function handoff(bindingFile: string, executable: string) {
  const identity = discoverPi(executable);
  const saved = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
  const bindings = new PiBindings(path.dirname(path.resolve(bindingFile)));
  if (bindings.file(saved.workspace, saved.tab) !== path.resolve(bindingFile))
    throw new Error("Invalid binding file identity");
  const dataRoot = path.dirname(bindings.root);
  const sessionDir = saved.workspace.startsWith("portfolio:")
    ? path.join(
        dataRoot,
        "portfolio-sessions",
        saved.workspace.slice(10),
        saved.logicalSessionId,
      )
    : path.join(dataRoot, "sessions", saved.workspace, saved.logicalSessionId);
  if (!bindings.validateCanonical(saved.workspace, saved.tab, sessionDir)) throw new Error("Canonical session unavailable");
  const { lease } = bindings.acquire(
    saved.workspace,
    saved.tab,
    saved.logicalSessionId,
    "handoff",
  );
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<number> | undefined, didClose = false;
  const signals: Array<[NodeJS.Signals, () => void]> = [];
  try {
    // This value is authoritative under the acquired lease; never use pre-acquire identity.
    const canonical = bindings.validateCanonical(saved.workspace, saved.tab, sessionDir);
    if (!canonical) throw new Error("Canonical session unavailable under lease");
    const guard = fileURLToPath(new URL("../server/pi-handoff-guard.mjs", import.meta.url));
    const gate = new URL("../server/pi-cli-gate.mjs", import.meta.url).href;
    // Invoke the exact installed CLI, using its exact canonical file, not a copied session.
    child = spawn(
      identity.node,
      ["--import", gate, identity.executable, "--session", canonical.path, "--session-dir", sessionDir, "--extension", guard],
      {
        cwd: canonical.cwd,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        shell: false,
        env: { ...process.env, PI_CODING_AGENT_DIR: identity.agentDir, HERDR_PI_ACTIVATE_NONCE: lease.nonce },
      },
    );
    const ownedChild = child;
    let launchError: Error | undefined;
    closed = new Promise<number>(resolve => {
      ownedChild.on("error", error => { launchError = error; });
      ownedChild.once("close", code => { didClose = true; resolve(code ?? 1); });
    });
    const waiting = new Promise<void>((resolve, reject) => {
      const ready = (message: any) => {
        if (message?.type === "herdr_writer_waiting" && message.nonce === lease.nonce) { ownedChild.off("message", ready); resolve(); }
      };
      ownedChild.on("message", ready);
      ownedChild.once("error", reject);
      ownedChild.once("close", () => reject(new Error("Managed CLI exited before activation")));
    });
    void waiting.catch(() => {}); // also contained if PID publication itself fails
    if (!child.pid) throw new Error("Managed CLI process did not spawn");
    bindings.setPid(saved.workspace, saved.tab, lease, child.pid);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      const forward = () => {
        if (ownedChild.exitCode === null && ownedChild.signalCode === null)
          ownedChild.kill(signal);
      };
      signals.push([signal, forward]);
      process.on(signal, forward);
    }
    await waiting;
    await new Promise<void>((resolve, reject) => ownedChild.send({ type: "herdr_activate_writer", nonce: lease.nonce }, error => error ? reject(error) : resolve()));
    const result = await closed;
    if (launchError) throw launchError;
    return result;
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
    if (child && closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!didClose) {
        child.kill("SIGTERM");
        timer = setTimeout(() => { if (!didClose) child!.kill("SIGKILL"); }, 10000);
        timer.unref();
      }
      await closed;
      if (timer) clearTimeout(timer);
    }
    bindings.release(saved.workspace, saved.tab, lease);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  const [binding, executable] = process.argv.slice(2);
  if (!binding || !executable) {
    console.error(
      "Usage: system-node <this-managed-launcher> <binding-file> <installed-pi-executable> (source .ts requires --import tsx)",
    );
    process.exitCode = 2;
  } else
    handoff(binding, executable).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
    );
}
