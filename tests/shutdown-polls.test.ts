import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLabService } from "../server/lifecycle.ts";
import { ViewChannel } from "../server/workbench/view-channel.ts";

test("shutdown drains pending presentation HTTP requests without waiting for their timeout", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-polls-"));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, "index.html"), "<html></html>");
  const service = await startLabService({ root: path.join(root, "data"), assets, executable: "" });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${service.rootToken}`, origin: service.origin, "content-type": "application/json" };
  const strategy: any = await fetch(service.origin + "/api/strategies", { method: "POST", headers, body: JSON.stringify({ name: "Shutdown fixture" }) }).then(r => r.json());
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const next = ViewChannel.prototype.next;
  ViewChannel.prototype.next = function (...args) { const result = next.apply(this, args); entered(); return result; };
  t.after(() => { ViewChannel.prototype.next = next; });
  const response = fetch(`${service.origin}/api/strategies/${strategy.id}/native/view-events?after=-1`, { headers: { ...headers, authorization: `Bearer ${strategy.token}` } });
  await Promise.race([waiting, response.then(r => { throw new Error(`Poll ended before waiting: ${r.status}`); })]);
  const began = Date.now();
  await service.close();
  assert.equal((await response).status, 200);
  assert.ok(Date.now() - began < 2000, "shutdown should wake the 10-second long poll immediately");
});

test("closed presentation channels wake current waiters and never start new waits", async () => {
  const view = new ViewChannel();
  const pending = view.next("fixture", -1, 10000);
  view.close();
  await pending;
  const began = Date.now();
  await view.next("fixture", -1, 10000);
  assert.ok(Date.now() - began < 1000);
  view.close();
});
