// Pi adapter for the backend's workbench tool registry.
//
// The backend sends its manifest (plain JSON Schema, which Pi validates
// without TypeBox) in the host config. Each generated tool only relays: it
// emits a workbench_tool_request and resolves when the backend replies with
// its own result or refusal. No tool logic or schema copy lives in the host.
import { randomUUID } from "node:crypto";

export function createWorkbenchTools({ specs, instructions, emit, calls, timeoutMs = 130000 }) {
  return (Array.isArray(specs) ? specs : []).map((spec, index) => ({
    name: spec.name,
    label: spec.title,
    description: spec.description,
    promptSnippet: `${spec.title}: ${spec.description.split(". ")[0]}.`,
    // Shared guidance once, not repeated for every tool.
    promptGuidelines: index === 0 && instructions ? [instructions] : [],
    executionMode: "sequential",
    parameters: spec.inputSchema,
    async execute(_id, input, signal) {
      if (signal?.aborted) throw new Error("Cancelled before dispatch");
      const requestId = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          calls.delete(requestId);
        };
        const abort = () => {
          clean();
          reject(new Error("Workbench operation interrupted. Check the pane before retrying; it may already have completed."));
        };
        const timer = setTimeout(abort, timeoutMs);
        calls.set(requestId, {
          resolve: (value) => (clean(), resolve(value)),
          reject: (error) => (clean(), reject(error)),
        });
        signal?.addEventListener("abort", abort, { once: true });
        emit({ type: "workbench_tool_request", requestId, name: spec.name, input });
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  }));
}
/** Resolve a pending tool call from a backend reply; true when handled. */
export function resolveToolReply(calls, command) {
  if (command?.type !== "workbench_tool_reply") return false;
  const pending = calls.get(command.requestId);
  if (pending) command.error ? pending.reject(new Error(command.error)) : pending.resolve(command.result);
  return true;
}
