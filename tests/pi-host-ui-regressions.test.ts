import { test } from "node:test";
import assert from "node:assert/strict";
const hostPath = "../server/pi-host-ui.mjs", fakePath = "./fake-installed-pi.mjs";
const { createHostUI } = await import(hostPath), fake = await import(fakePath);
function setup(options: Record<string, unknown> = {}) {
  const events: any[] = [];
  const bridge = createHostUI({ tuiModule: fake, themeModule: fake, keybindings: new fake.KeybindingsManager(), footerProvider: new fake.FooterDataProvider(), emit: (event: any) => events.push(event), ...options });
  return { bridge, events };
}
// Faithful paste-marker seam: getText/onChange are NOT the expanded user draft.
class PasteEditor {
  text = ""; expanded = ""; onChange?: (text: string) => void;
  render() { return [this.text]; }
  getText() { return this.text; }
  getExpandedText() { return this.expanded; }
  setText(text: string) { this.text = this.expanded = text; this.onChange?.(this.text); }
  handleInput(data: string) { this.expanded += data.replace("\x1b[200~", "").replace("\x1b[201~", ""); this.text = "[paste #1 1200 chars]"; this.onChange?.(this.text); }
}
test("expanded 1200-character paste survives editor replacement, removal and view detach", () => {
  const { bridge, events } = setup(), text = "p".repeat(1200);
  bridge.ui.setEditorComponent(() => new PasteEditor());
  bridge.terminal({ type: "terminal_input", surfaceId: "editor", data: "\x1b[200~" + text + "\x1b[201~" });
  assert.equal(bridge.snapshot().editor, text);
  assert.equal(events.filter(e => e.type === "ui_state" && e.key === "editor").at(-1).value, text);
  let replacement: PasteEditor;
  bridge.ui.setEditorComponent(() => replacement = new PasteEditor());
  assert.equal(replacement!.getExpandedText(), text);
  bridge.ui.setEditorComponent(undefined); assert.equal(bridge.snapshot().editor, text);
  bridge.ui.setEditorComponent(() => new PasteEditor()); bridge.detachView();
  assert.equal(bridge.snapshot().editor, text); assert.deepEqual(bridge.snapshot().surfaces, []);
  bridge.detach();
});

test("read-only UI resync publishes current 150x45 surface descriptor before frames and preserves approval", async () => {
  const { bridge, events } = setup();
  bridge.ui.setHeader(() => ({ render: () => ["header"] }));
  bridge.terminal({ type: "terminal_resize", surfaceId: "header", columns: 150, rows: 45 });
  const pending = bridge.ui.confirm("Unresolved", "No implicit answer"), before = bridge.snapshot();
  assert.deepEqual(before.surfaces, [{ surfaceId: "header", kind: "header", columns: 150, rows: 45 }]);
  const start = events.length; bridge.attachView();
  assert.deepEqual(bridge.snapshot().pending, before.pending);
  const replay = events.slice(start); assert.equal(replay[0].type, "terminal_open");
  assert.equal(replay[0].columns, 150); assert.equal(replay[0].rows, 45);
  assert.ok(replay.some(e => e.type === "terminal_frame"));
  bridge.respond({ requestId: before.pending[0].id, cancelled: true }); assert.equal(await pending, false); bridge.detach();
});

test("historical renderer surfaces are bounded independently and leave room for interactive custom UI", async () => {
  const { bridge } = setup();
  for (let i = 0; i < 200; i++) bridge.render("history:" + i, "tool", () => ({ render: () => ["tool " + i] }));
  assert.equal(bridge.snapshot().surfaces.length, 48);
  const custom = bridge.ui.custom(() => ({ render: () => ["Explicit approval only"] }));
  assert.ok(bridge.snapshot().surfaces.some((surface: any) => surface.kind === "custom"));
  const cancelled = assert.rejects(custom, /cancelled/); bridge.cancel(); await cancelled; bridge.detach();
});

