import test from "node:test";
import assert from "node:assert/strict";
import { conversationFor } from "../src/workbench-contract.ts";
import { fixture } from "./platform-fixtures.ts";
import { Workbench } from "../server/workbench/tools.ts";
import { mcpHandle } from "../server/workbench/mcp.ts";

const A = "r:11111111-1111-4111-8111-111111111111";
const B = "r:22222222-2222-4222-8222-222222222222";

test("one conversation per idea: Develop, a focused Explore and Release share it", () => {
  const view = { pursued: [{ target: A }, { target: B }], production: { current: { idea: B } } };
  const current = { "idea:current": A };
  assert.equal(conversationFor("research", view, current), `research:${A.slice(2)}`);
  assert.equal(conversationFor("literature", view, current), `research:${A.slice(2)}`, "Explore focused on the current idea");
  assert.equal(conversationFor("literature", view, { ...current, "literature:overview": "1" }), "literature", "the overview keeps its own");
  assert.equal(conversationFor("data", view, current), `research:${B.slice(2)}`, "Release: the candidate's idea");
  assert.equal(conversationFor("data", { pursued: view.pursued }, current), "data");
  assert.equal(conversationFor("ideas", view, current), "ideas");
  assert.equal(conversationFor("research", { pursued: [] }, {}), null);
  assert.equal(conversationFor("research", view, {}), `research:${A.slice(2)}`, "first pursued idea by default");
});

test("an idea's conversation is told it spans the stages", async (t) => {
  const x = fixture(t);
  const s = x.store.create("Guidance");
  const wb = new Workbench(x.store, x.platform, undefined, 0);
  t.after(() => wb.close());
  const init: any = await mcpHandle(wb, s.id, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "research", A);
  const text = init.result.instructions as string;
  assert.match(text, /follows it through the stages: Explore/);
  assert.match(text, /In Explore: This conversation is the Explore stage/);
  assert.match(text, /In Develop: This conversation is the Develop stage/);
  assert.match(text, /In Release: This conversation is the Release stage/);
  const plain: any = await mcpHandle(wb, s.id, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "ideas");
  assert.doesNotMatch(plain.result.instructions, /follows it through the stages/);
});
