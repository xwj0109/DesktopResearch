import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rpc } from "../server/rpc.ts";
import { PiPool } from "../server/pi.ts";
import { Store } from "../server/store.ts";
test("closed child stdin EPIPE rejects request without uncaught Socket error or resend", async (t) => {
  const script =
    "require('node:fs').closeSync(0);process.stdout.write(JSON.stringify({type:'ready'})+'\\n');setInterval(()=>{},1000);";
  const rpc = new Rpc(
    spawn(process.execPath, ["-e", script], { stdio: "pipe" }),
    500,
    100,
  );
  t.after(() => rpc.close());
  await once(rpc, "event");
  let writes = 0;
  const write = rpc.child.stdin.write.bind(rpc.child.stdin);
  rpc.child.stdin.write = ((...args: any[]) => {
    writes++;
    return (write as any)(...args);
  }) as typeof rpc.child.stdin.write;
  await assert.rejects(rpc.request("prompt", { message: "TEST ONLY" }));
  await rpc.exited;
  assert.equal(rpc.didExit, true);
  assert.equal(writes, 1);
  assert.equal(rpc.isClosed, true);
});
for (const stream of ["stdout", "stderr"] as const)
  test(`${stream} errors fail closed and reject pending requests`, async (t) => {
    const rpc = new Rpc(
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "pipe",
      }),
      500,
      100,
    );
    t.after(() => rpc.close());
    const pending = assert.rejects(
      rpc.request("get_state"),
      /Injected stream error/,
    );
    rpc.child[stream].emit("error", new Error("Injected stream error"));
    await pending;
    await rpc.exited;
    assert.equal(rpc.didExit, true);
  });
for (const action of ["stop", "close"] as const)
  test(`pending idle-eviction creation is cancelled by ${action}, with no later launch`, async (t) => {
    const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lab-cancel-create-")),
      ),
      store = new Store(root);
    let launches = 0;
    const pool = new PiPool(
      store,
      process.execPath,
      (_exe, _args, cwd, env) => {
        launches++;
        return new Rpc(
          spawn(
            process.execPath,
            [path.resolve("tests/fake-rpc.mjs"), "--stubborn"],
            { cwd, env, stdio: "pipe" },
          ),
          15000,
          150,
        );
      },
    );
    t.after(async () => {
      await pool.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const s = store.create("Cancel creation");
    await Promise.all([
      pool.handshake(s.id, "Ideas"),
      pool.handshake(s.id, "Literature"),
    ]);
    assert.equal(launches, 2);
    const connecting = pool.handshake(s.id, "Data");
    const rejected = assert.rejects(connecting, /cancelled|shutting down/);
    assert.equal(pool.info().terminating, 1);
    if (action === "stop") await pool.stop(s.id);
    else await pool.close();
    await rejected;
    assert.equal(launches, 2);
    assert.equal(pool.info().active, 0);
    if (action === "close")
      await assert.rejects(pool.handshake(s.id, "Data"), /shutting down/);
  });
