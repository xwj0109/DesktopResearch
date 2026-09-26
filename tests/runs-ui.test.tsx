import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { ResearchProvider } from "../src/workbench/research";
import { CandidatePane, FeaturesPane, RunsPane } from "../src/workbench/panes/Runs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const IDEA = "r:11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const summary = (id: string, sharpe: number, commit: string) => ({
  id, idea: IDEA, status: "succeeded", reason: null, entry: "train", command: "sh train.sh", commit, checkpointMessage: "Fit", autoCheckpoint: false,
  candidate: null, origin: "user", createdAt: "2026-09-26T10:00:00Z", startedAt: "2026-09-26T10:00:01Z", endedAt: "2026-09-26T10:00:05Z",
  usage: { wallSeconds: 4, peakMemoryBytes: 65_000_000 }, metrics: { sharpe }, outputs: 1,
});
const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

function harness() {
  const writes: [string, any][] = [];
  const drafts: Record<string, string> = {};
  let runs = [summary(A, 1.2, "c".repeat(40))];
  const client = {
    read: async (path: string) => {
      if (path.startsWith("/native/runs?idea=")) return { idea: IDEA, entries: [{ name: "train", command: "sh train.sh", description: null }], manifestError: null, features: [{ name: "funding_z", source: "fundingRate", lookback: "30d", available_after: "0s" }, { name: "depth_imb", source: "bookDepth", window: 10 }], runs, limit: { runs: 5, minutes: 60 }, agentUsage: { runs: 1, minutes: 10 } };
      if (path.startsWith("/native/runs/status?run=")) {
        const r = runs.find((x) => path.endsWith(x.id))!;
        return { ...r, environment: { lock: { file: "uv.lock", sha256: "f".repeat(64) }, files: ["uv.lock"], shell: "/bin/sh" }, hardware: { platform: "darwin", arch: "arm64", cpu: "Apple M5 Max", cores: 18, memoryBytes: 2 ** 37 }, snapshots: [{ name: "prices", sha256: "e".repeat(64) }], outputs: [{ path: "metrics.json", bytes: 20, sha256: "d".repeat(64) }], wallSeconds: 3600, logTail: "fitting…\ndone" };
      }
      if (path.startsWith("/native/runs/compare?")) return { a: runs[1], b: runs[0], differences: [{ field: "checkpoint", a: "cccccccc Fit", b: "dddddddd Fit" }], warnings: [], metrics: [{ name: "sharpe", a: 1.2, b: 1.5, delta: 0.3 }] };
      if (path === "/native/candidate") return { current: null, earlier: 0 };
      throw new Error(`unexpected read ${path}`);
    },
    write: async (path: string, body: any) => {
      writes.push([path, body]);
      if (path === "/native/runs/submit") {
        const r = summary(B, 1.5, "d".repeat(40));
        runs = [r, ...runs];
        return r;
      }
      return {};
    },
  };
  const scope: any = {
    client, portfolio: false, stage: "research",
    view: { pursued: [{ target: IDEA, title: "Carry", version: 1, pursuedOnVersion: 1, reason: "", pendingEdits: false }] },
    drafts, setDraft: (k: string, v: string) => (v ? (drafts[k] = v) : delete drafts[k]),
    goToStage: () => {}, appendComposer: () => {}, setComposer() {},
  };
  return { scope, writes, drafts };
}

test("Runs pane: start an entry, see what ran and its metrics, compare two runs, and set the agent limit", async (t) => {
  const h = harness();
  let r!: ReturnType<typeof create>;
  const Host = () => <ResearchProvider value={h.scope}><RunsPane /></ResearchProvider>;
  await act(async () => { r = create(<Host />); });
  t.after(() => act(async () => r.unmount()));
  await settle();
  const buttons = () => r.root.findAllByType("button");
  const byText = (t: string) => buttons().find((b) => text(b).includes(t))!;
  assert.match(text(r.root.findByProps({ "aria-label": "Runs" })), /train.*ccccccc.*sharpe 1\.2/);
  const detail = () => text(r.root.findByProps({ className: "rd-viewer run-detail" }));
  assert.match(detail(), /Apple M5 Max · 18 cores/);
  assert.match(detail(), /uv\.lock ffffffffffff/);
  assert.match(detail(), /sharpe1\.2/);
  assert.match(detail(), /fitting…\s+done/);
  // One click runs the entry; the new run opens.
  await act(async () => byText("Run ▸ train").props.onClick());
  await settle();
  assert.deepEqual(h.writes.at(-1), ["/native/runs/submit", { idea: IDEA, entry: "train", wallMinutes: 60 }]);
  assert.equal(h.drafts[`research:run:${IDEA}`], B);
  await act(async () => { r.update(<Host />); });
  await settle();
  // ⇧-click another run compares it with the open one.
  const row = buttons().find((b) => b.props.className?.startsWith("run-row") && text(b).includes("ccccccc"))!;
  await act(async () => row.props.onClick({ shiftKey: true }));
  await act(async () => { r.update(<Host />); });
  await settle();
  assert.match(text(r.root.findByProps({ "aria-label": "Metrics compared" })), /sharpe1\.21\.5\+0\.3/);
  // The agent limit is the user's to change.
  assert.match(text(r.root.findByProps({ className: "runs-limit" })), /Agent limit: 1\/5 runs · 10\/60 min this hour/);
  await act(async () => byText("Change").props.onClick());
  await act(async () => r.root.findByProps({ "aria-label": "Runs per hour" }).props.onChange({ target: { value: "2" } }));
  await act(async () => r.root.findAll((n) => n.type === "form" && n.props.className === "runs-limit")[0].props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(h.writes.at(-1), ["/native/runs/limit", { runs: 2, minutes: 60 }]);
});

test("Features show when each value is known; Resources show what every run cost", async (t) => {
  const h = harness();
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<ResearchProvider value={h.scope}><FeaturesPane /></ResearchProvider>); });
  t.after(() => act(async () => r.unmount()));
  await settle();
  const table = text(r.root.findByProps({ "aria-label": "Features" }));
  assert.match(table, /funding_zfundingRate30d0s/);
  assert.match(table, /depth_imbbookDepth▲ not statedwindow=10/);
  assert.match(text(r.root), /Ask Pi to check 1 timing/);
  // Resources: toggled in the Runs pane once there are two runs.
  let p!: ReturnType<typeof create>;
  await act(async () => { p = create(<ResearchProvider value={h.scope}><RunsPane /></ResearchProvider>); });
  t.after(() => act(async () => p.unmount()));
  await settle();
  await act(async () => p.root.findAllByType("button").find((b) => text(b).includes("Run ▸ train"))!.props.onClick());
  await settle();
  await act(async () => { p.update(<ResearchProvider value={h.scope}><RunsPane /></ResearchProvider>); });
  await settle();
  await act(async () => p.root.findAllByType("button").find((b) => text(b) === "Resources")!.props.onClick());
  const res = text(p.root.findByProps({ "aria-label": "Run resources" }));
  assert.match(res, /trainddddddd✓ succeeded4\.0 s62\.0 MiB1\.5trainccccccc✓ succeeded4\.0 s62\.0 MiB1\.2/);
});

test("Candidate pane without a candidate points to Develop", async () => {
  const h = harness();
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<ResearchProvider value={h.scope}><CandidatePane /></ResearchProvider>); });
  await settle();
  assert.match(text(r.root), /No release candidate yet/);
  await act(async () => r.unmount());
});
