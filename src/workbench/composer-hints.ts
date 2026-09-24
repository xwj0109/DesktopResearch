/** Inline `/` commands, `@` sources and CLI-style hints for the chat composer.
 * Pure functions so the behaviour is testable without a DOM. */

export interface ComposerCommand {
  name: string;
  description?: string;
  /** "app" commands map to generic conversation operations; others come from the runtime. */
  source: "app" | "runtime";
  usage?: string;
  /** Value suggestions for the first argument. */
  args?: "models" | "thinking";
}
export interface Suggestion {
  kind: "command" | "arg" | "source";
  label: string;
  detail?: string;
  tag?: string;
  /** Text replacing [from, caret) when accepted (commands and args). */
  insert?: string;
  caret?: number;
  /** Source to attach when accepted (the @token is removed). */
  sourceId?: string;
}
export interface HintContext {
  commands: ComposerCommand[];
  models: { id: string; provider: string; name: string }[];
  thinking: string[];
  sources: { id: string; name: string }[];
}

/** App commands, available with any runtime. */
export const APP_COMMANDS: ComposerCommand[] = [
  { name: "model", source: "app", usage: "/model <model>", description: "Switch the model", args: "models" },
  { name: "thinking", source: "app", usage: "/thinking <level>", description: "Set the thinking level", args: "thinking" },
  { name: "hotkeys", source: "app", usage: "/hotkeys", description: "Show conversation keyboard shortcuts" },
  { name: "copy", source: "app", usage: "/copy", description: "Copy the last assistant response" },
  { name: "quit", source: "app", usage: "/quit", description: "Stop this conversation runtime" },
  { name: "attach", source: "app", usage: "/attach", description: "Attach files (images, text, PDFs)" },
  { name: "cancel", source: "app", usage: "/cancel", description: "Cancel the running work" },
  { name: "reload", source: "app", usage: "/reload", description: "Reload extensions, prompts and skills" },
  { name: "connect", source: "app", usage: "/connect", description: "Connect the agent runtime" },
  { name: "stop", source: "app", usage: "/stop", description: "Stop the agent session" },
  { name: "clear", source: "app", usage: "/clear", description: "Clear the message and attachments" },
];

/** App commands first (they win name clashes), then the runtime's. */
export function allCommands(runtime: { name: string; description?: string }[]): ComposerCommand[] {
  const app = new Set(APP_COMMANDS.map((c) => c.name));
  return [
    ...APP_COMMANDS,
    ...runtime.filter((c) => !app.has(c.name)).map((c) => ({ name: c.name, description: c.description, source: "runtime" as const, usage: `/${c.name} [args]` })),
  ];
}

const rank = <T,>(items: T[], query: string, key: (t: T) => string) => {
  const q = query.toLowerCase();
  return items
    .map((item) => ({ item, at: key(item).toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.at - b.at)
    .map((x) => x.item);
};

/** Suggestions for the text before the caret; `from` is where the replaced token starts. */
export function suggest(text: string, caret: number, ctx: HintContext): { items: Suggestion[]; from: number } {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command)
    return {
      from: 0,
      items: rank(ctx.commands, command[1], (c) => c.name).map((c) => ({
        kind: "command",
        label: `/${c.name}`,
        detail: c.description,
        tag: c.source === "app" ? "app" : "runtime",
        insert: `/${c.name} `,
      })),
    };
  const arg = /^\/(\S+)\s+(\S*)$/.exec(before);
  if (arg) {
    const spec = ctx.commands.find((c) => c.name === arg[1]);
    if (spec?.args === "models")
      return {
        from: 0,
        items: rank(ctx.models, arg[2], (m) => `${m.name} ${m.id} ${m.provider}`).map((m) => ({
          kind: "arg",
          label: m.name,
          detail: m.provider,
          insert: `/${spec.name} ${m.provider}/${m.id}`,
        })),
      };
    if (spec?.args === "thinking")
      return { from: 0, items: rank(ctx.thinking, arg[2], (l) => l).map((l) => ({ kind: "arg", label: l, insert: `/${spec.name} ${l}` })) };
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at)
    return {
      from: caret - at[2].length - 1,
      items: rank(ctx.sources, at[2], (s) => s.name).slice(0, 20).map((s) => ({ kind: "source", label: s.name, tag: "source", sourceId: s.id })),
    };
  return { items: [], from: caret };
}

export interface ParsedCommand {
  name: string;
  args: string;
  spec?: ComposerCommand;
}
/** "/name args…" → parsed command, or undefined for ordinary messages. */
export function parseCommand(text: string, commands: ComposerCommand[]): ParsedCommand | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1], args: (m[2] ?? "").trim(), spec: commands.find((c) => c.name === m[1]) };
}

/** The CLI-style hint line under the input. */
export function hint(text: string, menuOpen: boolean, commands: ComposerCommand[]): { text: string; tone?: "warn" } {
  if (menuOpen) return { text: "↑↓ choose · tab complete · ⏎ accept · esc dismiss" };
  const parsed = parseCommand(text, commands);
  if (parsed) {
    if (!parsed.spec) return { text: `unknown command /${parsed.name} · type / to list commands`, tone: "warn" };
    return { text: `${parsed.spec.usage ?? `/${parsed.spec.name}`}${parsed.spec.description ? ` — ${parsed.spec.description}` : ""} · Enter run` };
  }
  if (text.trim().startsWith("/")) return { text: "type a command name · esc to dismiss" };
  return { text: "/ commands · @ attach a source · drop, paste or 📎 files · Enter send · Shift+Enter new line" };
}

/** Resolve "/model <x>" against the runtime's models (exact id, then name/id match). */
export function resolveModel(query: string, models: HintContext["models"]) {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const [provider, id] = q.includes("/") ? q.split(/\/(.*)/s) : [undefined, q];
  return (
    models.find((m) => m.id.toLowerCase() === id && (!provider || m.provider.toLowerCase() === provider)) ??
    models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q) ??
    models.find((m) => m.name.toLowerCase() === q) ??
    rank(models, q, (m) => `${m.name} ${m.id}`)[0]
  );
}
