import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import type { DesktopBridge } from "../../desktop/contracts";
import { themes, type ThemeId } from "./theme";
import { copyText } from "./PdfViewer";
import { HistoryEntry } from "./transcript";
import { Prose } from "./Prose";
import { activeBranch, parseEntries, summarize, toolResults, type PiEntry } from "./pi-session";

/** Pi's built-in commands, typed into Pi when chosen (Pi's own autocomplete
 * and dialogs take it from there; extension commands are one "/" away). */
const PI_COMMANDS: { name: string; description: string }[] = [
  { name: "model", description: "Switch model" },
  { name: "settings", description: "Settings" },
  { name: "resume", description: "Resume another session" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "fork", description: "Fork from an earlier message" },
  { name: "compact", description: "Compact the context" },
  { name: "name", description: "Name this session" },
  { name: "session", description: "Session info and usage" },
  { name: "copy", description: "Copy the last reply" },
  { name: "export", description: "Export the session" },
  { name: "hotkeys", description: "Keyboard shortcuts" },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "login", description: "Sign in to a provider" },
];

/** Registered by the terminal so other panes ("Ask Pi", review tray) can type
 * into the CLI as a bracketed paste instead of a separate composer. */
const pasteTargets = new Map<string, (text: string) => void>();
export const pasteIntoTerminal = (stage: string, text: string) => {
  const target = pasteTargets.get(stage);
  if (!target) return false;
  target(text);
  return true;
};

