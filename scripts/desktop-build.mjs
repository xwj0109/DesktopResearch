import { build } from "esbuild";
import { inventory } from "./desktop-inventory.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = path.join(root, "desktop-build");
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  logLevel: "info",
};
const banner = {
  js: 'import { createRequire as researchCreateRequire } from "node:module"; const require = researchCreateRequire(import.meta.url);',
};
await build({
  ...common,
  entryPoints: [path.join(root, "desktop/main.ts")],
  outfile: path.join(out, "desktop/main.mjs"),
  format: "esm",
  external: ["electron"],
  banner,
});
await build({
  ...common,
  entryPoints: [path.join(root, "desktop/preload.ts")],
  outfile: path.join(out, "desktop/preload.cjs"),
  format: "cjs",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: [path.join(root, "server/desktop-entry.ts")],
  outfile: path.join(out, "backend/desktop-entry.mjs"),
  format: "esm",
  banner,
});
await build({
  ...common,
  entryPoints: [path.join(root, "scripts/desktop-pi-handoff.ts")],
  outfile: path.join(out, "scripts/desktop-pi-handoff.mjs"),
  format: "esm",
  banner,
});
// Bundle the editor PTY glue and the exact native payload for this desktop target.
await build({ ...common, entryPoints: [path.join(root, "node_modules/node-pty/lib/index.js")], outfile: path.join(out, "backend/pty.cjs"), format: "cjs" });
const ptyTarget = `${process.platform}-${process.arch}`;
const ptyDirectory = path.join(out, "backend/prebuilds", ptyTarget);
await fs.mkdir(ptyDirectory, { recursive: true });
for (const name of ["pty.node", "spawn-helper"]) await fs.copyFile(path.join(root, "node_modules/node-pty/prebuilds", ptyTarget, name), path.join(ptyDirectory, name));
await fs.chmod(path.join(ptyDirectory, "spawn-helper"), 0o755);
await fs.copyFile(path.join(root, "node_modules/node-pty/LICENSE"), path.join(out, "backend/pty-LICENSE"));
// Stdio MCP bridge for external agents (plain Node, no dependencies).
await fs.copyFile(
  path.join(root, "scripts/pi-research-mcp.mjs"),
  path.join(out, "scripts/pi-research-mcp.mjs"),
);
for (const name of [
  "pi-host.mjs",
  "pi-host-ui.mjs",
  "pi-host-resources.mjs",
  "pi-host-session.mjs",
  "pi-host-queue.mjs",
  "pi-host-commands.mjs",
  "pi-host-editor.mjs",
  "pi-host-tools.mjs",
  "pi-research-extension.mjs",
])
  await fs.copyFile(
    path.join(root, "server", name),
    path.join(out, "backend", name),
  );
// Read as immutable provenance bytes by Platform, never executed as TypeScript.
await fs.copyFile(
  path.join(root, "server/reference-engine.ts"),
  path.join(out, "backend/reference-engine.ts"),
);
await fs.mkdir(path.join(out, "server"));
for (const name of ["pi-cli-gate.mjs", "pi-handoff-guard.mjs"])
  await fs.copyFile(
    path.join(root, "server", name),
    path.join(out, "server", name),
  );
await fs.cp(path.join(root, "dist"), path.join(out, "dist"), {
  recursive: true,
});
await fs.writeFile(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "pi-research-desktop",
      productName: "Pi Research",
      version: "0.1.0",
      private: true,
      type: "module",
      main: "desktop/main.mjs",
    },
    null,
    2,
  ),
);
console.log(
  "Staged app-owned code/assets only: desktop-build (no Pi, settings, auth, sessions or dev runtime).",
);

inventory(out); // Fail closed on unexpected payload before packaging.
