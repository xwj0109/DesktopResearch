import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export const fixedPayload = [
  "package.json",
  "backend/pty.cjs",
  "backend/pty-LICENSE",
  `backend/prebuilds/${process.platform}-${process.arch}/pty.node`,
  `backend/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  "desktop/main.mjs",
  "desktop/preload.cjs",
  "backend/desktop-entry.mjs",
  "backend/feeds-daemon.mjs",
  "backend/pi-host.mjs",
  "backend/pi-host-ui.mjs",
  "backend/pi-host-resources.mjs",
  "backend/pi-host-session.mjs",
  "backend/pi-host-queue.mjs",
  "backend/pi-host-commands.mjs",
  "backend/pi-host-editor.mjs",
  "backend/pi-host-tools.mjs",
  "backend/pi-research-extension.mjs",
  "backend/reference-engine.ts",
  "scripts/desktop-pi-handoff.mjs",
  "scripts/pi-research-mcp.mjs",
  "server/pi-cli-gate.mjs",
  "server/pi-handoff-guard.mjs",
  "dist/index.html",
];
export function inventory(root) {
  const entries = [];
  function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file),
        relative = path.relative(root, file).split(path.sep).join("/");
      if (stat.isSymbolicLink())
        throw new Error("Payload symlink denied: " + relative);
      if (stat.isDirectory()) {
        if (
          ![
            "desktop",
            "backend",
            "backend/prebuilds",
            `backend/prebuilds/${process.platform}-${process.arch}`,
            "scripts",
            "server",
            "dist",
            "dist/assets",
          ].includes(relative)
        )
          throw new Error("Unexpected payload directory: " + relative);
        scan(file);
      } else {
        if (
          !stat.isFile() ||
          (!fixedPayload.includes(relative) &&
            !/^dist\/assets\/[A-Za-z0-9_.-]+\.(?:m?js|css|woff2?|ttf|png|svg)$/.test(
              relative,
            ))
        )
          throw new Error("Unexpected payload file: " + relative);
        const bytes = fs.readFileSync(file);
        entries.push({
          path: relative,
          bytes: stat.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  scan(root);
  for (const file of fixedPayload)
    if (!entries.some((e) => e.path === file))
      throw new Error("Missing payload: " + file);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  console.log(
    JSON.stringify(
      {
        version: 1,
        files: inventory(path.resolve(process.argv[2] ?? "desktop-build")),
      },
      null,
      2,
    ),
  );
}
