import { Store } from "../server/store.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
