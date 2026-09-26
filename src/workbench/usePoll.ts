import { createContext, useCallback, useContext, useEffect, useReducer } from "react";
import { useResearch } from "./research";

/** Whether a pane is on screen: the active tab of a visible tile (StageLayout).
 * Hidden panes stay mounted and keep their data, but stop polling. */
export const PaneVisible = createContext(true);

interface Reader {
  read<T>(path: string): Promise<T>;
}
interface Entry {
  data?: unknown;
  error?: string;
  at: number;
  /** Each mounted reader's interval (Infinity while its pane is hidden). */
  subs: Map<symbol, number>;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  every: number;
  inflight?: Promise<void>;
}
/** One cache per window client: panes reading the same route share one request. */
const caches = new WeakMap<Reader, Map<string, Entry>>();
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function entryOf(client: Reader, path: string) {
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new Map()));
  let e = cache.get(path);
  if (!e) cache.set(path, (e = { at: 0, subs: new Map(), listeners: new Set(), every: Infinity }));
  return e;
}
function fetchNow(client: Reader, path: string, e: Entry) {
  e.inflight ??= client
    .read(path)
    .then(
      (data) => {
        e.data = data;
        e.error = undefined;
      },
      (err) => void (e.error = errorText(err)),
    )
    .finally(() => {
      e.inflight = undefined;
      e.at = Date.now();
      for (const l of e.listeners) l();
    });
  return e.inflight;
}
/** Poll at the fastest interval any visible reader asks for; not at all when none is visible. */
function schedule(client: Reader, path: string, e: Entry) {
  const every = Math.min(Infinity, ...e.subs.values());
  if (every === e.every) return;
  if (e.timer) clearInterval(e.timer);
  e.timer = undefined;
  e.every = every;
  if (Number.isFinite(every)) e.timer = setInterval(() => void fetchNow(client, path, e), every);
}

/** Read a GET route now and every `ms` while the pane is visible. Readers of
 * the same route share one cache entry and one request at a time. */
export function usePoll<T>(path: string | null, ms: number) {
  const { client } = useResearch();
  const visible = useContext(PaneVisible);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!path) return;
    const e = entryOf(client, path);
    const me = Symbol(path);
    e.subs.set(me, visible ? ms : Infinity);
    e.listeners.add(rerender);
    schedule(client, path, e);
    // Fresh data when first read, and when a pane comes back into view.
    if (e.data === undefined || (visible && Date.now() - e.at > ms)) void fetchNow(client, path, e);
    return () => {
      e.subs.delete(me);
      e.listeners.delete(rerender);
      schedule(client, path, e);
      if (!e.subs.size) caches.get(client)?.delete(path);
    };
  }, [client, path, ms, visible]);
  const e = path ? caches.get(client)?.get(path) : undefined;
  const reload = useCallback(() => (path ? fetchNow(client, path, entryOf(client, path)) : Promise.resolve()), [client, path]);
  return { data: e?.data as T | undefined, error: e?.error, reload };
}
