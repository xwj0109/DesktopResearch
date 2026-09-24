import { EditorActions } from "./editor-actions";
import { defaultRuntimeKeys, matchesRuntimeKey } from "./runtime-keys";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import type { NativeOperation, RuntimeCompletion } from "../native-contract";
import { CHAT_IMAGE_TYPES } from "../native-contract";
import { composeChatMessage, fileAttachment, isTextFile, sourceAttachment, splitChatMessage, type ChatAttachment } from "../chat-attachment";
import { ReviewAttachmentCard } from "./ReviewAttachmentCard";
import { useOptionalResearch } from "./research";
import { allCommands, hint, parseCommand, resolveModel, suggest, type Suggestion } from "./composer-hints";
import type { Artifact } from "../shared";

type Image = { name: string; mimeType: (typeof CHAT_IMAGE_TYPES)[number]; data: string; url: string };
const MAX_IMAGES = 4;
const IMAGE_BUDGET = 3_800_000; // base64 characters across images

/** Downscale large images (long side ≤ 2000 px) and re-encode big ones as JPEG. */
async function encodeImage(file: File): Promise<Image> {
  const type = CHAT_IMAGE_TYPES.includes(file.type as Image["mimeType"]) ? (file.type as Image["mimeType"]) : "image/png";
  let blob: Blob = file;
  if (typeof createImageBitmap === "function" && type !== "image/gif") {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      if (scale < 1 || file.size > 1_500_000) {
        const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await canvas.convertToBlob({ type: file.size > 1_500_000 ? "image/jpeg" : type, quality: 0.85 });
      }
      bitmap.close();
    } catch {}
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: file.name || "pasted image", mimeType: (blob.type || type) as Image["mimeType"], data: btoa(binary), url: URL.createObjectURL(blob) };
}
const sha256 = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The chat composer: message, attachments, inline `/` commands with CLI-style
 * hints, and `@` to attach a library source. Attachments are portable (text
 * envelopes + images), so they mean the same to any runtime. */
