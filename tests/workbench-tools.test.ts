import { Store } from "../server/store.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./platform-fixtures.ts";
import { Workbench, tools } from "../server/workbench/tools.ts";
import { McpAccess, mcpHandle } from "../server/workbench/mcp.ts";
import { relayWorkbenchTool } from "../server/pi.ts";
import { createWorkbenchTools, resolveToolReply } from "../server/pi-host-tools.mjs";
import type { PaperDeps } from "../desktop/papers.ts";

/** A small valid PDF with known text (Helvetica, one text line per entry). */
function makePdf(pages: string[][]) {
  const objects: string[] = [];
  const font = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  pages.forEach((lines, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l, k) => `${k ? "0 -16 Td " : ""}(${l}) Tj`).join(" ")} ET`;
    objects[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objects[4 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PAPER = makePdf([
  ["The numeraire portfolio is growth optimal.", "Drawdown constraints change the answer."],
  ["Theorem 3.1 establishes growth optimality", "under a linear drawdown constraint."],
]);
const ATOM = `<feed><entry><id>http://arxiv.org/abs/1206.2305v2</id><published>2012-06-11T00:00:00Z</published><title>The numeraire property</title><author><name>Constantinos Kardaras</name></author></entry></feed>`;
const net: PaperDeps = {
  lookup: async () => [{ address: "151.101.1.42", family: 4 }],
  fetch: (async (url: string) =>
    url.includes("/pdf/") ? new Response(new Uint8Array(PAPER)) : new Response(ATOM)) as typeof fetch,
};

function setup(t: any) {
  const x = fixture(t);
  const s = x.store.create("Workbench");
  const wb = new Workbench(x.store, x.platform, () => net, 0);
  t.after(() => wb.close());
  const call = (name: string, input: unknown = {}) => wb.call(s.id, name, input) as Promise<any>;
  return { ...x, sid: s.id, wb, call };
}
const idea = { rationale: "Growth-optimal sizing under a floor", universe: "BTC daily", horizon: "daily", falsification: "No gain after costs", uncertainty: "conjectured" as const };

test("the registry is one manifest of small tools with plain JSON Schema inputs", (t) => {
  const { wb } = setup(t);
  const manifest = wb.manifest();
  assert.equal(manifest.length, tools.length);
  assert.equal(new Set(manifest.map((m) => m.name)).size, manifest.length);
  for (const m of manifest) {
    assert.match(m.name, /^[a-z]+(_[a-z]+)*$/);
    assert.equal(m.inputSchema.type, "object", m.name);
    assert.equal("$schema" in m.inputSchema, false);
    assert.ok(m.description.length > 20);
  }
  assert.deepEqual(manifest.find((m) => m.name === "source_delete")!.annotations, { readOnlyHint: false, destructiveHint: true });
});

test("ideas through the tools: drafts on the shared board, strict save, pending edits on saved ideas, reasoned decisions", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const created = await call("idea_create", { title: "Kelly with a drawdown cap" });
  assert.match(created.created, /^d:/);
  assert.equal(store.ideaBoard(sid).cards[0].content.title, "Kelly with a drawdown cap", "drafts live in the strategy store");

  await assert.rejects(call("idea_save", { target: created.created }), /Cannot save yet: rationale: required/);
  await assert.rejects(call("idea_update", { target: created.created, patch: {} }), /at least one field/);
  await call("idea_update", { target: created.created, patch: idea });
  const saved = await call("idea_save", { target: created.created });
  assert.match(saved.saved, /^r:/);
  assert.equal(saved.version, 1);
  assert.equal(store.ideaBoard(sid).cards.length, 0, "saving removes the draft");

  await call("idea_update", { target: saved.saved, patch: { horizon: "weekly" } });
  assert.equal((await call("idea_get", { target: saved.saved })).edited, true);
  await assert.rejects(call("idea_decide", { target: saved.saved, decision: "pursue", reason: "x" }), /unsaved edits/);
  await call("idea_update", { target: saved.saved, patch: { horizon: "daily" } });
  assert.equal((await call("idea_get", { target: saved.saved })).edited, false, "editing back to the saved text clears the pending edit");

  await call("idea_decide", { target: saved.saved, decision: "pursue", reason: "Clean falsification test" });
  const listed = await call("ideas_list");
  assert.deepEqual(listed.ideas.map((i: any) => [i.title, i.status, i.version]), [["Kelly with a drawdown cap", "pursue", 1]]);
  assert.deepEqual((await call("idea_get", { target: saved.saved })).decision, { decision: "pursue", reason: "Clean falsification test", onVersion: 1 });

  // "The open idea" comes from what the window reports.
  await assert.rejects(call("idea_get"), /none is open in the window/);
  wb.view.setContext(sid, { ideaTarget: saved.saved });
  assert.equal((await call("idea_get")).target, saved.saved);
  await assert.rejects(call("idea_get", { target: "d:00000000-0000-4000-8000-000000000000" }), /not found/);
  await assert.rejects(call("idea_update", { target: 42 }), /Invalid input for idea_update/);
});