function xtermTheme(id: ThemeId) {
  const t = themes[id];
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.accent,
    cursorAccent: t.background,
    selectionBackground: t.selection,
    black: t.mode === "dark" ? t.darkBackground : t.darkForeground,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.mode === "dark" ? t.foreground : t.lighterBackground,
    brightBlack: t.muted,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.orange,
    brightBlue: t.blue,
    brightMagenta: t.magenta,
    brightCyan: t.cyan,
    brightWhite: t.brightForeground,
  };
}
/** Shell-escape a dropped path the way macOS Terminal pastes it. */
const escapePath = (p: string) => p.replace(/([\s'"\\()&;$`!*?[\]{}<>|#~])/g, "\\$1");

/** The real Pi CLI for this stage, in the app's theme (see desktop/terminal.ts). */
export function PiTerminal({
  bridge,
  stage,
  theme,
  onStatus,
}: {
  bridge: DesktopBridge;
  stage: string;
  theme: ThemeId;
  onStatus?: (status: { running: boolean; exited: number | null; cwd?: string }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const [exited, setExited] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [cwd, setCwd] = useState("");
  const status = useRef(onStatus);
  status.current = onStatus;
  const fitRef = useRef<() => { cols: number; rows: number }>(() => ({ cols: 100, rows: 30 }));
  const [label, setLabel] = useState("");
  const [view, setView] = useState<"terminal" | "reader">("terminal");
  const [menu, setMenu] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [running, setRunning] = useState(false);
  const offset = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow Pi's session file (read-only, incremental) for the bar and reading view.
  useEffect(() => {
    if (!bridge.terminalTranscript) return;
    let stopped = false;
    offset.current = 0;
    setEntries([]);
    const poll = async () => {
      try {
        const r = await bridge.terminalTranscript!(stage, offset.current);
        if (stopped) return;
        setRunning(r.running);
        if (r.reset) setEntries(parseEntries(r.text));
        else if (r.text) setEntries((old) => [...old, ...parseEntries(r.text)]);
        offset.current = r.offset;
      } catch {}
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [bridge, stage]);

  useEffect(() => {
    if (!host.current || !bridge.terminalOpen) return;
    let disposed = false;
    let cleanup = () => {};
    setExited(null);
    setError("");
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(async ([{ Terminal }, { FitAddon }]) => {
      if (disposed || !host.current) return;
      const t = new Terminal({
        fontSize: 13,
        fontFamily: getComputedStyle(host.current).getPropertyValue("--mono").trim() || 'ui-monospace, "SF Mono", Menlo, monospace',
        theme: xtermTheme(theme),
        cursorBlink: true,
        macOptionIsMeta: true,
        allowProposedApi: false,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(host.current);
      term.current = t;
      fitRef.current = () => {
        try {
          fit.fit();
        } catch {}
        return { cols: Math.max(20, t.cols), rows: Math.max(5, t.rows) };
      };
      // ⌘C copies a selection (the CLI never sees it); everything else goes to Pi.
      t.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.metaKey && e.key.toLowerCase() === "c" && t.hasSelection()) {
          copyText(t.getSelection());
          return false;
        }
        return true;
      });
      const input = t.onData((data) => bridge.terminalInput?.(stage, data));
      const off = bridge.onTerminal?.((event) => {
        if (event.stage !== stage) return;
        if (event.type === "output") t.write(event.data);
        else {
          setExited(event.code);
          status.current?.({ running: false, exited: event.code });
        }
      });
      pasteTargets.set(stage, (text) => {
        t.paste(text);
        t.focus();
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observer = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed || !host.current?.offsetWidth) return;
          const { cols, rows } = fitRef.current();
          bridge.terminalResize?.(stage, cols, rows);
        }, 60);
      });
      observer.observe(host.current);
      cleanup = () => {
        clearTimeout(timer);
        observer.disconnect();
        input.dispose();
        off?.();
        if (pasteTargets.get(stage)) pasteTargets.delete(stage);
        t.dispose();
        term.current = undefined;
      };
      const { cols, rows } = fitRef.current();
      try {
        const opened = await bridge.terminalOpen!(stage, cols, rows);
        if (disposed) return;
        setCwd(opened.cwd);
        setLabel(opened.label ?? "");
        if (opened.replay) t.write(opened.replay);
        status.current?.({ running: true, exited: null, cwd: opened.cwd });
        t.focus();
      } catch (e) {
        if (!disposed) setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [bridge, stage]);

  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme);
  }, [theme]);

  const restart = async () => {
    if (!bridge.terminalRestart || !term.current) return;
    setExited(null);
    setError("");
    setHandedOff(false);
    setView("terminal");
    term.current.reset();
    const { cols, rows } = fitRef.current();
    try {
      await bridge.terminalRestart(stage, cols, rows);
      status.current?.({ running: true, exited: null, cwd });
      term.current.focus();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const paste = (text: string) => {
    setView("terminal");
    term.current?.paste(text);
    term.current?.focus();
  };
  const type = (text: string) => {
    setView("terminal");
    bridge.terminalInput?.(stage, text);
    setTimeout(() => term.current?.focus());
  };
  const handoff = async () => {
    try {
      await bridge.terminalHandoff?.(stage);
      setHandedOff(true);
      setView("reader");
      status.current?.({ running: false, exited: null, cwd });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const summary = summarize(entries);
  const branch = activeBranch(entries);
  const results = toolResults(entries);
  useEffect(() => {
    const el = reader.current;
    if (el && view === "reader" && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, view]);
  // In the reading view, typing goes back to Pi (the key is delivered).
  const readerKey = (e: ReactKeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || handedOff) return;
    const data = e.key === "Enter" ? "\r" : e.key.length === 1 ? e.key : "";
    if (!data) return;
    e.preventDefault();
    type(data);
  };
  const folder = cwd.replace(/^\/Users\/[^/]+/, "~");

  if (!bridge.terminalOpen)
    return <p className="notice error">This window has no terminal bridge; update the desktop app.</p>;
  return (
    <div className="pi-pane">
      <div className="pi-bar" role="toolbar" aria-label="Pi session">
        <span className={`pi-dot ${handedOff ? "away" : running ? (summary.working ? "working" : "on") : "off"}`} title={handedOff ? "Running in Terminal" : running ? (summary.working ? "Working" : "Idle") : "Not running"} />
        <span className="pi-session" title={summary.name ?? label}>
          {/* The tile header already names the stage. */}
          {(summary.name ?? label ?? "Pi").split(" · ")[0]}
        </span>
        {summary.model && (
          <span className="pi-model" title="Model (from the session)">
            {summary.model.split("/").pop()}
            {summary.thinking ? ` · ${summary.thinking}` : ""}
          </span>
        )}
        <span className="spacer" />
        <button className={`idea-toggle ${view === "reader" ? "on" : ""}`} aria-label="Reading view" aria-pressed={view === "reader"} title="Reading view: formatted conversation (maths, tables, tool results). Typing returns to Pi." onClick={() => setView((v) => (v === "reader" ? "terminal" : "reader"))}>
          ≡ Read
        </button>
        <span className="pi-menu-anchor">
          <button className="idea-toggle" aria-label="Pi commands" title="Pi commands" aria-expanded={menu} disabled={handedOff} onClick={() => setMenu((m) => !m)}>
            / ▾
          </button>
          {menu && (
            <div className="pi-menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {PI_COMMANDS.map((c) => (
                <button
                  key={c.name}
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    type(`/${c.name}`);
                  }}
                >
                  <span className="label">/{c.name}</span>
                  <span className="detail">{c.description}</span>
                </button>
              ))}
              <button
                role="menuitem"
                title={cwd}
                onClick={() => {
                  setMenu(false);
                  copyText(cwd);
                }}
              >
                <span className="label">Copy folder path</span>
                <span className="detail">{folder.split("/").slice(-2).join("/")}</span>
              </button>
              <p className="pi-menu-note">Your extension and skill commands: type / in Pi. In Terminal, run pi -r in the copied folder.</p>
            </div>
          )}
        </span>
        <button className="idea-toggle" aria-label="Attach files" title="Attach files (their paths are pasted into Pi)" disabled={handedOff} onClick={() => picker.current?.click()}>
          + Attach
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const paths = [...(e.target.files ?? [])].map((f) => bridge.pathForFile?.(f)).filter(Boolean) as string[];
            if (paths.length) paste(paths.map(escapePath).join(" ") + " ");
            e.target.value = "";
          }}
        />
        {bridge.terminalHandoff && (
          <button className="idea-toggle" aria-label="Open in Terminal" title="Continue this session in Terminal (the pane's Pi stops first)" disabled={handedOff} onClick={() => void handoff()}>
            ↗ Terminal
          </button>
        )}
        <button className="idea-toggle" aria-label="Restart Pi" title="Restart Pi (the session is kept)" onClick={() => void restart()}>
          ↻
        </button>
      </div>
      <div
        className="pi-terminal"
        hidden={view !== "terminal"}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile?.(f)).filter(Boolean) as string[];
          if (paths.length) paste(paths.map(escapePath).join(" ") + " ");
        }}
      >
        <div ref={host} className="pi-terminal-host" onMouseDown={() => setTimeout(() => term.current?.focus())} />
      </div>
      {view === "reader" && (
        <div
          ref={reader}
          className="pi-reader transcript"
          tabIndex={0}
          onKeyDown={readerKey}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {!branch.length && <p className="note">No messages yet. The session file appears with Pi's first message.</p>}
          {branch.map((entry, index) => (
            <ReaderEntry key={entry.id ?? index} entry={entry} results={results} />
          ))}
          {summary.working && !handedOff && <p className="note">Pi is working…</p>}
        </div>
      )}
      {(exited !== null || error || handedOff) && (
        <div className="pi-terminal-notice" role="status">
          <span>
            {handedOff
              ? "This session continues in Terminal. Quit Pi there, then resume here."
              : error || `Pi exited${exited ? ` (code ${exited})` : ""}. Its session is saved.`}
          </span>
          <button className="btn small primary" onClick={() => void restart()}>
            {handedOff ? "Resume here" : error ? "Try again" : "Restart Pi"}
          </button>
        </div>
      )}
    </div>
  );
}

