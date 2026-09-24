import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { Store } from "../server/store.ts";
import { PiPool } from "../server/pi.ts";
import { createApp } from "../server/app.ts";
async function setup(t: any) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lab-api-test-")),
    ),
    store = new Store(root),
    pool = new PiPool(store, "");
  const a = store.create("A"),
    b = store.create("B");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(dist, "index.html"),
    "<html>public fixture</html>",
  );
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "/* public */");
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  const host = "127.0.0.1:" + port;
  server.on("request", createApp(store, pool, "http://" + host, dist));
  t.after(async () => {
    await pool.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (route: string, opts: any = {}) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...opts,
      headers: {
        Host: host,
        Authorization: "Bearer " + store.db.tokens[a.id],
        Origin: "http://" + host,
        ...opts.headers,
      },
    });
  const badHost = () =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/api/strategies/${a.id}`,
          headers: {
            Host: "evil.example",
            Authorization: "Bearer " + store.db.tokens[a.id],
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { store, a, b, call, badHost, root, dist };
}
test("authorized same-origin strategy state, events and raw upload succeed", async (t) => {
  const x = await setup(t),
    url = `/api/strategies/${x.a.id}`;
  const state = await x.call(url);
  assert.equal(state.status, 200);
  assert.equal(((await state.json()) as any).id, x.a.id);
  assert.equal((await x.call(url + "/events")).status, 200);
  const imported = await x.call(url + "/artifacts", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Revision": "1",
      "X-Filename": "hello.txt",
    },
    body: "hello world",
  });
  assert.equal(imported.status, 201);
  const data = (await imported.json()) as any;
  const response = await x.call(url + "/artifacts/" + data.artifacts[0].id);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello world");
});
test("HTTP capabilities deny cross-strategy read, upload, events, batches, annotations and Pi", async (t) => {
  const x = await setup(t);
  for (const suffix of [
    "",
    "/events",
    "/pi",
    "/batches/guessed",
    "/artifacts/guessed",
  ])
    assert.equal(
      (await x.call(`/api/strategies/${x.b.id}${suffix}`)).status,
      403,
    );
  for (const suffix of [
    "/artifacts",
    "/annotations",
    "/batches",
    "/discussions",
    "/pi/Ideas/connect",
    "/pi/Ideas/stop",
  ])
    assert.equal(
      (
        await x.call(`/api/strategies/${x.b.id}${suffix}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
  assert.equal((await x.call("/api/strategies")).status, 403);
});
test("guessed artifact IDs do not cross strategies even with own route", async (t) => {
  const x = await setup(t);
  x.store.import(x.b.id, x.b.revision, "secret.txt", Buffer.from("B only"));
  const id = x.store.get(x.b.id).artifacts[0].id;
  assert.equal(
    (await x.call(`/api/strategies/${x.a.id}/artifacts/${id}`)).status,
    404,
  );
});
test("origin, host and authorization protections reject ambient browser requests", async (t) => {
  const x = await setup(t),
    url = `/api/strategies/${x.a.id}`;
  assert.equal(
    (await x.call(url, { headers: { Authorization: "" } })).status,
    403,
  );
  assert.equal(
    (await x.call(url, { headers: { Origin: "http://evil.example" } })).status,
    403,
  );
  assert.equal(await x.badHost(), 403);
  assert.equal(
    (
      await x.call(url, {
        method: "PATCH",
        headers: { Origin: "", "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 1, lifecycle: "parked" }),
      })
    ).status,
    403,
  );
});
test("runtime and traversal are not downloadable, unsupported bytes force safe attachment", async (t) => {
  const x = await setup(t);
  for (const p of [
    "/.runtime/state.json",
    "/server/index.ts",
    "/api/strategies/" + x.a.id + "/artifacts/%2e%2e%2fstate.json",
  ])
    assert.ok((await x.call(p)).status >= 400);
  x.store.import(
    x.a.id,
    x.a.revision,
    "page.html",
    Buffer.from("<script>alert(1)</script>"),
  );
  const a = x.store.get(x.a.id).artifacts[0];
  const r = await x.call(`/api/strategies/${x.a.id}/artifacts/${a.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition")!, /attachment/);
  assert.match(r.headers.get("content-type")!, /octet-stream/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
test("HTTP optimistic conflict preserves first writer and Pi absence is truthful", async (t) => {
  const x = await setup(t),
    url = `/api/strategies/${x.a.id}`;
  const options = {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 1, lifecycle: "parked" }),
  };
  assert.equal((await x.call(url, options)).status, 200);
  assert.equal((await x.call(url, options)).status, 409);
  const info = (await (await x.call(url + "/pi")).json()) as any;
  assert.equal(info.configured, false);
  assert.equal(info.active, 0);
  assert.equal(
    (
      await x.call(url + "/pi/Ideas/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    503,
  );
});
test("public static serving rejects file, directory, index and root symlinks", async (t) => {
  const x = await setup(t);
  assert.equal((await x.call("/")).status, 200);
  assert.equal(await (await x.call("/assets/app.js")).text(), "/* public */");
  fs.symlinkSync(
    path.join(x.root, "state.json"),
    path.join(x.dist, "visible.json"),
  );
  assert.equal((await x.call("/visible.json")).status, 403);
  fs.symlinkSync(x.root, path.join(x.dist, "leak"));
  assert.equal((await x.call("/leak/state.json")).status, 403);
  fs.unlinkSync(path.join(x.dist, "index.html"));
  fs.symlinkSync(
    path.join(x.root, "state.json"),
    path.join(x.dist, "index.html"),
  );
  assert.equal((await x.call("/")).status, 403);
  assert.equal((await x.call("/lab/" + x.a.id)).status, 403);
  fs.renameSync(x.dist, x.dist + "-old");
  fs.symlinkSync(x.dist + "-old", x.dist);
  assert.equal((await x.call("/assets/app.js")).status, 403);
});
test("API refuses live steer and cross-strategy feedback draft references", async (t) => {
  const x = await setup(t);
  const res = await x.call(`/api/strategies/${x.a.id}/discussions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: 1,
      destination: "Ideas",
      instruction: "hello",
      behavior: "steer",
    }),
  });
  assert.equal(res.status, 400);
  const tab = x.store.get(x.a.id).tabs.Ideas;
  const invalid = await x.call(`/api/strategies/${x.a.id}/tabs/Ideas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: 1,
      state: { ...tab, editingAnnotationId: x.b.id },
    }),
  });
  assert.equal(invalid.status, 404);
});