test("sources through the tools: server-side reading, find with navigation, anchored highlights, delete and restore, import", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const imported = await call("paper_import", { source: "1206.2305" });
  assert.equal(imported.alreadyInLibrary, false);
  assert.equal((await call("paper_import", { source: "1206.2305" })).alreadyInLibrary, true, "identical bytes are not duplicated");
  const id = imported.artifact.id;
  assert.equal(store.get(sid).artifacts.length, 1);

  const page2 = await call("paper_read", { artifactId: id, page: 2 });
  assert.equal(page2.pages, 2);
  assert.match(page2.text, /Theorem 3\.1 establishes growth optimality/);
  await assert.rejects(call("paper_read", { artifactId: id, page: 9 }), /outside this PDF/);
  wb.view.setContext(sid, { activeArtifact: id, page: 2 });
  assert.equal((await call("paper_read")).page, 2, "defaults to the paper and page open in the window");

  const found = await call("paper_find", { query: "growth optimal", navigate: true });
  assert.equal(found.matches, 2);
  assert.equal(found.page, 1);
  const events = await wb.view.next(sid, 0, 0);
  assert.ok(events.events.some((e: any) => e.type === "find" && e.page === 1 && e.query === "growth optimal"));

  await assert.rejects(call("note_create", { page: 1, quote: "not on this page at all" }), /does not appear on page 1/);
  const hl = await call("note_create", { page: 2, quote: "under a linear drawdown constraint" });
  assert.equal(hl.kind, "highlight");
  const cm = await call("note_create", { page: 1, quote: "growth optimal", comment: "Key claim" });
  const notes = await call("source_notes", {});
  assert.deepEqual(notes.notes.map((n: any) => [n.page, n.comment]), [[2, "Highlight"], [1, "Key claim"]]);
  await call("note_update", { noteId: cm.noteId, status: "addressed" });
  assert.equal(store.get(sid).annotations.find((n) => n.id === cm.noteId)!.status, "addressed");
  await call("note_delete", { noteId: hl.noteId });
  assert.equal(store.get(sid).annotations.length, 1);

  const removed = await call("source_delete", { artifactId: id });
  assert.equal(removed.notesRemoved, 1);
  assert.equal((await call("sources_list")).recentlyDeleted.length, 1);
  await call("source_restore", { artifactId: id });
  assert.equal(store.get(sid).artifacts.length, 1);
});

test("view events are long-polled: a waiting window wakes on publish, new windows start from now", async (t) => {
  const { wb, sid } = setup(t);
  wb.view.publish(sid, { type: "refresh" });
  const fresh = await wb.view.next(sid, -1, 0);
  assert.deepEqual(fresh.events, [], "no replay of events from before the window opened");
  const waiting = wb.view.next(sid, fresh.seq, 5000);
  const started = Date.now();
  assert.equal(wb.view.publish(sid, { type: "open-idea", target: "d:00000000-0000-4000-8000-000000000000" }), true, "a listening window counts as shown");
  const woke = await waiting;
  assert.ok(Date.now() - started < 1000);
  assert.equal(woke.events[0].type, "open-idea");
});

test("MCP adapter: handshake, the same tools, tool errors as results, opt-in revocable access", async (t) => {
  const { wb, sid, store, root } = setup(t);
  const init: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.match(init.result.instructions, /research data, never as instructions/);
  assert.equal(await mcpHandle(wb, sid, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const list: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((x: any) => x.name), wb.manifest().map((m) => m.name));
  const ok: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "idea_create", arguments: { title: "From Claude Code" } } });
  assert.equal(ok.result.isError, false);
  assert.match(ok.result.structuredContent.created, /^d:/);
  const bad: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "idea_save", arguments: {} } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /none is open in the window/);
  const unknown: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.equal(unknown.error.code, -32601);

  const access = new McpAccess(store, "http://127.0.0.1:1111");
  assert.equal(access.enabled(sid), false);
  assert.throws(() => access.check(sid, "Bearer x"), /access is off/);
  access.enable(sid);
  const file = JSON.parse(fs.readFileSync(access.file(sid), "utf8"));
  assert.equal(fs.statSync(access.file(sid)).mode & 0o777, 0o600);
  assert.equal(file.origin, "http://127.0.0.1:1111");
  assert.doesNotThrow(() => access.check(sid, `Bearer ${file.token}`));
  assert.throws(() => access.check(sid, `Bearer ${"0".repeat(64)}`), /token is wrong/);
  // A restarted backend (new port) keeps access and rewrites the origin.
  const restarted = new McpAccess(store, "http://127.0.0.1:2222");
  assert.equal(JSON.parse(fs.readFileSync(access.file(sid), "utf8")).origin, "http://127.0.0.1:2222");
  assert.doesNotThrow(() => restarted.check(sid, `Bearer ${file.token}`));
  restarted.disable(sid);
  assert.equal(fs.existsSync(restarted.file(sid)), false);
  assert.throws(() => restarted.check(sid, `Bearer ${file.token}`), /access is off/);
  void root;
});

