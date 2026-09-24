/** Explicit compatibility proof only. Never included in npm test or app startup. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/store.ts";
import { PiPool } from "../server/pi.ts";
import { discoverPi } from "../server/pi-runtime.ts";
const allowMemoryWrites = process.argv.includes(
  "--allow-memory-runtime-writes",
);
const backupArgument = process.argv.find((arg) =>
  arg.startsWith("--memory-backup="),
);
const reportFile = allowMemoryWrites
  ? ".local-evidence/installed-pi-runtime-smoke.json"
  : ".local-evidence/installed-pi-smoke.json";
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-installed-proof-")),
);
const identity = discoverPi("/opt/homebrew/bin/pi", "/opt/homebrew/bin/node");
const baselineFiles = [
  "settings.json",
  "auth.json",
  "models.json",
  "models-store.json",
  "sandbox.json",
  "path-approvals.json",
  "hermes-memory-config.json",
].map((name) => path.join(identity.agentDir, name));
const baselines = () =>
  Object.fromEntries(
    baselineFiles.map((file) => [
      path.basename(file),
      fs.existsSync(file)
        ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
        : null,
    ]),
  );
const memoryRoots = ["pi-hermes-memory", "projects-memory"].map((name) =>
  fs.realpathSync(path.join(identity.agentDir, name)),
);
if (allowMemoryWrites) {
  if (!backupArgument)
    throw new Error(
      "Runtime-write proof requires --memory-backup=<directory> and explicit user authorization",
    );
  const backup = fs.realpathSync(
    backupArgument.slice("--memory-backup=".length),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(backup, "manifest.json"), "utf8"),
  );
  if (
    !manifest.sqliteConsistent ||
    memoryRoots.some((root) => !manifest.sources.includes(root))
  )
    throw new Error("Backup does not cover configured memory storage");
  for (const file of manifest.files) {
    if (file.symlink)
      throw new Error("Runtime-write proof refuses storage with symlinks");
    const target = path.resolve(backup, file.path);
    if (
      !target.startsWith(backup + path.sep) ||
      createHash("sha256").update(fs.readFileSync(target)).digest("hex") !==
        file.sha256
    )
      throw new Error("Memory backup integrity mismatch");
  }
}
const before = baselines(),
  shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const node = path.join(root, "proof-node"),
  cache = path.join(root, "cache");
fs.mkdirSync(cache);
const profile = path.join(root, "proof.sb");
fs.writeFileSync(
  profile,
  `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null")${allowMemoryWrites ? memoryRoots.map((dir) => ` (subpath ${JSON.stringify(dir)})`).join("") : ""})\n`,
);
fs.writeFileSync(
  node,
  `#!/bin/sh\nexport TMPDIR=${shellQuote(cache)}\nexport JITI_CACHE_DIR=${shellQuote(cache)}\nexec /usr/bin/sandbox-exec -f ${shellQuote(profile)} ${shellQuote(identity.node)} "$@"\n`,
  { mode: 0o700 },
);
process.env.LAB_PI_NODE = node;
process.env.LAB_PI_NO_INFERENCE = "1";
const store = new Store(path.join(root, "data")),
  pool = new PiPool(store, identity.executable),
  strategy = store.create("Disposable installed compatibility proof");
let result: any;
try {
  const connected = await pool.handshake(strategy.id, "Ideas");
  const commandCatalog = await pool.commandCatalog(strategy.id, "Ideas");
  const snapshot = await pool.snapshot(strategy.id, "Ideas"),
    history = await pool.nativeHistory(strategy.id, "Ideas");
  await pool.operate(strategy.id, "Ideas", {
    type: "editor_state",
    text: "Unsent compatibility proof draft",
  });
  await pool.stop(strategy.id, "Ideas");
  await pool.handshake(strategy.id, "Ideas");
  const reopened = await pool.snapshot(strategy.id, "Ideas");
  if (reopened.ui?.editor !== "Unsent compatibility proof draft")
    throw new Error("Expanded editor restore mismatch");
  result = {
    passed: true,
    installedVersion: identity.version,
    modelCount: connected.models.length,
    commandCount: commandCatalog.length,
    commands: commandCatalog.map((command: any) => command.name),
    ready: snapshot.runtimeState?.ready,
    historyMode: history.mode,
    editorRestored: true,
    noPromptsSent: true,
    networkDenied: true,
    externalWritesDeniedExcept: allowMemoryWrites ? memoryRoots : [],
    inheritedMacOSProofSandbox: true,
  };
} catch (error) {
  result = {
    passed: false,
    installedVersion: identity.version,
    error: error instanceof Error ? error.message : String(error),
    diagnostics: (
      await pool.snapshot(strategy.id, "Ideas").catch(() => ({ events: [] }))
    ).events
      .filter((e: any) => e.type === "diagnostic")
      .map((e: any) => ({
        code: e.code,
        message: String(e.message).slice(0, 600),
      })),
    noPromptsSent: true,
    networkDenied: true,
    externalWritesDeniedExcept: allowMemoryWrites ? memoryRoots : [],
    inheritedMacOSProofSandbox: true,
  };
} finally {
  await pool.close();
}
result.protectedBaselinesUnchanged =
  JSON.stringify(before) === JSON.stringify(baselines());
result.baselines = before;
result.proofRoot = root;
result.memoryRuntimeWritesAuthorized = allowMemoryWrites;
fs.writeFileSync(reportFile, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
if (!result.passed || !result.protectedBaselinesUnchanged) process.exitCode = 1;
