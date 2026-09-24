# Principle: agnosticity

Pi Research is **model-agnostic and runtime-agnostic**. The app must work the same whichever model answers and whichever agent runtime drives it: Pi today; Claude Code, Codex, Cursor or a local agent through MCP; tomorrow's runtimes through a new adapter. Nothing about research (what can be done, how it is validated, where it is stored, how it is shown) may depend on which agent or model is on the other end.

This is a design rule for every feature, not a feature of its own.

## The primitive: one operation registry

Every operation an agent can perform is defined **once**, in the backend, in the workbench registry (`server/workbench/tools.ts`):

```ts
define({
  name: "note_create",                 // stable snake_case name, identical for every runtime
  title: "Highlight or comment",
  description: "…",                    // written for any model: what it does, when to use it
  input: z.object({ … }).strict(),     // the only schema; exported as JSON Schema
  run: ({ sid, wb }, input) => …,      // runs in the backend against current state
});
```

`Workbench.call(strategy, name, input)` is the single entry point. It validates the input, runs the handler, and returns the backend's own result or a readable refusal. `Workbench.manifest()` is the only description of the tools any runtime receives.

Runtimes reach the registry through **thin adapters** that translate and nothing more:

| Adapter | Where | What it does |
| --- | --- | --- |
| Pi | `server/pi-host-tools.mjs`, `relayWorkbenchTool()` in `server/pi.ts` | Builds Pi custom tools from the manifest (plain JSON Schema) and relays each call to `Workbench.call`. |
| Pi CLI (conversation pane) | `server/pi-research-extension.mjs`, loaded with `pi -e` by `desktop/terminal.ts` | Lists the tools over MCP at startup and forwards each call; an in-memory token per backend run. |
| MCP | `server/workbench/mcp.ts`, `scripts/pi-research-mcp.mjs` | `initialize` / `tools/list` / `tools/call` over JSON-RPC, served from the same manifest and entry point. |

## Rules

1. **Define operations once, in the registry.** No runtime gets its own tool definitions, schemas, descriptions or logic. If an adapter needs a field the registry lacks, add it to the registry.
2. **zod is the source of truth for inputs.** Schemas are exported with `z.toJSONSchema`. Never hand-write a runtime-specific schema (TypeBox, OpenAI function JSON, …) or import a runtime SDK's schema library outside its adapter.
3. **Research runs in the backend.** Handlers act on the store and the scientific journal with the same checks as the UI. Never implement an operation in a window, a React component or an agent host. An operation must work with no window open.
4. **Windows display; they don't decide.** After an operation, the backend publishes a presentation event (open a paper, jump to a match, open an idea, refresh) on the view channel (`server/workbench/view-channel.ts`), and windows long-poll for it. Windows report what they show (view context) so tools can resolve "this paper" or "the open idea". Presentation state is never durable and is never journaled as a research request.
5. **Agents can do what the UI can do, with the same validation.** There are no agent-specific privileges or shortcuts, and no runtime gets more or less than another. A capability the UI offers should have a registry tool. If it doesn't yet, that is a gap to close, not a design choice.
6. **Design tools for any model.**
   - Prefer small tools with precise inputs over one tool with an action switch and many optional fields.
   - Re-read current state inside the tool. When intent depends on inspected evidence, require its expected revision or hash and refuse stale operations.
   - Return compact structured results, and refusals a model can act on (what was wrong, what to do next).
   - Never report success the backend didn't produce.
7. **Guidance is shared, not per runtime.** Behavioural guidance lives in `WORKBENCH_INSTRUCTIONS`. Adapters surface it however their runtime expects (Pi prompt guidelines, MCP `instructions`), with the same wording.
8. **Adapters are replaceable.** Adding a runtime means writing an adapter over `manifest()` and `call()`, and nothing else. Removing one must not affect any other runtime or the app.
9. **Model choice stays with the runtime.** The app never assumes a provider, model family or model-specific behaviour (prompt formats, tool-call quirks, context sizes).

## Adding a feature an agent should be able to use

1. Put the state in the backend (store or scientific journal), with a zod contract in `src/` if windows share it.
2. Add the operation to the registry: a name, a description written for any model, a strict zod input and a backend handler.
3. If the result should be visible, publish a view event. Handle it in `src/workbench/WorkbenchEvents.tsx` if it's a new kind.
4. Make the window use the same backend operation or route, never a separate path.
5. Test through `Workbench.call`. The adapter tests in `tests/workbench-tools.test.ts` then cover Pi and MCP automatically.

## Adding a runtime

Write an adapter that lists `Workbench.manifest()` in the runtime's format and forwards calls to `Workbench.call()`, passing its result or refusal back unchanged. Add a parity test alongside the Pi and MCP ones. Never copy tool definitions into the adapter.

## Where the app is not yet agnostic

These are known gaps. Close them in line with the rules above; don't extend them.

- **The conversation pane runs the Pi CLI.** It is the real `pi` in a PTY (`desktop/terminal.ts`), with research tools through the MCP-backed extension, so nothing about research depends on it. Starting another CLI agent in the same pane (with its own MCP config) is the natural next step toward rule 8. The graphical Pi-SDK conversation (`server/pi.ts`, `server/pi-host*.mjs`) remains only as a fallback.
- **Registry coverage.** Ideas, Sources and research review snapshots are covered (27 tools). Other research records (search brief, bibliography, spec, contract, graph, code, conclusion) and commands (handoffs, feasibility, datasets, runs, exports) are reachable only through the UI so far. Under rule 5 they should become registry tools, ideally derived from the existing zod contracts in `src/platform.ts`.
- **Request journal growth.** Every window mutation, including debounced idea-board edits, adds a request journal entry that is never pruned.

See [interface](INTERFACE.md#agents-operating-the-panes-workbench-tools) for how the current tools, view events and MCP access work.
