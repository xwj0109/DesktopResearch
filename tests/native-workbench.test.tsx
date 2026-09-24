import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { Workbench } from "../src/workbench/Workbench";
import { disconnectedWorkspace } from "../src/workbench/native-model";
import { ViewWriter } from "../src/native";
import { emptyView, type ViewState } from "../desktop/contracts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window = {
  innerWidth: 1440,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
};
(globalThis as any).document = {
  activeElement: null,
  getElementById() {
    return null;
  },
};
const id = "12345678-1234-1234-1234-123456789abc";
test("actual native strategy keeps three-pane composition without synthetic conversations or activity", async (t) => {
  let rendered: ReturnType<typeof create>;
  let saved = emptyView();
  let launcher = 0;
  await act(() => {
    rendered = create(
      <Workbench
        data={disconnectedWorkspace(id, "My actual research")}
        native={{
          kind: "strategy",
          initial: {
            ...emptyView(),
            drafts: { literature: "Restored paper draft" },
          },
          onChange: (value) => {
            saved = value;
          },
          onLauncher: () => {
            launcher++;
          },
          saveStatus: "Saved locally",
        }}
      />,
    );
  });
  t.after(() => act(() => rendered!.unmount()));
  const root = rendered!.root;
  assert.equal(root.findByType("textarea").props.value, "Restored paper draft");
  assert.equal(root.findAllByProps({ role: "separator" }).length, 1);
  const text = JSON.stringify(rendered!.toJSON());
  for (const absent of [
    "Sample prompt",
    "Prewritten example",
    "Authored fixture",
    "Reading momentum critically",
    "ILLUSTRATIVE CONVERSATION",
    "Synthetic content",
  ])
    assert.equal(text.includes(absent), false);
  assert.ok(text.includes("No conversation or activity is loaded"));
  assert.ok(text.includes("My actual research"));
  const stageNav = root.findByProps({ "aria-label": "Research stages" });
  const stages = stageNav
    .findAllByType("button")
    .filter((b) => typeof b.props["data-stage"] === "string");
  assert.equal(stages.length, 7);
  await act(() => stages[0].props.onClick());
  assert.equal(root.findByType("textarea").props.value, "");
  await act(() =>
    root
      .findByType("textarea")
      .props.onChange({ target: { value: "Independent idea" } }),
  );
  assert.equal(saved.drafts.ideas, "Independent idea");
  assert.equal(saved.drafts.literature, "Restored paper draft");
  const label = (node: any): string =>
    typeof node === "string" ? node : (node.children ?? []).map(label).join("");
  const launch = root
    .findAllByType("button")
    .find((b) => label(b).includes("Workspace launcher"))!;
  await act(() => launch.props.onClick());
  assert.equal(launcher, 1);
  assert.equal(
    root.findByProps({ "aria-label": "Send unavailable: no connected runtime" })
      .props.disabled,
    true,
  );
  assert.equal(saved.theme, undefined, "theme is app-wide, not per window");
  // Layouts persist per stage in the saved view; Design & Code is three panes.
  const columns = () => root.findByProps({ "aria-label": "Resize columns" });
  await act(() => columns().props.onKeyDown({ key: "ArrowLeft", preventDefault() {} }));
  assert.equal(saved.layouts?.ideas?.split, 0.44);
  await act(() => stages[4].props.onClick());
  const panes = root
    .findAll((n) => n.type === "section" && n.props["data-slot"])
    .map((n) => [n.props["data-slot"], n.props["aria-label"], n.props.hidden]);
  assert.deepEqual(panes, [
    ["a", "Pi", false],
    ["b", "Graph", false],
    ["c", "Code", false],
  ]);
  assert.ok(JSON.stringify(rendered!.toJSON()).includes("No graph loaded"));
});
test("actual portfolio cannot navigate into strategy stages or display fixture evidence", async (t) => {
  let rendered: ReturnType<typeof create>;
  let saved: ViewState | undefined;
  await act(() => {
    rendered = create(
      <Workbench
        data={disconnectedWorkspace(id, "Independent portfolio")}
        native={{
          kind: "portfolio",
          initial: { ...emptyView(), drafts: { portfolio: "Portfolio draft" } },
          onChange: (value) => {
            saved = value;
          },
          onLauncher() {},
          saveStatus: "Saved locally",
        }}
      />,
    );
  });
  t.after(() => act(() => rendered!.unmount()));
  const root = rendered!.root;
  assert.equal(
    root.findAllByProps({ "aria-label": "Research stages" }).length,
    0,
  );
  assert.equal(root.findByType("textarea").props.value, "Portfolio draft");
  assert.deepEqual(saved!.drafts, { portfolio: "Portfolio draft" });
  assert.equal(
    JSON.stringify(rendered!.toJSON()).includes("Frozen source example"),
    false,
  );
});
test("view write queue orders drafts and prepare-close waits for last save or rejects failed flush", async () => {
  let release: (() => void) | undefined;
  const seen: string[] = [];
  const writer = new ViewWriter({
    saveView: async (state) => {
      seen.push(state.drafts.ideas!);
      if (seen.length === 1)
        await new Promise<void>((r) => {
          release = r;
        });
    },
  });
  const first = writer.save({ ...emptyView(), drafts: { ideas: "first" } });
  const second = writer.save({ ...emptyView(), drafts: { ideas: "latest" } });
  let flushed = false;
  const flushing = writer.flush().then(() => {
    flushed = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false);
  assert.deepEqual(seen, ["first"]);
  release!();
  await Promise.all([first, second, flushing]);
  assert.deepEqual(seen, ["first", "latest"]);
  assert.equal(flushed, true);
  const failing = new ViewWriter({
    saveView: async () => {
      throw new Error("storage failed");
    },
  });
  await assert.rejects(failing.save(emptyView()));
  await assert.rejects(failing.flush());
});

test("flush joins saves appended after it began; prepare captures synchronous latest snapshot and freezes until cancel", async () => {
  const releases: Array<() => void> = [],
    seen: string[] = [];
  const writer = new ViewWriter({
    saveView: async (state) => {
      seen.push(state.drafts.ideas!);
      await new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  void writer.save({ ...emptyView(), drafts: { ideas: "first" } });
  let finished = false;
  const flush = writer.flush().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  void writer.save({ ...emptyView(), drafts: { ideas: "appended" } });
  releases.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(seen, ["first", "appended"]);
  releases.shift()!();
  await flush;
  writer.setSnapshot(() => ({
    ...emptyView(),
    drafts: { ideas: "latest synchronous editor snapshot" },
  }));
  const preparing = writer.prepare();
  assert.equal(writer.isPreparing(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.at(-1), "latest synchronous editor snapshot");
  void writer.save({ ...emptyView(), drafts: { ideas: "blocked edit" } });
  releases.shift()!();
  await preparing;
  assert.equal(seen.includes("blocked edit"), false);
  assert.equal(writer.isPreparing(), true);
  writer.cancel();
  assert.equal(writer.isPreparing(), false);
});

test("workspace follows the app-wide theme and routes changes to the shell", async (t) => {
  let rendered: ReturnType<typeof create>;
  const chosen: string[] = [];
  const view = (theme: "gruvbox" | "nord") => (
    <Workbench
      data={disconnectedWorkspace(id, "Themed")}
      native={{
        kind: "strategy",
        initial: { ...emptyView(), theme: "catppuccin" },
        onChange() {},
        onLauncher() {},
        saveStatus: "Saved locally",
        theme,
        onTheme: (next) => {
          chosen.push(next);
        },
      }}
    />
  );
  await act(() => {
    rendered = create(view("gruvbox"));
  });
  t.after(() => act(() => rendered!.unmount()));
  const shell = () => rendered!.root.findAll((n) => n.type === "div" && n.props.className === "wb")[0];
  assert.equal(shell().props["data-theme"], "gruvbox", "shell theme wins over legacy per-view value");
  await act(() => rendered!.root.findByProps({ "aria-label": "Change theme" }).props.onClick());
  await act(() =>
    rendered!.root.findByProps({ "aria-label": "Search commands" }).props.onChange({ target: { value: "theme · nord" } }),
  );
  await act(() => rendered!.root.findAllByProps({ role: "option" })[0].props.onClick());
  assert.deepEqual(chosen, ["nord"]);
  assert.equal(shell().props["data-theme"], "gruvbox", "no local divergence until the app broadcasts");
  await act(() => rendered!.update(view("nord")));
  assert.equal(shell().props["data-theme"], "nord");
});
