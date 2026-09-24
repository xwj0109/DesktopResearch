import test from "node:test";
import assert from "node:assert/strict";
import { matchesRuntimeKey } from "../src/workbench/runtime-keys";
// @ts-ignore authored host module
import { RuntimeQueue } from "../server/pi-host-queue.mjs";
// @ts-ignore authored host module
import { runRuntimeCommand } from "../server/pi-host-commands.mjs";

test("queue delegates scheduling to SDK and recovers only undelivered messages, including images", async () => {
  let steering: string[] = [],
    followUp: string[] = [];
  const calls: any[] = [];
  const session = {
    sessionId: "one",
    isStreaming: true,
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    steer: async (message: string, images: any[]) => {
      steering.push(message);
      calls.push(images);
    },
    followUp: async (message: string, images: any[]) => {
      followUp.push(message);
      calls.push(images);
    },
    clearQueue: () => {
      steering = [];
      followUp = [];
    },
  };
  const queue = new RuntimeQueue(() => session);
  await queue.submit({ message: "first", behavior: "steer" });
  await queue.submit({
    message: "then",
    behavior: "followUp",
    images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
  });
  assert.deepEqual(queue.snapshot(), {
    steering: ["first"],
    followUp: ["then"],
  });
  steering.shift();
  const recovered = queue.retrieve();
  assert.equal(recovered.queue.length, 1);
  assert.equal(recovered.queue[0].images[0].data, "aGVsbG8=");
  assert.equal(calls[1][0].type, "image");
  assert.deepEqual(queue.snapshot(), { steering: [], followUp: [] });
  session.isStreaming = false;
  await assert.rejects(
    queue.submit({ message: "late", behavior: "steer" }),
    /turn has finished/,
  );
});

test("custom runtime bindings replace defaults and empty arrays disable actions", () => {
  assert.equal(matchesRuntimeKey({ key: "Enter" }, "tui.input.submit"), true);
  const keys = {
    "tui.input.submit": "super+enter",
    "app.model.cycleForward": [],
    "tui.editor.historyPrevious": "ctrl+p",
  };
  assert.equal(
    matchesRuntimeKey({ key: "Enter" }, "tui.input.submit", keys),
    false,
  );
  assert.equal(
    matchesRuntimeKey(
      { key: "Enter", metaKey: true },
      "tui.input.submit",
      keys,
    ),
    true,
  );
  assert.equal(
    matchesRuntimeKey(
      { key: "p", ctrlKey: true },
      "app.model.cycleForward",
      keys,
    ),
    false,
  );
  assert.equal(
    matchesRuntimeKey(
      { key: "p", ctrlKey: true },
      "tui.editor.historyPrevious",
      keys,
    ),
    true,
  );
});

test("built-in new, clone and resume use managed replacement and validate selected files", async () => {
  const calls: any[] = [];
  const ctx: any = {
    runtime: {
      session: { sessionManager: { getLeafId: () => "leaf" } },
      newSession: async () => calls.push("new"),
      fork: async (...args: any[]) => calls.push(args),
      switchSession: async (file: string) => calls.push(file),
    },
    replace: async (fn: Function) => {
      calls.push("barrier");
      await fn();
    },
    guardFile: (file: string) => {
      calls.push("validated:" + file);
    },
    SessionManager: {
      list: async () => [{ path: "/managed/a.jsonl", id: "a" }],
    },
    ui: { select: async (_title: string, choices: string[]) => choices[0] },
    cwd: "/managed",
    sessionDir: "/managed",
  };
  await runRuntimeCommand("new", "", ctx);
  await runRuntimeCommand("clone", "", ctx);
  await runRuntimeCommand("resume", "", ctx);
  assert.deepEqual(calls, [
    "barrier",
    "new",
    "barrier",
    ["leaf", { position: "at" }],
    "validated:/managed/a.jsonl",
    "barrier",
    "/managed/a.jsonl",
  ]);
});

test("external editor owns a PTY, returns changed text and closes its surface", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX desktop test");
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  // @ts-ignore authored host module
  const { ExternalEditor } = await import("../server/pi-host-editor.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-fixture-"));
  const fixture = path.join(dir, "edit.cjs");
  fs.writeFileSync(
    fixture,
    "require('node:fs').writeFileSync(process.argv[2], 'edited in configured editor\\n'); process.stdout.write('EDITOR FIXTURE');",
  );
  const events: any[] = [];
  const editor = new ExternalEditor((event: any) => events.push(event));
  t.after(async () => {
    await editor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    await editor.run(`${process.execPath} ${fixture}`, "original"),
    "edited in configured editor",
  );
  assert.equal(events[0].type, "terminal_open");
  assert.equal(events.at(-1).type, "terminal_closed");
  assert.ok(
    events.some(
      (event) =>
        event.type === "terminal_frame" &&
        event.data.includes("EDITOR FIXTURE"),
    ),
  );
  assert.deepEqual(editor.surfaces(), []);
});