test("expansion rebuilds saved renderer factories and late old-factory rejection cannot dispose replacement surface", async () => {
  const { bridge, events } = setup(); let calls = 0;
  bridge.render("tool:one", "tool", () => { const text = "expanded=" + bridge.ui.getToolsExpanded(); calls++; return { render: () => [text] }; });
  bridge.ui.setToolsExpanded(true); assert.equal(calls, 2);
  assert.ok(events.some(e => e.type === "terminal_frame" && e.data.includes("expanded=true")));
  let rejectOld!: (error: Error) => void;
  bridge.ui.setHeader(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  bridge.ui.setHeader(() => ({ render: () => ["replacement"] }));
  rejectOld(new Error("late obsolete factory rejection")); await new Promise(resolve => setImmediate(resolve));
  assert.ok(bridge.snapshot().surfaces.some((surface: any) => surface.surfaceId === "header"));
  bridge.detach();
});

test("renderer invalidation clears caches when the factory reuses the same component", () => {
  const { bridge, events } = setup();
  let text = "before", cached: string[] | undefined, invalidations = 0;
  const component = {
    render: () => cached ??= [text],
    invalidate: () => { cached = undefined; invalidations++; },
  };
  bridge.render("tool:cached", "tool", () => component);
  text = "after async update";
  bridge.rerender("tool:cached");
  assert.equal(invalidations, 1);
  assert.match(events.filter(event => event.type === "terminal_frame").at(-1).data, /after async update/);
  text = "after expansion";
  bridge.ui.setToolsExpanded(true);
  assert.equal(invalidations, 2);
  assert.match(events.filter(event => event.type === "terminal_frame").at(-1).data, /after expansion/);
  bridge.detach();
});

test("retired UI permits inert shutdown removals but never new components or draft mutations", () => {
  const { bridge, events } = setup(), ui = bridge.ui;
  ui.setHeader(() => ({ render: () => ["header"] }));
  bridge.detach();
  const count = events.length;
  ui.setStatus("task", undefined);
  ui.setWidget("jobs", undefined);
  ui.setWidget("jobs", []);
  ui.setHeader(undefined);
  ui.setFooter(undefined);
  ui.setEditorComponent(undefined);
  ui.setWorkingVisible(true);
  assert.equal(events.length, count, "Cleanup must be inert, not mutate or emit on a replacement UI");
  let called = false;
  assert.throws(() => ui.setWidget("stale", () => { called = true; return { render: () => ["forbidden"] }; }), /invalidated/);
  assert.throws(() => ui.setStatus("task", "stale update"), /invalidated/);
  assert.throws(() => ui.setWorkingVisible(false), /invalidated/);
  assert.throws(() => ui.setEditorText("discard current draft"), /invalidated/);
  assert.equal(called, false);
  assert.deepEqual(bridge.snapshot().surfaces, []);
});

test("autocomplete wrappers register before an editor, compose once, and attach to setter-only replacement editors", async () => {
  let version = "base";
  const { bridge } = setup({ createAutocompleteProvider: () => ({
    getSuggestions: async () => ({ prefix: "/", items: [{ value: version }] }),
    applyCompletion: () => null,
  }) });
  const wrap = (suffix: string) => (base: any) => ({
    getSuggestions: async (...args: any[]) => { const result = await base.getSuggestions(...args); return { ...result, items: result.items.map((item: any) => ({ value: item.value + suffix })) }; },
    applyCompletion: (...args: any[]) => base.applyCompletion(...args),
  });
  bridge.ui.addAutocompleteProvider(wrap("-one"));
  const providers: any[] = [];
  const editor = () => ({ render: () => ["editor"], getText: () => "", setText() {}, setAutocompleteProvider: (provider: any) => providers.push(provider) });
  bridge.ui.setEditorComponent(editor); // Deliberately no getAutocompleteProvider.
  assert.equal((await providers.at(-1).getSuggestions()).items[0].value, "base-one");
  bridge.ui.addAutocompleteProvider(wrap("-two"));
  assert.equal((await providers.at(-1).getSuggestions()).items[0].value, "base-one-two");
  bridge.ui.setEditorComponent(editor);
  assert.equal((await providers.at(-1).getSuggestions()).items[0].value, "base-one-two");
  version = "updated";
  bridge.refreshAutocomplete();
  assert.equal((await providers.at(-1).getSuggestions()).items[0].value, "updated-one-two");
  bridge.detach();
});

test("retired editor callbacks cannot overwrite or submit the replacement editor's draft", () => {
  const { bridge, events } = setup();
  const previous: any = { render: () => ["previous"], getText: () => "previous", setText() {} };
  const replacement: any = { render: () => ["replacement"], getText: () => "replacement", setText() {} };
  bridge.ui.setEditorComponent(() => previous);
  bridge.ui.setEditorComponent(() => replacement);
  const count = events.length;
  previous.onChange("late completion");
  previous.onSubmit("late submit");
  assert.equal(events.length, count);
  assert.equal(bridge.snapshot().editor, "replacement");
  bridge.detach();
  const afterDetach = events.length;
  replacement.onChange("late after detach");
  replacement.onSubmit("late after detach");
  assert.equal(events.length, afterDetach);
});
