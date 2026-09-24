import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Platform } from "../server/platform.ts";
import { contentHash } from "../server/durable.ts";
import {
  inspectCSV,
  simulate,
  metrics,
  validateExport,
  analyze,
  allocate,
} from "../server/reference-engine.ts";
import {
  fixture,
  pipeline,
  command,
  version,
  approve,
  spec,
  conventions,
  externalPackage,
  reveal,
} from "./platform-fixtures.ts";
import type { PortfolioCommand, Ref } from "../src/platform.ts";
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const ref = (x: Ref): Ref => ({ id: x.id, hash: x.hash });
function pc(p: Platform, id: string, command: PortfolioCommand) {
  return p.portfolioCommand(id, {
    operationId: randomUUID(),
    revision: p.portfolioView(id).revision,
    command,
  });
}
test("approved exact versions, handoffs and data lineage survive later revisions and scope isolation", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Research"),
    b = store.create("Other"),
    f = pipeline(p, s.id);
  const old = p.strategyView(s.id);
  const revised = version(
    p,
    s.id,
    { ...spec, content: { ...spec.content, question: "Revised proposition" } },
    f.sr.id,
  );
  assert.notEqual(revised.hash, f.sr.hash);
  assert.deepEqual(p.strategyView(s.id).state.handoffs[0].spec, f.sr);
  assert.throws(
    () =>
      command(p, s.id, {
        type: "handoff.create",
        spec: revised,
        contract: f.cr,
        note: "No silent redirect",
      }),
    /different specification/,
  );
  assert.throws(
    () =>
      command(p, b.id, {
        type: "approval.record",
        target: f.sr,
        decision: "approve",
        reason: "Wrong scope",
      }),
    /not found/,
  );
  assert.equal(old.state.versions[0].checksExecuted, false);
  assert.equal(old.state.versions[0].scientificValidation, "not-established");
});
test("deterministic jobs capture actual engine source and repeat trials without editing inputs", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Run"),
    f = pipeline(p, s.id);
  const a = command(p, s.id, {
    type: "run.queue",
    config: f.config,
  }).state.runs.at(-1)!;
  await p.idle();
  const first = reveal(p, s.id, a.id);
  assert.equal(first.run.status, "completed");
  first
    .output!.points.map((x) => x.return)
    .forEach((x, i) => near(x, [0.099, 0.098, -0.001, -0.101][i]));
  near(first.output!.metrics.totalReturn, 0.083740272902);
  near(first.output!.metrics.maxDrawdown, 0.101899);
  assert.equal(first.output!.metrics.samples, 4);
  assert.equal(first.input.authoredCodeExecuted, false);
  const engine = fs.readFileSync(
    new URL("../server/reference-engine.ts", import.meta.url),
  );
  const { digest } = await import("../server/durable.ts");
  assert.equal(first.input.engine.sourceHash, digest(engine));
  const b = command(p, s.id, {
    type: "run.queue",
    config: f.config,
  }).state.runs.at(-1)!;
  await p.idle();
  const second = reveal(p, s.id, b.id);
  assert.notEqual(a.id, b.id);
  assert.equal(a.inputHash, b.inputHash);
  assert.deepEqual(first.output, second.output);
  assert.deepEqual(
    first.run.history.map((h) => h.status),
    ["queued", "running", "completed"],
  );
  assert.equal(second.evidence.scientificValidation, "not-established");
  const e = command(p, s.id, {
    type: "export.create",
    runId: b.id,
    limitations: ["Fixture, not investment evidence"],
  }).state.exports.at(-1)!;
  const pkg = p.exportPackage(s.id, e.id);
  assert.equal(validateExport(pkg).hash, e.hash);
  const text = JSON.stringify(pkg);
  assert.ok(!text.includes(store.db.rootToken));
  assert.ok(!text.includes(store.root));
  assert.ok(!text.includes("sessionId"));
  assert.equal(pkg.body.trialContext.attempts, 2);
});
test("CSV rejects malformed dates/order/duplicates/nonfinite/negative/missing and retains rejected evidence", (t) => {
  const contract = {
    columns: "date,close,signal",
    start: "2026-01-01",
    end: "2026-01-05",
  };
  for (const csv of [
    "date,close,signal\n2026-02-30,1,1\n2026-01-05,2,1",
    "date,close,signal\n2026-01-01,NaN,1\n2026-01-05,2,1",
    "date,close,signal\n2026-01-01,-1,1\n2026-01-05,2,1",
    "date,close,signal\n2026-01-01,1,1\n2026-01-01,2,1",
    "date,close,signal\n2026-01-05,1,1\n2026-01-01,2,1",
    "date,close,signal\n2026-01-01,,1\n2026-01-05,2,1",
  ])
    assert.ok(inspectCSV(csv, contract).findings.length);
  const { store, platform: p } = fixture(t),
    s = store.create("Rejected"),
    f = pipeline(
      p,
      s.id,
      "date,close,signal\n2026-01-01,NaN,1\n2026-01-05,2,1",
    );
  assert.equal(f.d.status, "rejected");
  assert.equal(f.d.rowsHash, null);
  assert.throws(
    () => command(p, s.id, { type: "run.queue", config: f.config }),
    /Accepted matching dataset/,
  );
  assert.ok(p.datasetRows(s.id, f.d.id).dataset.findings.length);
});
test("no lookahead under last-signal perturbation, MA partition warmup, no fake t0 return", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Timing"),
    f = pipeline(p, s.id),
    rows = [
      { date: "2026-01-01", close: 100, signal: 1 },
      { date: "2026-01-02", close: 110, signal: 1 },
      { date: "2026-01-03", close: 99, signal: 1 },
      { date: "2026-01-04", close: 108.9, signal: 1 },
      { date: "2026-01-05", close: 98.01, signal: 1 },
    ];
  const a = await simulate(rows, f.config, conventions);
  rows[4].signal = -1;
  const b = await simulate(rows, f.config, conventions);
  assert.deepEqual(a, b);
  const ma = await simulate(
    rows,
    { ...f.config, rule: "moving-average" },
    conventions,
  );
  assert.equal(ma.points[0].position, 0);
  assert.equal(ma.points[1].position, 1);
  assert.equal(ma.points[2].position, 0);
  assert.equal(ma.metrics.samples, 4);
  near(metrics([-0.2, 0.1], 252).maxDrawdown, 0.2);
  assert.equal(metrics([0.1], 252).annualizedVolatility, null);
  assert.throws(() => metrics([-1], 252), /insolvent/);
});
test("real cancellation, failed attempts, global active bound and restart reconciliation", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Jobs"),
    f = pipeline(p, s.id);
  const cancelled = command(p, s.id, {
    type: "run.queue",
    config: f.config,
  }).state.runs.at(-1)!;
  command(p, s.id, { type: "run.cancel", runId: cancelled.id });
  await p.idle();
  assert.equal(p.runDetails(s.id, cancelled.id).run.status, "cancelled");
  assert.equal(p.runDetails(s.id, cancelled.id).output, null);
  for (let i = 0; i < 4; i++)
    command(p, s.id, { type: "run.queue", config: f.config });
  await new Promise((r) => setImmediate(r));
  assert.ok(p.jobStatus().active <= 2);
  await p.close();
  assert.ok(
    p.strategyView(s.id).state.runs.some((r) => r.status === "interrupted"),
  );
  const restored = new Platform(store);
  await restored.idle();
  assert.equal(restored.jobStatus().active, 0);
  assert.ok(
    restored
      .strategyView(s.id)
      .state.runs.every((r) => r.status !== "running" && r.status !== "queued"),
  );
  await restored.close();
});
test("idempotency and stale scientific edits retain one operation; drafts/layout do not revise science", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("CAS");
  const env = {
    operationId: randomUUID(),
    revision: 0,
    command: { type: "version.create" as const, value: spec },
  };
  p.command(s.id, env);
  p.command(s.id, env);
  assert.equal(p.strategyView(s.id).state.versions.length, 1);
  assert.throws(
    () =>
      p.command(s.id, {
        ...env,
        command: {
          ...env.command,
          value: { ...spec, content: { ...spec.content, question: "changed" } },
        },
      }),
    /reused/,
  );
  assert.throws(
    () => p.command(s.id, { ...env, operationId: randomUUID() }),
    /conflict/,
  );
  const before = p.strategyView(s.id).revision;
  p.saveUI(s.id, {
    revision: 0,
    layout: [],
    drafts: [
      { id: randomUUID(), kind: "code", base: null, text: "unsaved source" },
    ],
  });
  assert.equal(p.strategyView(s.id).revision, before);
  assert.equal(p.readUI(s.id).drafts[0].text, "unsaved source");
  assert.throws(
    () => p.saveUI(s.id, { revision: 0, layout: [], drafts: [] }),
    /conflict/,
  );
});
test("bibliography ownership, human authenticity evidence, graph cycles and source-present do not claim execution", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Design"),
    f = pipeline(p, s.id);
  const code = version(p, s.id, {
    kind: "code",
    content: {
      filename: "rule.ts",
      language: "typescript",
      source: 'throw new Error("must never execute")',
      symbols: ["rule"],
      evidence: [],
    },
  });
  assert.equal(p.versionContent(s.id, code).meta.sourcePresent, true);
  assert.equal(p.versionContent(s.id, code).meta.checksExecuted, false);
  const n = randomUUID();
  assert.throws(
    () =>
      version(p, s.id, {
        kind: "graph",
        content: {
          spec: f.sr,
          nodes: [
            {
              id: n,
              label: "node",
              stage: "signal",
              inputs: [],
              outputs: [],
              assumptions: [],
              code: [{ version: code, symbol: "absent" }],
              evidence: [],
            },
          ],
          edges: [],
        },
      }),
    /symbol/,
  );
  assert.throws(
    () =>
      version(p, s.id, {
        kind: "graph",
        content: {
          spec: f.sr,
          nodes: [
            {
              id: n,
              label: "node",
              stage: "signal",
              inputs: [],
              outputs: [],
              assumptions: [],
              code: [],
              evidence: [],
            },
          ],
          edges: [{ from: n, to: n, label: "cycle" }],
        },
      }),
    /endpoint/,
  );
  assert.throws(
    () =>
      version(p, s.id, {
        kind: "idea",
        content: {
          title: "x",
          rationale: "x",
          universe: "x",
          horizon: "x",
          falsification: "x",
          uncertainty: "tested",
          evidence: [
            { category: "tested", reference: f.sr, description: "not a test" },
          ],
        },
      }),
    /completed recorded run/,
  );
});
test("frozen portfolio imports, exact intersection, formulas, constraints, zero variance, proposals and isolation", (t) => {
  const { store, platform: p } = fixture(t),
    pid = p.createPortfolio("Portfolio").id,
    other = p.createPortfolio("Other").id,
    a = externalPackage(
      ["2026-01-02", "2026-01-03", "2026-01-06"],
      [0.1, -0.1, 0.05],
    ),
    b = externalPackage(
      ["2026-01-03", "2026-01-06", "2026-01-07"],
      [0.02, -0.02, 0.01],
    );
  pc(p, pid, { type: "import.add", package: a });
  pc(p, pid, { type: "import.add", package: b });
  const imports = p.portfolioView(pid).state.imports.map(ref);
  const analysis = pc(p, pid, {
      type: "analysis.create",
      imports,
      allocation: { method: "equal", cap: 1 },
    }).state.analyses[0],
    result = p.analysis(pid, analysis.id);
  assert.deepEqual(result.dates, ["2026-01-03", "2026-01-06"]);
  assert.deepEqual(
    result.alignment.map((a) => a.dropped),
    [1, 1],
  );
  near(result.points[0].return, -0.04);
  near(result.points[1].return, 0.015);
  near(result.metrics.totalReturn, -0.0256);
  near(result.metrics.maxDrawdown, 0.04);
  near(
    result.correlations.find((c) => c.a === 0 && c.b === 1)!.value!,
    -1,
  );
  assert.equal(result.correlations[0].n, 2);
  const manual = analyze([a, b], imports, {
    method: "manual",
    cap: 1,
    weights: [0.25, 0.75],
  });
  near(manual.metrics.totalReturn, -0.012475);
  const inverse = analyze([a, b], imports, {
    method: "inverse-volatility",
    cap: 1,
  });
  near(inverse.weights[0], 0.2105263157894737);
  const capped = analyze([a, b], imports, {
    method: "inverse-volatility",
    cap: 0.6,
  });
  near(capped.weights[0], 0.4);
  near(capped.weights[1], 0.6);
  assert.throws(
    () => analyze([a, b], imports, { method: "equal", cap: 0.4 }),
    /Infeasible/,
  );
  assert.throws(
    () => allocate([0, 0.1], { method: "inverse-volatility", cap: 1 }),
    /undefined/,
  );
  assert.throws(
    () =>
      allocate([0.1, 0.2], { method: "manual", cap: 0.6, weights: [0.7, 0.3] }),
    /caps/,
  );
  assert.throws(
    () =>
      pc(p, other, {
        type: "analysis.create",
        imports,
        allocation: { method: "equal", cap: 1 },
      }),
    /not owned/,
  );
  const frozen = JSON.stringify(p.importedPackage(pid, imports[0].id));
  a.body.points[0].return = 0.2;
  assert.equal(JSON.stringify(p.importedPackage(pid, imports[0].id)), frozen);
  const proposal = pc(p, pid, {
    type: "proposal.create",
    analysis: ref(analysis),
    targetStrategyId: a.body.strategyId,
    request: "Review timing assumptions",
  }).state.proposals[0];
  assert.equal(
    p.proposal(pid, proposal.id).body.targetStrategyId,
    a.body.strategyId,
  );
  assert.equal(Object.keys(store.db.strategies).length, 0);
  assert.throws(() => p.authPortfolio(store.db.rootToken, pid), /capability/);
});
test("strict package integrity, no private extra fields, incompatible conventions, no overlap and zero correlation variance", () => {
  const a = externalPackage(["2026-01-02", "2026-01-03"], [0, 0]),
    b = externalPackage(["2026-01-02", "2026-01-03"], [0.1, -0.1]),
    refs = [
      { id: randomUUID(), hash: a.hash },
      { id: randomUUID(), hash: b.hash },
    ];
  const result = analyze([a, b], refs, { method: "equal", cap: 1 });
  assert.equal(
    result.correlations.find((c) => c.a === 0 && c.b === 1)!.value,
    null,
  );
  assert.throws(() =>
    validateExport({ ...a, body: { ...a.body, secret: "no" } }),
  );
  const corrupt = structuredClone(b);
  corrupt.body.points[0].return = 0.2;
  assert.throws(() => validateExport(corrupt), /hash/);
  corrupt.hash = contentHash(corrupt.body);
  assert.throws(() => validateExport(corrupt), /Output hash/);
  const incompatible = structuredClone(b);
  incompatible.body.conventions.currency = "EUR";
  assert.throws(
    () => analyze([a, incompatible], refs, { method: "equal", cap: 1 }),
    /Incompatible/,
  );
  const noOverlap = externalPackage(["2026-01-06", "2026-01-07"], [0.1, -0.1]);
  assert.throws(
    () => analyze([a, noOverlap], refs, { method: "equal", cap: 1 }),
    /Insufficient overlap/,
  );
});
test("explicit compact context excludes unrelated sources, has digest, rejects overflow and never starts a model", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Capsule"),
    other = store.create("Other");
  const selected = version(p, s.id, spec),
    foreign = version(p, other.id, {
      ...spec,
      content: { ...spec.content, question: "secret-unrelated" },
    });
  const c = p.capsule("strategy", s.id, {
    role: "research",
    task: "Check assumptions",
    selected: [selected],
    unresolved: ["Timing uncertainty"],
    budget: 16384,
  });
  assert.equal(c.status, "prepared-not-submitted");
  assert.ok(!c.text.includes("secret-unrelated"));
  assert.ok(!c.text.includes(store.db.rootToken));
  assert.throws(
    () =>
      p.capsule("strategy", s.id, {
        role: "research",
        task: "Check",
        selected: [foreign],
        unresolved: [],
        budget: 16384,
      }),
    /not owned/,
  );
  assert.throws(
    () =>
      p.capsule("strategy", s.id, {
        role: "research",
        task: "Check",
        selected: [selected],
        unresolved: [],
        budget: 512,
      }),
    /nothing truncated/,
  );
  assert.equal(store.get(s.id).batches.length, 0);
  const pid = p.createPortfolio("Manual conversation").id;
  const pkg = externalPackage(["2026-01-02", "2026-01-03"], [0.1, -0.1]);
  const i = pc(p, pid, { type: "import.add", package: pkg }).state.imports[0];
  const capsule = p.capsule("portfolio", pid, {
    role: "portfolio",
    task: "Discuss imported evidence",
    selected: [ref(i)],
    unresolved: [],
    budget: 16384,
  });
  assert.ok(capsule.text.includes("unverified-external-package"));
  assert.ok(!capsule.text.includes("secret-unrelated"));
});

