import test from "node:test";
import assert from "node:assert/strict";
import { emptyView, storableView, type ViewState } from "../desktop/contracts.ts";
import { ViewWriter } from "../src/native.tsx";
import { assertSender, UntrustedSender } from "../desktop/security.ts";

const id = "4add259b-a9e2-450f-a9c4-a7c9a0eaa31b";
const base = (): ViewState => ({
  ...emptyView(),
  stage: "ideas",
  drafts: { ideas: "composer text" },
  layouts: { ideas: { split: 0.5, tabs: { c: "sources" } }, code: { split: 0.4 } },
  companion: { open: [id], pinned: [], active: id },
  researchDrafts: { "ideas:board": '{"v":1}', [`artifact:${id}`]: '{"page":3}' },
});

test("a valid window snapshot is stored unchanged", () => {
  const { value, skipped } = storableView(base());
  assert.deepEqual(value, base());
  assert.deepEqual(skipped, []);
});

test("one invalid part never blocks the save: it is left out and named, everything else is kept", () => {
  const bad: any = base();
  bad.layouts.ideas.split = 0.05;
  bad.researchDrafts["x".repeat(130)] = "too long a key";
  bad.researchDrafts["ideas:big"] = "y".repeat(500001);
  bad.drafts.nonsense = "not a stage";
  bad.companion.open.push("not-a-uuid");
  const { value, skipped } = storableView(bad);
  assert.deepEqual(skipped.sort(), ["companion", "drafts.nonsense", "layouts.ideas", `researchDrafts.${"x".repeat(130)}`, "researchDrafts.ideas:big"].sort());
  assert.deepEqual(value.layouts, { code: { split: 0.4 } });
  assert.deepEqual(value.researchDrafts, base().researchDrafts, "valid drafts survive");
  assert.deepEqual(value.drafts, { ideas: "composer text" });
  assert.equal(value.companion, undefined);
  assert.equal(bad.layouts.ideas.split, 0.05, "the live state is not mutated");

  const many: any = { ...base(), researchDrafts: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${i}`, "v"])) };
  const trimmed = storableView(many);
  assert.equal(Object.keys(trimmed.value.researchDrafts!).length, 30);
  assert.deepEqual(trimmed.skipped, ["researchDrafts"]);

  assert.throws(() => storableView({ ...base(), stage: "nowhere" }), "core fields must be valid");
});

test("the writer stores the repaired snapshot, reports what it skipped, and a failed view save never blocks research writes", async () => {
  const sent: ViewState[] = [];
  const writer = new ViewWriter({ saveView: async (s) => void sent.push(s) });
  const bad: any = base();
  bad.layouts.ideas.zoom = "z";
  await writer.save(bad);
  assert.deepEqual(writer.skipped, ["layouts.ideas"]);
  assert.equal(sent[0].layouts?.ideas, undefined);
  await writer.save(base());
  assert.deepEqual(writer.skipped, []);

  // Saving the view fails outright (e.g. storage or window check): notes and
  // other research writes still go ahead instead of failing with it.
  const failing = new ViewWriter({ saveView: async () => { throw new Error("Window state could not be saved"); } });
  void failing.save(base()).catch(() => {});
  await failing.beforeResearchWrite();
  // …but a closing window still refuses new research writes.
  failing.setSnapshot(() => base());
  void failing.prepare().catch(() => {});
  await assert.rejects(failing.beforeResearchWrite(), /View is closing/);
});

test("sender rejections name the failed check", () => {
  const ok = { registered: true, destroyed: false, sessionMatches: true, mainFrame: true, url: `pi-research://app/strategy/${id}`, scope: { kind: "strategy" as const, id } };
  assert.doesNotThrow(() => assertSender(ok));
  const reason = (patch: object) => {
    try {
      assertSender({ ...ok, ...patch });
    } catch (e) {
      assert.ok(e instanceof UntrustedSender);
      return e.reason;
    }
  };
  assert.equal(reason({ registered: false }), "unregistered");
  assert.equal(reason({ destroyed: true }), "destroyed");
  assert.equal(reason({ sessionMatches: false }), "session");
  assert.equal(reason({ mainFrame: false }), "frame");
  assert.equal(reason({ url: ok.url + "#note" }), "url");
});
