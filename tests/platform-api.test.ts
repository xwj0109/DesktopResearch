import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { PiPool } from "../server/pi.ts";
import { createApp } from "../server/app.ts";
import {
  fixture,
  pipeline,
  command,
  externalPackage,
  spec,
} from "./platform-fixtures.ts";
async function apiFixture(t: any) {
  const x = fixture(t),
    pool = new PiPool(x.store, ""),
    s = x.store.create("Scope A"),
    other = x.store.create("Scope B"),
    a = x.platform.createPortfolio("Portfolio A"),
    b = x.platform.createPortfolio("Portfolio B"),
    server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  server.on("request", createApp(x.store, pool, origin, undefined, x.platform));
  t.after(async () => {
    await pool.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const call = (route: string, token: string, method = "GET", body?: unknown) =>
    fetch(origin + route, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...x, pool, s, other, a, b, call };
}
test("every new strategy/portfolio route requires its exact scoped capability, never launcher fallback", async (t) => {
  const x = await apiFixture(t),
    sid = x.s.id,
    pid = x.a.id,
    uuid = randomUUID(),
    sha = "a".repeat(64);
  const strategyRoutes: [string, string][] = [
    ["", "GET"],
    ["/commands", "POST"],
    ["/events", "GET"],
    [`/versions/${uuid}/${sha}`, "GET"],
    [`/datasets/${uuid}`, "GET"],
    [`/runs/${uuid}`, "GET"],
    [`/exports/${uuid}`, "GET"],
    ["/context", "POST"],
    ["/rebuild", "POST"],
    [`/datasets/${uuid}/source`, "GET"],
    [`/proposal-reviews/${uuid}`, "GET"],
    ["/ui", "GET"],
    ["/ui", "PUT"],
  ];
  for (const [route, method] of strategyRoutes)
    for (const token of [
      x.store.db.rootToken,
      x.store.db.tokens[x.other.id],
      x.a.token,
      x.b.token,
    ]) {
      const r = await x.call(
        `/api/strategies/${sid}/science${route}`,
        token,
        method,
        method === "GET" ? undefined : {},
      );
      assert.equal(r.status, 403, route + " must be scoped");
    }
  const portfolioRoutes: [string, string][] = [
    ["", "GET"],
    ["/commands", "POST"],
    ["/events", "GET"],
    [`/imports/${uuid}`, "GET"],
    [`/analyses/${uuid}`, "GET"],
    [`/proposals/${uuid}`, "GET"],
    ["/context", "POST"],
    ["/rebuild", "POST"],
    ["/conversation", "GET"],
  ];
  for (const [route, method] of portfolioRoutes)
    for (const token of [
      x.store.db.rootToken,
      x.store.db.tokens[sid],
      x.b.token,
    ]) {
      const r = await x.call(
        `/api/portfolios/${pid}${route}`,
        token,
        method,
        method === "GET" ? undefined : {},
      );
      assert.equal(r.status, 403, route + " must be scoped");
    }
  for (const route of ["/api/portfolios", "/api/strategies"])
    assert.equal((await x.call(route, x.a.token)).status, 403);
  assert.equal(x.pool.info().active, 0);
});
test("typed command endpoints persist real jobs/exports/imports/analyses and reject malformed/stale bodies", async (t) => {
  const x = await apiFixture(t),
    sid = x.s.id,
    key = x.store.db.tokens[sid],
    base = `/api/strategies/${sid}/science`,
    f = pipeline(x.platform, sid);
  let response = await x.call(base + "/commands", key, "POST", {
    operationId: randomUUID(),
    revision: 0,
    command: { type: "version.create", value: spec },
  });
  assert.equal(response.status, 409);
  response = await x.call(base + "/commands", key, "POST", {
    operationId: randomUUID(),
    revision: x.platform.strategyView(sid).revision,
    command: {
      type: "run.queue",
      config: { ...f.config, arbitraryCommand: "shell" },
    },
  });
  assert.equal(response.status, 400);
  response = await x.call(base + "/commands", key, "POST", {
    operationId: randomUUID(),
    revision: x.platform.strategyView(sid).revision,
    command: { type: "run.queue", config: f.config },
  });
  assert.equal(response.status, 200);
  const run = ((await response.json()) as any).state.runs[0];
  await x.platform.idle();
  command(x.platform, sid, {
    type: "run.expose",
    runId: run.id,
    reason: "Explicit API test reveal",
  });
  const details = (await (
    await x.call(base + "/runs/" + run.id, key)
  ).json()) as any;
  assert.equal(details.run.status, "completed");
  assert.equal(details.output.points.length, 4);
  assert.equal(details.input.authoredCodeExecuted, false);
  const exported = command(x.platform, sid, {
    type: "export.create",
    runId: run.id,
    limitations: ["API fixture"],
  }).state.exports[0];
  const pkg = await (
    await x.call(base + "/exports/" + exported.id, key)
  ).json();
  const pb = "/api/portfolios/" + x.a.id;
  response = await x.call(pb + "/commands", x.a.token, "POST", {
    operationId: randomUUID(),
    revision: 0,
    command: { type: "import.add", package: pkg },
  });
  assert.equal(response.status, 200);
  const imported = ((await response.json()) as any).state.imports[0];
  response = await x.call(pb + "/commands", x.a.token, "POST", {
    operationId: randomUUID(),
    revision: 1,
    command: {
      type: "analysis.create",
      imports: [{ id: imported.id, hash: imported.hash }],
      allocation: { method: "equal", cap: 1 },
    },
  });
  assert.equal(response.status, 200);
  const analysis = ((await response.json()) as any).state.analyses[0];
  assert.equal(
    (await x.call(pb + "/analyses/" + analysis.id, x.a.token)).status,
    200,
  );
  assert.equal(
    (
      await x.call(
        "/api/portfolios/" + x.b.id + "/imports/" + imported.id,
        x.b.token,
      )
    ).status,
    404,
  );
  const manual = (await (
    await x.call(pb + "/conversation", x.a.token)
  ).json()) as any;
  assert.equal(manual.status, "manual-context-export");
  assert.equal(manual.automaticCalls, false);
  assert.equal(x.pool.info().active, 0);
});
test("scoped APIs reject foreign refs/proposals and unknown routes cannot mutate source strategies", async (t) => {
  const x = await apiFixture(t),
    pkg = externalPackage(["2026-01-02", "2026-01-03"], [0.1, -0.1]),
    base = "/api/portfolios/" + x.a.id;
  const before = JSON.stringify(x.store.db.strategies);
  assert.equal(
    (
      await x.call(
        base + "/strategies/" + x.s.id + "/science/commands",
        x.a.token,
        "POST",
        { command: { type: "run.queue" } },
      )
    ).status,
    404,
  );
  assert.equal(JSON.stringify(x.store.db.strategies), before);
  assert.equal(
    (
      await x.call(base + "/commands", x.a.token, "POST", {
        operationId: randomUUID(),
        revision: 0,
        command: {
          type: "approval.record",
          target: { id: x.s.id, hash: pkg.hash },
          decision: "approve",
          reason: "forbidden",
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await x.call(base + "/context", x.a.token, "POST", {
        role: "portfolio",
        task: "Leak source",
        selected: [{ id: x.s.id, hash: pkg.hash }],
        unresolved: [],
        budget: 1000,
      })
    ).status,
    404,
  );
  assert.equal(
    (await x.call("/api/portfolios", x.store.db.rootToken)).status,
    200,
  );
  assert.equal(x.pool.info().active, 0);
});

test("case and encoded route variants cannot bypass scoped auth through launcher fallback", async (t) => {
  const x = await apiFixture(t);
  for (const route of [
    `/api/Strategies/${x.s.id}/science`,
    `/api/Portfolios/${x.a.id}`,
    `/API/strategies/${x.s.id}/science`,
    `/api//strategies/${x.s.id}/science`,
    `/api/strategies/${x.s.id}%2fscience`,
    `/api/portfolios/${x.a.id}%2fcommands`,
  ]) {
    const response = await x.call(route, x.store.db.rootToken);
    assert.notEqual(response.status, 200, route);
    assert.notEqual(response.status, 201, route);
  }
  assert.equal(
    (await x.call(`/api/strategies/${x.s.id}/science`, x.store.db.rootToken))
      .status,
    403,
  );
});

test("application disclosure is explicit, irreversible, idempotent and gates every result surface", async (t) => {
  const x = await apiFixture(t),
    sid = x.s.id,
    key = x.store.db.tokens[sid],
    base = `/api/strategies/${sid}/science`,
    f = pipeline(x.platform, sid);
  const run = command(x.platform, sid, { type: "run.queue", config: f.config })
    .state.runs[0];
  await x.platform.idle();
  const before = (await (
    await x.call(base + "/runs/" + run.id, key)
  ).json()) as any;
  assert.equal(before.requiresExposure, true);
  assert.equal(before.output, null);
  assert.equal(before.run.exposures.length, 0);
  assert.ok(before.input.engine.sourceHash);
  const stateText = await (await x.call(base, key)).text(),
    eventsText = await (await x.call(base + "/events", key)).text();
  for (const text of [stateText, eventsText]) {
    assert.ok(!text.includes('"metrics"'));
    assert.ok(!text.includes('"points"'));
    assert.ok(!text.includes("totalReturn"));
  }
  const capsule = {
    role: "results",
    task: "Explain this run",
    selected: [{ id: run.id, hash: run.hash }],
    unresolved: [],
    budget: 16384,
  };
  assert.equal(
    (await x.call(base + "/context", key, "POST", capsule)).status,
    409,
  );
  const env = {
    operationId: randomUUID(),
    revision: x.platform.strategyView(sid).revision,
    command: {
      type: "run.expose",
      runId: run.id,
      reason: "Explicitly reveal holdout output in this application",
    },
  };
  assert.equal(
    (await x.call(base + "/commands", key, "POST", { ...env, revision: 0 }))
      .status,
    409,
  );
  assert.equal(
    (await x.call(base + "/commands", key, "POST", env)).status,
    200,
  );
  assert.equal(
    (await x.call(base + "/commands", key, "POST", env)).status,
    200,
  );
  const after = (await (
    await x.call(base + "/runs/" + run.id, key)
  ).json()) as any;
  assert.equal(after.requiresExposure, false);
  assert.equal(after.run.exposures.length, 1);
  assert.equal(after.run.exposures[0].kind, "application-disclosure");
  assert.ok(after.output.metrics);
  assert.match(after.disclosureNotice, /not proof of secrecy/);
  assert.equal(
    (await x.call(base + "/context", key, "POST", capsule)).status,
    200,
  );
  const second = command(x.platform, sid, {
    type: "run.queue",
    config: f.config,
  }).state.runs.at(-1)!;
  await x.platform.idle();
  assert.equal(x.platform.runDetails(sid, second.id).requiresExposure, true);
  const exported = command(x.platform, sid, {
    type: "export.create",
    runId: second.id,
    limitations: ["Explicit export itself discloses this result"],
  }).state.exports.at(-1)!;
  const pkg = (await (
    await x.call(base + "/exports/" + exported.id, key)
  ).json()) as any;
  assert.equal(pkg.body.trialContext.exposed, true);
  assert.equal(
    pkg.body.trialContext.exposurePolicy,
    "application-recorded-disclosure-not-a-secrecy-proof",
  );
  assert.equal(x.platform.runDetails(sid, second.id).requiresExposure, false);
  assert.equal(x.platform.runDetails(sid, second.id).run.exposures.length, 1);
});