test("bibliography preserves authoritative ordering, exact artifact ownership and human verification evidence", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Bibliography"),
    other = store.create("Foreign");
  store.import(
    s.id,
    store.get(s.id).revision,
    "first.txt",
    Buffer.from("First paper"),
  );
  store.import(
    s.id,
    store.get(s.id).revision,
    "second.txt",
    Buffer.from("Second paper"),
  );
  const [a, b] = store.get(s.id).artifacts;
  const entry = (a: typeof b) => ({
    artifact: { id: a.id, hash: a.hash },
    citation: a.name,
    identifiers: ["manual:fixture"],
    sourceVersion: "v1",
    provenance: "Explicit local import",
    authenticity: "unverified" as const,
    verificationEvidence: "",
    decision: "include" as const,
    reason: "Relevant example",
    tags: ["fixture"],
  });
  const one = version(p, s.id, {
    kind: "bibliography",
    content: { entries: [entry(b), entry(a)] },
  });
  approve(p, s.id, one);
  const two = version(
    p,
    s.id,
    { kind: "bibliography", content: { entries: [entry(a), entry(b)] } },
    one.id,
  );
  assert.notEqual(one.hash, two.hash);
  const original = p.versionContent(s.id, one).value;
  assert.equal(original.kind, "bibliography");
  if (original.kind === "bibliography")
    assert.deepEqual(
      original.content.entries.map((e) => e.artifact.id),
      [b.id, a.id],
    );
  assert.throws(
    () =>
      version(p, other.id, {
        kind: "bibliography",
        content: { entries: [entry(a)] },
      }),
    /not owned/,
  );
  assert.throws(
    () =>
      version(p, s.id, {
        kind: "bibliography",
        content: { entries: [{ ...entry(a), authenticity: "human-checked" }] },
      }),
    /requires explicit evidence/,
  );
  assert.throws(
    () =>
      version(
        p,
        s.id,
        { kind: "bibliography", content: { entries: [entry(a), entry(b)] } },
        one.id,
      ),
    /Identical content/,
  );
  assert.deepEqual(p.strategyView(s.id).state.approvals[0].target, one);
});

