import { RuntimeTerminal } from "./RuntimeTerminal";
import { matchesRuntimeKey } from "./runtime-keys";
import { ChatComposer } from "./ChatComposer";
import { ReviewAttachmentCard } from "./ReviewAttachmentCard";
import { useOptionalResearch } from "./research";
import { ReviewIdeaForm } from "./panes/ReviewPane";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeClient } from "../native-client";
import { messageText } from "../native-client";
import type { PiDialog, PiEvent } from "../pi-protocol";
import { useConversation } from "./useConversation";
import {
  Elapsed,
  HistoryEntry,
  Spinner,
  ToolBlock,
  renderOutput,
  type ToolResultMessage,
  type ToolStatus,
} from "./transcript";
import { Prose } from "./Prose";

export interface RuntimeSummary {
  connected: boolean;
  running: boolean;
  pending?: number;
  model?: string;
  thinking?: string;
}

/** Pending Pi dialog, docked above the composer as a numbered choice list. */
function PendingDialog({
  dialog,
  respond,
  busy,
}: {
  dialog: PiDialog;
  respond: (value?: string | boolean, cancelled?: boolean) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const [search, setSearch] = useState("");
  const options =
    dialog.method === "select"
      ? (dialog.options ?? []).filter(option => option.toLowerCase().includes(search.toLowerCase())).map((option) => ({
          label: option,
          run: () => respond(option),
        }))
      : dialog.method === "confirm"
        ? [
            { label: "Confirm", run: () => respond(true) },
            { label: "Cancel", run: () => respond(undefined, true) },
          ]
        : [];
  return (
    <section
      className="ask"
      role="dialog"
      aria-label={dialog.title}
      onKeyDown={(event) => {
        if (["TEXTAREA", "INPUT"].includes((event.target as HTMLElement).tagName)) return;
        const n = Number(event.key);
        if (n >= 1 && n <= options.length && !busy) {
          event.preventDefault();
          options[n - 1].run();
        } else if (event.key === "Escape" && !busy) {
          event.preventDefault();
          respond(undefined, true);
        }
      }}
    >
      <h3>{dialog.title}</h3>
      {dialog.message && <p>{dialog.message}</p>}
      {dialog.method === "select" && (dialog.options?.length ?? 0) > 8 && <input aria-label="Search choices" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search choices…" />}
      {options.length > 0 && (
        <div className="ask-options">
          {options.map((option) => (
            <button disabled={busy} key={option.label} onClick={option.run}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {(dialog.method === "input" || dialog.method === "editor") && (
        <>
          {dialog.secret ? <input type="password" autoComplete="off" aria-label={dialog.title} value={value} onChange={event => setValue(event.target.value)} /> : <textarea
            aria-label={dialog.title}
            value={value}
            rows={dialog.method === "editor" ? 8 : 2}
            onChange={(e) => setValue(e.target.value)}
            placeholder={dialog.placeholder}
          />}
          <div className="row-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => respond(undefined, true)}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => respond(value)}
            >
              Submit
            </button>
          </div>
        </>
      )}
      {dialog.method === "select" && (
        <div className="row-actions">
          <span className="note">1–{options.length} to choose · esc to cancel</span>
          <button
            className="btn small"
            disabled={busy}
            onClick={() => respond(undefined, true)}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function RecoveryPanel({
  read,
  reconcile,
  onError,
}: {
  read: () => Promise<any>;
  reconcile: (expected: object, note: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [recovery, setRecovery] = useState<any>(),
    [historyReviewed, setHistoryReviewed] = useState(false),
    [writersStopped, setWritersStopped] = useState(false),
    [note, setNote] = useState("");
  return (
    <details className="fold">
      <summary>Recover interrupted session ownership</summary>
      <div className="fold-body">
        <p className="note">
          First inspect canonical history and stop any unmanaged terminal
          writer. Recovery preserves the uncertain outcome and never resends
          input.
        </p>
        <button
          className="btn small"
          onClick={() => void read().then(setRecovery, (e) => onError(String(e)))}
        >
          Inspect ownership
        </button>
        {recovery && (
          <>
            <p className={recovery.recoveryRequired ? "warn" : "ok"}>
              {recovery.recoveryRequired
                ? "Unresolved ownership or submission recorded"
                : "No recovery required"}
            </p>
            {recovery.lease && (
              <p className="note">
                Recorded process: {recovery.lease.pid}. Recovery is refused
                while it is alive.
              </p>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={historyReviewed}
                onChange={(e) => setHistoryReviewed(e.target.checked)}
              />
              I reviewed the canonical history
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={writersStopped}
                onChange={(e) => setWritersStopped(e.target.checked)}
              />
              Unmanaged session writers are stopped
            </label>
            <label className="stack">
              Recovery note
              <textarea value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button
              className="btn primary small"
              disabled={
                !recovery.recoveryRequired ||
                !historyReviewed ||
                !writersStopped ||
                !note.trim()
              }
              onClick={() => {
                const { recoveryRequired, ...expected } = recovery;
                void reconcile(expected, note).then(
                  () => setRecovery(undefined),
                  (e) => onError(String(e)),
                );
              }}
            >
              Reconcile inspected ownership
            </button>
          </>
        )}
      </div>
    </details>
  );
}

interface LiveTool {
  id: string;
  name: string;
  args?: unknown;
  status: ToolStatus;
  output?: string;
  seq: number;
}
function liveTools(events: PiEvent[]): LiveTool[] {
  const tools = new Map<string, LiveTool>();
  for (const event of events) {
    if (!event.type.startsWith("tool_execution_")) continue;
    const id = String(event.toolCallId ?? event.seq);
    const tool = tools.get(id) ?? {
      id,
      name: String(event.toolName ?? "tool"),
      status: "run" as ToolStatus,
      seq: event.seq,
    };
    if (event.type === "tool_execution_start") tool.args = event.args;
    if (event.type === "tool_execution_update")
      tool.output = renderOutput(event.partialResult);
    if (event.type === "tool_execution_end") {
      tool.status = event.isError ? "err" : "ok";
      tool.output = renderOutput(event.result);
    }
    tools.set(id, tool);
  }
  return [...tools.values()];
}

function StreamingMessage({ event }: { event: PiEvent }) {
  const message = event.message as any;
  const content = Array.isArray(message?.content) ? message.content : [];
  const thinking = content
    .filter((p: any) => p?.type === "thinking")
    .map((p: any) => p.thinking)
    .join("\n");
  const text =
    content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join("") ||
    (content.length ? "" : messageText(message)) ||
    String((event.assistantMessageEvent as any)?.delta ?? "");
  return (
    <article className="msg assistant streaming">
      <div className="msg-meta">
        <strong className="who-pi">pi</strong>
        <span>streaming</span>
      </div>
      {thinking && (
        <details className="thinking" open>
          <summary>thinking</summary>
          <div>{thinking}</div>
        </details>
      )}
      {(text || !thinking) && <Prose text={text} className="prose msg-body" />}
    </article>
  );
}

export function NativeConversation({
  client,
  stage,
  draft,
  onDraft,
  preparing,
  context,
  saveStatus,
  onRuntime,
  autoConnect = false,
}: {
  autoConnect?: boolean;
  client: NativeClient;
  stage: string;
  draft: string;
  onDraft: (text: string) => void;
  preparing?: boolean;
  /** Human scope label for the composer, e.g. "Momentum / Literature". */
  context?: string;
  saveStatus?: string;
  onRuntime?: (summary: RuntimeSummary) => void;
}) {
  const researchScope = useOptionalResearch();
  const session = useConversation({ client, stage, draft, onDraft, preparing, autoConnect });
  const { snapshot, history, events, error, busy, connecting, records, act } = session;
  const connected = !!snapshot?.connected,
    running = !!snapshot?.runtimeState?.isStreaming;
  const model = snapshot?.runtimeState?.model;
  const thinking = snapshot?.runtimeState?.thinkingLevel;
  const runStart = useRef(0);
  if (running && !runStart.current) runStart.current = Date.now();
  if (!running) runStart.current = 0;
  const pendingCount = snapshot?.ui?.pending?.length ?? 0;
  useEffect(() => {
    onRuntime?.({
      connected,
      running,
      pending: pendingCount,
      model: model ? (model.name ?? model.id) : undefined,
      thinking,
    });
  }, [connected, running, pendingCount, model?.id, model?.name, thinking]);

  const scroller = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const entries: any[] = history?.entries ?? [];
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, events.length]);

  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries)
    if (entry?.message?.role === "toolResult" && entry.message.toolCallId)
      results.set(String(entry.message.toolCallId), entry.message);
  const calledHere = new Set<string>();
  for (const entry of entries)
    if (entry?.message?.role === "assistant" && Array.isArray(entry.message.content))
      for (const part of entry.message.content)
        if (part?.type === "toolCall") calledHere.add(String(part.id));

  const lastStart = events.map((e) => e.type).lastIndexOf("agent_start");
  const allTools = liveTools(events);
  const currentTools = liveTools(lastStart >= 0 ? events.slice(lastStart) : events);
  const activeMessage = [...events]
    .reverse()
    .find((e) => e.type === "message_update");
  const surfaces = snapshot?.ui?.surfaces ?? [];
  const canSend =
    connected &&
    !!snapshot?.runtimeState?.ready &&
    !busy &&
    !running &&
    !preparing &&
    !snapshot?.runtimeState?.pendingUI;
  const notices = events
    .filter((e) => ["notification", "diagnostic", "editor_submit"].includes(e.type))
    .slice(-8);

  return (
    <div className="native-conversation" style={{ display: "contents" }} onKeyDown={event => {
      if ((event.target as HTMLElement).closest?.(".term, [role=dialog]")) return;
      const keys = snapshot?.runtimeState?.keybindings;
      if (matchesRuntimeKey(event, "app.message.copy", keys)) {
        const selected = event.target as HTMLTextAreaElement;
        if (selected.selectionStart !== undefined && selected.selectionStart !== selected.selectionEnd) return;
        event.preventDefault();
        const last = [...entries].reverse().find(entry => entry?.message?.role === "assistant");
        if (last) void navigator.clipboard.writeText(messageText(last.message)).catch(() => session.setError("Clipboard unavailable. Select and copy the response text."));
        return;
      }
      const tools = matchesRuntimeKey(event, "app.tools.expand", keys), thinking = matchesRuntimeKey(event, "app.thinking.toggle", keys);
      if (!tools && !thinking) return;
      event.preventDefault();
      const blocks = Array.from(scroller.current?.querySelectorAll<HTMLDetailsElement>(tools ? "details.tool" : "details.thinking") ?? []);
      const expand = blocks.some(block => !block.open);
      for (const block of blocks) block.open = expand;
    }}>
      <div className="runtime">
        <span className={`state ${connected ? "on" : ""}`}>
          <span className={`dot ${running ? "live" : connected ? "ok" : "idle"}`} />
          {connected
            ? running
              ? "Pi is working"
              : "Pi connected"
            : connecting ? "Connecting…" : "Disconnected"}
          {connected && model && (
            <span className="dim">· {model.name ?? model.id}</span>
          )}
        </span>
        <div className="actions">
          <button
            className={`btn small ${connected ? "" : "primary"}`}
            disabled={busy || !snapshot || preparing}
            onClick={() => void act({ type: connected ? "stop" : "connect" })}
          >
            {connecting ? "Connecting…" : connected ? "Stop session" : error ? "Retry connection" : "Connect"}
          </button>
          {connected && (
            <button
              className="btn small"
              disabled={busy || running || preparing}
              onClick={() => void act({ type: "reload" })}
            >
              Reload extensions
            </button>
          )}
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={session.manualRefresh}
          >
            Refresh
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        className="transcript"
        aria-label="Conversation"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="transcript-inner">
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {!connected && (
            <p className="notice">
              {connecting ? "Connecting to your saved conversation. You can keep writing while it loads."
                : "Your research and draft remain available. Connect to continue the conversation."}
            </p>
          )}
          <div className="divider">
            {history?.mode === "active-branch"
              ? "conversation"
              : "saved conversation"}
          </div>
          {entries.map((entry, index) =>
            entry?.message?.role === "toolResult" &&
            calledHere.has(String(entry.message.toolCallId)) ? null : (
              <div key={entry?.id ?? index}>
                <HistoryEntry entry={entry} results={results} />
                {researchScope && !researchScope.portfolio && entry?.message?.role === "assistant" && messageText(entry.message).trim() && <ReviewIdeaForm response={messageText(entry.message)} />}
              </div>
            ),
          )}
          {!entries.length && (
            <div className="empty">
              <h2>Your research starts here</h2>
              <p>Send a message to start this conversation.</p>
            </div>
          )}
          {history?.truncated && (
            <p role="alert" className="notice warn">
              A canonical entry exceeds the display limit. The full entry
              remains in the Pi session; this view has not skipped it.
            </p>
          )}
          {history?.next !== null &&
            history?.next !== undefined &&
            !history.truncated && (
              <button className="btn small ghost" onClick={session.loadMore}>
                Load more canonical entries
              </button>
            )}
          {running && activeMessage && <StreamingMessage event={activeMessage} />}
          {running && currentTools.length > 0 && (
            <div className="tools">
              {currentTools.map((tool) => (
                <ToolBlock key={tool.id} {...tool} />
              ))}
            </div>
          )}
          {running && (
            <div className="working" role="status">
              <Spinner />
              <span>working</span>
              <span className="dim">
                <Elapsed since={runStart.current} /> · {currentTools.length} tool
                {currentTools.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
          {!running && allTools.length > 0 && (
            <details className="worklog">
              <summary>
                Tool activity · {allTools.length} call
                {allTools.length === 1 ? "" : "s"} this connection
              </summary>
              <div className="tools">
                {allTools.map((tool) => (
                  <ToolBlock key={tool.id} {...tool} />
                ))}
              </div>
            </details>
          )}
          {notices.map((event) => {
            const level = String(event.notifyType ?? event.severity ?? "info");
            return (
              <div
                className={`notice ${level === "error" ? "error" : level === "warning" ? "warn" : ""}`}
                key={event.seq}
              >
                <div>
                  <span>
                    {String(
                      event.message ??
                        (event.type === "editor_submit"
                          ? "The extension submitted an editor draft. Review it and press Send explicitly."
                          : ""),
                    )}
                  </span>
                  {event.type === "editor_submit" && (
                    <button
                      className="btn small"
                      onClick={() => onDraft(String(event.text ?? ""))}
                    >
                      Use extension draft
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {snapshot?.ui?.editor && snapshot.ui.editor !== draft && (
            <div className="notice">
              <div>
                <span>A separate expanded Pi editor draft is saved by the host.</span>
                <button
                  className="btn small"
                  disabled={snapshot.ui.editor.length > 100000}
                  onClick={() => onDraft(snapshot.ui!.editor)}
                >
                  Copy recovered editor draft to composer
                </button>
              </div>
            </div>
          )}
          {snapshot?.runtimeState?.editorCheckpoint?.inputStatus === "pending" && (
            <p role="alert" className="notice warn">
              The previous editor input ended without an acknowledgement.
              Inspect the saved expanded text before typing; no keys were
              replayed.
            </p>
          )}
          {surfaces.some((s) => s.kind === "editor") && (
            <button
              className="btn small"
              disabled={busy}
              onClick={() => void act({ type: "editor_state", text: draft })}
            >
              Load composer draft into extension editor
            </button>
          )}
          {surfaces.map((surface) => (
            <details
              open={surface.kind === "custom" || surface.kind === "editor"}
              className="term"
              key={surface.surfaceId}
            >
              <summary>
                <span>
                  pi extension · {surface.kind} · {surface.columns}×{surface.rows}
                </span>
                {surface.kind === "custom" && (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        type: "terminal_cancel",
                        surfaceId: surface.surfaceId,
                      })
                    }
                  >
                    Dismiss
                  </button>
                )}
              </summary>
              <RuntimeTerminal key={`${snapshot?.generation}:${surface.surfaceId}`}
                surfaceId={surface.surfaceId} events={events} columns={surface.columns} rows={surface.rows}
                disabled={preparing || !connected} onError={session.setError}
                input={data => session.terminalInput(surface.surfaceId, data)}
                resize={(columns, rows) => { void act({ type: "terminal_resize", surfaceId: surface.surfaceId, columns, rows }); }} />
            </details>
          ))}
          {!connected && (
            <RecoveryPanel
              read={session.readRecovery}
              reconcile={session.reconcile}
              onError={session.setError}
            />
          )}
          {records.length > 0 && (
            <details className="fold">
              <summary>
                Request receipts · {records.length} retained in this view
              </summary>
              <div className="fold-body">
                {records.slice(0, 20).map((record) => (
                  <div className="receipt" key={record.id}>
                    <code>{record.id}</code>
                    <span className="tag">{record.status}</span>
                    <button
                      className="btn small"
                      onClick={() => session.inspectReceipt(record.id)}
                    >
                      Inspect
                    </button>
                    <button
                      className="btn small"
                      onClick={() => session.sealReceipt(record.id)}
                    >
                      Seal missing receipt
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      {snapshot?.ui?.pending.map((dialog) => (
        <PendingDialog
          key={dialog.id}
          dialog={dialog}
          busy={!!preparing}
          respond={(value, cancelled) =>
            void act({
              type: "ui_response",
              requestId: dialog.id,
              value,
              cancelled,
            })
          }
        />
      ))}
      {!!snapshot?.runtimeState?.queue && (snapshot.runtimeState.queue.steering.length > 0 || snapshot.runtimeState.queue.followUp.length > 0) && <div className="notice">
        <span>{snapshot.runtimeState.queue.steering.length} steering · {snapshot.runtimeState.queue.followUp.length} follow-up messages queued</span>
        <button className="btn small" disabled={busy || preparing} onClick={() => void act({ type: "retrieve_queue" })}>Return to editor</button>
      </div>}
      <ChatComposer
        extensionShortcuts={snapshot?.runtimeState?.extensionShortcuts}
        onCopy={() => {
          const last = [...entries].reverse().find(entry => entry?.message?.role === "assistant");
          if (last) void navigator.clipboard.writeText(messageText(last.message)).catch(() => session.setError("Clipboard unavailable. Select and copy the response text."));
        }}
        recoveredImages={session.recoveredImages}
        complete={session.complete}
        doubleEscapeAction={snapshot?.runtimeState?.doubleEscapeAction}
        keybindings={snapshot?.runtimeState?.keybindings}
        promptHistory={entries.filter(entry => entry?.message?.role === "user").map(entry => messageText(entry.message))}
        draft={draft}
        onDraft={onDraft}
        preparing={preparing}
        busy={busy}
        running={running}
        connected={connected}
        canSend={canSend}
        context={context ?? stage}
        saveStatus={saveStatus ?? "local draft"}
        models={snapshot?.models ?? []}
        model={model}
        thinking={thinking}
        thinkingLevels={snapshot?.runtimeState?.availableThinkingLevels ?? []}
        commands={connected ? (snapshot?.commands ?? []) : []}
        act={act}
      />
    </div>
  );
}
