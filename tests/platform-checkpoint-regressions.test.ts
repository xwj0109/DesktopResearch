import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Platform } from "../server/platform.ts";
import { createApp } from "../server/app.ts";
import { PiPool } from "../server/pi.ts";
import { contentHash } from "../server/durable.ts";
import { metrics, analyze, validateExport, LIMITATIONS } from "../server/reference-engine.ts";
import { fixture, externalPackage, pipeline, command } from "./platform-fixtures.ts";
import type { ExportPackage } from "../src/platform.ts";

async function failPublication<T>(file: string, work: () => T | Promise<T>): Promise<T> {
  const rename = fs.renameSync, sync = fs.fsyncSync;
  let published = false;
  fs.renameSync = (from, to) => { rename(from, to); if (String(to) === file) published = true; };
  fs.fsyncSync = (fd) => {
    if (published && fs.fstatSync(fd).isDirectory()) throw new Error("Injected directory publication fsync failure");
    sync(fd);
  };
  try { return await work(); }
  finally { fs.renameSync = rename; fs.fsyncSync = sync; }
}

test("mkdir retry reconfirms an existing strategies entry before any dependent catalog commit", (t) => {
  const { store } = fixture(t), workspace = store.storage.workspaces;
  const inode = fs.statSync(workspace).ino, catalog = path.join(store.root, "catalog.json");
  const before = fs.readFileSync(catalog, "utf8"), mkdir = fs.mkdirSync, sync = fs.fsyncSync;
  let created = false, failing = true, confirmed = 0;
  fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
    const result = (mkdir as any)(...args);
    if (String(args[0]) === path.join(workspace, "strategies")) created = true;
    return result;
  }) as typeof fs.mkdirSync;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (created && stat.isDirectory() && stat.ino === inode) {
      if (failing) throw new Error("Injected strategies-parent fsync failure");
      confirmed++;
    }
    sync(fd);
  };
  try {
    assert.throws(() => store.create("First attempt"), /parent fsync/);
    assert.equal(fs.existsSync(path.join(workspace, "strategies")), true);
    assert.throws(() => store.create("Still unsafe"), /parent fsync/);
    assert.equal(fs.readFileSync(catalog, "utf8"), before);
    failing = false;
    const s = store.create("Durably retried");
    assert.ok(confirmed > 0);
    assert.equal(store.get(s.id).name, "Durably retried");
    assert.equal(store.storage.warning, null);
  } finally { fs.mkdirSync = mkdir; fs.fsyncSync = sync; }
});

test("uncertain portfolio registration is explicit and cannot acknowledge dependent imports or creation", async (t) => {
  const { store, platform: p } = fixture(t);
  p.createPortfolio("Prior durable portfolio");
  const file = path.join(store.root, "portfolios.json"), previous = fs.readFileSync(file, "utf8");
  const created = await failPublication(file, () => p.createPortfolio("Uncertain portfolio"));
  assert.equal(created.persistence?.committed, true);
  assert.equal(created.persistence?.durability, "uncertain");
  assert.equal(created.persistence?.retry, "do-not-replay");
  assert.equal(p.listPortfolios().some(x => x.id === created.id), true);
  const request = {operationId: randomUUID(), revision: 0, command: {type: "import.add", package: externalPackage(["2026-01-02", "2026-01-03"], [.1, -.1])}};
  assert.throws(() => p.portfolioCommand(created.id, request), /registry publication durability uncertain/);
  assert.throws(() => p.createPortfolio("Must not replay"), /registry publication durability uncertain/);
  assert.throws(() => p.rebuild("portfolio", created.id), /registry publication durability uncertain/);
  assert.equal(fs.existsSync(path.join(store.storage.workspaces, "portfolios", created.id)), false);
  // Simulate the explicitly allowed crash outcome: the prior registry survives.
  fs.writeFileSync(file, previous);
  const restored = new Platform(store);
  assert.equal(restored.listPortfolios().some(x => x.id === created.id), false);
  assert.throws(() => restored.authPortfolio(created.token, created.id), /capability/);
  await restored.close();
});

test("portfolio restart confirms visible registry durability before accepting dependent imports", async (t) => {
  const { store, platform: p } = fixture(t), file = path.join(store.root, "portfolios.json");
  const created = await failPublication(file, () => p.createPortfolio("Visible registry"));
  const sync = fs.fsyncSync, inode = fs.statSync(store.root).ino;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).ino === inode) throw new Error("Registry still cannot sync"); sync(fd); };
  try { assert.throws(() => new Platform(store), /still cannot sync/); } finally { fs.fsyncSync = sync; }
  const restored = new Platform(store);
  const view = restored.portfolioCommand(created.id, {operationId: randomUUID(), revision: 0, command: {type: "import.add", package: externalPackage(["2026-01-02", "2026-01-03"], [.1, -.1])}});
  assert.equal(view.state.imports.length, 1);
  assert.equal(view.warning, null);
  await restored.close();
});