test("approved graph captures authored source mappings but never executes arbitrary source", async (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Source boundary"),
    f = pipeline(p, s.id);
  const code = version(p, s.id, {
    kind: "code",
    content: {
      filename: "never-run.ts",
      language: "typescript",
      source: 'throw new Error("AUTHORED CODE MUST NOT RUN");',
      symbols: ["declaredRule"],
      evidence: [],
    },
  });
  const graph = p.versionContent(s.id, f.gr).value;
  assert.equal(graph.kind, "graph");
  if (graph.kind !== "graph") throw new Error("fixture");
  const gr = version(
    p,
    s.id,
    {
      kind: "graph",
      content: {
        ...graph.content,
        nodes: graph.content.nodes.map((n) => ({
          ...n,
          code: [{ version: code, symbol: "declaredRule" }],
        })),
      },
    },
    f.gr.id,
  );
  approve(p, s.id, gr);
  const run = command(p, s.id, {
    type: "run.queue",
    config: { ...f.config, graph: gr },
  }).state.runs[0];
  await p.idle();
  const d = reveal(p, s.id, run.id);
  assert.equal(d.run.status, "completed");
  assert.deepEqual(d.input.authoredCode, [code]);
  assert.equal(d.input.authoredCodeExecuted, false);
  assert.equal(p.versionContent(s.id, code).meta.checksExecuted, false);
});

