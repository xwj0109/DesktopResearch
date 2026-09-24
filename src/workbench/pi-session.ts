/** Reading Pi's session JSONL (docs/session-format.md in the Pi package) for
 * the conversation pane's bar and reading view. Read-only: the app never
 * writes Pi sessions. */

export interface PiEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: any;
  [key: string]: any;
}

/** Complete JSONL lines → entries (malformed lines are skipped). */
export function parseEntries(text: string): PiEntry[] {
  const out: PiEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.type === "string") out.push(entry);
    } catch {}
  }
  return out;
}

/** The active branch: from the last entry back through parentIds, oldest first.
 * Branches left via /tree are not shown. */
export function activeBranch(entries: PiEntry[]): PiEntry[] {
  const byId = new Map<string, PiEntry>();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  const tree = entries.filter((e) => e.id);
  const path: PiEntry[] = [];
  let cursor: PiEntry | undefined = tree.at(-1);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id!)) {
    seen.add(cursor.id!);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.reverse();
}

export interface SessionSummary {
  name?: string;
  model?: string;
  thinking?: string;
  /** The last turn has not finished (a user message or tool step without a final reply). */
  working: boolean;
  messages: number;
}
export function summarize(entries: PiEntry[]): SessionSummary {
  const branch = activeBranch(entries);
  let name: string | undefined, model: string | undefined, thinking: string | undefined;
  for (const e of entries) if (e.type === "session_info" && typeof e.name === "string") name = e.name;
  for (const e of branch) {
    if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change") thinking = e.thinkingLevel;
    if (e.type === "message" && e.message?.role === "assistant" && e.message.model) model = `${e.message.provider}/${e.message.model}`;
  }
  const messages = branch.filter((e) => e.type === "message");
  const last = messages.at(-1)?.message;
  const working = !!last && (last.role === "user" || last.role === "toolResult" || (last.role === "assistant" && last.stopReason === "toolUse"));
  return { name, model, thinking, working, messages: messages.length };
}

/** Tool results by call id, so a reading view can show each call with its output. */
export function toolResults(entries: PiEntry[]) {
  const results = new Map<string, any>();
  for (const e of entries) if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId) results.set(String(e.message.toolCallId), e.message);
  return results;
}
