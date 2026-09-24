import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Store } from "../server/store.ts";
import { Platform } from "../server/platform.ts";
import { PiPool } from "../server/pi.ts";
import { createApp } from "../server/app.ts";
import { installed } from "./installed-fixture.ts";
import { NativeIntents } from "../server/native-intents.ts";
import { RequestJournal } from "../desktop/requests.ts";
import { labRequest } from "../desktop/protocol.ts";
import { allowedRequest } from "../desktop/security.ts";
import { emptyView } from "../desktop/contracts.ts";
import { ViewStore } from "../desktop/view-state.ts";
import { pipeline } from "./platform-fixtures.ts";

async function fixture(t: any) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-integration-")),
    ),
    install = installed(root, { fixtureHandledInput: true }),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = install.agent;
  const store = new Store(path.join(root, "data")),
    platform = new Platform(store),
    pool = new PiPool(store, install.executable),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  server.on("request", createApp(store, pool, origin, undefined, platform));
  const strategy = store.create("Native integration");
  const scope = { kind: "strategy" as const, id: strategy.id },
    token = store.db.tokens[strategy.id],
    base = `/api/strategies/${strategy.id}`;
  const request = async (tail: string, body?: unknown, id?: string) => {
    const res = await labRequest(
      scope,
      {
        path: base + tail,
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined
          ? {}
          : {
              requestId: id,
              body: new TextEncoder().encode(JSON.stringify(body)),
            }),
      },
      origin,
      token,
    );
    return {
      status: res.status,
      body: JSON.parse(new TextDecoder().decode(res.body)),
    };
  };
  t.after(async () => {
    await pool.close();
    await platform.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    prior === undefined
      ? delete process.env.PI_CODING_AGENT_DIR
      : (process.env.PI_CODING_AGENT_DIR = prior);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, platform, pool, scope, token, base, request };
}
test("native bridge reads never start Pi; explicit fenced requests persist and deduplicate across later submissions", async (t) => {
  const x = await fixture(t),
    base = "/native/conversations/ideas";
  const before = await x.request(base);
  assert.equal(before.body.connected, false);
  assert.equal(x.pool.info().active, 0);
  assert.equal(before.body.binding, undefined);
  const dispatch = async (operation: any, state: any, id = randomUUID()) => ({
    id,
    response: await x.request(
      base + "/actions",
      {
        intent: { id, generation: state.generation, context: state.context },
        operation,
      },
      id,
    ),
  });
  await dispatch({ type: "connect" }, before.body);
  const connected = (await x.request(base)).body;
  assert.equal(connected.connected, true);
  assert.match(connected.context, /^[a-f0-9]{64}$/);
  assert.equal(connected.runtimeState.sessionFile, undefined);
  assert.equal(connected.models[0].provider, "fake");
  const firstId = randomUUID(),
    payload = {
      intent: {
        id: firstId,
        generation: connected.generation,
        context: connected.context,
      },
      operation: { type: "prompt", message: "Only one native submission" },
    };
  const first = await x.request(base + "/actions", payload, firstId);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "acknowledged");
  await new Promise((r) => setTimeout(r, 100));
  const after = (await x.request(base)).body;
  assert.notEqual(after.context, connected.context);
  const history = (
    await x.request(base + "/history?cursor=0&context=" + after.context)
  ).body;
  assert.equal(history.mode, "active-branch");
  assert.equal(
    history.entries.filter((e: any) => e.customType === "fixture-input-handled")
      .length,
    1,
  );
  assert.equal(
    (await x.request(base + "/actions", payload, firstId)).body.status,
    "acknowledged",
  );
  await dispatch({ type: "prompt", message: "Second explicit input" }, after);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    (await x.request(base + "/actions", payload, firstId)).body.status,
    "acknowledged",
  );
  assert.equal(
    x.pool
      .history(x.scope.id, "Ideas")
      .entries.filter((e: any) => e.customType === "fixture-input-handled")
      .length,
    2,
  );
  const stale = await dispatch(
    { type: "prompt", message: "Must refuse old context" },
    connected,
  );
  assert.equal(stale.response.status, 409);
  const latest = (await x.request(base)).body;
  await dispatch({ type: "stop" }, latest);
  assert.equal(
    (await x.request(base + "/history?cursor=0")).body.mode,
    "offline-append-log",
  );
  assert.equal(x.pool.info().active, 0);
});
test("sealed missing intents reject delayed delivery and ledger pending intents never replay after reopen", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-intents-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let ledger = new NativeIntents(root),
    count = 0;
  const id = randomUUID();
  ledger.seal("scope", id);
  await assert.rejects(
    ledger.run("scope", id, { prompt: "delayed" }, async () => {
      count++;
    }),
    /sealed/,
  );
  assert.equal(count, 0);
  let finish!: () => void;
  const pendingId = randomUUID(),
    pending = ledger.run(
      "scope",
      pendingId,
      { prompt: "once" },
      () =>
        new Promise<void>((r) => {
          count++;
          finish = r;
        }),
    );
  ledger = new NativeIntents(root);
  assert.equal(
    (
      await ledger.run("scope", pendingId, { prompt: "once" }, async () => {
        count++;
      })
    ).status,
    "pending",
  );
  await assert.rejects(
    ledger.run("scope", pendingId, { prompt: "changed" }, async () => {}),
    /different/,
  );
  finish();
  await pending;
  assert.equal(count, 1);
});
test("native main journals before transport and preserves scientific drafts across reopen", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-journal-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { kind: "strategy" as const, id: randomUUID() },
    desktop = path.join(root, ".desktop");
  fs.mkdirSync(desktop);
  const journal = new RequestJournal(root, desktop),
    id = randomUUID(),
    request = {
      requestId: id,
      path: `/api/strategies/${scope.id}/native/conversations/ideas/actions`,
      method: "POST" as const,
      headers: { "content-type": "application/json" as const },
      body: new TextEncoder().encode("{}"),
    };
  await assert.rejects(
    journal.dispatch(scope, request, async () => {
      assert.equal(journal.list(scope)[0].status, "pending");
      throw new Error("Lost ACK");
    }),
    /Lost ACK/,
  );
  assert.equal(
    new RequestJournal(root, desktop).list(scope)[0].status,
    "uncertain",
  );
  await assert.rejects(
    journal.dispatch(scope, request, async () => {}),
    /already recorded/,
  );
  const views = new ViewStore(root, desktop),
    state = {
      ...emptyView(),
      researchDrafts: {
        "research:spec": JSON.stringify({
          question: "Recovered research question",
        }),
      },
    };
  views.save(scope, state);
  assert.deepEqual(new ViewStore(root, desktop).read(scope), state);
});
test("native science routes preserve approvals, exact receipts and scope isolation", async (t) => {
  const x = await fixture(t),
    pipelineState = pipeline(x.platform, x.scope.id);
  const view = (await x.request("/native/research")).body;
  assert.equal(view.science.state.versions.length, 3);
  assert.equal(JSON.stringify(view).includes(x.token), false);
  const id = randomUUID(),
    body = {
      operationId: id,
      revision: view.science.revision,
      command: { type: "run.queue", config: pipelineState.config },
    };
  const receipt = await x.request("/science/commands", body, id);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.receipt.operationId, id);
  assert.equal(
    (await x.request("/science/operations/" + id)).body.operationId,
    id,
  );
  for (const tail of [
    "/native/conversations/portfolio",
    "/../" + randomUUID() + "/native/research",
    "/native/conversations/ideas?after=0&generation=0&token=secret",
  ])
    assert.throws(() =>
      allowedRequest(x.scope, {
        path: x.base + tail,
        method: "GET",
        headers: {},
      }),
    );
  const foreignId = randomUUID();
  assert.throws(() =>
    allowedRequest(x.scope, {
      path: `/api/strategies/${foreignId}/native/research`,
      method: "GET",
      headers: {},
    }),
  );
});
test("expanded host editor persists acknowledged text across stop/reconnect without replaying keys", async (t) => {
  const x = await fixture(t);
  await x.pool.handshake(x.scope.id, "Ideas");
  await x.pool.operate(x.scope.id, "Ideas", {
    type: "command",
    name: "factories",
  });
  for (let i = 0; i < 100; i++) {
    if (
      (await x.pool.snapshot(x.scope.id, "Ideas")).ui?.surfaces.some(
        (s) => s.kind === "editor",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const text = "Expanded editor recovery ".repeat(500);
  await x.pool.operate(x.scope.id, "Ideas", { type: "editor_state", text });
  const before = await x.pool.snapshot(x.scope.id, "Ideas");
  assert.equal(before.ui?.editor, text);
  await x.pool.stop(x.scope.id, "Ideas");
  await x.pool.handshake(x.scope.id, "Ideas");
  assert.equal((await x.pool.snapshot(x.scope.id, "Ideas")).ui?.editor, text);
  const files = fs.readdirSync(x.store.safe("native-editor"));
  const checkpoint = JSON.parse(
    fs.readFileSync(
      x.store.safe("native-editor", files.find((f) => f.endsWith(".json"))!),
      "utf8",
    ),
  );
  assert.equal(checkpoint.text, text);
  assert.ok(checkpoint.revision > 0);
});
test("native bootstrap remains inspectable and approvals answerable while Connect is pending", async (t) => {
  const x = await fixture(t);
  const pkg = await import("./installed-fixture.ts");
  // Fixture configuration is isolated from the installed user harness.
  fs.writeFileSync(
    path.join(x.root, "agent", "settings.json"),
    JSON.stringify({ startupDialog: true }),
  );
  const base = "/native/conversations/ideas",
    state = (await x.request(base)).body,
    id = randomUUID();
  const connect = x.request(
    base + "/actions",
    {
      intent: { id, generation: state.generation, context: state.context },
      operation: { type: "connect" },
    },
    id,
  );
  let pending: any;
  for (let i = 0; i < 100; i++) {
    pending = (await x.request(base)).body;
    if (pending.ui?.pending.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(pending.ui.pending.length);
  const responseId = randomUUID();
  const response = await x.request(
    base + "/actions",
    {
      intent: {
        id: responseId,
        generation: pending.generation,
        context: pending.context,
      },
      operation: {
        type: "ui_response",
        requestId: pending.ui.pending[0].id,
        value: true,
      },
    },
    responseId,
  );
  assert.equal(response.status, 200);
  assert.equal((await connect).status, 200);
  assert.equal((await x.request(base)).body.runtimeState.ready, true);
});
