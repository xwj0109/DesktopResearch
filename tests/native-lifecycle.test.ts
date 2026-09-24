import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBackend, shutdownAfterStartup } from "../desktop/backend.ts";
import { StartupGate } from "../desktop/startup.ts";
function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-child-"));
  const entry = path.join(root, "fake-child.cjs");
  fs.writeFileSync(entry, source);
  return {
    root,
    entry,
    node: process.execPath,
    pi: "/authored-fixture-only",
    assets: root,
    handoffLauncher: path.join(root, "no-handoff"),
    startupTimeout: 1500,
    shutdownNoticeTimeout: 100,
  };
}
test("quit before ready prevents any backend launch, including delayed ready callback", () => {
  const gate = new StartupGate();
  let launches = 0;
  gate.requestQuit();
  assert.equal(
    gate.launch(() => ++launches),
    undefined,
  );
  assert.equal(launches, 0);
  assert.equal(gate.mayStart, false);
});
test("advisory closed does not release ownership until owned child actually exits", async () => {
  const options = fixture(
    `process.on('message', m => { if(m.type==='boot') process.send({version:1,type:'ready',origin:'http://127.0.0.1:12345',rootToken:'a'.repeat(64)}); else if(m.type==='shutdown'){process.send({version:1,type:'closed'});setTimeout(()=>process.exit(0),180);} });`,
  );
  try {
    const owner = await launchBackend(options);
    let done = false;
    const stopped = owner.stop().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(done, false);
    await stopped;
    assert.throws(() => process.kill(owner.pid, 0));
    assert.equal(done, true);
    await owner.stop();
  } finally {
    fs.rmSync(options.root, { recursive: true, force: true });
  }
});
test("quit during startup joins readiness then shutdown actual exit; cancellation retains owner", async () => {
  const options = fixture(
    `process.on('message', m => { if(m.type==='boot')setTimeout(()=>process.send({version:1,type:'ready',origin:'http://127.0.0.1:12345',rootToken:'a'.repeat(64)}),70); else if(m.type==='shutdown')process.exit(0); });`,
  );
  try {
    const starting = launchBackend(options);
    assert.equal(
      await shutdownAfterStartup(starting, async () => false),
      false,
    );
    const owner = await starting;
    assert.doesNotThrow(() => process.kill(owner.pid, 0));
    assert.equal(await shutdownAfterStartup(starting, async () => true), true);
    assert.throws(() => process.kill(owner.pid, 0));
  } finally {
    fs.rmSync(options.root, { recursive: true, force: true });
  }
});
test("partial startup failure, invalid protocol and absent executable clean up the exact child", async () => {
  for (const message of [
    `{version:1,type:'fatal',message:'Fixture failure'}`,
    `{version:2,type:'ready',rootToken:'secret'}`,
  ]) {
    const options = fixture(
      `require('node:fs').writeFileSync('pid',String(process.pid));process.on('message',m=>{if(m.type==='boot')process.send(${message});else if(m.type==='shutdown')process.exit(0);});`,
    );
    try {
      await assert.rejects(launchBackend(options));
      const pid = Number(
        fs.readFileSync(path.join(options.root, "pid"), "utf8"),
      );
      assert.throws(() => process.kill(pid, 0));
    } finally {
      fs.rmSync(options.root, { recursive: true, force: true });
    }
  }
  const options = fixture("");
  try {
    await assert.rejects(
      launchBackend({ ...options, node: path.join(options.root, "missing") }),
    );
  } finally {
    fs.rmSync(options.root, { recursive: true, force: true });
  }
});
test("readiness timeout cleans up instead of orphaning a partially started service", async () => {
  const options = fixture(
    `require('node:fs').writeFileSync('pid',String(process.pid));process.on('message',m=>{if(m.type==='shutdown')process.exit(0);});`,
  );
  try {
    await assert.rejects(
      launchBackend({ ...options, startupTimeout: 200 }),
      /timed out/,
    );
    const pid = Number(fs.readFileSync(path.join(options.root, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    fs.rmSync(options.root, { recursive: true, force: true });
  }
});