export function ChatComposer({
  draft,
  onDraft,
  preparing,
  busy,
  running,
  connected,
  canSend,
  context,
  saveStatus,
  models,
  model,
  thinking,
  thinkingLevels,
  commands: runtimeCommands,
  act,
  promptHistory = [],
  recoveredImages,
  keybindings,
  extensionShortcuts = [],
  doubleEscapeAction = "tree",
  onCopy,
  complete,
}: {
  doubleEscapeAction?: "tree" | "fork" | "none";
  complete?: (text: string) => Promise<RuntimeCompletion[]>;
  promptHistory?: string[];
  onCopy?: () => void;
  extensionShortcuts?: string[];
  keybindings?: Record<string, string | string[]>;
  recoveredImages?: { id: string; images: { mimeType: string; data: string }[] };
  draft: string;
  onDraft: (text: string) => void;
  preparing?: boolean;
  busy: boolean;
  running: boolean;
  connected: boolean;
  /** Runtime ready to accept a message (connected, idle, no pending dialog). */
  canSend: boolean;
  context: string;
  saveStatus: string;
  models: { id: string; provider: string; name: string }[];
  model?: { id: string; provider: string; name?: string };
  thinking?: string;
  thinkingLevels: string[];
  commands: { name: string; description?: string }[];
  act: (operation: NativeOperation) => Promise<boolean | void>;
}) {
  const research = useOptionalResearch();
  const artifacts: Artifact[] = research?.view?.artifacts ?? [];
  const { text, attachments, reviews } = splitChatMessage(draft);
  const [images, setImages] = useState<Image[]>([]);
  const recoveredId = useRef("");
  useEffect(() => {
    if (!recoveredImages || recoveredId.current === recoveredImages.id) return;
    recoveredId.current = recoveredImages.id;
    setImages(current => [...current, ...recoveredImages.images.map((image, index) => ({ name: `Recovered image ${index + 1}`, mimeType: image.mimeType as Image["mimeType"], data: image.data, url: `data:${image.mimeType};base64,${image.data}` }))]);
  }, [recoveredImages]);
  const [notice, setNotice] = useState("");
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const historyIndex = useRef(-1);
  const editorActions = useRef(new EditorActions());
  const lastEscape = useRef(0), lastClear = useRef(0);
  const historyDraft = useRef("");
  const modelPicker = useRef<HTMLSelectElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => allCommands(runtimeCommands), [runtimeCommands]);

  const setParts = (next: { text?: string; attachments?: ChatAttachment[] }) =>
    onDraft(composeChatMessage(next.text ?? text, next.attachments ?? attachments, reviews));
  const localMenu = suggest(text, caret, {
    commands,
    models,
    thinking: thinkingLevels,
    sources: artifacts.filter((a) => !attachments.some((x) => x.kind === "source" && x.id === a.id)),
  });
  const menuKey = `${text.slice(0, caret)}`;
  const [remoteMenu, setRemoteMenu] = useState<{ key: string; items: Suggestion[] }>({ key: "", items: [] });
  const completionCallback = useRef(complete); completionCallback.current = complete;
  useEffect(() => {
    let stale = false;
    if (!connected || !menuKey || menuKey.includes("\n") || !completionCallback.current) return;
    const timer = setTimeout(() => {
      void completionCallback.current!(menuKey).then(items => {
        if (!stale) setRemoteMenu({ key: menuKey, items: items.map(item => ({ ...item, kind: "arg", tag: "runtime" })) });
      }).catch(() => { if (!stale) setRemoteMenu({ key: menuKey, items: [] }); });
    }, 180);
    return () => { stale = true; clearTimeout(timer); };
  }, [menuKey, connected]);
  const menu = { ...localMenu, items: [...localMenu.items, ...(remoteMenu.key === menuKey ? remoteMenu.items.filter(item => !localMenu.items.some(local => local.label === item.label || local.insert === item.insert)) : [])] };
  const open = menu.items.length > 0 && dismissed !== menuKey && !preparing;
  const active = Math.min(cursor, Math.max(0, menu.items.length - 1));
  const help = hint(text, open, commands);

  const accept = (s: Suggestion) => {
    setDismissed(null);
    setCursor(0);
    if (s.kind === "source" && s.sourceId) {
      const a = artifacts.find((x) => x.id === s.sourceId);
      if (!a) return;
      // Drop the @token; don't leave a double space behind.
      const head = text.slice(0, menu.from), tail = text.slice(caret);
      const nextText = head.endsWith(" ") && tail.startsWith(" ") ? head + tail.slice(1) : head + tail;
      setParts({ text: nextText, attachments: [...attachments, sourceAttachment(a)] });
      setCaret(menu.from);
      setTimeout(() => input.current?.setSelectionRange(menu.from, menu.from));
      return;
    }
    const nextText = s.insert! + text.slice(caret);
    setParts({ text: nextText });
    setCaret(s.caret ?? s.insert!.length);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(s.caret ?? s.insert!.length, s.caret ?? s.insert!.length);
    });
  };

  const attachFiles = async (files: File[]) => {
    setNotice("");
    const added: ChatAttachment[] = [];
    const newImages: Image[] = [];
    const problems: string[] = [];
    let budget = 90000 - Math.max(0, composeChatMessage(text, attachments, reviews).length - 10000);
    for (const file of files) {
      try {
        if (file.type.startsWith("image/")) {
          if (images.length + newImages.length >= MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per message`);
          const image = await encodeImage(file);
          const used = [...images, ...newImages].reduce((n, i) => n + i.data.length, 0);
          if (used + image.data.length > IMAGE_BUDGET) throw new Error("images exceed 4 MB in total");
          newImages.push(image);
        } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          // PDFs join the strategy library, then attach by reference.
          if (!research) throw new Error("PDFs attach in strategy windows");
          const bytes = await file.arrayBuffer();
          const digest = await sha256(bytes);
          let found = (research.view?.artifacts ?? []).find((a: Artifact) => a.hash === digest);
          if (!found) {
            const latest = await research.client.read("/native/research");
            await research.client.upload(file, latest.revision);
            const after = await research.client.read("/native/research");
            found = after.artifacts.find((a: Artifact) => a.hash === digest);
            await research.refresh();
          }
          if (!found) throw new Error("imported, but could not be found in the library");
          added.push(sourceAttachment(found));
        } else if (isTextFile(file)) {
          if (budget < 500) throw new Error("the message is full");
          const a = fileAttachment(file.name, file.type || "text/plain", await file.text(), budget);
          budget -= (a as any).content.length;
          added.push(a);
        } else throw new Error("unsupported type (images, text files and PDFs attach)");
      } catch (e) {
        problems.push(`${file.name || "file"}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (added.length) setParts({ attachments: [...attachments, ...added] });
    if (newImages.length) setImages((old) => [...old, ...newImages]);
    if (problems.length) setNotice(`Not attached — ${problems.join(" · ")}`);
    input.current?.focus();
  };

  /** Run "/command args": app commands map to generic operations. */
  const runCommand = async (name: string, args: string) => {
    const spec = commands.find((c) => c.name === name);
    if (!spec) return setNotice(`Unknown command /${name}. Type / to see the commands.`);
    const clearCommand = () => setParts({ text: "" });
    if (spec.source === "runtime") {
      if (attachments.length || images.length) setNotice("Attachments stay here: they are sent with messages, not commands.");
      if (await act({ type: "command", name, args })) clearCommand();
      return;
    }
    switch (name) {
      case "copy": onCopy?.(); clearCommand(); return;
      case "quit": if (await act({ type: "stop" })) clearCommand(); return;
      case "hotkeys":
        clearCommand();
        setNotice(Object.entries(defaultRuntimeKeys).map(([action, fallback]) => { const keys = keybindings?.[action] ?? fallback; const label = action.split(".").slice(1).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(); return `${label}: ${[keys].flat().join(", ") || "unbound"}`; }).join(" · "));
        return;
      case "model": {
        const m = resolveModel(args, models);
        if (!args) { clearCommand(); modelPicker.current?.focus(); try { modelPicker.current?.showPicker?.(); } catch {} return; }
        if (!m) return setNotice(`No model matches "${args}".`);
        if (await act({ type: "set_model", provider: m.provider, modelId: m.id })) clearCommand();
        return;
      }
      case "thinking": {
        const level = thinkingLevels.find((l) => l === args.trim().toLowerCase());
        if (!level) return setNotice(`Thinking levels: ${thinkingLevels.join(", ") || "none available"}.`);
        if (await act({ type: "set_thinking", level })) clearCommand();
        return;
      }
      case "attach":
        clearCommand();
        picker.current?.click();
        return;
      case "clear":
        images.forEach(image => URL.revokeObjectURL(image.url));
        setImages([]);
        onDraft("");
        return;
      case "cancel":
      case "reload":
      case "connect":
      case "stop":
        if (await act({ type: name })) clearCommand();
        return;
    }
  };

  const submit = async (behavior: "steer" | "followUp" = "steer") => {
    setNotice("");
    const parsed = parseCommand(text, commands);
    if (parsed && (!running || parsed.spec?.source === "app")) return runCommand(parsed.name, parsed.args);
    if (text.startsWith("!")) {
      if (running) return setNotice("Wait for the active turn or cancel it before running a shell command.");
      if (await act({ type: "command", name: "shell", args: text.slice(1) })) setParts({ text: "" });
      return;
    }
    if ((!canSend && !running) || !connected || busy || preparing) return;
    if (images.length > MAX_IMAGES) { setNotice("Recovered images exceed four per message. Remove some before sending."); return; }
    const message = draft.trim() ? draft : images.length ? "[image attached]" : "";
    if (!message) return;
    const ok = await act({ ...(running ? { type: "queue" as const, behavior } : { type: "prompt" as const }), message, ...(images.length ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}) });
    if (ok) {
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent?.isComposing || e.keyCode === 229 || preparing) return;
    const is = (action: string) => matchesRuntimeKey(e, action, keybindings);
    const field = e.currentTarget;
    const start = field?.selectionStart ?? 0, end = field?.selectionEnd ?? start;
    if (open) {
      if (is("tui.select.down") || is("tui.select.up")) {
        e.preventDefault(); setCursor(c => (Math.min(c, menu.items.length - 1) + (is("tui.select.down") ? 1 : menu.items.length - 1)) % menu.items.length); return;
      }
      if (is("tui.input.tab") || is("tui.input.submit")) { e.preventDefault(); accept(menu.items[active]); return; }
      if (is("tui.select.cancel")) { e.preventDefault(); setDismissed(menuKey); return; }
    }
    if (is("tui.input.newLine")) {
      e.preventDefault(); setParts({ text: text.slice(0, start) + "\n" + text.slice(end) }); setCaret(start + 1);
      setTimeout(() => input.current?.setSelectionRange(start + 1, start + 1)); return;
    }
    const older = is("tui.editor.historyPrevious") || is("tui.editor.cursorUp");
    const newer = is("tui.editor.historyNext") || is("tui.editor.cursorDown");
    if (older || newer) {
      const atEdge = is("tui.editor.historyPrevious") || is("tui.editor.historyNext") || (start === end && (older ? !text.slice(0, start).includes("\n") : !text.slice(end).includes("\n")));
      const history = promptHistory.map(message => splitChatMessage(message).text).filter(Boolean).slice().reverse();
      if (atEdge && history.length && (older || historyIndex.current >= 0)) {
        e.preventDefault();
        if (historyIndex.current < 0) historyDraft.current = text;
        historyIndex.current = older ? Math.min(history.length - 1, historyIndex.current + 1) : historyIndex.current - 1;
        const recalled = historyIndex.current < 0 ? historyDraft.current : history[historyIndex.current];
        setParts({ text: recalled }); setCaret(recalled.length);
        setTimeout(() => input.current?.setSelectionRange(recalled.length, recalled.length)); return;
      }
      if (is("tui.editor.historyPrevious") || is("tui.editor.historyNext")) return;
    }
    const extensionKey = extensionShortcuts.find(key => matchesRuntimeKey(e, "extension", { extension: key }));
    if (extensionKey) { e.preventDefault(); void act({ type: "shortcut", key: extensionKey }); return; }
    if (is("app.editor.external")) { e.preventDefault(); void act({ type: "command", name: "editor", args: draft }); return; }
    if (is("app.model.select")) {
      e.preventDefault();
      if (connected && !busy && !running) { modelPicker.current?.focus(); try { modelPicker.current?.showPicker?.(); } catch {} }
      return;
    }
    if (is("app.thinking.cycle") && connected && !busy && !running && thinkingLevels.length) {
      e.preventDefault(); void act({ type: "set_thinking", level: thinkingLevels[(thinkingLevels.indexOf(thinking ?? "") + 1) % thinkingLevels.length] }); return;
    }
    if (is("app.model.cycleForward") || is("app.model.cycleBackward")) {
      e.preventDefault(); if (!busy && !running) void act({ type: "cycle_model", direction: is("app.model.cycleBackward") ? "backward" : "forward" }); return;
    }
    if (is("app.clear")) {
      if (start !== end) return; // Preserve graphical text copying.
      e.preventDefault();
      if (!draft && !images.length && Date.now() - lastClear.current < 500) void act({ type: "stop" });
      else { onDraft(""); images.forEach(image => URL.revokeObjectURL(image.url)); setImages([]); historyIndex.current = -1; }
      lastClear.current = Date.now(); return;
    }
    if (is("app.exit") && !draft && !images.length) { e.preventDefault(); void act({ type: "stop" }); return; }
    if (is("app.message.dequeue")) { e.preventDefault(); void act({ type: "retrieve_queue" }); return; }
    if (is("app.interrupt")) {
      e.preventDefault();
      if (running) void act({ type: "cancel" });
      else if (doubleEscapeAction !== "none" && Date.now() - lastEscape.current < 500) void act({ type: "command", name: doubleEscapeAction });
      lastEscape.current = Date.now(); return;
    }
    for (const name of ["new", "resume", "fork", "tree"]) {
      if (is(`app.session.${name}`)) { e.preventDefault(); void act({ type: "command", name }); return; }
    }
    const editorAction = ["cursorLeft", "cursorRight", "cursorWordLeft", "cursorWordRight", "cursorLineStart", "cursorLineEnd", "cursorUp", "cursorDown", "pageUp", "pageDown", "deleteCharBackward", "deleteCharForward", "deleteWordBackward", "deleteWordForward", "deleteToLineStart", "deleteToLineEnd", "yank", "yankPop", "undo", "jumpForward", "jumpBackward"].find(action => is(`tui.editor.${action}`));
    const nativeVertical = ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const edited = editorActions.current.apply(nativeVertical ? "" : editorAction ?? "", text, start, end, !e.ctrlKey && !e.metaKey && !e.altKey ? e.key : undefined);
    if (edited) {
      e.preventDefault(); setParts({ text: edited.text }); setCaret(edited.start);
      setTimeout(() => input.current?.setSelectionRange(edited.start, edited.end)); return;
    }
    if (is("tui.input.submit") || is("app.message.followUp") || ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey && !e.altKey)) {
      e.preventDefault(); void submit(is("app.message.followUp") ? "followUp" : "steer");
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void attachFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    void attachFiles([...e.dataTransfer.files].slice(0, 10));
  };
  const hasContent = !!text.trim() || attachments.length > 0 || reviews.length > 0 || images.length > 0;
  const isCommand = !!parseCommand(text, commands);

  return (
    <section
      className={`composer ${dragging ? "composer-drop" : ""}`}
      aria-label="Research composer"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="composer-box">
        <div className="composer-ctx">
          <span>{context}</span>
          <span className="spacer" />
          <span>{saveStatus}</span>
        </div>
        {(reviews.length > 0 || attachments.length > 0 || images.length > 0) && (
          <div className="composer-attachments" aria-label="Attachments">
            {reviews.map((review, index) => (
              <ReviewAttachmentCard
                key={`${review.id}:${review.hash}:${index}`}
                attachment={review}
                disabled={preparing}
                onRemove={() => onDraft(composeChatMessage(text, attachments, reviews.filter((_, i) => i !== index)))}
              />
            ))}
            {(attachments.length > 0 || images.length > 0) && (
              <div className="chat-chips">
            {attachments.map((a, index) => (
              <span className={`chat-chip ${a.kind}`} key={`${a.kind}:${a.name}:${index}`} title={a.kind === "source" ? `Library source ${a.id}` : `${a.mime}${a.truncated ? " · truncated" : ""}`}>
                <span className="glyph">{a.kind === "source" ? "▤" : "≡"}</span>
                <span className="name">{a.name}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${a.name}`} disabled={preparing} onClick={() => setParts({ attachments: attachments.filter((_, i) => i !== index) })}>
                  ×
                </button>
              </span>
            ))}
            {images.map((image, index) => (
              <span className="chat-chip image" key={image.url} title={image.name}>
                <img src={image.url} alt={image.name} />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(image.url);
                    setImages((old) => old.filter((_, i) => i !== index));
                  }}
                >
                  ×
                </button>
              </span>
            ))}
              </div>
            )}
          </div>
        )}
        <div className="composer-input">
          <label className="sr-only" htmlFor="live-draft">
            Message to the agent
          </label>
          {open && (
            <div className="composer-menu" role="listbox" aria-label={menu.items[0]?.kind === "source" ? "Sources" : "Commands"}>
              {menu.items.slice(0, 50).map((s, i) => (
                <div
                  key={s.label + i}
                  role="option"
                  aria-selected={i === active}
                  className={`composer-menu-item ${i === active ? "on" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(s);
                  }}
                  onMouseEnter={() => setCursor(i)}
                >
                  <span className="label">{s.label}</span>
                  {s.detail && <span className="detail">{s.detail}</span>}
                  {s.tag && <span className="tag">{s.tag}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            id="live-draft"
            data-autofocus
            rows={2}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            maxLength={Math.max(0, 100000 - (draft.length - text.length))}
            value={text}
            disabled={preparing}
            onChange={(e) => {
              editorActions.current.remember(text, caret);
              historyIndex.current = -1;
              setNotice("");
              setParts({ text: e.target.value });
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setCursor(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={reviews.length || attachments.length || images.length ? "Add a message (optional)…" : "Ask, or type / for commands and @ for sources…"}
          />
        </div>
        <p className={`composer-hint ${help.tone ?? ""}`}>{notice || help.text}</p>
        <div className="composer-bar">
          <button type="button" className="icon-btn attach" aria-label="Attach files" title="Attach images, text files or PDFs (or drop / paste them)" disabled={preparing} onClick={() => picker.current?.click()}>
            📎
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.toml,.tex,.bib,.py,.r,.jl,.ipynb,.ts,.js,.sql"
            onChange={(e) => {
              void attachFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <select
            ref={modelPicker}
            aria-label="Model"
            disabled={!connected || busy || running}
            value={model ? `${model.provider}\0${model.id}` : ""}
            onChange={(e) => {
              const [provider, modelId] = e.target.value.split("\0");
              void act({ type: "set_model", provider, modelId });
            }}
          >
            <option value="">{connected ? "Select model" : "No connected model"}</option>
            {models.map((m) => (
              <option key={m.provider + m.id} value={`${m.provider}\0${m.id}`}>
                {m.name} · {m.provider}
              </option>
            ))}
          </select>
          <select
            aria-label="Thinking level"
            className={thinking ? `thinking-${thinking}` : ""}
            disabled={!connected || busy || running}
            value={thinking ?? ""}
            onChange={(e) => void act({ type: "set_thinking", level: e.target.value })}
          >
            <option value="">Thinking</option>
            {thinkingLevels.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
          <span className="spacer" />
          {running ? (
            <>
              <button className="btn danger" onClick={() => void act({ type: "cancel" })}>Cancel work</button>
              <button className="btn primary send" disabled={busy || preparing || !hasContent} onClick={() => void submit()}>Steer</button>
              <button className="btn" disabled={busy || preparing || !hasContent} onClick={() => void submit("followUp")}>Follow up</button>
            </>
          ) : (
            <button className="btn primary send" disabled={busy || preparing || !hasContent || (!isCommand && !canSend)} onClick={() => void submit()}>
              {isCommand ? "Run" : "Send"}
            </button>
          )}
        </div>
      </div>
      <p className="composer-foot">
        <span>↑↓ prompt history · Escape cancel · /hotkeys for shortcuts</span>
      </p>
    </section>
  );
}
