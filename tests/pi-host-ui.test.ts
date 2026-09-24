import { test } from "node:test";
import assert from "node:assert/strict";
const uiModulePath = "../server/pi-host-ui.mjs",
  fixtureModulePath = "./fake-installed-pi.mjs",
  resourcesModulePath = "../server/pi-host-resources.mjs";
const { createHostUI, VirtualTerminal } = await import(uiModulePath);
const fixture = await import(fixtureModulePath);
function setup() {
  const events: any[] = [];
  const bridge = createHostUI({
    tuiModule: fixture,
    themeModule: fixture,
    keybindings: new fixture.KeybindingsManager(),
    footerProvider: new fixture.FooterDataProvider(),
    emit: (e: any) => events.push(e),
  });
  return { bridge, events };
}
test("native dialog timeouts and AbortSignals resolve fail-closed without approval", async () => {
  const { bridge, events } = setup();
  assert.equal(
    await bridge.ui.confirm("Approval", "Never default yes", { timeout: 5 }),
    false,
  );
  assert.equal(await bridge.ui.input("Input", "", { timeout: 5 }), undefined);
  const controller = new AbortController();
  const pending = bridge.ui.select("Select", ["a"], {
    signal: controller.signal,
  });
  const id = events.at(-1).request.id;
  controller.abort();
  assert.equal(await pending, undefined);
  assert.throws(() => bridge.respond({ requestId: id, value: "a" }), /expired/);
  const count = events.length;
  assert.equal(
    await bridge.ui.confirm("Aborted", "", { signal: controller.signal }),
    false,
  );
  assert.equal(events.length, count);
  bridge.detach();
});
test("custom cancellation rejects instead of returning approval, async late factory disposed", async () => {
  const { bridge, events } = setup();
  let complete!: (value: unknown) => void,
    disposed = 0;
  const custom = bridge.ui.custom(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const rejection = assert.rejects(custom, /cancelled/);
  const surfaceId = events.find((e) => e.type === "terminal_open").surfaceId;
  bridge.terminal({ type: "terminal_cancel", surfaceId });
  await rejection;
  complete({
    render: () => ["late"],
    dispose: () => {
      disposed++;
    },
  });
  await Promise.resolve();
  assert.equal(disposed, 1);
  assert.equal(bridge.snapshot().surfaces.length, 0);
  bridge.detach();
});
test("synchronous custom result stays structured in host; focus, overlay input, resize and disposal work", async () => {
  const { bridge, events } = setup();
  let disposed = 0,
    handle: any;
  const token = { callback: () => 42 };
  const immediate = bridge.ui.custom(
    (_tui: any, _theme: any, _keys: any, done: any) => {
      done(token);
      return {
        render: () => ["instant"],
        dispose: () => {
          disposed++;
        },
      };
    },
  );
  assert.equal(await immediate, token);
  assert.equal(disposed, 1);
  assert.equal(JSON.stringify(events).includes("callback"), false);
  const pending = bridge.ui.custom(
    (_tui: any, _theme: any, _keys: any, done: any) => ({
      render: (width: number) => [String(width)],
      handleInput: (data: string) => done(data),
    }),
    {
      overlay: true,
      onHandle: (h: unknown) => {
        handle = h;
      },
    },
  );
  assert.equal(handle.isFocused(), true);
  const id = events.filter((e) => e.type === "terminal_open").at(-1).surfaceId;
  bridge.terminal({
    type: "terminal_resize",
    surfaceId: id,
    columns: 150,
    rows: 40,
  });
  bridge.terminal({ type: "terminal_input", surfaceId: id, data: "selected" });
  assert.equal(await pending, "selected");
  assert.ok(
    events.some((e) => e.type === "terminal_frame" && e.data === "150"),
  );
  bridge.detach();
});
test("raw input interception, string/factory widgets, editor paste and unsupported graphics are explicit", async () => {
  const { bridge, events } = setup();
  let handled = 0;
  bridge.ui.setEditorText("abc");
  bridge.ui.pasteToEditor("DEF");
  assert.equal(bridge.ui.getEditorText(), "abcDEF");
  bridge.ui.setWidget("text", ["visible"], { placement: "belowEditor" });
  assert.deepEqual(bridge.snapshot().state["widget:text"], {
    lines: ["visible"],
    placement: "belowEditor",
  });
  bridge.ui.onTerminalInput((data: string) =>
    data === "blocked" ? { consume: true } : { data: "rewritten" },
  );
  bridge.ui.setHeader(() => ({
    render: () => ["head"],
    handleInput: () => {
      handled++;
    },
  }));
  bridge.terminal({
    type: "terminal_input",
    surfaceId: "header",
    data: "blocked",
  });
  assert.equal(handled, 0);
  bridge.terminal({ type: "terminal_input", surfaceId: "header", data: "yes" });
  assert.equal(handled, 1);
  assert.throws(
    () => bridge.ui.addAutocompleteProvider(() => ({})),
    /requires a host base provider/,
  );
  const terminal = new VirtualTerminal(
    "graphics",
    (e: any) => events.push(e),
    bridge.unsupported,
  );
  assert.throws(() => terminal.write("\x1b_Ggraphic-data"), /graphics/);
  assert.ok(
    events.some((e) => e.type === "diagnostic" && e.code === "unsupported_ui"),
  );
  bridge.detach();
  assert.equal(bridge.snapshot().surfaces.length, 0);
});
test("read-through settings storage leaves disk unchanged and uses session-local overlays", async (t) => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { readThroughSettings } = await import(resourcesModulePath);
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, '{"defaultModel":"original"}');
  const storage = readThroughSettings(root, root);
  storage.withLock("global", () => '{"defaultModel":"local"}');
  storage.withLock("global", (value: string) => {
    assert.equal(JSON.parse(value).defaultModel, "local");
  });
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).defaultModel,
    "original",
  );
  fs.writeFileSync(
    file,
    '{"defaultModel":"changed","packages":["new-package"],"skills":["new-skill"],"extensions":["new-extension"],"terminal":{"showImages":true,"imageWidthCells":80}}',
  );
  storage.withLock("global", (value: string) => {
    const current = JSON.parse(value);
    assert.equal(current.defaultModel, "local");
    assert.deepEqual(current.packages, ["new-package"]);
    assert.deepEqual(current.skills, ["new-skill"]);
    assert.deepEqual(current.extensions, ["new-extension"]);
    return JSON.stringify({
      ...current,
      terminal: { ...current.terminal, showImages: false },
    });
  });
  fs.writeFileSync(
    file,
    '{"defaultModel":"changed","packages":["newer-package"],"terminal":{"showImages":true,"imageWidthCells":120}}',
  );
  storage.withLock("global", (value: string) => {
    const current = JSON.parse(value);
    assert.equal(current.defaultModel, "local");
    assert.deepEqual(current.packages, ["newer-package"]);
    assert.deepEqual(current.terminal, {
      showImages: false,
      imageWidthCells: 120,
    });
    assert.equal(current.skills, undefined);
  });
  readThroughSettings(root, root).withLock("global", (value: string) => {
    assert.equal(JSON.parse(value).defaultModel, "changed");
  });
});
test("invalidated UI callbacks are fenced; explicit view detach disposes without auto-recreating factories", async () => {
  const { bridge, events } = setup();
  let disposed = 0;
  bridge.ui.setWidget("live", () => ({
    render: () => ["widget"],
    dispose: () => {
      disposed++;
    },
  }));
  const waiting = bridge.ui.confirm("Pending", "Do not approve on disconnect");
  bridge.detachView();
  assert.equal(await waiting, false);
  assert.equal(disposed, 1);
  assert.equal(bridge.snapshot().viewDetached, true);
  assert.deepEqual(bridge.snapshot().surfaces, []);
  await assert.rejects(bridge.ui.input("Detached input"), /detached/);
  bridge.attachView();
  assert.deepEqual(bridge.snapshot().surfaces, []);
  bridge.detach();
  assert.throws(() => bridge.ui.setEditorText("late mutation"), /invalidated/);
  assert.ok(events.some((e) => e.code === "stale_ui_callback"));
});
