import { composeReviewMessage, splitReviewMessage, type ReviewAttachment } from "../src/review-attachment";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { RuntimeTerminal } from "../src/workbench/RuntimeTerminal";
import { NativeConversation } from "../src/workbench/NativeConversation";
import { NativeClient } from "../src/native-client";
import type { DesktopBridge } from "../desktop/contracts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const A = "a".repeat(64),
  B = "b".repeat(64),
  id = "12345678-1234-1234-1234-123456789abc";
const flush = () => new Promise<void>((r) => setImmediate(r));
async function fixture(t: any, connected = true, initialDraft = "unsent research notes") {
  const ticks: Function[] = [];
  (globalThis as any).window = {
    setInterval: (fn: Function) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
  };
  let state: any = {
    version: 1,
    logicalSessionId: id,
    connected,
    generation: connected ? 1 : 0,
    through: 0,
    context: connected ? A : null,
    events: [],
    models: [],
    commands: [],
    resyncRequired: false,
    truncated: false,
    ui: {
      editor: "",
      state: {},
      pending: [],
      surfaces: [],
      viewDetached: false,
    },
    runtimeState: {
      ready: connected,
      isStreaming: false,
      availableThinkingLevels: [],
    },
  };
  let history: any = {
      mode: connected ? "active-branch" : "offline-append-log",
      context: state.context,
      entries: [],
      cursor: 0,
      next: null,
      truncated: false,
    },
    closing = false;
  const ops: any[] = [],
    draftChanges: string[] = [];
  let actionHook: (value: any) => Promise<any> = async () => ({
      status: "acknowledged",
    }),
    pageHook: (path: string) => Promise<any> = async () => history;
  const bridge = {
    lab: async (req: any) => {
      let data: any;
      if (req.method === "POST") {
        const value = JSON.parse(new TextDecoder().decode(req.body));
        ops.push(value.operation);
        data = await actionHook(value);
      } else if (req.path.includes("/history?"))
        data = await pageHook(req.path);
      else data = state;
      return {
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify(data)),
      };
    },
    readRequests: async () => [],
  } as unknown as DesktopBridge;
  const client = new NativeClient(
    bridge,
    {
      version: 1,
      desktop: true,
      viewId: "fixture",
      scope: { kind: "strategy", id },
    },
    async () => {
      if (closing) throw new Error("View is closing");
    },
  );
  let rendered: ReturnType<typeof create>;
  await act(async () => {
    rendered = create(
      <NativeConversation
        client={client}
        stage="ideas"
        draft={initialDraft}
        onDraft={(v) => draftChanges.push(v)}
      />,
    );
    await flush();
  });
  t.after(async () => {
    await act(() => rendered.unmount());
  });
  return {
    get root() {
      return rendered.root;
    },
    client,
    ops,
    draftChanges,
    ticks,
    setState: (v: any) => {
      state = v;
    },
    get state() {
      return state;
    },
    setHistory: (v: any) => {
      history = v;
    },
    get history() {
      return history;
    },
    actions: (fn: typeof actionHook) => {
      actionHook = fn;
    },
    pages: (fn: typeof pageHook) => {
      pageHook = fn;
    },
    close: () => {
      closing = true;
    },
    text: () => JSON.stringify(rendered.toJSON()),
    button: (label: string) =>
      rendered.root
        .findAllByType("button")
        .find((b) => b.children.join("") === label)!,
  };
}
test("Connect continues polling and bootstrap approval is answerable before its ACK", async (t) => {
  const x = await fixture(t, false);
  let finish!: () => void;
  x.actions(async (value) => {
    if (value.operation.type === "connect")
      await new Promise<void>((r) => (finish = r));
    else if (value.operation.type === "ui_response") {
      x.setState({
        ...x.state,
        ui: { ...x.state.ui, pending: [] },
        runtimeState: { ...x.state.runtimeState, ready: true },
      });
      finish();
    }
    return { status: "acknowledged" };
  });
  await act(async () => {
    x.button("Connect").props.onClick();
    await flush();
  });
  x.setState({
    ...x.state,
    connected: true,
    generation: 1,
    ui: {
      ...x.state.ui,
      pending: [{ id, method: "confirm", title: "Startup approval" }],
    },
  });
  await act(async () => {
    await x.ticks[0]();
    await flush();
  });
  assert.equal(x.button("Confirm").props.disabled, false);
  await act(async () => {
    x.button("Confirm").props.onClick();
    await flush();
  });
  assert.deepEqual(
    x.ops.map((o) => o.type),
    ["connect", "ui_response"],
  );
});
test("terminal keys keep order across a refused Refresh and never overwrite the composer", async (t) => {
  const x = await fixture(t);
  x.setState({
    ...x.state,
    ui: {
      ...x.state.ui,
      surfaces: [
        { surfaceId: "dialog", kind: "custom", columns: 80, rows: 24 },
      ],
    },
  });
  await act(async () => {
    await x.ticks[0]();
    await flush();
  });
  let finish!: () => void;
  x.actions(async (v) => {
    if (v.operation.data === "a") await new Promise<void>((r) => (finish = r));
    return { status: "acknowledged" };
  });
  const key = (s: string) =>
    x.root
      .findByType(RuntimeTerminal)
      .props.input(s);
  await act(async () => {
    key("a");
    key("b");
    await flush();
  });
  assert.deepEqual(
    x.ops.map((o) => o.data),
    ["a"],
  );
  await act(async () => {
    x.button("Refresh").props.onClick();
    key("c");
    await flush();
  });
  assert.deepEqual(
    x.ops.map((o) => o.data),
    ["a"],
  );
  await act(async () => {
    finish();
    await x.client.drain();
    await flush();
  });
  assert.deepEqual(
    x.ops.map((o) => o.data),
    ["a", "b", "c"],
  );
  assert.deepEqual(x.draftChanges, []);
});
test("a queued key rejected during close leaves a failure barrier instead of silently closing", async (t) => {
  const x = await fixture(t);
  x.setState({
    ...x.state,
    ui: {
      ...x.state.ui,
      surfaces: [
        { surfaceId: "editor", kind: "editor", columns: 80, rows: 24 },
      ],
    },
  });
  await act(async () => {
    await x.ticks[0]();
    await flush();
  });
  let finish!: () => void;
  x.actions(async () => {
    await new Promise<void>((r) => (finish = r));
    return { status: "acknowledged" };
  });
  const key = (s: string) =>
    x.root
      .findByType(RuntimeTerminal)
      .props.input(s);
  await act(async () => {
    key("a");
    key("b");
    await flush();
  });
  x.close();
  await act(async () => {
    const draining = assert.rejects(
      x.client.drain(),
      /Unacknowledged terminal input/,
    );
    finish();
    await draining;
    await flush();
  });
  assert.deepEqual(
    x.ops.map((o) => o.data),
    ["a"],
  );
  assert.match(x.text(), /Terminal input paused/);
});
test("delayed history pagination cannot append an old branch after refresh", async (t) => {
  const x = await fixture(t);
  x.setHistory({
    ...x.history,
    entries: [
      {
        id: "a",
        type: "message",
        message: { role: "user", content: "branch A" },
      },
    ],
    next: 50,
  });
  await act(async () => {
    x.button("Refresh").props.onClick();
    await flush();
  });
  let finish!: (value: any) => void;
  x.pages(async (p) =>
    p.includes("cursor=50") ? new Promise((r) => (finish = r)) : x.history,
  );
  await act(async () => {
    x.button("Load more canonical entries").props.onClick();
    await flush();
  });
  x.setState({ ...x.state, context: B });
  x.setHistory({
    ...x.history,
    context: B,
    entries: [
      {
        id: "b",
        type: "message",
        message: { role: "user", content: "branch B" },
      },
    ],
    next: null,
  });
  await act(async () => {
    x.button("Refresh").props.onClick();
    await flush();
  });
  await act(async () => {
    finish({
      mode: "active-branch",
      context: A,
      entries: [
        {
          id: "old",
          type: "message",
          message: { role: "user", content: "old branch next page" },
        },
      ],
      cursor: 50,
      next: null,
      truncated: false,
    });
    await flush();
  });
  assert.match(x.text(), /branch B/);
  assert.doesNotMatch(x.text(), /old branch next page/);
});