test("portfolio proposal transfer requires target strategy authority and remains only a recorded human request", (t) => {
  const { store, platform: p } = fixture(t),
    s = store.create("Target"),
    wrong = store.create("Wrong target"),
    pid = p.createPortfolio("Request").id,
    pkg = externalPackage(["2026-01-02", "2026-01-03"], [0.1, -0.1], s.id);
  const imported = pc(p, pid, { type: "import.add", package: pkg }).state
    .imports[0];
  const analysis = pc(p, pid, {
    type: "analysis.create",
    imports: [ref(imported)],
    allocation: { method: "equal", cap: 1 },
  }).state.analyses[0];
  const proposal = pc(p, pid, {
      type: "proposal.create",
      analysis: ref(analysis),
      targetStrategyId: s.id,
      request: "Review cost assumptions, do not execute",
    }).state.proposals[0],
    request = p.proposal(pid, proposal.id);
  assert.throws(
    () =>
      command(p, wrong.id, {
        type: "proposal.review",
        proposal: request,
        decision: "accept-for-review",
        reason: "Wrong target",
      }),
    /target mismatch/,
  );
  const review = command(p, s.id, {
    type: "proposal.review",
    proposal: request,
    decision: "accept-for-review",
    reason: "Will assess manually",
  }).state.proposalReviews[0];
  assert.deepEqual(p.reviewedProposal(s.id, review.id).package, request);
  assert.equal(p.strategyView(s.id).state.runs.length, 0);
  assert.equal(p.strategyView(s.id).state.approvals.length, 0);
  assert.equal(p.strategyView(s.id).state.versions.length, 0);
  assert.equal(store.get(s.id).batches.length, 0);
});
