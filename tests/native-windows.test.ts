import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { startLabService } from "../server/lifecycle.ts";
import { emptyView, channels } from "../desktop/contracts.ts";

// Bundle against an authored fake Electron module, never start Electron/Pi.
test("native window orchestration: profiles before load, dedup/focus, scope checks and close-time flush", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-windows-")),
  );
  const assets = path.join(root, "assets"),
    storage = path.join(root, "data");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "index.html"), "<html></html>");
  fs.mkdirSync(storage);
  fs.mkdirSync(path.join(storage, ".desktop"));
  const outfile = path.join(root, "test-shell.mjs");
  await build({
    stdin: {
      contents: `export { Windows } from './desktop/windows.ts'; export * from './tests/native-electron-fake.ts';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    alias: { electron: path.resolve("tests/native-electron-fake.ts") },
    banner: {
      js: 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const { Windows, calls, invoke } = await import(pathToFileURL(outfile).href);
  const service = await startLabService({
    root: storage,
    assets,
    executable: "",
    handoffLauncher: "/unused",
  });
  const create = async (kind: string, name: string) => {
    const response = await fetch(service.origin + "/api/" + kind, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + service.rootToken,
        Origin: service.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ id: string }>;
  };
  try {
    const strategy = await create("strategies", "Real local strategy"),
      portfolio = await create("portfolios", "Real local portfolio");
    const codes: string[] = [];
    const windows = new Windows(
      {
        root: storage,
        assets,
        desktop: path.join(storage, ".desktop"),
        preload: "/authored-fake-preload",
        diagnose: (code: string) => codes.push(code),
        papers: {
          lookup: async () => [{ address: "151.101.1.42", family: 4 }],
          fetch: (async (url: string) =>
            url.includes("/pdf/")
              ? new Response(new TextEncoder().encode("%PDF-1.7 fixture"))
              : url.includes("search_query=")
                ? new Response(
                    '<feed><entry><id>http://arxiv.org/abs/1206.2305v2</id><published>2012-06-11T00:00:00Z</published><title>The numeraire property</title><author><name>Constantinos Kardaras</name></author></entry></feed>',
                  )
                : new Response("<feed></feed>")) as typeof fetch,
        },
        paperSearchGapMs: 0,
      },
      {
        ...service,
        actualExit: new Promise(() => {}),
        stop: service.close,
        pid: 0,
      },
    );
    await windows.restore();
    assert.equal(calls.windows.length, 1);
    await Promise.all([
      windows.open({ kind: "strategy", id: strategy.id }),
      windows.open({ kind: "strategy", id: strategy.id }),
    ]);
    await windows.open({ kind: "portfolio", id: portfolio.id });
    assert.equal(calls.windows.length, 3);
    assert.equal(new Set(calls.profiles).size, 3);
    const launcher = calls.windows[0],
      s = calls.windows[1],
      p = calls.windows[2];
    await windows.open({ kind: "strategy", id: strategy.id });
    assert.equal(s.focused, 1);
    assert.equal(calls.windows.length, 3);
    const context = await invoke(s, channels.bootstrap);
    assert.deepEqual(context.scope, { kind: "strategy", id: strategy.id });
    assert.match(context.viewId, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(context).includes(service.rootToken), false);
    for (const w of calls.windows) {
      if (process.platform === "darwin") {
        assert.equal(w.options.titleBarStyle, "hiddenInset");
        assert.deepEqual(w.options.trafficLightPosition, { x: 12, y: 10 });
      }
      assert.equal(w.options.webPreferences.sandbox, true);
      assert.equal(w.options.webPreferences.contextIsolation, true);
      assert.equal(w.options.webPreferences.nodeIntegration, false);
      assert.equal(w.options.webPreferences.webSecurity, true);
      assert.ok(w.webContents.session.protocol.handlers.has("pi-research"));
      assert.equal(w.webContents.session.permissions[0](), false);
      assert.equal(w.webContents.openHandler().action, "deny");
    }
    const list = await invoke(launcher, channels.lab, {
      method: "GET",
      path: "/api/strategies",
      headers: {},
    });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(list.body)), [
      { id: strategy.id, name: "Real local strategy" },
    ]);
    const metadata = await invoke(p, channels.lab, {
      method: "GET",
      path: "/api/portfolios/" + portfolio.id,
      headers: {},
    });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(metadata.body)), {
      id: portfolio.id,
      name: "Real local portfolio",
    });
    await assert.rejects(
      invoke(s, channels.bootstrap, undefined, {
        senderFrame: { url: s.webContents.mainFrame.url },
      }),
    );
    await assert.rejects(
      invoke(s, channels.open, { kind: "portfolio", id: portfolio.id }),
    );
    await assert.rejects(
      invoke(s, channels.lab, {
        method: "GET",
        path: "/api/portfolios/" + portfolio.id,
        headers: {},
      }),
    );
    // Paper downloads are strategy-only and return bytes for the normal import route.
    await assert.rejects(invoke(launcher, channels.fetchPaper, "2609.22612"), /strategy windows only/);
    await assert.rejects(invoke(p, channels.fetchPaper, "2609.22612"), /strategy windows only/);
    await assert.rejects(invoke(s, channels.fetchPaper, "http://example.org/x.pdf"), /https/);
    const paper = await invoke(s, channels.fetchPaper, "2609.22612");
    assert.equal(paper.name, "arXiv 2609.22612.pdf");
    assert.equal(new TextDecoder().decode(paper.bytes).slice(0, 5), "%PDF-");
    // A window that stops being recognised gets a plain save-view reason and a
    // diagnostics code instead of the generic denial; valid state still saves.
    await assert.rejects(
      invoke(s, channels.saveView, emptyView(), { senderFrame: { url: s.webContents.mainFrame.url } }),
      /Window state could not be saved: this window is no longer recognised by the desktop \(frame\)/,
    );
    assert.ok(codes.includes("ipc-sender-frame"));
    await assert.rejects(invoke(s, channels.saveView, { ...emptyView(), stage: "nowhere" }), /Window state could not be saved: stage/);
    assert.ok(codes.includes("view-save-invalid"));
    await invoke(s, channels.saveView, emptyView());
    // arXiv suggestions: strategy windows only; typed words in, bounded hits out.
    await assert.rejects(invoke(launcher, channels.searchPapers, "kardaras"), /strategy windows only/);
    await assert.rejects(invoke(p, channels.searchPapers, "kardaras"), /strategy windows only/);
    await assert.rejects(invoke(s, channels.searchPapers, "x".repeat(301)));
    await assert.rejects(invoke(s, channels.searchPapers, { q: "kardaras" }));
    assert.deepEqual(await invoke(s, channels.searchPapers, "2609.22612"), []);
    const hits = await invoke(s, channels.searchPapers, "kardaras numeraire");
    assert.deepEqual(hits.map((h: any) => [h.id, h.title, h.year]), [["1206.2305", "The numeraire property", "2012"]]);
    // End-to-end through the real window protocol and backend: source deletion,
    // undo, and a refusal reason that survives the error-sanitising boundary.
    const base = `/api/strategies/${strategy.id}`;
    const lab = async (method: "GET" | "POST", tail: string, value?: unknown, binary?: { name: string; bytes: Uint8Array }) => {
      const res = await invoke(s, channels.lab, {
        method,
        path: base + tail,
        requestId: method === "POST" ? randomUUID() : undefined,
        headers:
          method === "GET"
            ? {}
            : binary
              ? { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(binary.name), "x-revision": String(value) }
              : { "content-type": "application/json" },
        ...(method === "POST" ? { body: binary ? binary.bytes : new TextEncoder().encode(JSON.stringify(value)) } : {}),
      });
      return { status: res.status, json: JSON.parse(new TextDecoder().decode(res.body)) };
    };
    const view = async () => (await lab("GET", "/native/research")).json;
    await lab("POST", "/artifacts", (await view()).revision, { name: "thesis.txt", bytes: new TextEncoder().encode("thesis") });
    const thesis = (await view()).artifacts.at(-1);
    const deleted = await lab("POST", `/artifacts/${thesis.id}/delete`, { revision: (await view()).revision });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { removed: "thesis.txt", artifactId: thesis.id, annotationsRemoved: 0, revision: (await view()).revision });
    assert.equal((await view()).deleted[0].artifact.id, thesis.id, "recently deleted reaches the renderer");
    const undone = await lab("POST", `/artifacts/${thesis.id}/restore`, { revision: (await view()).revision });
    assert.equal(undone.json.restored, "thesis.txt");
    assert.equal((await view()).artifacts.some((a: any) => a.id === thesis.id), true);
    await lab("POST", "/annotations", { revision: (await view()).revision, annotation: { artifactId: thesis.id, anchor: { page: 1, quote: "q", rotation: 0 }, comment: "c", status: "draft" } });
    const noteId = (await view()).annotations.at(-1).id;
    await lab("POST", "/batches", { revision: (await view()).revision, destination: "Ideas", instruction: "review", annotationIds: [noteId], behavior: "followUp" });
    const reviewInput = { revision: (await view()).revision, destination: "Ideas", instruction: "Compare the evidence", annotationIds: [noteId] };
    const prepared = await lab("POST", "/native/reviews/review_prepare", reviewInput);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.json.review.status, "draft");
    assert.equal(prepared.json.review.instruction, reviewInput.instruction);
    const stale = await lab("POST", "/native/reviews/review_prepare", reviewInput);
    assert.equal(stale.status, 409);
    const reference = { reviewId: prepared.json.review.id, expectedHash: prepared.json.review.hash };
    const copied = await lab("POST", "/native/reviews/review_duplicate", { ...reference, revision: (await view()).revision, instruction: "A second question" });
    assert.equal(copied.status, 200);
    assert.deepEqual(copied.json.review.annotations, prepared.json.review.annotations);
    const linkedIdea = await lab("POST", "/native/reviews/review_create_idea", { ...reference, title: "Evidence-based hypothesis", response: "A candidate explanation to investigate" });
    assert.equal(linkedIdea.status, 200);
    assert.match(linkedIdea.json.target, /^d:/);
    assert.deepEqual(linkedIdea.json.review, { id: reference.reviewId, hash: reference.expectedHash });
    const draftRefusal = await lab("POST", "/native/reviews/review_delete", { ...reference, revision: (await view()).revision });
    assert.equal(draftRefusal.status, 409);
    assert.deepEqual(draftRefusal.json.refusal, { code: "review-draft-cited" });
    const deletion = await lab("POST", "/native/reviews/review_delete", { reviewId: copied.json.review.id, expectedHash: copied.json.review.hash, revision: (await view()).revision });
    assert.equal(deletion.status, 200);
    assert.equal(deletion.json.deleted, copied.json.review.id);
    assert.equal((await view()).batches.some((b: any) => b.id === copied.json.review.id), false);
    const refused = await lab("POST", `/artifacts/${thesis.id}/delete`, { revision: (await view()).revision });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.refusal.code, "frozen-batch");
    assert.match(refused.json.refusal.batch, /^[a-f0-9]{10}$/);
    assert.equal(JSON.stringify(refused.json).includes(storage), false, "no private paths cross the boundary");
    // One theme for the whole app: saved from any window, pushed to all of them.
    assert.equal(await invoke(launcher, channels.readTheme), null);
    await invoke(s, channels.saveTheme, "gruvbox");
    for (const w of [launcher, s, p])
      assert.deepEqual(
        w.sent.filter(([c]: [string]) => c === channels.themeChanged).at(-1),
        [channels.themeChanged, "gruvbox"],
      );
    assert.equal(await invoke(p, channels.readTheme), "gruvbox");
    await assert.rejects(invoke(s, channels.saveTheme, "not-a-real-theme"));
    await assert.rejects(invoke(s, channels.saveTheme, "../../etc"));
    assert.equal(await invoke(launcher, channels.readTheme), "gruvbox");
    const state = {
      ...emptyView(),
      drafts: { literature: "flush during close" },
    };
    s.onPrepare = async () => {
      await invoke(s, channels.saveView, state);
    };
    assert.equal(await windows.prepareQuit(), true);
    assert.deepEqual((await invoke(s, channels.readView)).drafts, state.drafts);
    await assert.rejects(windows.open({ kind: "launcher" }));
    windows.destroy();
    assert.ok(calls.windows.every((w: any) => w.destroyed));
    // Reconstruction restores scopes/layout only; transport allowlist contains no connect.
    const restored = new Windows(
      {
        root: storage,
        assets,
        desktop: path.join(storage, ".desktop"),
        preload: "/authored-fake-preload",
      },
      {
        ...service,
        actualExit: new Promise(() => {}),
        stop: service.close,
        pid: 0,
      },
    );
    await restored.restore();
    assert.equal(calls.windows.length, 6);
    // The app theme survives restart and colours new windows before first paint.
    assert.equal(await invoke(calls.windows[3], channels.readTheme), "gruvbox");
    assert.equal(calls.windows[3].options.backgroundColor, "#1e1e1e");
    // One owner preparing a window close must be joined, not overwritten, by app quit.
    const restoredStrategy = calls.windows[4],
      restoredPortfolio = calls.windows[5];
    let release: (() => void) | undefined;
    restoredStrategy.onPrepare = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    restoredStrategy.emit("close", { preventDefault() {} });
    const quitting = restored.prepareQuit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restoredStrategy.prepareCount, 1);
    release!();
    assert.equal(await quitting, true);
    assert.equal(restoredStrategy.destroyed, true);
    assert.equal(restoredPortfolio.prepareCount, 1);
    restored.destroy();
    // Failed preparation cancels the whole barrier and restores editing in all survivors.
    const cancelled = new Windows(
      {
        root: storage,
        assets,
        desktop: path.join(storage, ".desktop"),
        preload: "/authored-fake-preload",
      },
      {
        ...service,
        actualExit: new Promise(() => {}),
        stop: service.close,
        pid: 0,
      },
    );
    await cancelled.restore();
    const survivors = calls.windows.filter((w: any) => !w.destroyed);
    survivors.at(-1).onPrepare = async () => {
      throw new Error("fixture flush failed");
    };
    assert.equal(await cancelled.prepareQuit(), false);
    assert.ok(survivors.every((w: any) => w.cancelledCount >= 1));
    await cancelled.open({ kind: "launcher" });
    // Launcher deletion prepares an open strategy and resumes it on refusal.
    const disposable = await create("strategies", "Disposable strategy");
    await cancelled.open({ kind: "strategy", id: disposable.id });
    const disposableWindow = calls.windows.at(-1);
    const activeLauncher = survivors[0];
    const remove = (expectedName: string) => invoke(activeLauncher, channels.lab, {
      path: `/api/strategy-management/${disposable.id}/delete`, method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ expectedName })),
    });
    const refusedDelete = await remove("Stale name");
    assert.equal(refusedDelete.status, 409);
    assert.equal(disposableWindow.destroyed, false);
    assert.equal(disposableWindow.cancelledCount, 1);
    const acceptedDelete = await remove("Disposable strategy");
    assert.equal(acceptedDelete.status, 200);
    assert.equal(disposableWindow.prepareCount, 2);
    assert.equal(disposableWindow.destroyed, true);
    cancelled.destroy();
    assert.deepEqual(calls.errors, []);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