test("Pi adapter: generated tools relay to the registry and resolve only on the backend's reply", async (t) => {
  const { wb, sid } = setup(t);
  const emitted: any[] = [];
  const calls = new Map();
  const piTools = createWorkbenchTools({ specs: wb.manifest(), instructions: "shared guidance", emit: (e: any) => emitted.push(e), calls });
  assert.equal(piTools.length, wb.manifest().length);
  assert.deepEqual(piTools[0].promptGuidelines, ["shared guidance"]);
  assert.deepEqual(piTools[1].promptGuidelines, [], "guidance once, not per tool");
  assert.deepEqual(piTools[0].parameters, wb.manifest()[0].inputSchema);

  const create = piTools.find((x: any) => x.name === "idea_create");
  const pending = create.execute("call-1", { title: "Via Pi" });
  const request = emitted.at(-1);
  assert.equal(request.type, "workbench_tool_request");
  // The backend side: the relay runs the registry and replies to the host.
  const replies: any[] = [];
  await relayWorkbenchTool(wb, sid, request, { request: async (type: string, body: any) => void replies.push({ type, ...body }) });
  assert.equal(replies[0].type, "workbench_tool_reply");
  assert.equal(resolveToolReply(calls, replies[0]), true);
  const result = await pending;
  assert.match(JSON.parse(result.content[0].text).created, /^d:/);

  const failing = create.execute("call-2", {});
  const replies2: any[] = [];
  await relayWorkbenchTool(wb, sid, emitted.at(-1), { request: async (type: string, body: any) => void replies2.push({ type, ...body }) });
  resolveToolReply(calls, replies2[0]);
  await assert.rejects(failing, /Invalid input for idea_create: title/);

  const controller = new AbortController();
  const aborted = create.execute("call-3", { title: "x" }, controller.signal);
  controller.abort();
  await assert.rejects(aborted, /interrupted/);
  assert.equal(calls.size, 0);
});

test("review tools preserve exact evidence, reject stale preparation, and create citable idea drafts headlessly", async (t) => {
  const { call, sid, store, platform, wb } = setup(t);
  const imported = await call("paper_import", { source: "1206.2305" });
  const note = await call("note_create", { artifactId: imported.artifact.id, page: 1, quote: "growth optimal", comment: "Original comment" });
  const before = await call("reviews_list");
  const input = { revision: before.revision, destination: "Ideas", instruction: "Does the result extend?", annotationIds: [note.noteId] };
  const { review } = await call("review_prepare", input);
  assert.equal(review.status, "draft");
  assert.equal(review.attempts, 0);
  await assert.rejects(call("review_prepare", input), /revision|changed|conflict/i);
  await call("note_update", { noteId: note.noteId, comment: "Changed after snapshot" });
  const { review: copy } = await call("review_duplicate", { revision: store.get(sid).revision, reviewId: review.id, expectedHash: review.hash, instruction: "What about drawdown?" });
  assert.equal(copy.annotations[0].comment, "Original comment");
  assert.notEqual(copy.id, review.id);
  assert.notEqual(copy.hash, review.hash);
  assert.equal((await call("review_get", { reviewId: review.id, expectedHash: review.hash })).instruction, input.instruction);
  await assert.rejects(call("review_get", { reviewId: review.id, expectedHash: "0".repeat(64) }), /not found/);
  const draft = await call("review_create_idea", { reviewId: review.id, expectedHash: review.hash, title: "Extension hypothesis", response: "The assumptions may extend under a drawdown bound." });
  const created = await call("idea_get", { target: draft.target });
  assert.deepEqual(created.content.evidence[0].reference, { id: review.id, hash: review.hash });
  assert.equal(created.content.uncertainty, "conjectured");
  await call("idea_update", { target: draft.target, patch: idea });
  const saved = await call("idea_save", { target: draft.target });
  assert.equal(saved.version, 1, "review reference is valid scientific evidence");
  const viaMcp: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "review_get", arguments: { reviewId: review.id, expectedHash: review.hash } } });
  assert.equal(viaMcp.result.isError, false);
  assert.equal(viaMcp.result.structuredContent.hash, review.hash);
  const capsule = platform.capsule("strategy", sid, { role: "ideas", task: "Assess evidence", selected: [{ id: review.id, hash: review.hash }], unresolved: [], budget: 16384 });
  assert.match(capsule.text, /Original comment/);
  assert.equal(store.get(sid).batches.length, 2);
  assert.ok(platform.strategyView(sid).state.versions.length);
});

test("review deletion checks identity, concurrency, delivery and citations, and leaves sources intact", async t => {
  const { call, sid, store, wb } = setup(t);
  const imported = await call("paper_import", { source: "1206.2305" });
  const note = await call("note_create", { artifactId: imported.artifact.id, page: 1, quote: "growth optimal" });
  const prepare = async () => (await call("review_prepare", { revision: store.get(sid).revision, destination: "Ideas", instruction: "Review to remove", annotationIds: [note.noteId] })).review;
  const review = await prepare();
  const reference = { reviewId: review.id, expectedHash: review.hash };
  const remove = () => call("review_delete", { ...reference, revision: store.get(sid).revision });
  await assert.rejects(call("review_delete", { ...reference, expectedHash: "0".repeat(64), revision: store.get(sid).revision }), /changed|no longer/);
  await assert.rejects(call("review_delete", { ...reference, revision: 0 }), /changed/);
  for (const status of ["pending", "accepted/queued", "working", "delivery-uncertain"] as const) {
    store.delivery(sid, review.id, { status });
    await assert.rejects(remove(), (e: any) => e.refusal?.code === "review-in-flight");
  }
  store.delivery(sid, review.id, { status: "completed" });
  const draft = await call("review_create_idea", { ...reference, title: "Linked draft", response: "Reasoning from this review" });
  await assert.rejects(remove(), (e: any) => e.refusal?.code === "review-draft-cited");
  await call("idea_update", { target: draft.target, patch: idea });
  await call("idea_save", { target: draft.target });
  await assert.rejects(remove(), (e: any) => e.refusal?.code === "cited");
  const unreferenced = await prepare();
  const sources = structuredClone(store.get(sid).artifacts), notes = structuredClone(store.get(sid).annotations);
  const result: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "review_delete", arguments: { reviewId: unreferenced.id, expectedHash: unreferenced.hash, revision: store.get(sid).revision } } });
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.deleted, unreferenced.id);
  assert.equal(store.get(sid).batches.some(b => b.id === unreferenced.id), false);
  assert.deepEqual(store.get(sid).artifacts, sources);
  assert.deepEqual(store.get(sid).annotations, notes);
  assert.ok(store.get(sid).batches.some(b => b.id === review.id));
  assert.equal(wb.manifest().find(t => t.name === "review_delete")!.annotations.destructiveHint, true);
  assert.equal(new Store(store.root).get(sid).batches.some(b => b.id === unreferenced.id), false, "deletion persists after reopening");
});

