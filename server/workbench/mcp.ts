import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.ts";
import { STAGE_GUIDANCE, WORKBENCH_INSTRUCTIONS, type Workbench } from "./tools.ts";

/** MCP adapter over the workbench registry (JSON-RPC 2.0, Streamable HTTP in
 * JSON-response mode, no SSE). Any MCP client (Claude Code, Codex, Cursor, …)
 * reaches exactly the tools Pi gets, with the same backend checks.
 *
 * Access is opt-in per strategy: enabling it issues a random token written,
 * with the backend's current origin, to .runtime/mcp/<strategy>.json (0600).
 * The stdio bridge (scripts/pi-research-mcp.mjs) reads that file on every
 * request, so an app restart (new port) needs no client change. Disabling
 * deletes the file and the token stops working immediately. */

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const accessFileSchema = z
  .object({ version: z.literal(1), strategy: z.uuid(), name: z.string(), origin: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export class McpAccess {
  private tokens = new Map<string, string>();
  constructor(
    private store: Store,
    private origin: string,
  ) {
    // Re-issue files written by an earlier run with this run's origin.
    for (const file of this.list()) {
      try {
        const value = accessFileSchema.parse(JSON.parse(fs.readFileSync(path.join(this.dir(), file), "utf8")));
        this.store.get(value.strategy);
        this.tokens.set(value.strategy, value.token);
        this.write(value.strategy, value.token);
      } catch {
        fs.rmSync(path.join(this.dir(), file), { force: true });
      }
    }
  }
  private dir() {
    return this.store.safe("mcp");
  }
  private list() {
    try {
      return fs.readdirSync(this.dir()).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f));
    } catch {
      return [];
    }
  }
  file(sid: string) {
    return path.join(this.dir(), `${sid}.json`);
  }
  private write(sid: string, token: string) {
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const tmp = this.file(sid) + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, strategy: sid, name: this.store.get(sid).name, origin: this.origin, token }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.file(sid));
  }
  enabled(sid: string) {
    return this.tokens.has(sid);
  }
  enable(sid: string) {
    this.store.get(sid);
    const token = this.tokens.get(sid) ?? randomBytes(32).toString("hex");
    this.tokens.set(sid, token);
    this.write(sid, token);
  }
  disable(sid: string) {
    this.tokens.delete(sid);
    fs.rmSync(this.file(sid), { force: true });
  }
  /** Token for the app's own conversation pane (Pi CLI started by the desktop):
   * kept in memory for this backend run only, independent of the opt-in
   * external access above. */
  private sessions = new Map<string, string>();
  session(sid: string) {
    this.store.get(sid);
    let token = this.sessions.get(sid);
    if (!token) this.sessions.set(sid, (token = randomBytes(32).toString("hex")));
    return token;
  }
  check(sid: string, header: string | undefined) {
    const given = header?.replace(/^Bearer /, "") ?? "";
    const same = (expected?: string) =>
      !!expected && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!same(this.tokens.get(sid)) && !same(this.sessions.get(sid)))
      throw Object.assign(new Error("External agent access is off for this strategy, or the token is wrong."), { status: 401 });
  }
}

/** "This conversation develops …" for a Research Development Pi (its idea from the URL). */
function ideaLine(wb: Workbench, sid: string, idea?: string) {
  if (!idea) return "";
  const i = wb.ideas(sid).find((x) => x.target === idea);
  return i ? ` The idea this conversation develops is “${i.content.title}” (${idea}, v${i.version}); tools that take an idea default to it, whatever the window shows, and changes to other ideas are refused.` : "";
}
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const reply = (id: Message["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one JSON-RPC message or batch. Returns undefined for notifications.
 * `stage` (from the connection URL) adds that stage's role to the instructions. */
export async function mcpHandle(wb: Workbench, sid: string, body: unknown, stage?: keyof typeof STAGE_GUIDANCE, idea?: string): Promise<unknown> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => mcpHandle(wb, sid, m, stage, idea)))).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  const m = (body ?? {}) as Message;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return failure(m.id, -32600, "Invalid JSON-RPC request");
  const notification = m.id === undefined;
  try {
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pi-research", title: "Pi Research workbench", version: "0.1.0" },
          instructions: `${WORKBENCH_INSTRUCTIONS} Strategy: ${wb.store.get(sid).name}.${stage ? ` ${STAGE_GUIDANCE[stage]}` : ""}${ideaLine(wb, sid, idea)}`,
        });
      }
      case "ping":
        return notification ? undefined : reply(m.id, {});
      case "tools/list":
        return reply(m.id, {
          tools: wb.manifest().map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, ...t.annotations },
          })),
        });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        try {
          const result = await wb.call(sid, name, m.params?.arguments ?? {}, { idea, origin: "agent" });
          return reply(m.id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            ...(result && typeof result === "object" && !Array.isArray(result) ? { structuredContent: result } : {}),
            isError: false,
          });
        } catch (error) {
          // Tool failures are results the model should see, not protocol errors.
          return reply(m.id, { content: [{ type: "text", text: String((error as Error)?.message ?? error).slice(0, 2000) }], isError: true });
        }
      }
      default:
        if (notification) return undefined;
        return failure(m.id, -32601, `Method not supported: ${m.method}`);
    }
  } catch (error) {
    return notification ? undefined : failure(m.id, -32603, String((error as Error)?.message ?? error).slice(0, 500));
  }
}
