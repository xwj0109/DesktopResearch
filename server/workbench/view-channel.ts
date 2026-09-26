/** Presentation events from agents to strategy windows, plus what each
 * window currently shows.
 *
 * Research changes happen in the backend; windows only display. Agents that
 * open a paper, jump to a passage or select an idea publish a view event;
 * windows long-poll for them (no fixed-interval polling). Windows report
 * their visible context so tools can resolve "this paper" and know whether
 * anyone is watching. Nothing here is durable or authoritative. */

export type ViewEvent =
  | { type: "open-source"; artifactId: string; page?: number }
  | { type: "find"; artifactId: string; query: string; occurrence: number; page: number }
  | { type: "close-source" | "pin-source" | "unpin-source"; artifactId: string }
  | { type: "open-idea"; target: string }
  | { type: "focus-idea"; target: string | null }
  | { type: "develop-idea"; target: string | null }
  | { type: "refresh" };
export interface ViewContext {
  /** Literature's focus idea in this window (r:<id>), if any. */
  focusIdea?: string | null;
  /** The idea Research Development is working on in this window (r:<id>). */
  developIdea?: string | null;
  activeArtifact?: string | null;
  page?: number;
  openArtifacts?: string[];
  ideaTarget?: string | null;
  stage?: string | null;
}
type Stamped = ViewEvent & { seq: number };

const KEEP = 50;
const CONNECTED_MS = 25_000;
export class ViewChannel {
  private closed = false;
  private events = new Map<string, Stamped[]>();
  private seq = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  private contexts = new Map<string, { at: number; value: ViewContext }>();
  private seen = new Map<string, number>();

  publish(sid: string, event: ViewEvent) {
    const seq = (this.seq.get(sid) ?? 0) + 1;
    this.seq.set(sid, seq);
    const list = this.events.get(sid) ?? [];
    list.push({ ...event, seq });
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    this.events.set(sid, list);
    for (const wake of this.waiters.get(sid) ?? []) wake();
    return this.connected(sid);
  }
  /** Events after `after`, waiting up to `holdMs` when there are none. A
   * window that asks with after=-1 starts from now (no replay of old events). */
  async next(sid: string, after: number, holdMs = 10_000): Promise<{ seq: number; events: Stamped[] }> {
    this.seen.set(sid, Date.now());
    const now = this.seq.get(sid) ?? 0;
    const since = after < 0 || after > now ? now : after;
    const ready = () => (this.events.get(sid) ?? []).filter((e) => e.seq > since);
    if (!this.closed && !ready().length && holdMs > 0)
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(sid) ?? new Set();
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, holdMs);
        set.add(done);
        this.waiters.set(sid, set);
      });
    this.seen.set(sid, Date.now());
    return { seq: this.seq.get(sid) ?? 0, events: ready() };
  }
  setContext(sid: string, value: ViewContext) {
    this.contexts.set(sid, { at: Date.now(), value });
    this.seen.set(sid, Date.now());
  }
  context(sid: string): ViewContext {
    return this.connected(sid) ? (this.contexts.get(sid)?.value ?? {}) : {};
  }
  /** A window for this strategy is open and listening. */
  connected(sid: string) {
    return Date.now() - (this.seen.get(sid) ?? 0) < CONNECTED_MS;
  }
  close() {
    this.closed = true;
    for (const set of this.waiters.values()) for (const wake of set) wake();
    this.waiters.clear();
  }
}
