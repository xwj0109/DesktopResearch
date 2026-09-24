import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const sessionHelper = "../server/pi-host-session.mjs",
  fixtureModule = "./fake-installed-pi.mjs";
const { ensureCanonicalSession } = await import(sessionHelper);
const { SessionManager } = await import(fixtureModule);

test("SDK first-flush fixture reproduces EEXIST from a manually written header without public resume", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-flush-repro-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root);
  fs.writeFileSync(
    manager.getSessionFile(),
    JSON.stringify(manager.getHeader()) + "\n",
  );
  manager.appendModelChange("fixture", "fixture-model");
  assert.equal(
    fs.readFileSync(manager.getSessionFile(), "utf8").trim().split("\n").length,
    1,
  );
  assert.throws(
    () =>
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "LOCAL FIXTURE; NO INFERENCE" }],
      }),
    { code: "EEXIST" },
  );
});

test("durable canonical materialization uses public resume, preserves setup entries/leaf, and accepts first assistant", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-flush-fix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root),
    id = manager.getSessionId(),
    file = manager.getSessionFile();
  const setup = manager.appendCustomEntry("setup", {
    content: "preserve this prepopulated entry",
  });
  manager.appendModelChange("fixture", "fixture-model");
  manager.branch(setup);
  assert.equal(fs.existsSync(file), false);
  ensureCanonicalSession(manager);
  assert.equal(manager.getSessionId(), id);
  assert.equal(manager.getLeafId(), setup);
  manager.appendThinkingLevelChange("low");
  const before = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    before.map((entry) => entry.type),
    ["session", "custom", "model_change", "thinking_level_change"],
  );
  assert.equal(before.at(-1).parentId, setup);
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "LOCAL ASSISTANT FIXTURE; NOT MODEL OUTPUT" },
    ],
  });
  const restored = SessionManager.open(file, root, root);
  assert.equal(restored.getSessionId(), id);
  assert.equal(restored.getSessionFile(), file);
  assert.equal(restored.getEntries().length, 4);
  assert.equal(
    restored.getEntries()[0].data.content,
    "preserve this prepopulated entry",
  );
});