async function httpFixture(t: any) {
  const x = fixture(t), s = x.store.create("HTTP publication"), pool = new PiPool(x.store, "");
  x.store.import(s.id, x.store.get(s.id).revision, "source.txt", Buffer.from("source"));
  x.store.annotate(s.id, x.store.get(s.id).revision, {artifactId: x.store.get(s.id).artifacts[0].id, anchor: {page: 1, quote: "source", rotation: 0}, comment: "Review"});
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  server.on("request", createApp(x.store, pool, origin, undefined, x.platform));
  t.after(async () => { await pool.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (route: string, method: string, body: unknown, headers: Record<string,string> = {}) => fetch(origin + route, {
    method, headers: {Origin: origin, Authorization: `Bearer ${x.store.db.tokens[s.id]}`, "Content-Type": "application/json", ...headers},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {...x, s, request};
}
for (const mutation of ["create", "patch", "tab", "upload", "annotation", "batch", "discussion"] as const)
  test(`companion ${mutation} response conveys published uncertainty and preserves committed state`, async t => {
    const x = await httpFixture(t), s = x.store.get(x.s.id), base = `/api/strategies/${s.id}`;
    let route = base, method = "POST", body: unknown, headers: Record<string,string> = {};
    switch (mutation) {
      case "create": route = "/api/strategies"; body = {name: "Published creation"}; headers.Authorization = `Bearer ${x.store.db.rootToken}`; break;
      case "patch": method = "PATCH"; body = {revision: s.revision, lifecycle: "parked"}; break;
      case "tab": route += "/tabs/Ideas"; method = "PUT"; body = {revision: s.revision, state: {...s.tabs.Ideas, notes: "Published notes"}}; break;
      case "upload": route += "/artifacts"; body = "Published source bytes"; headers = {"Content-Type": "application/octet-stream", "X-Filename": "published.txt", "X-Revision": String(s.revision)}; break;
      case "annotation": route += "/annotations"; body = {revision: s.revision, annotation: {artifactId: s.artifacts[0].id, anchor: {page: 1, quote: "source", rotation: 0}, comment: "Published annotation"}}; break;
      case "batch": route += "/batches"; body = {revision: s.revision, annotationIds: [s.annotations[0].id], destination: "Ideas", instruction: "Published immutable review"}; break;
      case "discussion": route += "/discussions"; body = {revision: s.revision, destination: "Ideas", instruction: "Published discussion"}; break;
    }
    const response = await failPublication(path.join(x.root, "catalog.json"), () => x.request(route, method, body, headers));
    assert.ok(response.ok);
    assert.equal(response.headers.get("X-Herdr-Durability"), "uncertain");
    const result = await response.json() as any;
    assert.equal(result.persistence.committed, true);
    assert.equal(result.persistence.durability, "uncertain");
    assert.equal(result.persistence.retry, "do-not-replay");
    assert.match(result.warning, /uncertain/);
    assert.match(result.runtimeError, /uncertain/);
    if (mutation === "create") assert.ok(x.store.get(result.id));
    else assert.equal(x.store.get(s.id).revision, s.revision + 1);
    const blocked = await x.request(base, "PATCH", {revision: x.store.get(s.id).revision, lifecycle: "active"});
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json() as any).persistence, undefined, "A blocked subsequent action must not claim it committed");
  });

test("uncertain job input publication never enters the execution queue", async t => {
  const {store, platform: p} = fixture(t), s = store.create("Job publication"), f = pipeline(p, s.id);
  const revision = p.strategyView(s.id).revision;
  const event = path.join(store.storage.strategyRoot(s.id), "meta", "science", "journal", String(revision + 1).padStart(8, "0") + ".json");
  const env = {operationId: randomUUID(), revision, command: {type: "run.queue", config: f.config}};
  const view = await failPublication(event, () => p.command(s.id, env));
  assert.match(view.warning!, /sync failed/);
  await p.idle();
  assert.equal(p.jobStatus().active, 0); assert.equal(p.jobStatus().queued, 0);
  assert.deepEqual(p.strategyView(s.id).state.runs[0].history.map(h => h.status), ["queued"]);
  assert.equal(p.command(s.id, env).state.runs.length, 1);
  const restored = new Platform(store);
  assert.equal(restored.strategyView(s.id).state.runs[0].status, "interrupted");
  await restored.close();
});

test("constant nonzero returns have exactly zero volatility, undefined correlation and blocked inverse volatility", () => {
  assert.equal(metrics([.1,.1,.1],252).annualizedVolatility, 0);
  assert.equal(metrics([.1,.1,.1],252).mean, .1);
  const a = externalPackage(["2026-01-02","2026-01-03","2026-01-04"],[.1,.1,.1]);
  const b = externalPackage(["2026-01-02","2026-01-03","2026-01-04"],[.1,.05,-.02]);
  const refs = [{id:randomUUID(),hash:a.hash},{id:randomUUID(),hash:b.hash}];
  const result = analyze([a,b],refs,{method:"equal",cap:1});
  assert.equal(result.individual[0].annualizedVolatility,0);
  assert.ok(result.correlations.filter(c=>c.a===0).every(c=>c.value===null));
  assert.throws(()=>analyze([a,b],refs,{method:"inverse-volatility",cap:1}),/zero variance/);
  for(const values of [[.1,.10000000000000002,.1],[1e-200,-1e-200,1e-200]]) {
    assert.ok(metrics(values,252).annualizedVolatility! > 0);
    const small=externalPackage(["2026-01-02","2026-01-03","2026-01-04"],values);
    const result=analyze([small],[{id:randomUUID(),hash:small.hash}],{method:"inverse-volatility",cap:1});
    assert.ok(Math.abs(result.correlations[0].value! - 1)<1e-12);
    assert.deepEqual(result.weights,[1]);
  }
});

function rehashOutput(pkg: ExportPackage) {
  let equity=1,peak=1;
  const points=pkg.body.points.map(p=>{equity*=1+p.return;peak=Math.max(peak,equity);return {...p,equity,drawdown:1-equity/peak};});
  pkg.body.outputHash=contentHash({points,metrics:metrics(points.map(p=>p.return),pkg.body.conventions.annualisation),conventions:pkg.body.conventions,limitations:LIMITATIONS});
  pkg.hash=contentHash(pkg.body);return pkg;
}
test("imports enforce source-independent buyhold, moving-average warmup/binary and flat-return rules", () => {
  const original=externalPackage(["2026-01-02","2026-01-03","2026-01-04"],[.1,.05,-.02]);
  validateExport(original);
  const forged=structuredClone(original);forged.body.config.rule="moving-average";forged.body.config.window=252;forged.hash=contentHash(forged.body);
  assert.throws(()=>validateExport(forged),/warmup/);
  const flat=structuredClone(original);flat.body.points.forEach(p=>{p.position=0;p.turnover=0;p.return=0;});rehashOutput(flat);
  assert.throws(()=>validateExport(flat),/unit long exposure/);
  flat.body.config.rule="moving-average";rehashOutput(flat);validateExport(flat);
  flat.body.points[2].position=.5;flat.body.points[2].turnover=.5;rehashOutput(flat);
  assert.throws(()=>validateExport(flat),/binary/);
  flat.body.config.rule="exogenous";flat.body.points[0].return=.02;rehashOutput(flat);
  assert.throws(()=>validateExport(flat),/Flat exposure/);
  const impossible=structuredClone(original);impossible.body.config.rule="exogenous";impossible.body.points.forEach(p=>p.position=-1);impossible.body.points[0].return=2;rehashOutput(impossible);
  assert.throws(()=>validateExport(impossible),/positive close prices/);
});

test("portfolio creation HTTP response exposes uncertainty without granting usable mutation authority", async t => {
  const x = await httpFixture(t);
  const response = await failPublication(path.join(x.root, "portfolios.json"), () =>
    x.request("/api/portfolios", "POST", {name: "Uncertain HTTP portfolio"}, {Authorization: `Bearer ${x.store.db.rootToken}`}));
  assert.equal(response.status, 201);
  const created = await response.json() as any;
  assert.equal(created.persistence.durability, "uncertain");
  assert.equal(created.persistence.committed, true);
  assert.equal(created.persistence.retry, "do-not-replay");
  const blocked = await x.request(`/api/portfolios/${created.id}/commands`, "POST", {
    operationId: randomUUID(), revision: 0, command: {type: "import.add", package: externalPackage(["2026-01-02", "2026-01-03"], [.1,-.1])},
  }, {Authorization: `Bearer ${created.token}`});
  assert.equal(blocked.status, 503);
  assert.equal(fs.existsSync(path.join(x.store.storage.workspaces, "portfolios", created.id)), false);
});

test("uncertain running transition cannot execute an already queued reference job", async t => {
  const {store, platform: p} = fixture(t), s = store.create("Running publication"), f = pipeline(p, s.id);
  const revision = p.strategyView(s.id).revision;
  const event = path.join(store.storage.strategyRoot(s.id), "meta", "science", "journal", String(revision + 2).padStart(8, "0") + ".json");
  const rowsFile = path.join(store.storage.strategyRoot(s.id), "meta", "science", "blobs", f.d.rowsHash!);
  const open = fs.openSync;
  let executionReads = 0;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === rowsFile && p.strategyView(s.id).state.runs[0]?.status === "running") executionReads++;
    return open(...args);
  }) as typeof fs.openSync;
  try {
    await failPublication(event, async () => {
      command(p,s.id,{type:"run.queue",config:f.config});
      await p.idle();
    });
  } finally { fs.openSync = open; }
  assert.equal(executionReads, 0, "Executor must not even load observations after an uncertain running intent");
  const run = p.strategyView(s.id).state.runs[0];
  assert.deepEqual(run.history.map(h=>h.status), ["queued", "running"]);
  assert.equal(run.outputHash, null);
  assert.equal(p.jobStatus().active,0);
  assert.match(p.jobStatus().warning!,/persistence failure/);
  const restored = new Platform(store);
  assert.equal(restored.strategyView(s.id).state.runs[0].status,"interrupted");
  await restored.close();
});