import { EditorActions } from "../src/workbench/editor-actions";
test("editor kill, yank, undo, Unicode deletion and vertical movement retain cursor positions", () => {
  const editor = new EditorActions();
  assert.deepEqual(editor.apply("deleteToLineStart", "first\nsecond", 9, 9), {
    text: "first\nond",
    start: 6,
    end: 6,
  });
  assert.deepEqual(editor.apply("yank", "first\nond", 6, 6), {
    text: "first\nsecond",
    start: 9,
    end: 9,
  });
  assert.deepEqual(editor.apply("undo", "first\nsecond", 9, 9), {
    text: "first\nond",
    start: 6,
    end: 6,
  });
  assert.deepEqual(editor.apply("deleteCharBackward", "a😀b", 3, 3), {
    text: "ab",
    start: 1,
    end: 1,
  });
  assert.deepEqual(editor.apply("cursorDown", "long\na\nlast", 3, 3), {
    text: "long\na\nlast",
    start: 6,
    end: 6,
  });
  editor.apply("jumpForward", "one two three", 0, 0);
  assert.equal(editor.apply("", "one two three", 0, 0, "t")?.start, 4);
});

test("external editor cancellation terminates its PTY and preserves the draft", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX desktop test");
  // @ts-ignore authored host module
  const { ExternalEditor } = await import("../server/pi-host-editor.mjs");
  const editor = new ExternalEditor(() => {});
  t.after(() => editor.close());
  const result = editor.run("/bin/cat", "original");
  const rejected = assert.rejects(result, /cancelled/);
  await editor.close();
  await rejected;
  assert.deepEqual(editor.surfaces(), []);
});

import { researchRequest } from "../desktop/research-routes";
import { completionQuerySchema } from "../src/native-contract";
test("runtime completions are scoped read-only requests with bounded text", () => {
  const scope = {
    kind: "strategy" as const,
    id: "11111111-1111-4111-8111-111111111111",
  };
  const path = `/api/strategies/${scope.id}/native/conversations/ideas/complete?text=%2Fsession&generation=1`;
  assert.equal(
    researchRequest(scope, { method: "GET", path, headers: {} }),
    true,
  );
  assert.throws(
    () => researchRequest(scope, { method: "POST", path, headers: {} }),
    /Invalid read/,
  );
  assert.equal(
    researchRequest({ kind: "launcher" }, { method: "GET", path, headers: {} }),
    false,
  );
  assert.equal(
    completionQuerySchema.safeParse({ text: "a".repeat(401), generation: 1 })
      .success,
    false,
  );
});

import { researchDTO } from "../desktop/protocol";
test("desktop projection preserves recovered queue payloads without exposing unrelated host results", () => {
  const result = researchDTO(
    {
      id: "request",
      hash: "hash",
      status: "acknowledged",
      result: {
        secret: "hidden",
        queue: [
          {
            message: "recover this",
            images: [{ mimeType: "image/png", data: "aGVsbG8=", hidden: true }],
          },
        ],
      },
    },
    "/native/conversations/ideas/actions",
  ) as any;
  assert.equal(result.result.queue[0].message, "recover this");
  assert.deepEqual(result.result.queue[0].images[0], {
    mimeType: "image/png",
    data: "aGVsbG8=",
  });
  assert.equal(result.result.secret, undefined);
  assert.equal(
    (
      researchDTO(
        { result: { secret: "hidden" } },
        "/native/conversations/ideas/actions",
      ) as any
    ).result,
    undefined,
  );
});

test("editor deletes entire grapheme clusters and accumulates consecutive kills", () => {
  const editor = new EditorActions();
  assert.equal(
    editor.apply("deleteCharBackward", "👩‍💻", "👩‍💻".length, "👩‍💻".length)?.text,
    "",
  );
  assert.equal(editor.apply("deleteCharForward", "e\u0301x", 0, 0)?.text, "x");
  assert.equal(
    editor.apply("deleteWordBackward", "one two", 7, 7)?.text,
    "one ",
  );
  assert.equal(editor.apply("deleteWordBackward", "one ", 4, 4)?.text, "");
  assert.equal(editor.apply("yank", "", 0, 0)?.text, "one two");
  assert.equal(editor.apply("cursorLineStart", "\nline", 0, 0)?.start, 0);
});

import { terminalInputFrames } from "../src/terminal-input";
test("large terminal paste frames are byte-bounded and preserve Unicode and bracketed paste markers", () => {
  const data = "\x1b[200~" + "👩‍💻café".repeat(3000) + "\x1b[201~";
  const frames = terminalInputFrames(data);
  assert.ok(frames.length > 1);
  assert.equal(frames.join(""), data);
  assert.ok(frames.every(frame => Buffer.byteLength(frame) <= 8192));
});

test("duplicate queued text keeps the remaining message's own images", async () => {
  const texts: string[] = [];
  const session = { sessionId: "duplicate", isStreaming: true, getSteeringMessages: () => texts, getFollowUpMessages: () => [], steer: async (message: string) => { texts.push(message); }, clearQueue: () => { texts.length = 0; } };
  const queue = new RuntimeQueue(() => session);
  await queue.submit({ message: "same", behavior: "steer", images: [{ mimeType: "image/png", data: "first" }] });
  await queue.submit({ message: "same", behavior: "steer", images: [{ mimeType: "image/png", data: "second" }] });
  texts.shift();
  assert.equal(queue.retrieve().queue[0].images[0].data, "second");
});
