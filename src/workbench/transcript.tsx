import { splitChatMessage } from "../chat-attachment";
import { ReviewAttachmentCard } from "./ReviewAttachmentCard";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { messageText } from "../native-client";
import { Prose } from "./Prose";

const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Braille spinner. Uses the global timer so hosts that stub `window` keep
 * their own interval bookkeeping intact. */
export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), 90);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden="true">{frames[frame]}</span>;
}

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatElapsed(now - since)}</>;
}

export function formatTime(value: unknown) {
  const date = new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    short: date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }),
    full: date.toLocaleString(),
  };
}

const preferredArgs = ["path", "file_path", "filePath", "command", "cmd", "query", "url", "pattern", "name"];
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args).slice(0, 160);
  const record = args as Record<string, unknown>;
  const key = preferredArgs.find((k) => typeof record[k] === "string");
  const text = key
    ? String(record[key])
    : Object.values(record)
        .filter((v) => typeof v === "string" || typeof v === "number")
        .join(" · ");
  return text.replace(/\s+/g, " ").slice(0, 160);
}
export function renderOutput(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = messageText(value);
  if (text) return text;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type ToolStatus = "run" | "ok" | "err";
const glyph: Record<ToolStatus, ReactNode> = {
  run: <Spinner />,
  ok: "✓",
  err: "✗",
};
/** One tool call, Pi-TUI style: tinted block, accent tool name, argument
 * summary, and a `⎿` result. Collapses when it completes unless the user
 * toggled it; failures stay open. */
export function ToolBlock({
  name,
  args,
  status,
  output,
  when,
  tag,
}: {
  name: string;
  args?: unknown;
  status: ToolStatus;
  output?: string;
  when?: ReactNode;
  tag?: string;
}) {
  const [open, setOpen] = useState(status === "err");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setOpen(status === "err");
  }, [status, touched]);
  const body =
    output ||
    (args !== undefined && typeof args === "object"
      ? JSON.stringify(args, null, 2)
      : "");
  return (
    <details
      className={`tool ${status}`}
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        if (next !== open) {
          setTouched(true);
          setOpen(next);
        }
      }}
    >
      <summary>
        <span className="glyph">{glyph[status]}</span>
        <span className="name">{name}</span>
        <span className="args">{summarizeArgs(args)}</span>
        {tag && <span className="tag">{tag}</span>}
        {when && <span className="when">{when}</span>}
      </summary>
      {body && <pre>{body}</pre>}
    </details>
  );
}

type Part = { type?: string; [key: string]: unknown };
const parts = (content: unknown): Part[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? (content as Part[])
      : content && typeof content === "object"
        ? [content as Part]
        : [];

export interface ToolResultMessage {
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  isError?: boolean;
}

/** One canonical session entry. Assistant tool calls are joined with their
 * `toolResult` messages from the same page via `results`. */
export function HistoryEntry({
  entry,
  results,
}: {
  entry: any;
  results: Map<string, ToolResultMessage>;
}) {
  const message = entry?.message;
  const time = formatTime(entry?.timestamp ?? message?.timestamp);
  const stamp = time && <time title={time.full}>{time.short}</time>;
  if (!message)
    return (
      <details className="event-line">
        <summary>
          Session event · {String(entry?.customType ?? entry?.type ?? "entry")}
          {stamp && <> · {stamp}</>}
        </summary>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    );
  const role = message.role;
  if (role === "user") {
    const composed = splitChatMessage(messageText(message));
    const images = parts(message.content).filter((part) => part.type === "image");
    const empty = !composed.text && !composed.attachments.length && !composed.reviews.length && !images.length;
    return (
      <article className="msg user">
        <div className="msg-meta">
          <strong>you</strong>
          {stamp}
        </div>
        {(composed.text || empty) && composed.text !== "[image attached]" && <div className="msg-body">{composed.text || "(empty message)"}</div>}
        {(composed.attachments.length > 0 || images.length > 0) && (
          <div className="msg-attachments">
            {composed.attachments.map((a, index) => (
              <span className={`chat-chip ${a.kind}`} key={`${a.kind}:${index}`} title={a.kind === "source" ? `Library source ${a.id}` : a.mime}>
                <span className="glyph">{a.kind === "source" ? "▤" : "≡"}</span>
                <span className="name">{a.name}</span>
              </span>
            ))}
            {images.map((part, index) =>
              typeof part.data === "string" && typeof part.mimeType === "string" ? (
                <img className="msg-image" key={`img${index}`} src={`data:${part.mimeType};base64,${part.data}`} alt="attached image" />
              ) : (
                <span className="chat-chip image" key={`img${index}`}>image</span>
              ),
            )}
          </div>
        )}
        {composed.reviews.map((attachment, index) => <ReviewAttachmentCard key={`${attachment.id}:${index}`} attachment={attachment} />)}
      </article>
    );
  }
  if (role === "assistant") {
    const content = parts(message.content);
    return (
      <article className="msg assistant">
        <div className="msg-meta">
          <strong className="who-pi">pi</strong>
          {message.model && <span>{String(message.model)}</span>}
          {stamp}
        </div>
        {content.map((part, index) => {
          if (part.type === "thinking" && typeof part.thinking === "string")
            return (
              <details className="thinking" key={index}>
                <summary>thought</summary>
                <div>{part.thinking}</div>
              </details>
            );
          if (part.type === "toolCall") {
            const result = results.get(String(part.id));
            return (
              <div className="tools" key={index}>
                <ToolBlock
                  name={String(part.name ?? "tool")}
                  args={part.arguments}
                  status={result ? (result.isError ? "err" : "ok") : "ok"}
                  output={result ? renderOutput(result.content) : undefined}
                  tag={result ? undefined : "no result on this page"}
                />
              </div>
            );
          }
          if (part.type === "image")
            return (
              <p className="note" key={index}>
                [image in canonical session]
              </p>
            );
          const text = messageText(part);
          return text ? <Prose key={index} text={text} className="prose msg-body" /> : null;
        })}
        {message.stopReason === "error" && message.errorMessage && (
          <p className="notice error">{String(message.errorMessage)}</p>
        )}
      </article>
    );
  }
  if (role === "toolResult")
    return (
      <div className="tools">
        <ToolBlock
          name={String(message.toolName ?? "tool")}
          status={message.isError ? "err" : "ok"}
          output={renderOutput(message.content)}
          when={stamp}
        />
      </div>
    );
  if (role === "bashExecution")
    return (
      <div className="tools">
        <ToolBlock
          name="bash"
          args={{ command: message.command }}
          status={message.exitCode === 0 || message.exitCode === undefined ? "ok" : "err"}
          output={String(message.output ?? "")}
          when={stamp}
        />
      </div>
    );
  return (
    <details className="event-line">
      <summary>
        {String(role ?? entry.customType ?? entry.type)}
        {stamp && <> · {stamp}</>}
      </summary>
      <pre>{messageText(message) || JSON.stringify(message, null, 2)}</pre>
    </details>
  );
}
