import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Terminals, scopeFolder, stageSessionId } from "../desktop/terminal.ts";
import { fixture } from "./platform-fixtures.ts";
import { Workbench } from "../server/workbench/tools.ts";
import { McpAccess, mcpHandle } from "../server/workbench/mcp.ts";

function fakePty() {
  const spawned: any[] = [];
  const module = {
    spawn(file: string, args: string[], options: any) {
      const handlers: any = {};
      const p = {
        file, args, options, written: [] as string[], resized: [] as number[][], killed: false,
        onData: (cb: any) => (handlers.data = cb), onExit: (cb: any) => (handlers.exit = cb),
        write: (d: string) => p.written.push(d), resize: (c: number, r: number) => p.resized.push([c, r]),
        kill: () => (p.killed = true), pid: 42, emit: (d: string) => handlers.data(d), exit: (code: number) => handlers.exit({ exitCode: code }),
      };
      spawned.push(p);
      return p;
    },
  };
  return { module, spawned };
}

test("the pane runs the real Pi CLI: login shell, stable session per stage, research tools via -e", async () => {
  const { module, spawned } = fakePty();
  const terminals = new Terminals({ node: "/usr/local/bin/node", pi: "/opt/pi/cli.js", extension: "/app/backend/pi-research-extension.mjs" }, () => module);
  const sent: any[] = [];
  const target = {
    key: "strategy-s1:ideas",
    label: "Kelly · Ideas",
    cwd: path.join(process.env.TMPDIR ?? "/tmp", "pi-term-test-" + process.pid),
    sessionId: stageSessionId("s1", "ideas"),
    send: (type: string, payload: unknown) => sent.push([type, payload]),
    tools: async () => ({ url: "http://127.0.0.1:9/mcp/s1", token: "t0k" }),
  };
  const opened = await terminals.open(target, 100, 30);
  assert.equal(opened.reused, false);
  const p = spawned[0];
  assert.deepEqual(p.args.slice(0, 3), ["-l", "-c", 'exec "$0" "$@"'], "through the user's login shell");
  assert.deepEqual(p.args.slice(3), ["/usr/local/bin/node", "/opt/pi/cli.js", "--session-id", target.sessionId, "--name", "Kelly · Ideas", "-e", "/app/backend/pi-research-extension.mjs"]);
  assert.equal(p.options.cwd, target.cwd);
  assert.equal(p.options.env.PI_RESEARCH_MCP_URL, "http://127.0.0.1:9/mcp/s1");
  assert.equal(p.options.env.PI_RESEARCH_MCP_TOKEN, "t0k");
  assert.equal(p.options.env.TERM, "xterm-256color");
  assert.equal(p.options.env.ELECTRON_RUN_AS_NODE, undefined);

  p.emit("\x1b[1mpi\x1b[0m ready");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [["output", "\x1b[1mpi\x1b[0m ready"]], "output is coalesced and pushed");
  terminals.input(target.key, "hello\r");
  terminals.resize(target.key, 120, 40);
  assert.deepEqual(p.written, ["hello\r"]);
  assert.deepEqual(p.resized, [[120, 40]]);

  const again = await terminals.open(target, 120, 40);
  assert.equal(again.reused, true, "switching back reattaches to the running CLI");
  assert.equal(again.replay, "", "no raw replay; Pi repaints instead");
  assert.deepEqual(p.resized.at(-1), [119, 40], "width nudge makes Pi redraw its screen");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(p.resized.at(-1), [120, 40]);
  assert.equal(spawned.length, 1);

  p.exit(0);
  assert.deepEqual(sent.at(-1), ["exit", 0]);
  await terminals.open(target, 120, 40);
  assert.equal(spawned.length, 2, "an exited CLI is started again on open");
  terminals.closeWhere("strategy-s1:");
  assert.equal(spawned[1].killed, true);

  // No tools (portfolio, or backend unreachable): no -e, no MCP environment.
  await terminals.open({ ...target, key: "portfolio-p:portfolio", tools: undefined }, 80, 24);
  assert.equal(spawned[2].args.includes("-e"), false);
  assert.equal(spawned[2].options.env.PI_RESEARCH_MCP_TOKEN, undefined);
  terminals.closeAll();

  const missing = new Terminals({ node: "/n" }, () => module);
  await assert.rejects(missing.open(target, 80, 24), /Pi is not installed/);
});