test("library sections: one registry operation for the window and agents, kept through delete and restore", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const id = (await call("paper_import", { source: "1206.2305" })).artifact.id;
  assert.equal((await call("sources_list")).sources[0].importance, "other", "new sources start in Other");
  const before = await wb.view.next(sid, -1, 0);
  assert.deepEqual(await call("source_importance", { artifactId: id, importance: "primary" }), { artifactId: id, importance: "primary" });
  assert.equal((await call("sources_list")).sources[0].importance, "primary");
  assert.ok((await wb.view.next(sid, before.seq, 0)).events.some((e: any) => e.type === "refresh"), "the window refreshes");
  const artifact = structuredClone(store.get(sid).artifacts[0]);

  await call("source_delete", { artifactId: id });
  await call("source_restore", { artifactId: id });
  assert.equal(store.get(sid).importance![id], "primary", "a restored source keeps its section");
  assert.deepEqual(store.get(sid).artifacts[0], artifact, "sections never change the immutable artifact");

  await call("source_importance", { artifactId: id, importance: "other" });
  assert.deepEqual(store.get(sid).importance, {});
  await assert.rejects(call("source_importance", { artifactId: id, importance: "key" }));
  await assert.rejects(call("source_importance", { artifactId: "00000000-0000-4000-8000-000000000000", importance: "primary" }));
});

test("pursued ideas: pursue stays through revisions (latest version, with where it was decided); revise and reject are answered by a new version", async (t) => {
  const { call, sid, store } = setup(t);
  const imported = (await call("paper_import", { source: "1206.2305" })).artifact;
  const paper = store.get(sid).artifacts.find((a) => a.id === imported.id)!;
  const draft = await call("idea_create", { title: "Kelly with a drawdown cap" });
  await call("idea_update", {
    target: draft.created,
    patch: { ...idea, evidence: [{ category: "cited", reference: { id: paper.id, hash: paper.hash }, description: "Theorem 3.1" }] },
  });
  await call("idea_create", { title: "Still brainstorming" });
  const saved = (await call("idea_save", { target: draft.created })).saved;
  assert.deepEqual((await call("ideas_pursued")).ideas, [], "saved but undecided is not pursued");

  await call("idea_decide", { target: saved, decision: "pursue", reason: "Clean falsification test" });
  let [p] = (await call("ideas_pursued")).ideas;
  assert.equal(p.target, saved);
  assert.deepEqual([p.version, p.pursuedOnVersion, p.reason], [1, 1, "Clean falsification test"]);
  assert.match(p.hash, /^[a-f0-9]{64}$/);
  assert.equal(p.content.evidence[0].source, paper.name, "cited sources are named");

  // Pending edits don't leak into what later stages read.
  await call("idea_update", { target: saved, patch: { horizon: "weekly" } });
  [p] = (await call("ideas_pursued")).ideas;
  assert.equal(p.pendingEdits, true);
  assert.equal(p.content.horizon, "daily", "the saved version, not the edit");

  // Saving v2 keeps it pursued, at v2, and says it was pursued on v1.
  await call("idea_save", { target: saved });
  [p] = (await call("ideas_pursued")).ideas;
  assert.deepEqual([p.version, p.pursuedOnVersion, p.content.horizon, p.pendingEdits], [2, 1, "weekly", false]);
  assert.equal((await call("ideas_list")).ideas.find((i: any) => i.target === saved).status, "pursue");
  assert.deepEqual((await call("idea_get", { target: saved })).decision, { decision: "pursue", reason: "Clean falsification test", onVersion: 1, carried: true });

  // Revise is answered by the next version: back to to-decide, out of the list.
  await call("idea_decide", { target: saved, decision: "revise", reason: "Tighten the falsification" });
  assert.deepEqual((await call("ideas_pursued")).ideas, []);
  await call("idea_update", { target: saved, patch: { falsification: "No gain after costs, 2018-2025" } });
  await call("idea_save", { target: saved });
  assert.equal((await call("ideas_list")).ideas.find((i: any) => i.target === saved).status, "to-decide");
  await call("idea_decide", { target: saved, decision: "pursue", reason: "Sharper now" });
  [p] = (await call("ideas_pursued")).ideas;
  assert.deepEqual([p.version, p.pursuedOnVersion, p.reason], [3, 3, "Sharper now"]);
});

