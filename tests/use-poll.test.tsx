import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { ResearchProvider } from "../src/workbench/research";
import { PaneVisible, usePoll } from "../src/workbench/usePoll";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function Reader({ path, ms }: { path: string; ms: number }) {
  const { data } = usePoll<{ n: number }>(path, ms);
  return <span>{data ? data.n : "…"}</span>;
}

test("panes reading the same route share one request; hidden panes stop polling", async () => {
  const reads: string[] = [];
  const client = { read: async (path: string) => (reads.push(path), { n: reads.length }) };
  const scope: any = { client };
  const host = (shown: boolean) => (
    <ResearchProvider value={scope}>
      <PaneVisible.Provider value={shown}>
        <Reader path="/native/rd/files?idea=r:a" ms={40} />
        <Reader path="/native/rd/files?idea=r:a" ms={40} />
      </PaneVisible.Provider>
    </ResearchProvider>
  );
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(host(true)); await sleep(5); });
  assert.equal(reads.length, 1, "one request for both readers");
  assert.deepEqual(r.root.findAllByType("span").map((s) => s.children[0]), ["1", "1"], "both show the shared data");
  await act(async () => { await sleep(100); });
  const polled = reads.length;
  assert.ok(polled >= 2 && polled <= 4, `polls while visible (${polled})`);
  // Hidden (another tab is active): the data stays, the polling stops.
  await act(async () => { r.update(host(false)); await sleep(120); });
  const hidden = reads.length;
  await act(async () => { await sleep(120); });
  assert.equal(reads.length, hidden, "no requests while hidden");
  // Shown again: refreshed at once, then polled.
  await act(async () => { r.update(host(true)); await sleep(5); });
  assert.equal(reads.length, hidden + 1);
  await act(async () => r.unmount());
});
