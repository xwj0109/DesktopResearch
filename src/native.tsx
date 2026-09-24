import { Notice } from "./workbench/Notice";
import { NativeClient } from "./native-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  DesktopBridge,
  DesktopContext,
  Scope,
  ViewState,
} from "../desktop/contracts";
import { storableView } from "../desktop/contracts";
import { Clock, Workbench, piMark } from "./workbench/Workbench";
import { disconnectedWorkspace } from "./workbench/native-model";
import { CommandPalette, type Command } from "./workbench/CommandPalette";
import {
  isThemeId,
  resolveTheme,
  themeIds,
  themeStyle,
  themes,
  type ThemeId,
} from "./workbench/theme";
export interface WorkspaceSummary {
  id: string;
  name: string;
}
export class ViewWriter {
  private pending: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private snapshot?: () => ViewState;
  private preparing = false;
  private barriers = new Set<() => Promise<void>>();
  /** Snapshot parts left out of the last save because they failed validation. */
  skipped: string[] = [];
  addBarrier = (barrier: () => Promise<void>) => {
    this.barriers.add(barrier);
    return () => {
      this.barriers.delete(barrier);
    };
  };
  constructor(private bridge: Pick<DesktopBridge, "saveView">) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  isPreparing = () => this.preparing;
  setSnapshot = (get: () => ViewState) => {
    this.snapshot = get;
  };
  private enqueue(state: ViewState) {
    const task = this.pending
      .catch(() => {})
      .then(() => {
        const { value, skipped } = storableView(state);
        this.skipped = skipped;
        return this.bridge.saveView(value);
      });
    this.pending = task;
    void task.catch(() => {});
    return task;
  }
  save(state: ViewState) {
    return this.preparing ? this.pending : this.enqueue(state);
  }
  async flush() {
    // A save appended while an earlier write is awaited must join the barrier.
    let retried = false;
    while (true) {
      const tail = this.pending;
      try { await tail; }
      catch (error) {
        if (tail !== this.pending) continue;
        if (retried || !this.snapshot) throw error;
        // A view snapshot is an idempotent local replacement. Retrying it must
        // never replay an annotation, import, or other research mutation.
        retried = true;
        this.enqueue(this.snapshot());
        continue;
      }
      if (tail === this.pending) return;
    }
  }
  /** Before a research write: refuse while closing, and let pending draft
   * saves land first. Drafts are a local convenience, so a snapshot that
   * cannot be stored never blocks notes, imports or research records. */
  beforeResearchWrite = async () => {
    if (this.preparing) throw new Error("View is closing");
    await this.flush().catch(() => {});
  };
  async prepare() {
    this.preparing = true;
    for (const fn of this.listeners) fn();
    await Promise.all([...this.barriers].map((barrier) => barrier()));
    if (this.snapshot) this.enqueue(this.snapshot());
    await this.flush();
  }
  cancel = () => {
    this.preparing = false;
    for (const fn of this.listeners) fn();
  };
}
async function request(bridge: DesktopBridge, path: string, name?: string | Record<string, unknown>) {
  const response = await bridge.lab({
    path,
    method: name === undefined ? "GET" : "POST",
    headers: name === undefined ? {} : { "content-type": "application/json" },
    ...(name === undefined
      ? {}
      : { body: new TextEncoder().encode(JSON.stringify(typeof name === "string" ? { name } : name)) }),
  });
  const body = JSON.parse(new TextDecoder().decode(response.body));
  if (response.status < 200 || response.status >= 300)
    throw new Error(body.error ?? "Workspace request failed");
  if (body.durabilityUncertain)
    throw new Error(
      "The workspace change was published but durability is uncertain. Do not repeat it. Quit and verify the workspace list after restarting.",
    );
  return body;
}
export function Launcher({
  bridge,
  theme,
  onTheme,
}: {
  bridge: DesktopBridge;
  theme: ThemeId;
  onTheme: (id: ThemeId) => void;
}) {
  const [strategies, setStrategies] = useState<WorkspaceSummary[]>([]),
    [portfolios, setPortfolios] = useState<WorkspaceSummary[]>([]);
  const [kind, setKind] = useState<"strategy" | "portfolio">("strategy"),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [palette, setPalette] = useState<string | null>(null),
    [active, setActive] = useState<"list" | "create">("list");
  const [editing, setEditing] = useState<WorkspaceSummary | null>(null);
  const [editedName, setEditedName] = useState("");
  const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null);
  const [managementError, setManagementError] = useState("");
  const [managementStatus, setManagementStatus] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [s, p] = await Promise.all([
        request(bridge, "/api/strategies"),
        request(bridge, "/api/portfolios"),
      ]);
      setStrategies(s);
      setPortfolios(p);
    } catch {
      setError("Workspace list unavailable. No creation was replayed.");
    } finally {
      setBusy(false);
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => (open === null ? "" : null));
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  const open = async (scope: Exclude<Scope, { kind: "launcher" }>) => {
    try {
      await bridge.openWorkspace(scope);
    } catch {
      setError("Workspace could not open. Please refresh the list and try again.");
    }
  };
  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await request(
        bridge,
        `/api/${kind === "strategy" ? "strategies" : "portfolios"}`,
        name.trim(),
      );
      setName("");
      await open({ kind, id: result.id });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Creation failed. Refresh the list before retrying.",
      );
    } finally {
      await refresh();
    }
  };
  const manage = async (action: "rename" | "delete", item: WorkspaceSummary) => {
    if (busy) return;
    setBusy(true); setManagementError(""); setManagementStatus("");
    try {
      await request(bridge, `/api/strategy-management/${item.id}/${action}`, { expectedName: item.name, ...(action === "rename" ? { name: editedName.trim() } : {}) });
      setEditing(null); setDeleting(null);
      setManagementStatus(action === "rename" ? "Strategy renamed." : "Strategy deleted from the launcher. Stored research files are retained on disk.");
    } catch (error) { setManagementError(error instanceof Error ? error.message : "Workspace change failed. Refresh before retrying."); }
    finally { await refresh(); }
  };
  const chooseTheme = onTheme;
  const items = kind === "strategy" ? strategies : portfolios;
  const commands: Command[] = [
    ...strategies.map((item) => ({
      id: "s-" + item.id,
      label: item.name,
      detail: "strategy",
      glyph: "◆",
      group: "open strategy",
      run: () => void open({ kind: "strategy", id: item.id }),
    })),
    ...portfolios.map((item) => ({
      id: "p-" + item.id,
      label: item.name,
      detail: "portfolio",
      glyph: "◇",
      group: "open portfolio",
      run: () => void open({ kind: "portfolio", id: item.id }),
    })),
    ...themeIds.map((id) => ({
      id: `theme-${id}`,
      label: `Theme · ${themes[id].label}`,
      detail: themes[id].mode,
      glyph: id === theme ? "●" : "○",
      hint: id === theme ? "current" : themes[id].mode,
      group: "theme",
      run: () => chooseTheme(id),
    })),
  ];
  return (
    <div className={bridge.integratedTitlebar ? "wb integrated-titlebar" : "wb"} data-theme={theme} style={themeStyle(theme)}>
      <header className="bar">
        <div className="bar-left">
          <button
            className="bar-item bar-menu"
            onClick={() => setPalette("")}
            aria-label="Open command palette"
            title="Command palette  ⌘K"
          >
            π
          </button>
          <span className="bar-title">
            <strong>Pi Research</strong> › workspaces
          </span>
        </div>
        <Clock />
        <div className="bar-right">
          <span className="bar-item">
            <span className="dot idle" />
            no pi connection
          </span>
          <button
            className="bar-item"
            onClick={() => setPalette("theme ")}
            aria-label="Change theme"
          >
            ◐ {themes[theme].label.toLowerCase()}
          </button>
          <span className="bar-item">
            <kbd>⌘K</kbd>
          </span>
        </div>
      </header>
      <div className="tiles">
        <section
          className={`tile main ${active === "list" ? "active" : ""}`}
          aria-label="Saved workspaces"
          onPointerDownCapture={() => setActive("list")}
          onFocusCapture={() => setActive("list")}
        >
          <span className="tile-label" aria-hidden="true">
            ~/workspaces
          </span>
          <div className="tabs" role="tablist" aria-label="Workspace kind">
            {(["strategy", "portfolio"] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "strategy" ? "Strategies" : "Portfolios"}
                <sup>{(k === "strategy" ? strategies : portfolios).length}</sup>
              </button>
            ))}
            <span className="spacer" />
            <button
              className="btn small ghost"
              style={{ alignSelf: "center" }}
              disabled={busy}
              onClick={() => {
                setError("");
                void refresh();
              }}
            >
              Refresh list
            </button>
          </div>
          <div className="pathbar">
            <span className="path">
              {kind === "strategy"
                ? "Seven research stages, one shared strategy context."
                : "Separate evidence review. No automatic cross-strategy coordination."}
            </span>
          </div>
          <div className="launch-list">
            {managementError && <Notice error message={managementError} onDismiss={() => setManagementError("")} />}
            {managementStatus && <Notice message={managementStatus} onDismiss={() => setManagementStatus("")} />}
            {items.map((item) => (
              <div className="launch-entry" key={item.id}>
                <div className="launch-entry-row">
                  <button className="launch-row" disabled={busy} onClick={() => void open({ kind, id: item.id })}>
                    <span className="g">{kind === "strategy" ? "◆" : "◇"}</span>
                    <span className="label">{item.name}</span><span className="detail">open ›</span>
                  </button>
                  {kind === "strategy" && <div className="launch-entry-actions">
                    <button className="btn small" disabled={busy} aria-label={`Rename ${item.name}`} onClick={() => { setEditing(item); setEditedName(item.name); setDeleting(null); setManagementError(""); }}>Rename</button>
                    <button className="btn small danger" disabled={busy} aria-label={`Delete ${item.name}`} onClick={() => { setDeleting(item); setEditing(null); setManagementError(""); }}>Delete…</button>
                  </div>}
                </div>
                {kind === "strategy" && editing?.id === item.id && <form className="launch-manage" onSubmit={event => { event.preventDefault(); void manage("rename", editing); }}>
                  <label className="stack">Strategy name<input autoFocus value={editedName} maxLength={120} disabled={busy} onChange={event => setEditedName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }} /></label>
                  <div className="launch-entry-actions"><button className="btn primary" disabled={busy || !editedName.trim() || editedName.trim() === editing.name}>Save name</button><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
                </form>}
                {kind === "strategy" && deleting?.id === item.id && <div className="launch-manage" role="group" aria-label={`Confirm deletion of ${item.name}`}>
                  <strong>Delete “{item.name}”?</strong>
                  <p>This removes the strategy from the launcher, closes its window and revokes agent access. Stored research files and existing portfolio imports remain on disk. There is no restore action in the launcher.</p>
                  <p>Stop connected sessions and finish or cancel experiments before deleting.</p>
                  <div className="launch-entry-actions"><button className="btn danger" disabled={busy} onClick={() => void manage("delete", deleting)}>Delete strategy</button><button className="btn" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button></div>
                </div>}
              </div>
            ))}
            {!items.length && (
              <p className="note" style={{ padding: "10px" }}>
                {busy
                  ? "Loading local workspaces…"
                  : `No ${kind === "strategy" ? "strategies" : "portfolios"} yet. Create a local workspace.`}
              </p>
            )}
          </div>
          <div className="pane-status">
            <span>Independent contexts · connecting never sends a prompt</span>
          </div>
        </section>
        <section
          className={`tile pane ${active === "create" ? "active" : ""}`}
          style={{ width: 380 }}
          aria-label="Create workspace"
          onPointerDownCapture={() => setActive("create")}
          onFocusCapture={() => setActive("create")}
        >
          <span className="tile-label" aria-hidden="true">
            new
          </span>
          <div className="launch-create">
            <pre className="banner" aria-hidden="true">
              {piMark}
            </pre>
            <h2 className="section-title">create {kind}</h2>
            <label className="fld" htmlFor="workspace-name">
              Workspace name
            </label>
            <div className="input-row">
              <input
                id="workspace-name"
                maxLength={120}
                value={name}
                disabled={busy}
                placeholder={kind === "strategy" ? "cross-sectional momentum" : "q3 evidence review"}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </div>
            <div>
              <button
                className="btn primary"
                disabled={busy || !name.trim()}
                onClick={() => void create()}
              >
                Create and open
              </button>
            </div>
            <p className="note">
              Creates local storage only. No Pi session, tools or models are
              started.
            </p>
            {error && (
              <p role="alert" className="notice error">
                {error}
              </p>
            )}
          </div>
        </section>
      </div>
      {palette !== null && (
        <CommandPalette
          commands={commands}
          initialQuery={palette}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}
/** One theme for the whole app: main owns it, every window follows. A window's
 * legacy per-view theme seeds the app-wide value once if none is set yet. */
export function useAppTheme(bridge: DesktopBridge, appTheme: string | null | undefined, legacy?: string) {
  const [theme, setTheme] = useState<ThemeId>(() => resolveTheme(appTheme ?? legacy));
  useEffect(() => {
    if (!appTheme && isThemeId(legacy)) void bridge.saveTheme?.(legacy).catch(() => {});
    return bridge.onThemeChanged?.((next) => {
      if (isThemeId(next)) setTheme(next);
    });
  }, [bridge]);
  const choose = useCallback(
    (id: ThemeId) => {
      setTheme(id);
      void bridge.saveTheme?.(id).catch(() => {});
    },
    [bridge],
  );
  return [theme, choose] as const;
}
export function NativeApp({
  bridge,
  context,
  initial,
  writer,
  theme: appTheme,
}: {
  bridge: DesktopBridge;
  context: DesktopContext;
  initial: ViewState;
  writer: ViewWriter;
  theme?: string | null;
}) {
  const [theme, chooseTheme] = useAppTheme(bridge, appTheme, initial.theme);
  const preparing = useSyncExternalStore(writer.subscribe, writer.isPreparing);
  const client = useMemo(
    () =>
      new NativeClient(bridge, context, writer.beforeResearchWrite),
    [bridge, context, writer],
  );
  useEffect(() => writer.addBarrier(() => client.drain()), [writer, client]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>(),
    [error, setError] = useState(""),
    [saveStatus, setSaveStatus] = useState("Local drafts");
  const changed = useCallback(
    (state: ViewState) => {
      setSaveStatus("Saving local draft…");
      void writer.save(state).then(
        () =>
          setSaveStatus(
            writer.skipped.length
              ? `Saved locally, except ${writer.skipped.join(", ")} (invalid; kept in this window)`
              : "Saved locally",
          ),
        (error) =>
          setSaveStatus(
            `Draft not saved: ${String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 240)}`,
          ),
      );
    },
    [writer],
  );
  useEffect(() => {
    if (context.scope.kind === "launcher") return;
    const scope = context.scope;
    let disposed = false;
    let loaded = false;
    // Only the first load can fail the view; a later poll that fails (busy
    // backend, sleep) keeps the loaded workspace and simply retries.
    const load = () => request(bridge, `/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}/${scope.id}`).then(value => { loaded = true; if (!disposed) setWorkspace(value); }, () => { if (!disposed && !loaded) setError("Workspace metadata unavailable. No conversation was loaded. Quit and reopen before continuing."); });
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { disposed = true; clearInterval(timer); };

  }, [bridge, context]);
  useEffect(() => {
    if (error) void bridge.reportViewStatus("failed").catch(() => {});
    else if (context.scope.kind === "launcher" || workspace)
      void bridge.reportViewStatus("ready").catch(() => {});
  }, [bridge, context.scope.kind, !!workspace, error]);
  if (context.scope.kind === "launcher")
    return <Launcher bridge={bridge} theme={theme} onTheme={chooseTheme} />;
  if (!workspace)
    return (
      <div className="wb" style={themeStyle(theme)}>
        <div className="boot">
          <div>
            <pre className="banner" aria-hidden="true">
              {piMark}
            </pre>
            <h1>Pi Research</h1>
            <p role={error ? "alert" : "status"} className={error ? "err" : ""}>
              {error || "Opening local workspace…"}
            </p>
          </div>
        </div>
      </div>
    );
  return (
    <Workbench
      data={disconnectedWorkspace(workspace.id, workspace.name)}
      native={{
        client,
        kind: context.scope.kind,
        initial,
        onChange: changed,
        saveStatus,
        theme,
        onTheme: chooseTheme,
        preparing,
        isPreparing: writer.isPreparing,
        registerSnapshot: writer.setSnapshot,
        onLauncher: () => {
          void bridge
            .focusLauncher()
            .catch(() => setSaveStatus("Workspace launcher could not open"));
        },
      }}
    />
  );
}
