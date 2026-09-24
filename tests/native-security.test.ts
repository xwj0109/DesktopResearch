import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  allowedRequest,
  assertSender,
  documentURL,
  scopePath,
} from "../desktop/security.ts";
import {
  assetResponse,
  boundedBytes,
  workspaceDTO,
  labRequest,
  CSP,
} from "../desktop/protocol.ts";
import { bootSchema, childSchema, type Scope } from "../desktop/contracts.ts";
const id = "12345678-1234-1234-1234-123456789abc";
const strategy: Scope = { kind: "strategy", id },
  portfolio: Scope = { kind: "portfolio", id },
  launcher: Scope = { kind: "launcher" };
const get = (path: string) => ({ path, method: "GET", headers: {} });
const post = (path: string, value: unknown) => ({
  path,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)),
});
test("exact sender identity, frame, session, origin and document scope are all required", () => {
  const proof = {
    registered: true,
    destroyed: false,
    sessionMatches: true,
    mainFrame: true,
    scope: strategy,
    url: "pi-research://app" + scopePath(strategy),
  };
  assert.doesNotThrow(() => assertSender(proof));
  for (const key of ["registered", "sessionMatches", "mainFrame"] as const)
    assert.throws(() => assertSender({ ...proof, [key]: false }));
  assert.throws(() => assertSender({ ...proof, destroyed: true }));
  for (const url of [
    "https://app" + scopePath(strategy),
    "pi-research://evil" + scopePath(strategy),
    "pi-research://app/",
    proof.url + "?token=x",
    proof.url + "#x",
    "pi-research://app" + scopePath(portfolio),
    "pi-research://user@app" + scopePath(strategy),
  ])
    assert.equal(documentURL(url, strategy), false);
});
test("t15 transport cannot invoke Pi, science, cross-scope routes or arbitrary proxy payloads", () => {
  assert.doesNotThrow(() =>
    allowedRequest(strategy, get("/api/strategies/" + id)),
  );
  assert.doesNotThrow(() =>
    allowedRequest(launcher, post("/api/portfolios", { name: "A" })),
  );
  for (const route of [
    "/api/strategies",
    "/api/portfolios/" + id,
    `/api/strategies/${id}/pi/Literature/connect`,
    `/api/strategies/${id}/conversations/Literature/connect`,
    `/api/strategies/${id}/science/commands`,
    `/api/strategies/${id}?raw=true`,
    `/api/strategies/${id}/../`,
    `https://evil/api/strategies/${id}`,
  ])
    assert.throws(() => allowedRequest(strategy, get(route)));
  for (const value of [
    { name: "" },
    { name: "a", token: "x" },
    { name: "a".repeat(121) },
    { name: 3 },
    [],
  ])
    assert.throws(() =>
      allowedRequest(launcher, post("/api/strategies", value)),
    );
  assert.throws(() =>
    allowedRequest(strategy, {
      ...get("/api/strategies/" + id),
      headers: { Authorization: "Bearer x" },
    }),
  );
  assert.throws(() =>
    allowedRequest(strategy, {
      ...get("/api/strategies/" + id),
      body: new Uint8Array(),
    }),
  );
});
test("positive DTOs remove every capability and nested private field from list/create/detail", () => {
  const internal = {
    id,
    name: "Workspace",
    token: "secret",
    rootToken: "secret",
    tokens: { x: "secret" },
    path: "/private",
    nested: { token: "secret" },
    sessions: ["secret"],
  };
  assert.deepEqual(workspaceDTO([internal], launcher, "GET"), [
    { id, name: "Workspace" },
  ]);
  assert.deepEqual(workspaceDTO(internal, launcher, "POST"), { id });
  assert.deepEqual(workspaceDTO(internal, strategy, "GET"), {
    id,
    name: "Workspace",
  });
  assert.deepEqual(
    workspaceDTO({ state: internal, warning: "secret" }, portfolio, "GET"),
    { id, name: "Workspace" },
  );
  assert.deepEqual(
    workspaceDTO(
      { ...internal, persistence: { warning: "secret" } },
      launcher,
      "POST",
    ),
    { id, durabilityUncertain: true },
  );
  assert.throws(() =>
    workspaceDTO(
      { ...internal, id: "22345678-1234-1234-1234-123456789abc" },
      strategy,
      "GET",
    ),
  );
});
test("asset scheme serves only scoped document and built assets with CSP, not API or data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-assets-"));
  try {
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(
      path.join(root, "index.html"),
      '<script src="/assets/main.js"></script>',
    );
    fs.writeFileSync(path.join(root, "assets/main.js"), "export {}");
    const doc = await assetResponse(
      "pi-research://app" + scopePath(strategy),
      "GET",
      root,
      strategy,
    );
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), /src="\/assets/);
    assert.equal(doc.headers.get("Content-Security-Policy"), CSP);
    assert.match(CSP, /connect-src 'none'/);
    assert.equal(
      (
        await assetResponse(
          "pi-research://app/assets/main.js",
          "GET",
          root,
          strategy,
        )
      ).status,
      200,
    );
    for (const url of [
      "pi-research://app/",
      "pi-research://app/api/strategies",
      "pi-research://app/assets/%2e%2e/secret",
      "https://app/assets/main.js",
      "pi-research://app/assets/main.js?x=1",
    ])
      assert.notEqual(
        (await assetResponse(url, "GET", root, strategy)).status,
        200,
      );
    fs.symlinkSync(
      path.join(root, "index.html"),
      path.join(root, "assets/link.js"),
    );
    // Symlinks within assets remain assets; escape is denied.
    const outside = path.join(root, "..", path.basename(root) + "-outside");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(root, "assets/escape.js"));
    assert.equal(
      (
        await assetResponse(
          "pi-research://app/assets/escape.js",
          "GET",
          root,
          strategy,
        )
      ).status,
      404,
    );
    fs.unlinkSync(outside);
    assert.equal(
      (
        await assetResponse(
          "pi-research://app/assets/main.js",
          "POST",
          root,
          strategy,
        )
      ).status,
      405,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("bounded responses and strict versioned lifecycle schemas", async () => {
  await assert.rejects(
    boundedBytes(new Response(new Uint8Array(100)), 99),
    /too large/,
  );
  assert.equal(
    childSchema.safeParse({ version: 2, type: "closed" }).success,
    false,
  );
  assert.equal(
    childSchema.safeParse({
      version: 1,
      type: "ready",
      origin: "https://evil",
      rootToken: "a".repeat(64),
    }).success,
    false,
  );
  assert.equal(
    bootSchema.safeParse({
      version: 1,
      type: "boot",
      root: "/tmp/x",
      assets: "/tmp/y",
      executable: "/x",
      handoffLauncher: "/y",
      extra: true,
    }).success,
    false,
  );
});
test("main scoped proxy supplies capability but never returns raw error credentials", async () => {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-capability");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        mode === "ok"
          ? { id, name: "Scoped", token: "private-capability" }
          : { error: "private-capability", nested: { rootToken: "secret" } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const response = await labRequest(
      strategy,
      get("/api/strategies/" + id),
      origin,
      "private-capability",
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), {
      id,
      name: "Scoped",
    });
    mode = "invalid";
    await assert.rejects(
      labRequest(
        strategy,
        get("/api/strategies/" + id),
        origin,
        "private-capability",
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
