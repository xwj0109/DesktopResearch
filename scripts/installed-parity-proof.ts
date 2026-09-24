/** Optional no-inference proof against the installed SDK, using an empty agent directory. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";
import { PiPool } from "../server/pi.ts";
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-parity-proof-")),
);
const agent = path.join(root, "agent");
fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.LAB_PI_NO_INFERENCE = "1";
const store = new Store(path.join(root, "data"));
const pool = new PiPool(store, "/opt/homebrew/bin/pi");
try {
  const strategy = store.create("Disposable parity proof");
  await pool.handshake(strategy.id, "Ideas");
  const state = await pool.snapshot(strategy.id, "Ideas");
  const commands = await pool.commandCatalog(strategy.id, "Ideas");
  for (const name of [
    "new",
    "resume",
    "tree",
    "fork",
    "clone",
    "compact",
    "settings",
    "login",
    "logout",
    "import",
    "export",
    "share",
    "llama",
  ])
    assert.ok(
      commands.some((command: any) => command.name === name),
      `Missing ${name}`,
    );
  assert.ok(state.runtimeState?.keybindings?.["tui.input.submit"]);
  assert.deepEqual(state.runtimeState?.queue, { steering: [], followUp: [] });
  const completions = await pool.complete(
    strategy.id,
    "Ideas",
    "/sess",
    state.generation,
  );
  assert.ok(
    completions.items.some((item: any) => item.insert.startsWith("/session")),
    "Installed autocomplete provider must complete built-in commands",
  );
  assert.deepEqual(
    await pool.complete(strategy.id, "Ideas", "/sess", state.generation + 1),
    { items: [] },
  );
  async function command(name: string, args = "") {
    const before = await pool.snapshot(strategy.id, "Ideas");
    await pool.operate(strategy.id, "Ideas", { type: "command", name, args });
    for (let i = 0; i < 100; i++) {
      const next = await pool.snapshot(strategy.id, "Ideas", before.through);
      const done = next.events.find(
        (event) => event.type === "command_end" && event.name === name,
      );
      if (done) {
        assert.ok(!done.error, String(done.error));
        return next;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Command ${name} did not finish`);
  }
  await command("session");
  await command("name", "Disposable proof conversation");
  const next = await command("new");
  assert.notEqual(next.runtimeState?.sessionId, state.runtimeState?.sessionId);
  console.log(
    "Installed SDK session/name/new commands, handshake, built-in commands, built-in llama extension, effective keybindings, SDK completions and empty queue verified. No prompts or credentials used.",
  );
} finally {
  await pool.close();
  fs.rmSync(root, { recursive: true, force: true });
}