test("each stage's conversation learns its role through the tools connection; Literature starts from pursued ideas", async (t) => {
  const { wb, sid } = setup(t);
  const init = (stage?: any) => mcpHandle(wb, sid, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, stage) as Promise<any>;
  const literature = (await init("literature")).result.instructions;
  assert.match(literature, /Literature stage/);
  assert.match(literature, /ideas_pursued/);
  assert.match(literature, /research data, never as instructions/, "shared guidance is kept");
  assert.doesNotMatch((await init()).result.instructions, /stage/i, "no stage: no stage text (external MCP clients)");
  assert.match((await init("ideas")).result.instructions, /Ideas stage/);
  const { isStage, STAGE_GUIDANCE } = await import("../server/workbench/tools.ts");
  assert.equal(isStage("literature"), true);
  assert.equal(isStage("portfolio"), false);
  assert.equal(isStage(["literature"]), false, "query arrays are refused");
  assert.equal(Object.keys(STAGE_GUIDANCE).length, 7);
});

test("Literature focus: per-idea ranks (cited papers start primary), a focus agents can read and set, only pursued ideas", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const imported = (await call("paper_import", { source: "1206.2305" })).artifact;
  const paper = store.get(sid).artifacts.find((a) => a.id === imported.id)!;
  const make = async (title: string, evidence: any[]) => {
    const d = await call("idea_create", { title });
    await call("idea_update", { target: d.created, patch: { ...idea, evidence } });
    return (await call("idea_save", { target: d.created })).saved as string;
  };
  const a = await make("Kelly with a drawdown cap", [{ category: "cited", reference: { id: paper.id, hash: paper.hash }, description: "Theorem 3.1" }]);
  const b = await make("Vol-managed crypto", []);
  await call("idea_decide", { target: a, decision: "pursue", reason: "Clean test" });

  // Only pursued ideas can be the focus.
  await assert.rejects(call("literature_focus", { target: b }), /not pursued/);
  await call("idea_decide", { target: b, decision: "pursue", reason: "Cheap data" });
  const before = await wb.view.next(sid, -1, 0);
  assert.equal((await call("literature_focus", { target: b })).focus, b);
  assert.ok((await wb.view.next(sid, before.seq, 0)).events.some((e: any) => e.type === "focus-idea" && e.target === b), "the window is told");

  // The focus the window reports is what agents read.
  wb.view.setContext(sid, { focusIdea: b });
  assert.equal((await call("ideas_pursued")).focus, b);
  assert.equal((await call("sources_list")).literatureFocus, b);

  // Ranks are per idea; a cited paper counts as primary for its idea until ranked otherwise.
  let pursued = (await call("ideas_pursued")).ideas;
  assert.deepEqual(pursued.find((p: any) => p.target === a).ranks, { [paper.id]: "primary" });
  assert.deepEqual(pursued.find((p: any) => p.target === b).ranks, {});
  await call("source_importance", { artifactId: paper.id, importance: "secondary", idea: b });
  await call("source_importance", { artifactId: paper.id, importance: "other", idea: a });
  pursued = (await call("ideas_pursued")).ideas;
  assert.deepEqual(pursued.find((p: any) => p.target === a).ranks, { [paper.id]: "other" }, "explicit other overrides cited");
  assert.deepEqual(pursued.find((p: any) => p.target === b).ranks, { [paper.id]: "secondary" });
  assert.equal(store.get(sid).importance?.[paper.id], undefined, "library-wide sections are untouched");
  assert.equal((await call("sources_list", { idea: b })).sources.find((s: any) => s.id === paper.id).ideaRank, "secondary");
  await assert.rejects(call("source_importance", { artifactId: paper.id, importance: "primary", idea: "r:00000000-0000-4000-8000-000000000000" }), /not a saved idea/);

  // A focus that is no longer pursued is not reported.
  await call("idea_decide", { target: b, decision: "reject", reason: "No edge" });
  assert.equal((await call("ideas_pursued")).focus, null);
});

