import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { Notice } from "../src/workbench/Notice";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("notification replacement cancels old expiry, and unmount cancels pending dismissal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dismissed: string[] = [];
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <Notice message="Saved" onDismiss={() => dismissed.push("saved")} />,
    );
  });
  await act(async () => t.mock.timers.tick(5000));
  await act(async () =>
    renderer.update(
      <Notice message="Deleted" onDismiss={() => dismissed.push("deleted")} />,
    ),
  );
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(
    dismissed.length,
    0,
    "older expiry cannot clear the replacement message",
  );
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(dismissed.join(","), "deleted");
  await act(async () =>
    renderer.update(
      <Notice
        message="Another action"
        onDismiss={() => dismissed.push("unmounted")}
      />,
    ),
  );
  await act(async () => renderer.unmount());
  await act(async () => t.mock.timers.tick(12000));
  assert.equal(dismissed.join(","), "deleted");
});

test("hover pauses expiry and both the bar and close button dismiss immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0,
    renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <Notice message="Review attached" onDismiss={() => count++} />,
    );
  });
  t.after(() => act(async () => renderer.unmount()));
  const bar = renderer!.root.findByProps({ role: "status" });
  await act(async () => bar.props.onMouseEnter());
  await act(async () => t.mock.timers.tick(20000));
  assert.equal(count, 0);
  await act(async () => bar.props.onMouseLeave());
  await act(async () => t.mock.timers.tick(6000));
  assert.equal(count, 1);
  await act(async () => bar.props.onClick());
  assert.equal(count, 2);
  let stopped = false;
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Dismiss notification" })
      .props.onClick({
        stopPropagation() {
          stopped = true;
        },
      }),
  );
  assert.equal(count, 3);
  assert.equal(stopped, true);
});

test("errors allow more reading time and keyboard focus pauses their expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0,
    renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <Notice
        message="Review is cited by an idea"
        error
        onDismiss={() => count++}
      />,
    );
  });
  t.after(() => act(async () => renderer.unmount()));
  const bar = renderer!.root.findByProps({ role: "alert" });
  await act(async () => t.mock.timers.tick(6000));
  assert.equal(count, 0);
  await act(async () => bar.props.onFocusCapture());
  await act(async () => t.mock.timers.tick(20000));
  assert.equal(count, 0);
  await act(async () =>
    bar.props.onBlurCapture({
      currentTarget: { contains: () => false },
      relatedTarget: null,
    }),
  );
  await act(async () => t.mock.timers.tick(12000));
  assert.equal(count, 1);
});
