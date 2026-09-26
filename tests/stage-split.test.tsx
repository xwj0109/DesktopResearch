import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { StageLayout } from "../src/workbench/StageLayout";
import { stageLayouts, paneLabels, type LayoutState } from "../src/workbench/layouts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("a tile can show a second of its panes below the current one; the choice is saved with the stage", async () => {
  const layout = stageLayouts.research;
  let state: LayoutState = {};
  const Host = () => {
    const [s, setS] = React.useState<LayoutState>({});
    return (
      <StageLayout
        layout={layout}
        defaults={layout}
        state={s}
        onState={(next) => ((state = next), setS(next))}
        active="c"
        onActive={() => {}}
        onSwap={() => {}}
        render={(kind) => <div data-pane-body={kind}>{kind}</div>}
        tileLabel={(kind) => paneLabels[kind]}
      />
    );
  };
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<Host />); });
  const shown = () => r.root.findAll((n) => n.props["data-pane-body"] && !n.parent?.props.hidden).map((n) => n.props["data-pane-body"]);
  assert.deepEqual(shown(), ["pi", "runs"]);
  await act(async () => r.root.findByProps({ "aria-label": "Show another pane below" }).props.onClick());
  assert.deepEqual(shown(), ["pi", "runs", "documents"]);
  assert.deepEqual(state.below, { c: "documents" });
  // Choose what goes below; the current tab is never offered twice.
  const select = r.root.findByProps({ "aria-label": "Pane below" });
  assert.equal(select.findAllByType("option").some((o) => o.props.value === "runs"), false);
  await act(async () => select.props.onChange({ target: { value: "changes" } }));
  assert.deepEqual(shown(), ["pi", "runs", "changes"]);
  await act(async () => r.root.findByProps({ "aria-label": "Close Changes below" }).props.onClick());
  assert.deepEqual(shown(), ["pi", "runs"]);
  assert.equal("below" in state && state.below !== undefined, false, "closing leaves nothing behind for the saved view");
});