test("notes linked to ideas: stance optional, the version it was judged on, focus default, beside the note (not in it)", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const paper = (await call("paper_import", { source: "1206.2305" })).artifact;
  const d = await call("idea_create", { title: "Kelly with a drawdown cap" });
  await call("idea_update", { target: d.created, patch: idea });
  const kelly = (await call("idea_save", { target: d.created })).saved;
  await call("idea_decide", { target: kelly, decision: "pursue", reason: "Clean test" });
  const note = await call("note_create", { artifactId: paper.id, page: 2, quote: "under a linear drawdown constraint" });

  // No idea and no focus: refused, and nothing is created by a refused note_create either.
  await assert.rejects(call("note_link", { noteId: note.noteId, stance: "supports" }), /no Literature focus/);
  const notesBefore = store.get(sid).annotations.length;
  await assert.rejects(call("note_create", { artifactId: paper.id, page: 1, quote: "growth optimal", stance: "supports" }), /no Literature focus/);
  assert.equal(store.get(sid).annotations.length, notesBefore, "a refused link leaves no unlinked note behind");

  // Focus default; link without a stance, then judge it.
  wb.view.setContext(sid, { focusIdea: kelly });
  assert.deepEqual(await call("note_link", { noteId: note.noteId, stance: "unclassified" }), { noteId: note.noteId, idea: kelly, stance: null, onVersion: 1 });
  await call("note_link", { noteId: note.noteId, stance: "supports" });
  const saved = structuredClone(store.get(sid).annotations.find((n) => n.id === note.noteId));

  // create + link in one call
  const c = await call("note_create", { artifactId: paper.id, page: 1, quote: "growth optimal", comment: "Only under log utility", stance: "refines" });
  assert.deepEqual(c.link, { idea: kelly, stance: "refines", onVersion: 1 });

  // The idea moves on: old links keep their version; re-judging records the new one.
  await call("idea_update", { target: kelly, patch: { horizon: "weekly" } });
  await call("idea_save", { target: kelly });
  let notes = await call("idea_notes", {});
  assert.deepEqual(notes.counts, { supports: 1, contradicts: 0, refines: 1, unclassified: 0 });
  assert.equal(notes.currentVersion, 2);
  assert.deepEqual(notes.notes.map((n: any) => [n.stance, n.onVersion, n.page]), [["supports", 1, 2], ["refines", 1, 1]]);
  await call("note_link", { noteId: c.noteId, stance: "contradicts" });
  notes = await call("idea_notes", { idea: kelly });
  assert.deepEqual(notes.notes.map((n: any) => [n.stance, n.onVersion]), [["supports", 1], ["contradicts", 2]]);
  const listed = (await call("source_notes", { artifactId: paper.id })).notes.find((n: any) => n.id === note.noteId);
  assert.deepEqual(listed.ideas, [{ idea: kelly, title: "Kelly with a drawdown cap", stance: "supports", onVersion: 1, currentVersion: 2 }]);
  assert.deepEqual(store.get(sid).annotations.find((n) => n.id === note.noteId), saved, "the note itself never changes");

  // Links survive a source delete + restore; "none" unlinks.
  await call("source_delete", { artifactId: paper.id });
  await call("source_restore", { artifactId: paper.id });
  assert.equal((await call("idea_notes", {})).total, 2);
  await call("note_link", { noteId: c.noteId, stance: "none" });
  assert.deepEqual((await call("idea_notes", {})).counts, { supports: 1, contradicts: 0, refines: 0, unclassified: 0 });
  await assert.rejects(call("note_link", { noteId: "00000000-0000-4000-8000-000000000000", stance: "supports" }), /Note not found/);
});

test("coverage per idea: papers, notes by stance, and gaps that say what to look for next", async (t) => {
  const { ideaCoverage } = await import("../src/idea-coverage.ts");
  const link = (stance: any, version = 2) => ({ stance, version, hash: "a".repeat(64), at: "2026-09-25T10:00:00Z" });
  const codes = (c: any) => c.gaps.map((g: any) => g.code);
  assert.deepEqual(codes(ideaCoverage({}, [], 1)), ["no-papers", "no-evidence"]);
  assert.equal(ideaCoverage({}, [], 1).next, "Find papers for this idea", "one next step, most fundamental first");
  assert.equal(ideaCoverage({ p1: "primary", p2: "primary" }, [], 1).next, "Read and note evidence in the 2 primary papers");
  const c = ideaCoverage({ p1: "primary", p2: "primary", p3: "secondary", p4: "other" }, [
    { artifactId: "p1", link: link("supports") },
    { artifactId: "p1", link: link("supports", 1) },
    { artifactId: "p3", link: link(null) },
  ], 2);
  assert.deepEqual(c.papers, { primary: 2, secondary: 1, withNotes: 2 });
  assert.deepEqual(c.notes, { supports: 2, contradicts: 0, refines: 0, unclassified: 1, total: 3 });
  assert.equal(c.stale, 1);
  assert.deepEqual(codes(c), ["no-contradicting", "unjudged", "stale", "unread-primary"]);
  assert.equal(c.next, "Look for evidence that could contradict it");
  assert.deepEqual(c.gaps.map((g: any) => g.text), [
    "Supporting evidence only: nothing contradicts it yet",
    "1 note without a stance",
    "1 note judged on an earlier version",
    "1 primary paper without notes",
  ]);
  assert.deepEqual(codes(ideaCoverage({ p1: "primary" }, [{ artifactId: "p1", link: link("supports") }, { artifactId: "p1", link: link("contradicts") }], 2)), [], "balanced and current: no gaps");

  // Through the registry, from real ranks and links.
  const { call, wb, sid } = setup(t);
  const paper = (await call("paper_import", { source: "1206.2305" })).artifact;
  const d = await call("idea_create", { title: "Kelly with a drawdown cap" });
  await call("idea_update", { target: d.created, patch: idea });
  const kelly = (await call("idea_save", { target: d.created })).saved;
  await call("idea_decide", { target: kelly, decision: "pursue", reason: "Clean test" });
  let cov = (await call("ideas_pursued")).ideas[0].coverage;
  assert.deepEqual(codes(cov), ["no-papers", "no-evidence"]);
  wb.view.setContext(sid, { focusIdea: kelly });
  await call("source_importance", { artifactId: paper.id, importance: "primary", idea: kelly });
  await call("note_create", { artifactId: paper.id, page: 2, quote: "under a linear drawdown constraint", stance: "supports" });
  cov = (await call("ideas_pursued")).ideas[0].coverage;
  assert.deepEqual([cov.papers.primary, cov.papers.withNotes, cov.notes.supports], [1, 1, 1]);
  assert.deepEqual(codes(cov), ["no-contradicting"]);
  await call("idea_update", { target: kelly, patch: { horizon: "weekly" } });
  await call("idea_save", { target: kelly });
  assert.deepEqual(codes((await call("ideas_pursued")).ideas[0].coverage), ["no-contradicting", "stale"], "a revision makes earlier judgements stale");
});

