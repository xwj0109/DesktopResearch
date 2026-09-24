import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { ResearchProvider } from "../src/workbench/research";
import { IdeaBoard } from "../src/workbench/panes/IdeaBoard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, setTimeout };
(globalThis as any).document = { activeElement: null, getElementById() { return null; } };

const paper = { id: "aaaaaaaa-1111-4111-8111-111111111111", hash: "a".repeat(64), name: "Kardaras et al. 2012 - The numeraire property (arXiv 1206.2305).pdf", bytes: 1, kind: "pdf", mime: "application/pdf", created: "2026-09-23T10:00:00Z" };
const note = { id: "bbbbbbbb-2222-4222-8222-222222222222", artifactId: paper.id, anchor: { page: 6, quote: "growth-optimality is taken up in Theorem 3.1" }, comment: "key result", status: "draft" };
const full = { title: "Kelly on BTC with a drawdown cap", rationale: "Growth-optimal sizing under a drawdown floor", universe: "BTC-USD daily", horizon: "daily rebalance", falsification: "No improvement over buy-hold after costs", uncertainty: "conjectured", evidence: [{ category: "cited", reference: { id: "", hash: "" }, description: "" }] };

/** In-memory backend: version.create / idea.decide, exact-version reads. */
function harness(initialDrafts: Record<string, string>) {
  const commands: any[] = [];
  const blobs = new Map<string, any>();
  let n = 0;
  let view: any = { revision: 1, artifacts: [paper], annotations: [note], batches: [], ideas: { cards: [], edits: {}, archived: [] }, science: { revision: 1, state: { versions: [], decisions: [], approvals: [] } } };
  const ops: any[] = [];
  /** The backend's board operations (server/workbench/tools.ts applyBoard). */
  const applyOp = (b: any, op: any) => {
    const saved = (id: string) => {
      const v = view.science.state.versions.filter((x: any) => x.id === id).sort((a: any, c: any) => c.version - a.version)[0];
      return blobs.get(v.hash);
    };
    if (op.op === "create") b.cards.unshift({ key: op.key, content: op.content, updated: new Date().toISOString() });
    if (op.op === "patch") {
      const id = op.target.slice(2);
      if (op.target.startsWith("d:")) {
        const c = b.cards.find((x: any) => x.key === id);
        if (!c) throw new Error("Draft not found");
        c.content = { ...c.content, ...op.patch };
      } else {
        const next = { ...(b.edits[id] ?? saved(id)), ...op.patch };
        if (JSON.stringify(next) === JSON.stringify(saved(id))) delete b.edits[id];
        else b.edits[id] = next;
      }
    }
    if (op.op === "delete") b.cards = b.cards.filter((x: any) => x.key !== op.key);
    if (op.op === "restore") b.cards.splice(op.index, 0, op.card);
    if (op.op === "discard") delete b.edits[op.recordId];
    if (op.op === "archive") b.archived.push(op.recordId);
    if (op.op === "unarchive") b.archived = b.archived.filter((x: string) => x !== op.recordId);
    if (op.op === "adopt") {
      b.cards.push(...op.board.cards);
      Object.assign(b.edits, op.board.edits);
      b.archived.push(...op.board.archived);
    }
    return b;
  };
  let setViewOuter: (v: any) => void = () => {};
  let drafts = { ...initialDrafts };
  const options = { refuseDelete: false };
  const client = {
    bytes: () => new Promise(() => {}),
    read: async (path: string) => {
      if (path === "/native/research") return view;
      const [, , , id, hash] = path.split("/");
      return { value: { kind: "idea", content: blobs.get(hash) }, meta: { id, version: 1 } };
    },
    write: async (path: string, body: any) => {
      if (path === "/native/ideas") {
        ops.push(body);
        view = { ...view, ideas: applyOp(structuredClone(view.ideas), body) };
        return { ideas: view.ideas };
      }
      const c = body.command;
      commands.push(c);
      const s = structuredClone(view.science.state);
      if (c.type === "version.create") {
        const id = c.id ?? `cccccccc-3333-4333-8333-${String(++n).padStart(12, "0")}`;
        const hash = (n + commands.length).toString(16).padStart(64, "0");
        blobs.set(hash, c.value.content);
        s.versions.push({ id, hash, kind: "idea", version: s.versions.filter((v: any) => v.id === id).length + 1, created: new Date(Date.now() + commands.length * 1000).toISOString() });
      }
      if (c.type === "idea.delete") {
        if (options.refuseDelete) throw Object.assign(new Error("refused"), { status: 409, refusal: { code: "cited", records: ["idea v1 (1a2b3c4d)"] } });
        s.versions = s.versions.filter((v: any) => v.id !== c.id);
        s.decisions = s.decisions.filter((d: any) => d.target.id !== c.id);
      }
      if (c.type === "idea.decide") s.decisions.push({ id: String(commands.length), target: c.target, decision: c.decision, reason: c.reason, at: new Date(Date.now() + commands.length * 1000).toISOString() });
      view = { ...view, science: { revision: view.science.revision + 1, state: s } };
      return {};
    },
    bridge: {},
  };
  const composer: string[] = [];
  function Host() {
    const [v, setV] = React.useState<any>(view);
    const [d, setD] = React.useState<Record<string, string>>(drafts);
    setViewOuter = setV;
    const scope: any = {
      client, portfolio: false, stage: "ideas", view: v, loadError: "",
      refresh: async () => setV(view),
      drafts: d,
      setDraft: (key: string, value: string) =>
        setD((old) => {
          const next = { ...old };
          if (value) next[key] = value;
          else delete next[key];
          drafts = next;
          return next;
        }),
      setComposer() {}, appendComposer: (t: string) => composer.push(t),
      companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><IdeaBoard /></ResearchProvider>;
  }
  return { Host, commands, composer, options, ops, board: () => view.ideas, drafts: () => drafts, refresh: () => setViewOuter(view) };
}

test("idea board: brainstorm freely, save, decide with a reason, revise, cite highlights, archive", async (t) => {
  const h = harness({ "ideas:idea": JSON.stringify({ nativeDraft: 1, content: full }) });
  let r: ReturnType<typeof create>;
  await act(() => { r = create(<h.Host />); });
  t.after(() => act(() => r!.unmount()));
  await act(() => new Promise((res) => setTimeout(res, 0)));
  const root = r!.root;
  const text = (node: any): string => (typeof node === "string" ? node : (node.children ?? []).map(text).join(""));
  const all = () => text(r!.toJSON() as any) + JSON.stringify(r!.toJSON());
  const button = (label: string, within: any = root) => {
    const b = within.findAll((n: any) => n.type === "button" && (text(n) === label || n.props["aria-label"] === label))[0];
    assert.ok(b, `button ${label}`);
    return b;
  };
  const click = (label: string, within?: any) => act(async () => button(label, within).props.onClick({ stopPropagation() {} }));
  const column = (name: string) => root.find((n) => n.type === "section" && n.props["aria-label"] === name);
  const cardsIn = (name: string) => column(name).findAll((n) => n.type === "article").map((a) => text(a.findByType("h4")));
  const openCard = (title: string) => act(async () => root.find((n) => n.type === "article" && text(n).includes(title)).props.onClick());
  const field = (label: string) => root.find((n) => (n.type === "input" || n.type === "textarea") && n.props["aria-label"] === label);
  const type = (label: string, value: string) => act(async () => field(label).props.onChange({ target: { value } }));

  // The old single-form draft is adopted into the backend board; the legacy slot is freed.
  assert.deepEqual(cardsIn("Brainstorm"), [full.title]);
  assert.equal(h.drafts()["ideas:idea"], undefined);
  assert.equal(h.ops[0].op, "adopt");
  assert.equal(h.board().cards[0].content.title, full.title);

  // New idea opens straight into the editor and autosaves.
  await click("+ New idea");
  await type("Title", "Vol-targeted momentum");
  assert.equal(h.ops.at(-1).op, "create", "typing is debounced, not sent per keystroke");
  // Saving an empty idea shows what's missing, inline, and sends nothing.
  await click("Save idea");
  assert.equal(h.commands.length, 0);
  assert.ok(root.findAll((n) => n.props.className === "fld-error" && text(n) === "required").length >= 4);
  await click("← Board");
  await act(() => new Promise((res) => setTimeout(res, 0)));
  assert.deepEqual(h.ops.at(-1).patch, { title: "Vol-targeted momentum" }, "leaving the editor sends only changed fields");
  assert.equal(h.board().cards.find((c: any) => c.content.title === "Vol-targeted momentum")?.content.title, "Vol-targeted momentum");
  assert.deepEqual(cardsIn("Brainstorm").sort(), [full.title, "Vol-targeted momentum"].sort());

  // Delete a draft, then undo.
  const momentum = root.find((n) => n.type === "article" && text(n).includes("Vol-targeted"));
  await click("Delete", momentum);
  assert.deepEqual(cardsIn("Brainstorm"), [full.title]);
  await click("Undo");
  assert.equal(cardsIn("Brainstorm").length, 2);

  // Cite a highlight, then save: the blank evidence row is dropped, the cited one kept.
  await openCard(full.title);
  await click("+ From my highlights");
  await act(async () => root.find((n) => n.props.role === "option" && text(n).includes("Theorem 3.1")).props.onClick());
  assert.equal(field("Evidence 2 description").props.value, "p. 6: “growth-optimality is taken up in Theorem 3.1” — key result");
  await click("Save idea");
  const created = h.commands.at(-1);
  assert.equal(created.type, "version.create");
  assert.equal(created.id, undefined, "first version gets a new record");
  assert.deepEqual(created.value.content.evidence, [{ category: "cited", reference: { id: paper.id, hash: paper.hash }, description: "p. 6: “growth-optimality is taken up in Theorem 3.1” — key result" }]);
  assert.match(all(), /saved v1/, "editor follows the draft to its saved record");
  await click("← Board");
  assert.deepEqual(cardsIn("To decide"), [full.title]);
  assert.deepEqual(cardsIn("Brainstorm"), ["Vol-targeted momentum"]);

  // Decide from the card: a reason is required, then it moves to Pursue.
  const saved = () => root.find((n) => n.type === "article" && text(n).includes(full.title));
  await click("Decide", saved());
  await click("pursue", saved());
  assert.equal(button("pursue", saved().find((n) => n.type === "form")).props.disabled, true, "no reason, no decision");
  await act(async () => saved().find((n) => n.type === "input").props.onChange({ target: { value: "Clean falsification test" } }));
  await act(async () => saved().find((n) => n.type === "form").props.onSubmit({ preventDefault() {} }));
  const decided = h.commands.at(-1);
  assert.deepEqual([decided.type, decided.decision, decided.reason], ["idea.decide", "pursue", "Clean falsification test"]);
  assert.deepEqual(cardsIn("Pursue"), [full.title]);

  // Editing a saved idea keeps a pending next version until saved.
  await openCard(full.title);
  await type("Horizon", "weekly rebalance");
  assert.match(all(), /unsaved changes to v1/);
  await click("Save version 2");
  assert.equal(h.commands.at(-1).id, "cccccccc-3333-4333-8333-000000000001", "v2 continues the same record");
  assert.equal(h.commands.at(-1).value.content.horizon, "weekly rebalance");
  assert.match(all(), /saved v2/);
  await click("← Board");
  assert.deepEqual(cardsIn("To decide"), [full.title], "a new version needs a new decision");

  // Ask Pi only fills the composer.
  await click("Ask Pi", saved());
  assert.match(h.composer[0], /^Idea: Kelly on BTC with a drawdown cap\n/);
  assert.match(h.composer[0], /Horizon: weekly rebalance/);

  // Saved ideas are archived (not deleted) and can be restored.
  await click("Archive", saved());
  assert.deepEqual(cardsIn("To decide"), []);
  await click("Show archived");
  await click("Restore");
  assert.deepEqual(cardsIn("To decide"), [full.title]);

  // Dragging a draft onto Pursue saves it, then asks why.
  await openCard("Vol-targeted momentum");
  for (const [label, value] of [["Rationale", "r"], ["Universe", "u"], ["Horizon", "h"], ["Falsification", "f"]]) await type(label, value);
  await click("← Board");
  const before = h.commands.length;
  const dt = { data: "", types: ["text/x-idea"], getData() { return this.data; }, setData(_: string, v: string) { this.data = v; } };
  await act(async () => root.find((n) => n.type === "article" && text(n).includes("Vol-targeted")).props.onDragStart({ dataTransfer: dt }));
  await act(async () => column("Pursue").props.onDrop({ preventDefault() {}, dataTransfer: dt }));
  assert.equal(h.commands.length, before + 1);
  assert.equal(h.commands.at(-1).type, "version.create");
  const prompt = root.find((n) => n.type === "input" && n.props["aria-label"] === "Reason to pursue");
  assert.ok(prompt, "reason prompt on the newly saved card");
  assert.equal(h.board().cards.length, 0, "no drafts left");
});

test("idea board: an archived idea can be deleted for good after confirming; a cited one explains why not", async (t) => {
  const h = harness({ "ideas:idea": JSON.stringify({ nativeDraft: 1, content: { ...full, evidence: [] } }) });
  let r: ReturnType<typeof create>;
  await act(() => { r = create(<h.Host />); });
  t.after(() => act(() => r!.unmount()));
  await act(() => new Promise((res) => setTimeout(res, 0)));
  const root = r!.root;
  const text = (node: any): string => (typeof node === "string" ? node : (node.children ?? []).map(text).join(""));
  const click = (label: string) =>
    act(async () => root.findAll((n: any) => n.type === "button" && (text(n) === label || n.props["aria-label"] === label))[0].props.onClick({ stopPropagation() {} }));
  const has = (s: string) => JSON.stringify(r!.toJSON()).includes(s);

  // Sections collapse and expand from their headers.
  const head = () => root.find((n) => n.type === "button" && n.props.className === "group-head" && text(n).includes("Brainstorm"));
  await act(async () => head().props.onClick());
  assert.equal(head().props["aria-expanded"], false);
  assert.equal(root.findAll((n) => n.type === "article").length, 0);
  await act(async () => head().props.onClick());
  assert.equal(root.findAll((n) => n.type === "article").length, 1);

  await act(async () => root.find((n) => n.type === "article").props.onClick());
  await click("Save idea");
  await click("Archive");
  assert.equal(root.findAll((n) => n.type === "article").length, 0);
  await click("Show archived");
  await click("Delete…");
  assert.match(text(root.find((n) => n.props.role === "alertdialog")), /Erases its only version and the decisions on it\. This can't be undone\./);

  // Cited elsewhere: refused with the reason; the idea stays archived.
  h.options.refuseDelete = true;
  await click("Delete");
  assert.ok(has("is cited by idea v1 (1a2b3c4d)"));
  assert.equal(h.commands.at(-1).type, "idea.delete");

  h.options.refuseDelete = false;
  await click("Delete…");
  await click("Delete");
  assert.deepEqual(h.commands.at(-1), { type: "idea.delete", id: "cccccccc-3333-4333-8333-000000000001" });
  assert.ok(has("permanently"));
  assert.equal(root.findAll((n) => n.props["aria-label"] === "Archived").length, 0, "archive fold gone");
  assert.deepEqual(h.board().archived, []);
});
