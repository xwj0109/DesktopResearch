import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./platform-fixtures.ts";
import { Workbench } from "../server/workbench/tools.ts";
import { mcpHandle } from "../server/workbench/mcp.ts";

process.env.SHELL = "/bin/sh";
const idea = { rationale: "Carry", universe: "BTC perp", horizon: "8h", falsification: "No net carry", uncertainty: "conjectured" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(t: any) {
  const x = fixture(t);
  const s = x.store.create("Risks");
  const wb = new Workbench(x.store, x.platform, undefined, 0);
  t.after(() => wb.close());
  const call = (name: string, input: unknown = {}) => wb.call(s.id, name, input) as Promise<any>;
  const ended = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      wb.runs.tick();
      const r = wb.runs.read(s.id, id);
      if (["succeeded", "failed", "cancelled", "lost"].includes(r.status)) return r;
      await sleep(40);
    }
    throw new Error("run did not end");
  };
  return { ...x, sid: s.id, wb, call, ended };
}
async function pursued(call: (n: string, i?: unknown) => Promise<any>, title: string) {
  const d = await call("idea_create", { title });
  await call("idea_update", { target: d.created, patch: idea });
  const saved = (await call("idea_save", { target: d.created })).saved as string;
  await call("idea_decide", { target: saved, decision: "pursue", reason: "Test it" });
  return saved;
}

test("risks: drafted as unknown, tested by runs, worst first, waivers need a reason", async (t) => {
  const { call, wb, sid, store, ended } = setup(t);
  const a = await pursued(call, "Carry");
  const b = await pursued(call, "Other");
  wb.view.setContext(sid, { developIdea: a });
  const r1 = (await call("risk_add", { text: "Funding is published after the decision time", kind: "timing" })).risk;
  const r2 = (await call("risk_add", { text: "Historical funding before 2021 has gaps", kind: "data" })).risk;
  const r3 = (await call("risk_add", { text: "Fees eat the carry", kind: "cost", status: "estimated", evidence: { text: "0.02% taker vs 0.01% per 8h" } })).risk;
  assert.deepEqual([r1.status, r1.by], ["unknown", "user"]);
  await assert.rejects(call("risk_add", { text: "x", kind: "data", status: "waived" }), /needs a reason/);
  // Evidence from a run of the idea.
  await call("rd_files", { idea: a });
  const run = await call("run_submit", { idea: a, command: "echo measured" });
  await ended(run.id);
  await call("risk_set", { risk: r1.id, status: "failed", evidence: { run: run.id }, reason: "Published 8h late" });
  await call("risk_set", { risk: r2.id, status: "measured-ok", evidence: { run: run.id } });
  const bRun = await (async () => {
    await call("rd_files", { idea: b });
    return call("run_submit", { idea: b, command: "true" });
  })();
  await assert.rejects(call("risk_set", { risk: r2.id, evidence: { run: bRun.id } }), /belongs to another idea/);
  await assert.rejects(call("risk_set", { risk: r3.id, status: "waived" }), /needs a reason/);
  let list = await call("risk_list", {});
  assert.deepEqual(list.risks.map((r: any) => r.status), ["failed", "estimated", "measured-ok"], "worst first");
  assert.deepEqual(list.counts, { failed: 1, unknown: 0, estimated: 1, waived: 0, measuredOk: 1, stale: 0 });
  assert.equal(list.risks[0].evidenceRun.id, run.id);
  assert.equal((await call("risk_list", { idea: b })).risks.length, 0, "risks belong to one idea");

  // Evidence goes stale when later runs use other data.
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", a.slice(2));
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n");
  await call("data_register", { idea: a, path: "px.csv", title: "Prices" });
  fs.writeFileSync(path.join(dir, "fit.sh"), "cat data/prices.csv\n");
  const later = await call("run_submit", { idea: a, command: "sh fit.sh" });
  assert.equal((await ended(later.id)).status, "succeeded");
  list = await call("risk_list", {});
  assert.match(list.risks.find((r: any) => r.id === r2.id).stale, /other data than the latest run/);
  assert.equal(list.counts.stale, 2);

  // A failed risk stops a release candidate unless the user says why to go ahead.
  await call("rd_checkpoint", { idea: a, message: "Clean" }).catch(() => {});
  await assert.rejects(call("production_commit", { idea: a }), /1 of the idea's risks failed \(“Funding is published after the decision time”\)/);
  const c = await call("production_commit", { idea: a, acceptFailedRisks: "Research result only; live timing handled later" });
  assert.equal(c.acceptedFailedRisks, "Research result only; live timing handled later");
  assert.deepEqual(c.risks.map((r: any) => r.status).sort(), ["estimated", "failed", "measured-ok"]);
  assert.equal((await call("candidate_status")).checks.risks.failed, 1);
  // Delete only on request; unknown ids say so.
  await call("risk_delete", { risk: r3.id });
  await assert.rejects(call("risk_delete", { risk: r3.id }), /not found/);
});

test("a conversation bound to an idea keeps its risks on that idea", async (t) => {
  const { call, wb, sid } = setup(t);
  const a = await pursued(call, "Bound");
  const b = await pursued(call, "Other");
  wb.view.setContext(sid, { developIdea: b });
  const agent = async (name: string, args: unknown) => {
    const r: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "research", a);
    return { error: r.result.isError as boolean, text: r.result.content[0].text as string, value: r.result.structuredContent };
  };
  const added = await agent("risk_add", { text: "Order book depth is not archived for the needed venue", kind: "data" });
  assert.equal(added.error, false, added.text);
  assert.equal(added.value.idea, a);
  assert.equal(added.value.risk.by, "agent");
  assert.equal((await agent("risk_add", { idea: b, text: "x", kind: "data" })).error, true);
  assert.equal((await call("risk_list", { idea: b })).risks.length, 0);
});

test("idea_context: one summary of where an idea stands, with next steps, for the agent and the user", async (t) => {
  const { call, wb, sid, ended } = setup(t);
  const a = await pursued(call, "Context idea");
  wb.view.setContext(sid, { developIdea: a, stage: "research" });
  let c = await call("idea_context", {});
  assert.deepEqual([c.idea.title, c.idea.status, c.window], ["Context idea", "pursue", { stage: "research", current: true }]);
  assert.ok(c.next.some((n: string) => /Name the 3–5 risks/.test(n)));
  assert.ok(c.next.some((n: string) => /No recorded runs yet/.test(n)));
  await call("risk_add", { text: "Depth data is not archived", kind: "data" });
  const run = await call("run_submit", { idea: a, command: "mkdir -p \"$PI_RESEARCH_OUTPUTS\" && echo '{\"auc\": 0.61}' > \"$PI_RESEARCH_OUTPUTS/metrics.json\"" });
  await ended(run.id);
  c = await call("idea_context", {});
  assert.equal(c.next[0], "Test the risk “Depth data is not archived” with the cheapest run that could fail it.");
  assert.deepEqual(c.runs.map((r: any) => [r.status, r.metrics.auc]), [["succeeded", 0.61]]);
  assert.equal(c.risks.counts.unknown, 1);
  assert.equal(c.candidate, null);
  assert.deepEqual(c.agentRuns.limit, { runs: 5, minutes: 60 });
});