test("revise an idea from a note: added as evidence to an unsaved revision (with its stance), never twice, idea stays pursued", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const imported = (await call("paper_import", { source: "1206.2305" })).artifact;
  const paper = store.get(sid).artifacts.find((a) => a.id === imported.id)!;
  const d = await call("idea_create", { title: "Kelly with a drawdown cap" });
  await call("idea_update", { target: d.created, patch: idea });
  const kelly = (await call("idea_save", { target: d.created })).saved;
  await call("idea_decide", { target: kelly, decision: "pursue", reason: "Clean test" });
  wb.view.setContext(sid, { focusIdea: kelly });
  const note = await call("note_create", { artifactId: paper.id, page: 2, quote: "under a linear drawdown constraint", comment: "Only linear floors", stance: "refines" });

  const before = await wb.view.next(sid, -1, 0);
  const r = await call("idea_add_note", { noteId: note.noteId });
  assert.deepEqual([r.idea, r.added, r.evidence], [kelly, true, 1]);
  assert.ok((await wb.view.next(sid, before.seq, 0)).events.some((e: any) => e.type === "open-idea" && e.target === kelly), "the idea is opened");
  const edit = store.ideaBoard(sid).edits[kelly.slice(2)];
  assert.deepEqual(edit.evidence, [{ category: "cited", reference: { id: paper.id, hash: paper.hash }, description: "p. 2: “under a linear drawdown constraint” — Only linear floors (refines)" }]);

  // Not twice; nothing saved; still pursued (the revision is pending).
  assert.equal((await call("idea_add_note", { noteId: note.noteId, show: false })).added, false);
  const [p] = (await call("ideas_pursued")).ideas;
  assert.deepEqual([p.version, p.pendingEdits, p.content.evidence.length], [1, true, 0], "later stages keep reading the saved version");
  await call("idea_save", { target: kelly });
  assert.deepEqual((await call("ideas_pursued")).ideas.map((i: any) => [i.version, i.content.evidence.length]), [[2, 1]], "saving makes it v2, still pursued");

  // Drafts work too; archived ideas are refused; unknown notes are refused.
  const draft = await call("idea_create", { title: "Spin-off" });
  assert.equal((await call("idea_add_note", { noteId: note.noteId, idea: draft.created, show: false })).added, true);
  assert.equal(store.ideaBoard(sid).cards[0].content.evidence.length, 1);
  await wb.applyBoard(sid, { op: "archive", recordId: kelly.slice(2) });
  await assert.rejects(call("idea_add_note", { noteId: note.noteId, idea: kelly }), /archived/);
  await assert.rejects(call("idea_add_note", { noteId: "00000000-0000-4000-8000-000000000000", idea: draft.created }), /Note not found/);
});

test("Research Development through the tools: per-idea workspaces, the window's developing idea, checkpoints; a RD Pi knows its idea", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const mk = async (title: string, pursue: boolean) => {
    const d = await call("idea_create", { title });
    await call("idea_update", { target: d.created, patch: idea });
    const s = (await call("idea_save", { target: d.created })).saved;
    if (pursue) await call("idea_decide", { target: s, decision: "pursue", reason: "Worth building" });
    return s as string;
  };
  const kelly = await mk("Kelly with a drawdown cap", true);
  const later = await mk("Not yet", false);
  await assert.rejects(call("rd_develop", { target: later }), /not pursued/);
  await assert.rejects(call("rd_files", {}), /none is being developed/);

  wb.view.setContext(sid, { developIdea: kelly });
  const listed = await call("rd_files", {});
  assert.equal(listed.idea, kelly);
  assert.deepEqual(listed.files.map((f: any) => f.path).sort(), [".gitignore", "README.md"]);
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", kelly.slice(2));
  fs.writeFileSync(path.join(dir, "fit.py"), "print('fit')\n");
  assert.deepEqual((await call("rd_changes", {})).files, [{ path: "fit.py", status: "A", added: 1, removed: 0, binary: false }]);
  assert.match((await call("rd_diff", { path: "fit.py" })).diff, /\+print\('fit'\)/);
  const cp = await call("rd_checkpoint", { message: "First fit" });
  assert.equal(cp.message, "First fit");
  assert.deepEqual((await call("rd_history", {})).checkpoints.map((c: any) => c.message), ["First fit", "Workspace created"]);
  assert.deepEqual((await call("rd_history", { sha: cp.sha })).files.map((f: any) => f.path), ["fit.py"]);
  assert.match((await call("rd_diff", { path: "fit.py", sha: cp.sha })).diff, /\+print\('fit'\)/);
  assert.equal((await call("rd_read", { path: "fit.py" })).text, "print('fit')\n");
  // Another idea has its own, separate workspace.
  assert.deepEqual((await call("rd_files", { idea: later })).files.map((f: any) => f.path).sort(), [".gitignore", "README.md"]);

  const init: any = await mcpHandle(wb, sid, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "research", kelly);
  assert.match(init.result.instructions, /Research Development stage for one pursued idea/);
  assert.match(init.result.instructions, /develops is “Kelly with a drawdown cap” \(r:[0-9a-f-]+, v1\)/);
});

