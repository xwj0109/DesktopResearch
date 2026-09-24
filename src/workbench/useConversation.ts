import { terminalInputFrames } from "../terminal-input";
import { useEffect, useRef, useState } from "react";
import type { NativeClient } from "../native-client";
import type {
  RuntimeCompletion,
  NativeHistory,
  NativeOperation,
  NativeSnapshot,
} from "../native-contract";
import type { PiEvent } from "../pi-protocol";
import type { RequestRecord } from "../../desktop/contracts";

// Window/client lifetime, so changing tabs or StrictMode remounts never retries
// a failed connection or overrides an explicit Stop.
const connectionVisits = new WeakMap<NativeClient, Set<string>>();
function visits(client: NativeClient) {
  let set = connectionVisits.get(client);
  if (!set) { set = new Set(); connectionVisits.set(client, set); }
  return set;
}

/** Canonical session state for one stage/portfolio conversation.
 *
 * Behavioural contract (carried over unchanged from the previous workbench):
 * generation/context-fenced polling and history paging, client-known intent IDs
 * persisted before dispatch, no automatic replay of uncertain actions, ordered
 * terminal input with a failure barrier, and composer drafts that are only
 * cleared when the acknowledged prompt still matches the draft. */
export function useConversation({
  client,
  stage,
  draft,
  onDraft,
  preparing,
  autoConnect = false,
}: {
  client: NativeClient;
  stage: string;
  draft: string;
  onDraft: (text: string) => void;
  preparing?: boolean;
  autoConnect?: boolean;
}) {
  const base = `/native/conversations/${stage}`;
  const [snapshot, setSnapshot] = useState<NativeSnapshot>(),
    [history, setHistory] = useState<NativeHistory>(),
    [events, setEvents] = useState<PiEvent[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connecting, setConnecting] = useState(false),
    [recoveredImages, setRecoveredImages] = useState<{ id: string; images: { mimeType: string; data: string }[] }>(),
    [records, setRecords] = useState<RequestRecord[]>([]);
  const inputTail = useRef(Promise.resolve()),
    inputFailed = useRef(false),
    inputPending = useRef(0);
  const paging = useRef(false),
    historyEpoch = useRef(0),
    alive = useRef(true),
    current = useRef<NativeSnapshot | undefined>(undefined),
    sequence = useRef(0),
    sending = useRef(false),
    lastHistory = useRef(""),
    draftRef = useRef(draft),
    draftChange = useRef(onDraft);
  draftRef.current = draft;
  draftChange.current = onDraft;

  const loadRecords = () =>
    client.records().then((rows) => {
      if (alive.current)
        setRecords(rows.filter((r) => r.path.startsWith(client.base + base)));
    });

  const refresh = async (force = false) => {
    const seq = ++sequence.current,
      previous = current.current;
    const state = await client.read<NativeSnapshot>(
      base +
        (previous && !force
          ? `?after=${previous.through}&generation=${previous.generation}`
          : ""),
    );
    if (!alive.current || seq !== sequence.current) return;
    current.current = state;
    for (const event of state.events) {
      if (event.type === "editor_replaced" && event.seq > (previous?.generation === state.generation ? previous.through : 0) && draftRef.current === event.original)
        draftChange.current(String(event.text));
    }
    setSnapshot(state);
    setEvents((old) =>
      (previous?.generation !== state.generation || force
        ? state.events
        : [...old, ...state.events]
      ).slice(-512),
    );
    const stamp = `${state.generation}:${state.context}:${state.connected}:${state.lastSubmission?.status}`;
    if (force || stamp !== lastHistory.current || state.resyncRequired) {
      const page = await client.read<NativeHistory>(
        base +
          "/history?cursor=0" +
          (state.context ? `&context=${state.context}` : ""),
      );
      if (alive.current && seq === sequence.current) {
        historyEpoch.current++;
        setHistory(page);
        lastHistory.current = stamp;
      }
    }
  };

  useEffect(() => {
    alive.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        await refresh();
      } catch (e) {
        if (alive.current) setError(String(e instanceof Error ? e.message : e));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1200);
    void loadRecords();
    return () => {
      alive.current = false;
      sequence.current++;
      clearInterval(timer);
    };
  }, [client, base]);

  /** Resolves true once the runtime acknowledged the operation. */
  const act = async (operation: NativeOperation): Promise<boolean> => {
    const parallelReply =
      operation.type === "ui_response" || operation.type === "cancel";
    if ((!parallelReply && sending.current) || preparing || !current.current)
      return false;
    if (!parallelReply && inputPending.current > 0) {
      setError(
        "Wait for typed terminal input to be acknowledged before changing the session.",
      );
      return false;
    }
    if (operation.type === "connect" || operation.type === "stop") visits(client).add(base);
    if (operation.type === "connect") setConnecting(true);
    if (!parallelReply) {
      sending.current = true;
      setBusy(true);
    }
    setError("");
    const selected = current.current,
      id = crypto.randomUUID(),
      submitted = draftRef.current;
    try {
      const receipt = await client.write<{ status: string; result?: { queue?: { message: string; images?: { mimeType: string; data: string }[] }[] } }>(
        base + "/actions",
        {
          intent: {
            id,
            generation: selected.generation,
            context: selected.context,
            ...(selected.runtimeState?.sessionId ? { sessionId: selected.runtimeState.sessionId } : {}),
          },
          operation,
        },
        id,
      );
      if (receipt.status !== "acknowledged")
        throw new Error(
          `Request ${receipt.status}. Inspect the receipt and canonical history; it was not replayed.`,
        );
      if ((operation.type === "prompt" || operation.type === "queue") && draftRef.current === submitted)
        draftChange.current("");
      if ((operation.type === "cancel" || operation.type === "retrieve_queue") && receipt.result?.queue?.length) {
        draftChange.current([draftRef.current, ...receipt.result.queue.map(item => item.message)].filter(Boolean).join("\n\n"));
        const images = receipt.result.queue.flatMap(item => item.images ?? []);
        if (images.length) setRecoveredImages({ id, images });
      }
      await refresh(true);
      return true;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (!parallelReply) sending.current = false;
      if (alive.current) {
        if (operation.type === "connect") setConnecting(false);
        if (!parallelReply) setBusy(false);
        void loadRecords();
      }
    }
  };

  useEffect(() => {
    if (!autoConnect || !snapshot || preparing || busy || error || visits(client).has(base)) return;
    visits(client).add(base);
    if (!snapshot.connected) void act({ type: "connect" });
  }, [autoConnect, snapshot, preparing, busy, error, client, base]);

  const terminalInput = (surfaceId: string, data: string): void => {
    // Preserve ordering and per-frame bounds for bracketed paste as well as keys.
    const frames = terminalInputFrames(data);
    if (frames.length > 1) { for (const frame of frames) terminalInput(surfaceId, frame); return; }
    const selected = current.current;
    if (!selected || preparing || inputFailed.current) {
      setError(
        "Terminal input is paused. Refresh the session before continuing.",
      );
      return;
    }
    inputPending.current++;
    const task = inputTail.current
      .then(async () => {
        if (inputFailed.current) return;
        const id = crypto.randomUUID();
        const result = await client.write<{ status: string }>(
          base + "/actions",
          {
            intent: {
              id,
              generation: selected.generation,
              context: selected.context,
            ...(selected.runtimeState?.sessionId ? { sessionId: selected.runtimeState.sessionId } : {}),
            },
            operation: { type: "terminal_input", surfaceId, data },
          },
          id,
        );
        if (result.status !== "acknowledged")
          throw new Error(
            "Terminal input was not acknowledged; queued keys were not replayed",
          );
        if (alive.current) await refresh();
      })
      .catch((e) => {
        inputFailed.current = true;
        if (alive.current)
          setError(
            `${String(e)}. Terminal input paused; inspect the saved editor and refresh before typing again.`,
          );
        throw e;
      });
    inputTail.current = client.track(
      task.finally(() => {
        inputPending.current--;
      }),
      base,
    );
  };

  /** Explicit refresh; refused while typed terminal input is still queued. */
  const manualRefresh = () => {
    if (inputPending.current > 0) {
      setError("Wait for queued terminal input before refreshing.");
      return;
    }
    inputFailed.current = true;
    void refresh(true).then(
      () => {
        inputTail.current = Promise.resolve();
        client.acknowledgeBarrier(base);
        inputFailed.current = false;
      },
      (e) => setError(String(e)),
    );
  };

  const loadMore = () => {
    if (paging.current || !history) return;
    paging.current = true;
    const epoch = historyEpoch.current,
      generation = current.current?.generation,
      context = history.context,
      cursor = history.next;
    void client
      .read<NativeHistory>(
        base +
          `/history?cursor=${cursor}` +
          (context ? `&context=${context}` : ""),
      )
      .then(
        (page) => {
          if (
            !alive.current ||
            historyEpoch.current !== epoch ||
            current.current?.generation !== generation ||
            current.current?.context !== context ||
            page.context !== context
          )
            return;
          setHistory((h) =>
            h && h.next === cursor && h.context === context
              ? { ...page, entries: [...h.entries, ...page.entries] }
              : h,
          );
        },
        (e) => {
          if (alive.current && historyEpoch.current === epoch)
            setError(String(e));
        },
      )
      .finally(() => {
        paging.current = false;
      });
  };

  const inspectReceipt = (id: string) =>
    void client.read<any>(base + `/receipts/${id}`).then(
      (result) =>
        setError(
          result.receipt
            ? `Receipt: ${result.receipt.status}. An acknowledgement confirms dispatch only; canonical messages show the outcome.`
            : "No backend receipt found. This is not proof that delayed delivery is impossible. Seal the request before replacing it.",
        ),
      (e) => setError(String(e)),
    );
  const sealReceipt = (id: string) =>
    void client.write(base + `/receipts/${id}/seal`, {}).then(
      () =>
        setError(
          "Receipt inspected/sealed. Existing dispatched work is not cancelled; inspect canonical history before another send.",
        ),
      (e) => setError(String(e)),
    );
  const complete = async (text: string): Promise<RuntimeCompletion[]> => {
    const selected = current.current;
    const encoded = encodeURIComponent(text);
    if (!selected?.connected || text.length > 400 || encoded.length > 1500) return [];
    const result = await client.read<{ items: RuntimeCompletion[] }>(base + `/complete?text=${encoded}&generation=${selected.generation}`);
    return result.items;
  };
  const readRecovery = () => client.read(base + "/recovery");
  const reconcile = async (expected: object, note: string) => {
    await client.write(base + "/recovery", {
      ...expected,
      historyReviewed: true,
      unmanagedWritersStopped: true,
      note,
    });
    await refresh(true);
  };

  return {
    snapshot,
    history,
    events,
    error,
    setError,
    busy,
    connecting,
    recoveredImages,
    complete,
    records,
    act,
    terminalInput,
    manualRefresh,
    loadMore,
    inspectReceipt,
    sealReceipt,
    readRecovery,
    reconcile,
  };
}
