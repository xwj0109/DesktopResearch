import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { inventory, fixedPayload } = await import(
  pathToFileURL(path.resolve("scripts/desktop-inventory.mjs")).href
);
test("package inventory permits only owned runtime helpers and renderer assets, excluding data/auth/dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-payload-"));
  try {
    for (const file of [
      ...fixedPayload,
      "dist/assets/main-abc.js",
      "dist/assets/main-abc.css",
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "authored-fixture");
    }
    const list = inventory(root);
    assert.equal(list.length, fixedPayload.length + 2);
    assert.ok(list.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    for (const denied of [
      "auth.json",
      "data/workspace.json",
      "node_modules/pi/index.js",
      "backups/archive.zip",
      "dist/assets/source.ts",
      "dist/assets/secret.json",
    ]) {
      const file = path.join(root, denied);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "authored-fixture");
      assert.throws(() => inventory(root));
      fs.unlinkSync(file);
      const top = denied.split("/")[0];
      if (["data", "node_modules", "backups"].includes(top))
        fs.rmSync(path.join(root, top), { recursive: true });
    }
    fs.symlinkSync(
      path.join(root, "package.json"),
      path.join(root, "dist/assets/alias.js"),
    );
    assert.throws(() => inventory(root), /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("packaging sources retain relocated SDK/helper paths and local signature verification without dev tsx", () => {
  const build = fs.readFileSync("scripts/desktop-build.mjs", "utf8"),
    packageScript = fs.readFileSync("scripts/desktop-package.mjs", "utf8");
  for (const helper of [
    "pi-host.mjs",
    "pi-host-ui.mjs",
    "pi-host-resources.mjs",
    "pi-host-session.mjs",
    "reference-engine.ts",
    "pi-cli-gate.mjs",
    "pi-handoff-guard.mjs",
  ])
    assert.ok(build.includes(helper));
  assert.equal(build.includes("node_modules/tsx"), false);
  assert.match(packageScript, /--verify/);
  assert.match(packageScript, /local\.pi\.research\.desktop/);
  assert.match(fs.readFileSync("vite.config.ts", "utf8"), /base: '\/'/);
  const main = fs.readFileSync("desktop/main.ts", "utf8");
  assert.match(main, /void app\.whenReady\(\)\.then/);
  assert.equal(main.includes("bypassCSP"), false);
  assert.match(main, /gate\.launch/);
});
