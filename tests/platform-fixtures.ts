import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Platform } from "../server/platform.ts";
import { contentHash } from "../server/durable.ts";
import { metrics, LIMITATIONS } from "../server/reference-engine.ts";
import type {
  StrategyCommand,
  VersionInput,
  Ref,
  RunConfig,
  ExportPackage,
} from "../src/platform.ts";
export const conventions = {
  currency: "USD",
  frequency: "daily" as const,
  annualisation: 252,
  timezone: "UTC" as const,
  calendar: "observed-dates",
  returnBasis: "simple-net" as const,
  capital: "unit-equity" as const,
  rebalance: "prior-close-fixed-weight" as const,
  costs: "turnover-linear" as const,
};
export const spec: Extract<VersionInput, { kind: "spec" }> = {
  kind: "spec",
  content: {
    question: "Does a declared close signal work?",
    sources: [],
    assumptions: ["Idealized prior-close rebalance"],
    falsification: "Negative net return",
    baseline: "Buy and hold",
    universe: "One fixture asset",
    timing: "prior-close-only",
    dataRequirements: "One close per observation",
    signalRules: "Lagged exogenous signal",
    riskRules: "Unit bounded exposure",
    costs: "Linear turnover costs",
    partitions: "Named nonoverlapping trial ranges",
    validation: "Reference fixture",
    acceptance: "Mechanical consistency, not profitability",
    engine: "reference-close-v1",
    supportedRules: ["buy-hold", "exogenous", "moving-average"],
    unsupportedRequirements: [],
  },
};
export function fixture(t: any) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lab-platform-")),
    ),
    store = new Store(root),
    platform = new Platform(store);
  t.after(async () => {
    await platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, platform };
}
export function command(p: Platform, sid: string, c: StrategyCommand) {
  return p.command(sid, {
    operationId: randomUUID(),
    revision: p.strategyView(sid).revision,
    command: c,
  });
}
export function version(
  p: Platform,
  sid: string,
  value: VersionInput,
  id?: string,
): Ref {
  const v = command(p, sid, {
    type: "version.create",
    value,
    ...(id ? { id } : {}),
  }).state.versions.at(-1)!;
  return { id: v.id, hash: v.hash };
}
export function approve(p: Platform, sid: string, target: Ref) {
  command(p, sid, {
    type: "approval.record",
    target,
    decision: "approve",
    reason: "Explicit fixture human decision",
  });
}
export function pipeline(
  p: Platform,
  sid: string,
  csv = "date,close,signal\n2026-01-01,100,1\n2026-01-02,110,-1\n2026-01-03,99,0\n2026-01-04,108.9,1\n2026-01-05,98.01,1",
) {
  const sr = version(p, sid, spec);
  approve(p, sid, sr);
  const cr = version(p, sid, {
    kind: "contract",
    content: {
      spec: sr,
      provider: "Manual fixture",
      license: "User-authored test data",
      provenance: "Deterministic synthetic values",
      universe: "One fixture asset",
      units: "positive-close-price",
      columns: "date,close,signal",
      frequency: "daily",
      timezone: "UTC",
      calendar: conventions.calendar,
      availability: "at-close",
      missingness: "reject-no-fill",
      start: "2026-01-01",
      end: "2026-01-05",
      conventions,
    },
  });
  approve(p, sid, cr);
  const h = command(p, sid, {
    type: "handoff.create",
    spec: sr,
    contract: cr,
    note: "Acquire only declared fixture",
  }).state.handoffs.at(-1)!;
  const d = command(p, sid, {
    type: "dataset.ingest",
    contract: cr,
    handoff: h.id,
    csv,
  }).state.datasets.at(-1)!;
  const gr = version(p, sid, {
    kind: "graph",
    content: {
      spec: sr,
      nodes: [
        {
          id: randomUUID(),
          label: "Prior close reference",
          stage: "signal",
          inputs: ["close", "signal"],
          outputs: ["return"],
          assumptions: ["Idealized timing"],
          code: [],
          evidence: [],
        },
      ],
      edges: [],
    },
  });
  approve(p, sid, gr);
  const config: RunConfig = {
    spec: sr,
    contract: cr,
    dataset: { id: d.id, hash: d.hash },
    graph: gr,
    rule: "exogenous",
    window: 2,
    feeBps: 5,
    slippageBps: 5,
    partition: "holdout",
    start: "2026-01-01",
    end: "2026-01-05",
    seed: 0,
  };
  return { sr, cr, h, d, gr, config };
}
export function externalPackage(
  dates: string[],
  returns: number[],
  id: string = randomUUID(),
): ExportPackage {
  const ref = () => ({ id: randomUUID(), hash: "a".repeat(64) }),
    sr = ref(),
    dr = ref(),
    gr = ref(),
    runId = randomUUID(),
    inputHash = "b".repeat(64);
  const start = new Date(Date.parse(dates[0]) - 86400000)
    .toISOString()
    .slice(0, 10);
  const points = dates.map((date, i) => ({
    date,
    periodStart: i ? dates[i - 1] : start,
    return: returns[i],
    position: 1,
    turnover: i ? 0 : 1,
    cost: 0,
  }));
  let equity = 1,
    peak = 1;
  const outputPoints = points.map((p) => {
    equity *= 1 + p.return;
    peak = Math.max(peak, equity);
    return { ...p, equity, drawdown: 1 - equity / peak };
  });
  const body: ExportPackage["body"] = {
    schema: "herdr-portfolio-export-v1",
    strategyId: id,
    runId,
    inputHash,
    outputHash: contentHash({
      points: outputPoints,
      metrics: metrics(returns, 252),
      conventions,
      limitations: LIMITATIONS,
    }),
    spec: sr,
    dataset: dr,
    graph: gr,
    engine: {
      id: "reference-close-v1",
      sourceHash: "c".repeat(64),
      version: 1,
    },
    config: {
      spec: sr,
      contract: ref(),
      dataset: dr,
      graph: gr,
      rule: "buy-hold",
      window: 2,
      feeBps: 0,
      slippageBps: 0,
      partition: "holdout",
      start,
      end: dates.at(-1)!,
      seed: 0,
    },
    conventions,
    points,
    costs: { feeBps: 0, slippageBps: 0, leverage: 1 },
    trialContext: {
      attempts: 1,
      partition: "holdout",
      exposed: false,
      exposurePolicy: "application-recorded-disclosure-not-a-secrecy-proof",
      trials: [{ id: runId, inputHash, status: "completed" }],
    },
    limitations: ["Externally supplied fixture; unverified authenticity"],
  };
  return { body, hash: contentHash(body) };
}

export function reveal(p: Platform, sid: string, id: string) {
  command(p, sid, {
    type: "run.expose",
    runId: id,
    reason: "Explicit test disclosure",
  });
  return p.runDetails(sid, id);
}
