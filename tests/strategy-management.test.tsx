import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { create, act } from "react-test-renderer";
import { fixture } from "./platform-fixtures";
import { Workbench } from "../server/workbench/tools";
import { Store } from "../server/store";
import { PiPool } from "../server/pi";
import { Launcher } from "../src/native";
import { allowedRequest } from "../desktop/security";
import { labRequest } from "../desktop/protocol";
import { startLabService } from "../server/lifecycle";
import path from "node:path";
import os from "node:os";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("strategy rename preserves identity; deletion revokes catalog access and retains files across restart", async t => {
  const { store, platform } = fixture(t);
  const s = store.create("Original"), token = store.db.tokens[s.id];
  store.import(s.id, s.revision, "evidence.txt", Buffer.from("Evidence to preserve"));
  const before = structuredClone(store.get(s.id));
  const wb = new Workbench(store, platform), pool = new PiPool(store, "");
  wb.assertStrategyDeletable = sid => pool.assertStrategyDeletable(sid);
  t.after(async () => { await pool.close(); await wb.close(); });
  const renamed: any = await wb.call(s.id, "strategy_rename", { expectedName: "Original", name: "  New name  " });
  assert.deepEqual(renamed, { id: s.id, name: "New name" });
  assert.deepEqual(store.get(s.id).tabs, before.tabs);
  assert.deepEqual(store.get(s.id).artifacts, before.artifacts);
  await assert.rejects(wb.call(s.id, "strategy_delete", { expectedName: "Original" }), /name changed/);
  const root = store.storage.strategyRoot(s.id);
  const other = store.create("Keep me");
  const inspect = pool.ownership.bind(pool);
  pool.ownership = (() => ({ recoveryRequired: true })) as any;
  await assert.rejects(wb.call(s.id, "strategy_delete", { expectedName: "New name" }), /ownership/);
  pool.ownership = inspect;
  const result: any = await wb.call(s.id, "strategy_delete", { expectedName: "New name" });
  assert.equal(result.filesRetained, true);
  assert.equal(fs.existsSync(root), true);
  assert.throws(() => store.auth(token, s.id), /capability/);
  assert.equal(new Store(store.root).get(other.id).name, "Keep me");
  assert.throws(() => new Store(store.root).get(s.id), /not found/);
});

test("management routes require launcher authority and pass only safe metadata", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-management-"));
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "index.html"), "<html></html>");
  const service = await startLabService({ root, assets: path.join(root, "assets"), executable: "", handoffLauncher: "/unused" });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const created = await fetch(service.origin + "/api/strategies", { method: "POST", headers: { authorization: `Bearer ${service.rootToken}`, origin: service.origin, "content-type": "application/json" }, body: JSON.stringify({ name: "HTTP strategy" }) }).then(r => r.json()) as any;
  const req = (action: string, body: unknown) => ({ path: `/api/strategy-management/${created.id}/${action}`, method: "POST" as const, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  const rename = req("rename", { expectedName: "HTTP strategy", name: "Renamed" });
  assert.throws(() => allowedRequest({ kind: "strategy", id: created.id }, rename), /outside/);
  const denied = await fetch(service.origin + rename.path, { method: "POST", headers: { authorization: `Bearer ${created.token}`, origin: service.origin, "content-type": "application/json" }, body: JSON.stringify({ expectedName: "HTTP strategy", name: "No" }) });
  assert.equal(denied.status, 403);
  const renamed = await labRequest({ kind: "launcher" }, rename, service.origin, service.rootToken);
  assert.equal(renamed.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(renamed.body)), { id: created.id, name: "Renamed" });
  const deleted = await labRequest({ kind: "launcher" }, req("delete", { expectedName: "Renamed" }), service.origin, service.rootToken);
  assert.equal(deleted.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(deleted.body)), { id: created.id, deleted: true, filesRetained: true });
});

test("launcher rename and deletion are explicit and refresh the list", async t => {
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  const id = "10000000-0000-4000-8000-000000000001";
  let items = [{ id, name: "My strategy" }], calls: any[] = [];
  const bridge: any = { openWorkspace: async () => {}, lab: async (req: any) => {
    let result: any;
    if (req.method === "GET") result = req.path === "/api/strategies" ? items : [];
    else {
      const body = JSON.parse(new TextDecoder().decode(req.body)); calls.push({ path: req.path, body });
      if (req.path.endsWith("/rename")) { items = [{ id, name: body.name }]; result = items[0]; }
      else { items = []; result = { id, deleted: true, filesRetained: true }; }
    }
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(result)) };
  } };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Launcher bridge={bridge} theme="flexoki-light" onTheme={() => {}} />); });
  t.after(() => act(async () => renderer.unmount()));
  const root = renderer!.root;
  await act(async () => root.findByProps({ "aria-label": "Rename My strategy" }).props.onClick());
  const form = root.findByType("form");
  await act(async () => form.findByType("input").props.onChange({ target: { value: "Renamed strategy" } }));
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  assert.equal(calls[0].body.expectedName, "My strategy");
  await act(async () => root.findByProps({ "aria-label": "Delete Renamed strategy" }).props.onClick());
  assert.equal(calls.length, 1, "opening confirmation is not deletion");
  const confirmation = root.findByProps({ "aria-label": "Confirm deletion of Renamed strategy" });
  await act(async () => confirmation.findAllByType("button").find(b => b.children.join("") === "Delete strategy")!.props.onClick());
  assert.equal(calls[1].body.expectedName, "Renamed strategy");
  assert.equal(root.findAllByProps({ "aria-label": "Delete Renamed strategy" }).length, 0);
});
