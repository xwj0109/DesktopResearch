import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { NativeClient } from "../src/native-client";
import { useConversation } from "../src/workbench/useConversation";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("active conversations connect once, preserve drafts, respect Stop and never retry a failed connection on remount", async t => {
  const ticks: Array<() => void> = [];
  (globalThis as any).window = { setInterval: (fn: () => void) => { ticks.push(fn); return 0; } };
  const connected = new Set<string>(), operations: any[] = [], drafts: string[] = [];
  let fail = false;
  const client = new NativeClient({
    lab: async (req: any) => {
      const stage = req.path.split("/conversations/")[1].split(/[/?]/)[0];
      let data: any;
      if (req.method === "POST") {
        const { operation } = JSON.parse(new TextDecoder().decode(req.body));
        operations.push({ stage, ...operation });
        if (fail) throw new Error("Session owned elsewhere");
        if (operation.type === "connect") connected.add(stage);
        if (operation.type === "stop") connected.delete(stage);
        data = { status: "acknowledged" };
      } else if (req.path.includes("/history")) data = { entries: [], context: null, next: null };
      else data = { connected: connected.has(stage), generation: 0, context: null, through: 0, events: [] };
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(data)), headers: {} };
    },
  } as any, { scope: { kind: "strategy", id: "fixture" } } as any, async () => {});
  let session: ReturnType<typeof useConversation>;
  function Harness({ stage, enabled = true, preparing = false }: { stage: string; enabled?: boolean; preparing?: boolean }) {
    session = useConversation({ client, stage, autoConnect: enabled, preparing, draft: "keep this draft", onDraft: value => drafts.push(value) });
    return null;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Harness key="ideas" stage="ideas" />); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  assert.deepEqual(operations, [{ stage: "ideas", type: "connect" }]);
  assert.deepEqual(drafts, []);
  await act(async () => { await session!.act({ type: "stop" }); });
  await act(async () => { renderer.update(<Harness key="sources" stage="sources" />); });
  assert.equal(operations.at(-1)!.stage, "sources");
  await act(async () => { renderer.update(<Harness key="ideas" stage="ideas" />); });
  assert.equal(operations.length, 3, "returning to stopped tab must not reconnect");
  fail = true;
  await act(async () => { renderer.update(<Harness key="data" stage="data" />); });
  assert.match(session!.error, /owned elsewhere/);
  await act(async () => { renderer.update(<Harness key="data-remount" stage="data" />); });
  assert.equal(operations.length, 4, "failed connection must not retry on tab remount");
  fail = false;
  await act(async () => { await session!.act({ type: "connect" }); });
  assert.equal(operations.length, 5, "manual retry is available");
  await act(async () => { renderer.update(<Harness key="manual" stage="manual" enabled={false} />); });
  assert.equal(operations.length, 5);
  await act(async () => { renderer.update(<Harness key="closing" stage="closing" preparing />); });
  assert.equal(operations.length, 5, "closing must not connect");
  await act(async () => { renderer.update(<Harness key="closing" stage="closing" preparing={false} />); });
  assert.equal(operations.length, 6, "cancelled close may resume first connection");
  assert.ok(operations.every(op => op.type === "connect" || op.type === "stop"));
});