test("stage sessions are stable UUIDs, different per stage and strategy; folders follow the data root", () => {
  const a = stageSessionId("s1", "ideas");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stageSessionId("s1", "ideas"), a);
  assert.notEqual(stageSessionId("s1", "literature"), a);
  assert.notEqual(stageSessionId("s2", "ideas"), a);
  assert.equal(scopeFolder("/data", { kind: "strategy", id: "x" }), "/data/workspaces/strategies/x");
});

test("the Pi extension registers the workbench tools from the backend and forwards calls", async (t) => {
  const x = fixture(t);
  const s = x.store.create("Extension");
  const wb = new Workbench(x.store, x.platform);
  t.after(() => wb.close());
  const access = new McpAccess(x.store, "http://backend");
  const token = access.session(s.id);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    access.check(s.id, init.headers.authorization);
    return new Response(JSON.stringify(await mcpHandle(wb, s.id, JSON.parse(init.body))));
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  process.env.PI_RESEARCH_MCP_URL = `http://backend/mcp/${s.id}`;
  process.env.PI_RESEARCH_MCP_TOKEN = token;
  t.after(() => {
    delete process.env.PI_RESEARCH_MCP_URL;
    delete process.env.PI_RESEARCH_MCP_TOKEN;
  });
  const { default: extension } = await import(`../server/pi-research-extension.mjs?${Date.now()}`);
  const registered: any[] = [];
  await extension({ registerTool: (tool: any) => registered.push(tool) });
  assert.deepEqual(registered.map((r) => r.name), wb.manifest().map((m) => m.name));
  assert.equal(registered[0].promptGuidelines.length, 1);
  assert.equal(registered[1].promptGuidelines.length, 0);
  const create = registered.find((r) => r.name === "idea_create");
  const result = await create.execute("c1", { title: "From the Pi CLI" });
  assert.match(result.content[0].text, /"created":"d:/);
  assert.equal(x.store.ideaBoard(s.id).cards[0].content.title, "From the Pi CLI");
  await assert.rejects(registered.find((r) => r.name === "idea_save").execute("c2", {}), /none is open in the window/);

  // A wrong token is refused by the backend; without environment the extension is inert.
  assert.throws(() => access.check(s.id, "Bearer nope"), /token is wrong/);
  delete process.env.PI_RESEARCH_MCP_URL;
  const { default: inert } = await import(`../server/pi-research-extension.mjs?inert${Date.now()}`);
  const none: any[] = [];
  await inert({ registerTool: (tool: any) => none.push(tool) });
  assert.equal(none.length, 0);
});

test("reading the pane's Pi session: active branch only, working/idle, model and name for the bar", async () => {
  const { parseEntries, activeBranch, summarize, toolResults } = await import("../src/workbench/pi-session.ts");
  const line = (o: object) => JSON.stringify(o);
  const text = [
    line({ type: "session", version: 3, id: "s", cwd: "/x" }),
    line({ type: "message", id: "a1", parentId: null, message: { role: "user", content: "first question" } }),
    line({ type: "message", id: "a2", parentId: "a1", message: { role: "assistant", provider: "deepseek", model: "v4", content: [{ type: "text", text: "old answer" }], stopReason: "stop" } }),
    line({ type: "message", id: "b2", parentId: "a1", message: { role: "assistant", provider: "anthropic", model: "sonnet", content: [{ type: "toolCall", id: "t1", name: "paper_read", arguments: {} }], stopReason: "toolUse" } }),
    line({ type: "message", id: "b3", parentId: "b2", message: { role: "toolResult", toolCallId: "t1", toolName: "paper_read", content: [{ type: "text", text: "page text" }], isError: false } }),
    line({ type: "session_info", id: "i1", parentId: "b3", name: "Kelly · Ideas" }),
    "{not json",
  ].join("\n");
  const entries = parseEntries(text);
  assert.equal(entries.length, 6, "malformed lines are skipped");
  assert.deepEqual(activeBranch(entries).map((e) => e.id), ["a1", "b2", "b3", "i1"], "the branch left via /tree is not shown");
  const s = summarize(entries);
  assert.deepEqual([s.name, s.model, s.working, s.messages], ["Kelly · Ideas", "anthropic/sonnet", true, 3]);
  assert.equal(toolResults(entries).get("t1").content[0].text, "page text");
  const done = parseEntries(text + "\n" + line({ type: "message", id: "b4", parentId: "i1", message: { role: "assistant", provider: "anthropic", model: "sonnet", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
  assert.equal(summarize(done).working, false);
});

test("the pane finds Pi's session file, reads it incrementally, and hands off to Terminal without two writers", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { sessionFile, readSession, handoffScript } = await import("../desktop/terminal.ts");
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  const cwd = "/Users/me/Pi Research Data/workspaces/strategies/abc";
  const id = stageSessionId("abc", "ideas");
  const dir = path.join(agent, "sessions", "--Users-me-Pi Research Data-workspaces-strategies-abc--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-09-24T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, '{"type":"session"}\n{"type":"message","id":"a"}\n{"type":"mess');
  assert.equal(sessionFile(cwd, id, agent), file, "documented location");
  const first = readSession(file, 0);
  assert.equal(first.text.split("\n").filter(Boolean).length, 2, "a partly written last line waits");
  fs.appendFileSync(file, 'age","id":"b"}\n');
  const next = readSession(file, first.offset);
  assert.equal(next.text, '{"type":"message","id":"b"}\n');
  assert.equal(readSession(file, 10_000_000).reset, true, "a rewritten file starts over");
  assert.deepEqual(readSession(undefined, 0).text, "");
  // Unknown folder naming: found by id anyway.
  const other = stageSessionId("abc", "code");
  fs.mkdirSync(path.join(agent, "sessions", "odd-name"), { recursive: true });
  fs.writeFileSync(path.join(agent, "sessions", "odd-name", `x_${other}.jsonl`), "");
  assert.match(sessionFile(cwd, other, agent) ?? "", /odd-name/);

  const script = handoffScript({ node: "/n/node", pi: "/p/pi's cli.js" }, { cwd, sessionId: id, label: "Kelly · Ideas" });
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /^#!\/bin\/zsh -l/);
  assert.match(body, new RegExp(`--session-id '${id}' --name 'Kelly · Ideas'`));
  assert.match(body, /'\/p\/pi'\\''s cli\.js'/, "paths are shell-quoted");
  assert.equal(fs.statSync(script).mode & 0o777, 0o700);

  const { module, spawned } = fakePty();
  const terminals = new Terminals({ node: "/n", pi: "/p" }, () => module);
  const target = { key: "k", label: "L", cwd: os.tmpdir(), sessionId: id, send: () => {} };
  await terminals.open(target, 80, 24);
  assert.equal(terminals.running("k"), true);
  terminals.handoff(target);
  assert.equal(spawned[0].killed, true, "the pane's Pi stops before Terminal takes the session");
  assert.equal(terminals.running("k"), false);
});

test("reading view prose renders maths and tables; prices stay text", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Prose } = await import("../src/workbench/Prose.tsx");
  const html = renderToStaticMarkup(React.createElement(Prose, { text: "Growth $g=\\mu-\\tfrac12\\sigma^2$ costs $5 and $10.\n\n$$\n\\max_\\pi \\mathbb{E}[\\log W_T]\n$$\n\n| a | b |\n|---|---|\n| $x$ | 2 |\n\n\\[ \\alpha \\]" }));
  assert.equal((html.match(/class="math-inline"/g) ?? []).length, 2);
  assert.equal((html.match(/class="math-block"/g) ?? []).length, 2);
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("costs $5 and $10."));
  assert.ok(html.includes("katex"));
});

test("stray renderer errors are reported as a bounded source code, never a message", async () => {
  const { faultSource } = await import("../src/view-fault.ts");
  const { viewFaultSchema } = await import("../desktop/contracts.ts");
  assert.equal(faultSource("pi-research://app/assets/xterm-B-qIQCd3.js\nTypeError at Viewport"), "xterm");
  assert.equal(faultSource("Error: secret /Users/x/file\n    at pi-research://app/assets/Workbench-DaBPJEDV.js:1:2"), "workbench");
  assert.equal(faultSource("no asset here"), "unknown");
  assert.ok(viewFaultSchema.safeParse({ fault: "error", source: "xterm" }).success);
  assert.equal(viewFaultSchema.safeParse({ fault: "error", source: "Cannot read x" }).success, false);
  assert.equal(viewFaultSchema.safeParse({ fault: "error", source: "xterm", message: "x" }).success, false);
});
