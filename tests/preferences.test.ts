import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreferenceStore } from "../desktop/preferences";

test("old connection setting is ignored while the saved theme survives", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preferences-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "preferences.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, theme: "gruvbox", autoConnect: false }));
  const preferences = new PreferenceStore(root);
  assert.deepEqual(preferences.read(), { version: 1, theme: "gruvbox" });
  preferences.update({ theme: "flexoki-light" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, theme: "flexoki-light" });
});
