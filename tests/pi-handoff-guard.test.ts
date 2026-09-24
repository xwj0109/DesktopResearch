import { test } from "node:test";
import assert from "node:assert/strict";
const modulePath = "../server/pi-handoff-guard.mjs";
const { default: guard } = await import(modulePath);
test("managed CLI guard cancels New/Resume/Import/Fork even when UI notification fails", () => {
  const handlers = new Map<string, Function>();
  guard({ on: (name: string, callback: Function) => handlers.set(name, callback) });
  for (const reason of ["new", "resume", "import"]) assert.deepEqual(handlers.get("session_before_switch")!({ reason }, { ui: { notify: () => {} } }), { cancel: true });
  assert.deepEqual(handlers.get("session_before_fork")!({}, { ui: { notify: () => { throw new Error("unavailable UI"); } } }), { cancel: true });
});