test("review attachment stays out of the text field, survives editing, and sends full evidence", async t => {
  const attachment: ReviewAttachment = { kind: "research-review", id: "10000000-0000-4000-8000-000000000001", hash: A, title: "Compare the assumptions", passages: 1, papers: 1, content: "Exact evidence: a unique passage on page 6." };
  const draft = composeReviewMessage("", [attachment]);
  const x = await fixture(t, true, draft);
  const input = x.root.findByProps({ id: "live-draft" });
  assert.equal(input.props.value, "");
  const card = x.root.findByProps({ className: "review-attachment" });
  assert.equal(card.findByType("details").props.open, undefined, "attachment is collapsed");
  await act(async () => input.props.onChange({ target: { value: "My additional question" } }));
  const edited = splitReviewMessage(x.draftChanges.at(-1)!);
  assert.equal(edited.text, "My additional question");
  assert.deepEqual(edited.attachments, [attachment]);
  await act(async () => x.root.findByProps({ "aria-label": "Remove review attachment: Compare the assumptions" }).props.onClick());
  assert.equal(x.draftChanges.at(-1), "");
  // Fixture retains the supplied draft until acknowledgement, like a restored view.
  const send = x.root.findAllByType("button").find(b => b.props.className === "btn primary send")!;
  assert.equal(send.props.disabled, false, "an attachment-only message can be sent");
  x.actions(async () => { throw new Error("Send failed"); });
  x.draftChanges.length = 0;
  await act(async () => { send.props.onClick(); await flush(); });
  assert.equal(x.draftChanges.length, 0, "failure does not remove the attachment");
  x.actions(async () => ({ status: "acknowledged" }));
  await act(async () => { send.props.onClick(); await flush(); });
  assert.equal(x.ops.at(-1).message, draft);
  assert.equal(splitReviewMessage(x.ops.at(-1).message).attachments[0].content, attachment.content);
  assert.equal(x.draftChanges.at(-1), "", "acknowledgement clears the entire submitted draft");
});