/** One session entry in the reading view. */
function ReaderEntry({ entry, results }: { entry: PiEntry; results: Map<string, any> }) {
  if (entry.type === "message") {
    const m = entry.message;
    if (m?.role === "toolResult") return null; // shown with its call
    if (m?.role === "bashExecution")
      return (
        <div className="tools">
          <pre className="reader-bash">
            <span className="dim">$ </span>
            {m.command}
            {"\n"}
            {String(m.output ?? "").slice(0, 20000)}
          </pre>
        </div>
      );
    if (m?.role === "custom" && m.display === false) return null;
    return <HistoryEntry entry={entry} results={results} />;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return (
      <details className="reader-summary">
        <summary>{entry.type === "compaction" ? "Earlier conversation compacted" : "Summary of another branch"}</summary>
        <Prose text={String(entry.summary ?? "")} />
      </details>
    );
  if (entry.type === "model_change") return <p className="reader-event">model → {entry.provider}/{entry.modelId}</p>;
  if (entry.type === "thinking_level_change") return <p className="reader-event">thinking → {entry.thinkingLevel}</p>;
  if (entry.type === "custom_message" && entry.display)
    return (
      <div className="msg">
        <Prose text={typeof entry.content === "string" ? entry.content : (entry.content ?? []).map((c: any) => c.text ?? "").join("\n")} />
      </div>
    );
  return null;
}