test("data through the tools: fetch needs an interval for bars; a workspace file registers as a shared snapshot", async (t) => {
  const { call, wb, sid, store } = setup(t);
  await assert.rejects(call("data_fetch", { source: "binance", symbol: "BTCUSDT", start: "2024-01-01", end: "2024-01-02" }), /Give an interval/);
  await assert.rejects(call("data_fetch", { source: "binance", symbol: "BTCUSDT", interval: "7m", start: "2024-01-01", end: "2024-01-02" }), /Intervals/);
  await assert.rejects(call("data_fetch", { source: "binance-archive", symbol: "BTCUSDT", start: "2024-01-01", end: "2024-01-02" }), /Give market/);
  await assert.rejects(call("data_fetch", { source: "binance-archive", market: "spot", dataset: "bookDepth", symbol: "BTCUSDT", start: "2024-01-01", end: "2024-01-02" }), /Spot publishes: trades, aggTrades, klines/);
  const d = await call("idea_create", { title: "Kelly" });
  await call("idea_update", { target: d.created, patch: idea });
  const kelly = (await call("idea_save", { target: d.created })).saved;
  await call("idea_decide", { target: kelly, decision: "pursue", reason: "x" });
  wb.view.setContext(sid, { developIdea: kelly });
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", kelly.slice(2));
  await call("rd_files", {});
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n2024-01-03,2\n");
  const m = await call("data_register", { path: "px.csv", title: "Prices", note: "hand-made" });
  assert.deepEqual([m.name, m.rows, m.source], ["prices", 2, { kind: "file", from: "px.csv", note: "hand-made" }]);
  assert.deepEqual((await call("data_snapshots")).snapshots.map((s: any) => s.name), ["prices"]);
  assert.equal((await call("data_preview", { name: "prices" })).preview.valueColumn, "close");
  await assert.rejects(call("data_register", { path: "../../secret", title: "x" }), /Invalid path|outside/);
});

test("send to production: exact idea version, a clean checkpoint, the snapshots its code used; later commits replace, history kept", async (t) => {
  const { call, wb, sid, store } = setup(t);
  const mk = async (title: string, pursue: boolean) => {
    const d = await call("idea_create", { title });
    await call("idea_update", { target: d.created, patch: idea });
    const s = (await call("idea_save", { target: d.created })).saved;
    if (pursue) await call("idea_decide", { target: s, decision: "pursue", reason: "Convinced" });
    return s as string;
  };
  const kelly = await mk("Age-invariant Kelly", true);
  const other = await mk("Not pursued", false);
  await assert.rejects(call("production_commit", { idea: other }), /not pursued/);
  wb.view.setContext(sid, { developIdea: kelly });
  await call("rd_files", {});
  const dir = path.join(store.storage.strategyRoot(sid), "Research-Workspaces", kelly.slice(2));
  // Two snapshots; the code reads one of them.
  fs.writeFileSync(path.join(dir, "px.csv"), "date,close\n2024-01-02,1\n");
  fs.writeFileSync(path.join(dir, "fx.csv"), "date,value\n2024-01-02,1\n");
  await call("data_register", { path: "px.csv", title: "Prices" });
  await call("data_register", { path: "fx.csv", title: "FX" });
  fs.writeFileSync(path.join(dir, "fit.py"), 'import polars as pl\npl.read_csv("data/prices.csv")\n');
  await assert.rejects(call("production_commit", {}), /not yet checkpointed/);
  const preview = await call("production_preview", {});
  assert.ok(preview.pending > 0);
  assert.deepEqual(Object.fromEntries(preview.snapshots.map((s: any) => [s.name, s.referenced])), { fx: false, prices: true }, "the code reads prices only");
  const cp = await call("rd_checkpoint", { message: "Fit and report" });
  const c = await call("production_commit", { note: "Positive enough to continue" });
  assert.deepEqual([c.idea, c.title, c.version, c.checkpoint, c.checkpointMessage, c.snapshots.map((s: any) => s.name), c.note], [kelly, "Age-invariant Kelly", 1, cp.sha, "Fit and report", ["prices"], "Positive enough to continue"]);
  assert.match(c.snapshots[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await call("production_status")).current.checkpoint, cp.sha);
  // A later commit (new idea version) replaces it; the first is kept.
  await call("idea_update", { target: kelly, patch: { horizon: "weekly" } });
  await call("idea_save", { target: kelly });
  const c2 = await call("production_commit", { snapshots: ["prices", "fx"] });
  assert.deepEqual([c2.version, c2.snapshots.map((s: any) => s.name)], [2, ["prices", "fx"]]);
  assert.deepEqual((await call("production_status")).earlier, 1);
  assert.equal(store.get(sid).production!.history[0].version, 1);
  await assert.rejects(call("production_commit", { snapshots: ["nope"] }), /Snapshot nope not found/);
});
