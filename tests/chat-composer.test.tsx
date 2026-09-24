import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { allCommands, hint, parseCommand, resolveModel, suggest } from "../src/workbench/composer-hints";
import { composeChatMessage, fileAttachment, sourceAttachment, splitChatMessage } from "../src/chat-attachment";
import { composeReviewMessage } from "../src/review-attachment";
import { ChatComposer } from "../src/workbench/ChatComposer";
import { ResearchProvider } from "../src/workbench/research";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const models = [
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5" },
  { id: "gpt-5", provider: "openai", name: "GPT-5" },
];
const runtime = [{ name: "summarize", description: "Summarize a document" }, { name: "model", description: "runtime clash" }];
const commands = allCommands(runtime);
const paper = { id: "aaaaaaaa-1111-4111-8111-111111111111", hash: "a".repeat(64), name: "Kardaras 2012 - The numeraire property.pdf", bytes: 1, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" };
const ctx = { commands, models, thinking: ["off", "low", "high"], sources: [paper] };

test("suggestions: / lists commands (app first, runtime clashes lose), arguments complete, @ finds sources", () => {
  const all = suggest("/", 1, ctx);
  assert.equal(all.items[0].label, "/model");
  assert.equal(all.items.filter((s) => s.label === "/model").length, 1, "app command wins a name clash");
  assert.ok(all.items.some((s) => s.label === "/summarize" && s.tag === "runtime"));
  assert.deepEqual(suggest("/sum", 4, ctx).items.map((s) => s.insert), ["/summarize "]);
  assert.deepEqual(suggest("/model gpt", 10, ctx).items.map((s) => s.insert), ["/model openai/gpt-5"]);
  assert.deepEqual(suggest("/thinking h", 11, ctx).items.map((s) => s.label), ["high"]);
  const at = suggest("compare with @numer", 19, ctx);
  assert.equal(at.items[0].sourceId, paper.id);
  assert.equal(at.from, 13);
  assert.deepEqual(suggest("hello world", 11, ctx).items, []);
  assert.deepEqual(suggest("email me@host", 13, ctx).items, [], "@ inside a word is not a mention");
});

test("commands parse, hints read like a CLI, models resolve by id, provider/id or name", () => {
  assert.deepEqual(parseCommand("/summarize the paper", commands)?.args, "the paper");
  assert.equal(parseCommand("not a command", commands), undefined);
  assert.equal(hint("", false, commands).text, "/ commands · @ attach a source · drop, paste or 📎 files · Enter send · Shift+Enter new line");
  assert.equal(hint("/", true, commands).text, "↑↓ choose · tab complete · ⏎ accept · esc dismiss");
  assert.equal(hint("/model ", false, commands).text, "/model <model> — Switch the model · Enter run");
  assert.deepEqual(hint("/nope", false, commands), { text: "unknown command /nope · type / to list commands", tone: "warn" });
  assert.equal(resolveModel("openai/gpt-5", models)?.id, "gpt-5");
  assert.equal(resolveModel("Claude Sonnet 5", models)?.id, "claude-sonnet-5");
  assert.equal(resolveModel("sonnet", models)?.id, "claude-sonnet-5");
  assert.equal(resolveModel("", models), undefined);
});

test("attachments are portable text envelopes that round-trip with review attachments", () => {
  const review = { kind: "research-review" as const, id: "10000000-0000-4000-8000-000000000001", hash: "b".repeat(64), title: "Compare", passages: 1, papers: 1, content: "evidence" };
  const file = fileAttachment("notes.md", "text/markdown", "a\n\n[/Chat attachment] b");
  const message = composeChatMessage("Look at these", [sourceAttachment(paper), file], [review]);
  assert.match(message, /Read it with paper_read \/ paper_find using that artifactId/, "any runtime can act on a source reference");
  const back = splitChatMessage(message);
  assert.equal(back.text, "Look at these");
  assert.equal(back.attachments.length, 2);
  assert.equal(back.reviews[0].content, "evidence");
  assert.match((back.attachments[1] as any).content, /^a\n\n\[\/Chat attachment​\] b$/, "content cannot close its envelope");
  // Text appended later (e.g. Ask Pi) stays a clean paragraph.
  assert.equal(splitChatMessage(composeChatMessage("", [sourceAttachment(paper)]) + "\nappended").text, "appended");
  assert.equal((fileAttachment("big.txt", "text/plain", "x".repeat(200), 50) as { truncated: boolean }).truncated, true);
});

function mount(t: any, initial = "", options: { connected?: boolean; running?: boolean; history?: string[] } = {}) {
  const ops: any[] = [];
  let draft = initial;
  let setOuter: (d: string) => void = () => {};
  let result = true;
  function Host() {
    const [d, setD] = React.useState(initial);
    setOuter = setD;
    const scope: any = { view: { artifacts: [paper] }, client: {}, refresh: async () => {} };
    return (
      <ResearchProvider value={scope}>
        <ChatComposer
          draft={d}
          onDraft={(v) => { draft = v; setD(v); }}
          busy={false}
          running={options.running ?? false}
          promptHistory={options.history}
          connected={options.connected ?? true}
          canSend={!options.running}
          context="Test / Ideas"
          saveStatus="Saved"
          models={models}
          thinking="low"
          thinkingLevels={["off", "low", "high"]}
          commands={runtime}
          act={async (op) => { ops.push(op); return result; }}
        />
      </ResearchProvider>
    );
  }
  let r: ReturnType<typeof create>;
  act(() => { r = create(<Host />); });
  t.after(() => act(() => r!.unmount()));
  const root = () => r!.root;
  const input = () => root().findByProps({ id: "live-draft" });
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const type = (value: string) => act(async () => input().props.onChange({ target: { value, selectionStart: value.length } }));
  const key = (k: string, mods: any = {}) => act(async () => input().props.onKeyDown({ key: k, preventDefault() {}, ...mods }));
  const menu = () => root().findAll((n) => n.props.role === "option").map((n) => text(n.findAll((c) => c.props.className === "label")[0]));
  const hintText = () => text(root().find((n) => typeof n.props.className === "string" && n.props.className.startsWith("composer-hint")));
  return { ops, draft: () => draft, type, key, menu, hintText, input, root, text, fail: () => (result = false), setOuter };
}

test("composer: typing / opens the command list, Tab completes, Enter runs the command and clears it", async (t) => {
  const c = mount(t);
  assert.equal(c.root().findAll((n) => n.props["aria-label"] === "Installed Pi command").length, 0, "the separate command box is gone");
  await c.type("/");
  assert.equal(c.menu()[0], "/model");
  assert.ok(c.menu().includes("/summarize"));
  assert.equal(c.hintText(), "↑↓ choose · tab complete · ⏎ accept · esc dismiss");
  await c.type("/su");
  await c.key("Tab");
  assert.equal(c.input().props.value, "/summarize ");
  assert.match(c.hintText(), /^\/summarize \[args\] — Summarize a document · Enter run$/);
  await c.type("/summarize the numeraire paper");
  await c.key("Enter", { metaKey: true });
  assert.deepEqual(c.ops.at(-1), { type: "command", name: "summarize", args: "the numeraire paper" });
  assert.equal(c.draft(), "", "a run command is cleared");
});

test("composer: app commands map to generic operations; unknown commands are explained, not sent", async (t) => {
  const c = mount(t);
  await c.type("/model sonnet");
  await c.key("Enter", { metaKey: true });
  assert.deepEqual(c.ops.at(-1), { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });
  await c.type("/thinking high");
  await c.key("Enter", { metaKey: true });
  assert.deepEqual(c.ops.at(-1), { type: "set_thinking", level: "high" });
  await c.type("/cancel");
  await c.key("Enter", { metaKey: true });
  assert.deepEqual(c.ops.at(-1), { type: "cancel" });
  const before = c.ops.length;
  await c.type("/nope");
  assert.match(c.hintText(), /unknown command \/nope/);
  await c.key("Enter", { metaKey: true });
  assert.equal(c.ops.length, before);
  assert.match(c.hintText(), /Unknown command \/nope/);
  // A failed command keeps its text.
  c.fail();
  await c.type("/summarize x");
  await c.key("Enter", { metaKey: true });
  assert.equal(c.input().props.value, "/summarize x");
});

test("composer: @ attaches a library source as a chip; files attach; images travel as portable images", async (t) => {
  const c = mount(t);
  await c.type("compare with @numer");
  assert.deepEqual(c.menu(), [paper.name]);
  await c.key("Enter");
  assert.equal(c.input().props.value, "compare with ");
  const parts = splitChatMessage(c.draft());
  assert.deepEqual(parts.attachments.map((a) => a.kind === "source" && a.id), [paper.id]);
  assert.ok(c.root().findAll((n) => n.props.className === "chat-chip source").length === 1);

  const picker = c.root().find((n) => n.type === "input" && n.props.type === "file");
  const md = new File(["# Notes\nthe drawdown floor"], "notes.md", { type: "text/markdown" });
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "chart.png", { type: "image/png" });
  const exe = new File(["x"], "tool.exe", { type: "application/octet-stream" });
  await act(async () => { picker.props.onChange({ target: { files: [md, png, exe], value: "" } }); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(splitChatMessage(c.draft()).attachments.map((a) => a.name), [paper.name, "notes.md"]);
  assert.equal(c.root().findAll((n) => n.props.className === "chat-chip image").length, 1);
  assert.match(c.hintText(), /tool\.exe: unsupported type/);

  await c.key("Enter", { metaKey: true });
  const sent = c.ops.at(-1);
  assert.equal(sent.type, "prompt");
  assert.equal(splitChatMessage(sent.message).attachments.length, 2);
  assert.deepEqual(sent.images, [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  assert.equal(c.root().findAll((n) => n.props.className === "chat-chip image").length, 0, "images clear after an acknowledged send");
});

test("composer: review attachments from the review tray still compose with chat attachments", async (t) => {
  const review = { kind: "research-review" as const, id: "10000000-0000-4000-8000-000000000001", hash: "b".repeat(64), title: "Compare", passages: 1, papers: 1, content: "evidence" };
  const c = mount(t, composeReviewMessage("", [review]));
  await c.type("my question");
  const parts = splitChatMessage(c.draft());
  assert.equal(parts.text, "my question");
  assert.equal(parts.reviews[0].id, review.id);
});


test("Pi editor keys: Enter sends, Shift+Enter and IME do not, thinking cycles, Ctrl+C preserves copying", async t => {
  const c = mount(t, "Draft");
  await c.key("Enter", { shiftKey: true, currentTarget: { selectionStart: 5, selectionEnd: 5 } });
  await c.key("Enter", { nativeEvent: { isComposing: true } });
  assert.equal(c.ops.length, 0);
  await c.key("Enter");
  assert.deepEqual(c.ops[0], { type: "prompt", message: "Draft\n" });
  await c.key("Tab", { shiftKey: true });
  assert.deepEqual(c.ops[1], { type: "set_thinking", level: "high" });
  await c.key("c", { ctrlKey: true, currentTarget: { selectionStart: 0, selectionEnd: 2 } });
  assert.equal(c.draft(), "Draft\n");
  await c.key("c", { ctrlKey: true, currentTarget: { selectionStart: 2, selectionEnd: 2 } });
  assert.equal(c.draft(), "");
});

test("prompt history respects multiline cursor boundaries and restores the draft and attachments", async t => {
  const c = mount(t, composeChatMessage("unfinished\nsecond line", [sourceAttachment(paper)]), { history: ["older", "latest"] });
  await c.key("ArrowUp", { currentTarget: { selectionStart: 15, selectionEnd: 15 } });
  assert.equal(c.input().props.value, "unfinished\nsecond line");
  await c.key("ArrowUp", { currentTarget: { selectionStart: 0, selectionEnd: 0 } });
  assert.equal(c.input().props.value, "latest");
  await c.key("ArrowUp");
  assert.equal(c.input().props.value, "older");
  await c.key("ArrowDown");
  await c.key("ArrowDown");
  assert.equal(c.input().props.value, "unfinished\nsecond line");
  assert.equal(splitChatMessage(c.draft()).attachments.length, 1);
});

test("working: Enter steers, Alt+Enter follows up and Escape cancels", async t => {
  const c = mount(t, "next question", { running: true });
  await c.key("Enter");
  assert.deepEqual(c.ops[0], { type: "queue", behavior: "steer", message: "next question" });
  await c.key("Enter", { altKey: true });
  assert.deepEqual(c.ops[1], { type: "queue", behavior: "followUp", message: "next question" });
  await c.key("Escape");
  assert.deepEqual(c.ops.at(-1), { type: "cancel" });
  assert.equal(c.draft(), "next question");
});

test("working: slash cancel remains a control and is never queued as a model message", async t => {
  const c = mount(t, "", { running: true });
  await c.type("/cancel ");
  await c.key("Enter");
  assert.deepEqual(c.ops, [{ type: "cancel" }]);
});
