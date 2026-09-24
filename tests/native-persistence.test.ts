import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewStore } from "../desktop/view-state.ts";
import { emptyView, type Scope } from "../desktop/contracts.ts";
import {
  storageIdentity,
  saveWindowState,
  readWindowState,
  clampBounds,
} from "../desktop/window-state.ts";
import {
  validateDesktopRoot,
  systemRuntime,
  cleanEnvironment,
  desktopConfig,
} from "../desktop/config.ts";
import { diagnostics } from "../desktop/diagnostics.ts";
const a: Scope = {
    kind: "strategy",
    id: "12345678-1234-1234-1234-123456789abc",
  },
  b: Scope = { kind: "portfolio", id: "12345678-1234-1234-1234-123456789abc" };
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-native-")),
  );
  fs.mkdirSync(path.join(root, ".desktop"));
  return root;
}
test("native draft store survives reconstruction and separates scope and seven stages", () => {
  const root = fixture();
  try {
    const store = new ViewStore(root, path.join(root, ".desktop"));
    const state = {
      ...emptyView(),
      drafts: {
        ideas: "idea",
        literature: "paper",
        research: "hypothesis",
        data: "data",
        code: "code",
        backtests: "test",
        results: "result",
      },
    };
    store.save(a, state);
    store.save(b, { ...emptyView(), drafts: { portfolio: "independent" } });
    const relaunched = new ViewStore(root, path.join(root, ".desktop"));
    assert.deepEqual(relaunched.read(a), state);
    assert.deepEqual(relaunched.read(b).drafts, { portfolio: "independent" });
    assert.throws(() =>
      store.save(a, { ...state, drafts: { portfolio: "wrong" } }),
    );
    assert.throws(() => store.save(b, state));
    assert.throws(() => store.save(a, { ...state, token: "x" }));
    assert.throws(() =>
      store.save(a, { ...state, drafts: { ideas: "x".repeat(100001) } }),
    );
    const files = fs.readdirSync(path.join(root, ".desktop/views"));
    assert.equal(files.length, 2);
    for (const f of files)
      assert.equal(
        fs.statSync(path.join(root, ".desktop/views", f)).mode & 0o777,
        0o600,
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("corrupt drafts fail visibly instead of silently overwriting; symlink reads denied", () => {
  const root = fixture();
  try {
    const store = new ViewStore(root, path.join(root, ".desktop"));
    store.save(a, emptyView());
    const file = path.join(
      root,
      ".desktop/views",
      storageIdentity(root, a) + ".json",
    );
    fs.writeFileSync(file, "{bad");
    assert.throws(() => store.read(a));
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(root, ".desktop"), file);
    assert.throws(() => store.read(a));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("canonical root/scope identity, layout deduplication, atomic persistence and display clamping", () => {
  const root = fixture(),
    other = fixture();
  try {
    const alias = path.join(other, "alias");
    fs.symlinkSync(root, alias);
    assert.equal(storageIdentity(root, a), storageIdentity(alias, a));
    assert.notEqual(storageIdentity(root, a), storageIdentity(root, b));
    assert.notEqual(storageIdentity(root, a), storageIdentity(other, a));
    const bounds = { x: 90000, y: 90000, width: 1400, height: 900 };
    const file = path.join(root, ".desktop/windows.json");
    saveWindowState(file, [
      { scope: a, bounds, maximized: true },
      { scope: a, bounds, maximized: false },
      { scope: b, bounds, maximized: false },
    ]);
    assert.equal(readWindowState(file).length, 2);
    assert.equal(readWindowState(file)[0].maximized, true);
    assert.deepEqual(
      clampBounds(bounds, [{ x: 0, y: 0, width: 1280, height: 800 }]),
      { x: 0, y: 0, width: 1280, height: 800 },
    );
    fs.writeFileSync(file, "{}");
    assert.deepEqual(readWindowState(file), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
test("protected legacy, Projects, global Pi, package and ancestor roots are rejected without creation", () => {
  const root = fixture();
  try {
    const assets = path.join(root, "package/dist");
    fs.mkdirSync(assets, { recursive: true });
    for (const selected of [
      "relative",
      "/",
      os.homedir(),
      path.join(os.homedir(), "herdr-lab/new-test-must-not-exist"),
      path.join(os.homedir(), "Projects/new-test-must-not-exist"),
      path.join(os.homedir(), ".pi/new-test-must-not-exist"),
      path.join(root, "package/data"),
      root,
    ])
      assert.throws(() => validateDesktopRoot(selected, assets));
    const allowed = path.join(root, "new-data");
    assert.equal(validateDesktopRoot(allowed, assets).real, allowed);
    assert.equal(fs.existsSync(allowed), false);
    assert.throws(() => desktopConfig(["--lab-root"], assets, {}));
    assert.throws(() =>
      desktopConfig(["--lab-root", allowed], assets, {
        LAB_PI_NODE: "/not-installed/node",
      }),
    );
    assert.equal(fs.existsSync(allowed), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("explicit invalid Node/Pi fail without fallback; incompatible fake Node probe rejected", () => {
  const root = fixture();
  try {
    assert.throws(() =>
      systemRuntime({ LAB_PI_NODE: "", PATH: process.env.PATH }),
    );
    assert.throws(() =>
      systemRuntime({ LAB_PI_NODE: process.execPath, LAB_PI_EXECUTABLE: "" }),
    );
    for (const version of ["22.18.9", "21.9.0", "22.bad.0"]) {
      const node = path.join(root, "node");
      fs.writeFileSync(
        node,
        `#!/bin/sh\nprintf '%s' '{"node":"${version}","electron":null}'\n`,
        { mode: 0o700 },
      );
      assert.throws(
        () =>
          systemRuntime({ LAB_PI_NODE: node, LAB_PI_EXECUTABLE: "/not-used" }),
        /22.19/,
      );
    }
    assert.deepEqual(
      cleanEnvironment({
        NODE_OPTIONS: "bad",
        NODE_PATH: "bad",
        ELECTRON_RUN_AS_NODE: "1",
        SAFE: "yes",
      }),
      { SAFE: "yes" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("private diagnostics contain bounded event codes only and reject credential strings", () => {
  const root = fixture();
  try {
    const log = diagnostics(path.join(root, "diagnostics"));
    log("app-ready");
    log("token=" + "a".repeat(64));
    for (let i = 0; i < 200; i++) log("renderer-loaded");
    const file = path.join(root, "diagnostics/startup.jsonl"),
      text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("token"), false);
    assert.ok(text.split("\n").length <= 129);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("all seven maximum-length escaped drafts remain readable after an acknowledged save", () => {
  const root = fixture();
  try {
    const store = new ViewStore(root, path.join(root, ".desktop"));
    const drafts = Object.fromEntries(
      [
        "ideas",
        "literature",
        "research",
        "data",
        "code",
        "backtests",
        "results",
      ].map((key) => [key, "\u0000".repeat(100000)]),
    );
    const value = { ...emptyView(), drafts };
    store.save(a, value);
    assert.ok(
      fs.statSync(
        path.join(root, ".desktop/views", storageIdentity(root, a) + ".json"),
      ).size >
        4 * 1024 * 1024,
    );
    assert.deepEqual(
      new ViewStore(root, path.join(root, ".desktop")).read(a),
      value,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
