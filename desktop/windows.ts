import fs from "node:fs/promises";
import { RequestJournal } from "./requests.ts";
import { allowedRequest } from "./security.ts";
import {
  BrowserWindow,
  session,
  screen,
  ipcMain,
  dialog,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  channels,
  scopeSchema,
  type Scope,
  type DesktopContext,
} from "./contracts.ts";
import { assertSender, documentURL, scopeKey, scopePath, UntrustedSender } from "./security.ts";
import { assetResponse, boundedBytes, labRequest } from "./protocol.ts";
import {
  storageIdentity,
  readWindowState,
  saveWindowState,
  clampBounds,
  type WindowRecord,
} from "./window-state.ts";
import { ownedDirectory } from "../server/lifecycle.ts";
import { ViewStore } from "./view-state.ts";
import { PreferenceStore, themeIdSchema } from "./preferences.ts";
import { createPaperSearch, defaultPaperDeps, fetchPaper, parsePaperSource, type PaperDeps } from "./papers.ts";
import { themes, isThemeId } from "../src/workbench/theme.ts";
import type { Backend } from "./backend.ts";
import { Terminals, readSession, scopeFolder, sessionFile, stageSessionId } from "./terminal.ts";
import { createRequire as nodeRequire } from "node:module";
import { stageIds, viewFaultSchema } from "./contracts.ts";
interface Owned {
  window: BrowserWindow;
  session: Session;
  scope: Scope;
  capability: string;
  context: DesktopContext;
  pending: number;
  closing?: Promise<boolean>;
  preparing?: Promise<boolean>;
  markReady: () => void;
  failReady: () => void;
  loadFailed?: boolean;
  readyLogged?: boolean;
}
export class Windows {
  private owned = new Map<string, Owned>();
  private opening = new Map<string, Promise<void>>();
  private managing = new Set<string>();
  private partitions = new Map<string, Session>();
  private prepared = new Map<
    number,
    { nonce: string; resolve: (ok: boolean) => void }
  >();
  private quitting = false;
  private stateFile: string;
  private stateWarning = false;
  private viewStore: ViewStore;
  private preferences: PreferenceStore;
  private accepting = true;
  private terminals: Terminals;
  constructor(
    private config: {
      root: string;
      desktop: string;
      assets: string;
      preload: string;
      diagnose?: (code: string) => void;
      papers?: PaperDeps;
      paperSearchGapMs?: number;
      /** System Node and the installed Pi CLI (from desktop config). */
      node?: string;
      pi?: string;
      /** Packaged node-pty glue and the Pi extension carrying the workbench tools. */
      ptyModule?: string;
      piExtension?: string;
    },
    private backend: Backend,
  ) {
    this.stateFile = path.join(config.desktop, "windows.json");
    this.terminals = new Terminals(
      { node: config.node, pi: config.pi, extension: config.piExtension },
      () => nodeRequire(import.meta.url)(config.ptyModule ?? "node-pty"),
    );
    this.viewStore = new ViewStore(config.root, config.desktop);
    this.preferences = new PreferenceStore(config.desktop);
    const requests = new RequestJournal(config.root, config.desktop);
    const handle = (
      channel: string,
      fn: (owner: Owned, input: unknown) => unknown,
    ) =>
      ipcMain.handle(channel, async (event, input) => {
        let owner: Owned;
        try { owner = this.sender(event); }
        catch (error) {
          // Record which check failed (bounded code) so a window that stops
          // being recognised is diagnosable, and say so for draft saves.
          const reason = error instanceof UntrustedSender ? error.reason : "unregistered";
          this.config.diagnose?.(`ipc-sender-${reason}`);
          if (channel === channels.saveView)
            throw new Error(`Window state could not be saved: this window is no longer recognised by the desktop (${reason}). Copy any unsaved text, then quit and reopen.`);
          throw new Error("Desktop request denied or failed; no operation is automatically replayed");
        }
        try {
          return await fn(owner, input);
        } catch (error) {
          if (channel === channels.saveView) {
            if (error instanceof z.ZodError) {
              this.config.diagnose?.("view-save-invalid");
              const fields = error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 1200);
              throw new Error(`Window state could not be saved: ${fields}`);
            }
            const code = (error as NodeJS.ErrnoException)?.code;
            throw new Error(`Window state could not be saved${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}. Keep this window open and retry.`);
          }
          throw new Error("Desktop request denied or failed; no operation is automatically replayed");
        }
      });
    handle(channels.exportFile, async (o, input) => {
      if (
        o.scope.kind === "launcher" ||
        o.closing ||
        this.quitting ||
        !this.accepting
      )
        throw new Error("Export unavailable");
      const value = z
        .object({
          name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/),
          text: z.string().max(5 * 1024 * 1024),
        })
        .strict()
        .parse(input);
      const result = await dialog.showSaveDialog(o.window, {
        title: "Save research artifact",
        defaultPath: value.name,
      });
      if (result.canceled || !result.filePath) return;
      await fs.writeFile(result.filePath, value.text, { mode: 0o600 });
    });
    handle(channels.requests, (o, input) => {
      z.undefined().parse(input);
      return requests.list(o.scope);
    });
    handle(channels.status, (o, input) => {
      const status = z.union([z.enum(["ready", "failed"]), viewFaultSchema]).parse(input);
      if (typeof status === "object") {
        // A working view hit a stray error: keep a code, don't stop the user.
        this.config.diagnose?.(`renderer-fault-${status.fault}-${status.source}`);
        return;
      }
      if (status === "ready") {
        // Once per window: repeated reports would exhaust the bounded log.
        if (!o.readyLogged) this.config.diagnose?.("renderer-ui-ready");
        o.readyLogged = true;
        o.markReady();
      } else {
        this.config.diagnose?.("renderer-ui-failed");
        this.loadFailure(o, "renderer-ui-failed");
      }
    });
    handle(channels.bootstrap, (o, input) => {
      z.undefined().parse(input);
      return o.context;
    });
    handle(channels.lab, async (o, input) => {
      if (o.pending >= 16 || o.closing || this.quitting || !this.accepting)
        throw new Error("Window busy/closing");
      o.pending++;
      try {
        const req = allowedRequest(o.scope, input);
        const send = () =>
          labRequest(o.scope, req, this.backend.origin, o.capability);
        const deletion = o.scope.kind === "launcher" && req.path.match(/^\/api\/strategy-management\/([0-9a-f-]{36})\/delete$/);
        if (deletion) {
          const key = scopeKey({ kind: "strategy", id: deletion[1] });
          if (this.managing.has(key)) throw new Error("Strategy operation already in progress");
          this.managing.add(key);
          let target: Owned | undefined;
          try {
            await this.opening.get(key);
            target = this.owned.get(key);
            if (target && !(await this.prepare(target))) throw new Error("Strategy window could not prepare for deletion");
            if (target) target.closing = Promise.resolve(true);
            const result = await send();
            if (result.status < 300) target?.window.destroy();
            return result;
          } finally {
            if (target && !target.window.isDestroyed()) { target.closing = undefined; this.cancelPreparation(target); }
            this.managing.delete(key);
          }
        }
        return req.method === "GET" || o.scope.kind === "launcher"
          ? await send()
          : await requests.dispatch(o.scope, req, send);
      } finally {
        o.pending--;
      }
    });
    handle(channels.open, async (o, input) => {
      if (o.scope.kind !== "launcher") throw new Error("Launcher only");
      const scope = scopeSchema.parse(input);
      if (scope.kind === "launcher") throw new Error("Workspace required");
      await this.open(scope);
    });
    handle(channels.launcher, async (_o, input) => {
      z.undefined().parse(input);
      await this.open({ kind: "launcher" });
    });
    handle(channels.readView, (o, input) => {
      z.undefined().parse(input);
      return this.viewStore.read(o.scope);
    });
    // Kept available during prepare-close: future editor flush must not be blocked by close state.
    handle(channels.saveView, (o, input) => {
      this.viewStore.save(o.scope, input);
    });
    // Paper retrieval: explicit, one at a time per window, strategy scopes only.
    const fetching = new WeakSet<Owned>();
    ipcMain.handle(channels.fetchPaper, async (event, input) => {
      const o = this.sender(event);
      if (o.scope.kind !== "strategy" || o.closing || this.quitting || !this.accepting)
        throw new Error("Paper import is available in strategy windows only");
      if (fetching.has(o)) throw new Error("Another paper is still downloading");
      fetching.add(o);
      try {
        const source = parsePaperSource(z.string().max(2048).parse(input));
        return await fetchPaper(source, this.config.papers ?? defaultPaperDeps());
      } catch (error) {
        // Unlike other channels, surface the reason: it is about the link, not internals.
        throw new Error(error instanceof Error ? error.message : "Paper download failed");
      } finally {
        fetching.delete(o);
      }
    });
    // arXiv suggestions: words only, shared polite rate limit (1 request / 3 s).
    const search = createPaperSearch(() => this.config.papers ?? defaultPaperDeps(), this.config.paperSearchGapMs ?? 3000);
    ipcMain.handle(channels.searchPapers, async (event, input) => {
      const o = this.sender(event);
      if (o.scope.kind !== "strategy" || o.closing || this.quitting || !this.accepting)
        throw new Error("Paper search is available in strategy windows only");
      const text = z.string().max(300).parse(input);
      try {
        return await search(o, text);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "arXiv search failed");
      }
    });
    // The real Pi CLI in the conversation pane (see terminal.ts).
    const stageLabels: Record<string, string> = {
      ideas: "Ideas", literature: "Literature", research: "Research Development", data: "Data",
      code: "Design & Code", backtests: "Backtests", results: "Results", portfolio: "Portfolio",
    };
    const terminalRequest = z.object({ stage: z.enum([...stageIds, "portfolio"]), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) }).strict();
    const backendJson = async (o: Owned, method: "GET" | "POST", tail: string) => {
      const scope = o.scope as { kind: "strategy" | "portfolio"; id: string };
      const response = await fetch(`${this.backend.origin}/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}/${scope.id}${tail}`, {
        method,
        headers: { Authorization: `Bearer ${o.capability}`, Origin: this.backend.origin, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Backend ${response.status}`);
      return response.json();
    };
    const openTerminal = async (o: Owned, input: unknown, restart: boolean) => {
      if (o.scope.kind === "launcher" || o.closing || this.quitting || !this.accepting) throw new Error("No conversation in this window");
      const { stage, cols, rows } = terminalRequest.parse(input);
      if ((o.scope.kind === "portfolio") !== (stage === "portfolio")) throw new Error("Conversation outside scope");
      const scope = o.scope;
      const key = `${scopeKey(scope)}:${stage}`;
      if (restart) this.terminals.close(key);
      const name = String((await backendJson(o, "GET", "").catch(() => ({})))?.name ?? "Pi Research");
      const label = `${name} · ${stageLabels[stage]}`;
      const opened = await this.terminals.open(
        {
          key,
          label,
          cwd: scopeFolder(this.config.root, scope),
          sessionId: stageSessionId(scope.id, stage),
          send: (type, payload) => {
            if (o.window.isDestroyed()) return;
            o.window.webContents.send(channels.terminalEvent, type === "output" ? { stage, type, data: payload } : { stage, type, code: payload });
          },
          ...(scope.kind === "strategy" ? { tools: () => backendJson(o, "POST", "/native/agent-tools") } : {}),
        },
        cols,
        rows,
      );
      return { ...opened, label };
    };
    const stageOf = (o: Owned, input: unknown, extra: z.ZodRawShape = {}) => {
      if (o.scope.kind === "launcher") throw new Error("No conversation in this window");
      const value = z.object({ stage: z.enum([...stageIds, "portfolio"]), ...extra }).strict().parse(input) as { stage: string; since?: number };
      if ((o.scope.kind === "portfolio") !== (value.stage === "portfolio")) throw new Error("Conversation outside scope");
      return { scope: o.scope, ...value, key: `${scopeKey(o.scope)}:${value.stage}` };
    };
    handle(channels.terminalTranscript, (o, input) => {
      const { scope, stage, since, key } = stageOf(o, input, { since: z.number().int().min(0) });
      const read = readSession(sessionFile(scopeFolder(this.config.root, scope), stageSessionId(scope.id, stage)), since ?? 0);
      return { text: read.text, offset: read.offset, reset: read.reset, file: read.file, running: this.terminals.running(key) };
    });
    handle(channels.terminalHandoff, async (o, input) => {
      const { scope, stage, key } = stageOf(o, input);
      const name = String((await backendJson(o, "GET", "").catch(() => ({})))?.name ?? "Pi Research");
      const script = this.terminals.handoff({
        key,
        label: `${name} · ${stageLabels[stage]}`,
        cwd: scopeFolder(this.config.root, scope),
        sessionId: stageSessionId(scope.id, stage),
        send: () => {},
      });
      const electron: any = await import("electron");
      const failed = await electron.shell?.openPath?.(script);
      if (failed) throw new Error(`Terminal could not be opened: ${failed}`);
    });
    handle(channels.terminalOpen, (o, input) => openTerminal(o, input, false));
    handle(channels.terminalRestart, (o, input) => openTerminal(o, input, true));
    ipcMain.on(channels.terminalInput, (event, input) => {
      try {
        const o = this.sender(event);
        if (o.scope.kind === "launcher") return;
        const { stage, data } = z.object({ stage: z.enum([...stageIds, "portfolio"]), data: z.string().max(65536) }).strict().parse(input);
        this.terminals.input(`${scopeKey(o.scope)}:${stage}`, data);
      } catch {}
    });
    ipcMain.on(channels.terminalResize, (event, input) => {
      try {
        const o = this.sender(event);
        if (o.scope.kind === "launcher") return;
        const { stage, cols, rows } = terminalRequest.parse(input);
        this.terminals.resize(`${scopeKey(o.scope)}:${stage}`, cols, rows);
      } catch {}
    });
    handle(channels.readTheme, (_o, input) => {
      z.undefined().parse(input);
      return this.preferences.read().theme ?? null;
    });
    // One theme for the whole app: persist once, then push to every window.
    handle(channels.saveTheme, (_o, input) => {
      const theme = themeIdSchema.parse(input);
      if (!isThemeId(theme)) throw new Error("Unknown theme");
      this.preferences.update({ theme });
      for (const owner of this.owned.values())
        if (!owner.window.isDestroyed()) owner.window.webContents.send(channels.themeChanged, theme);
    });
    ipcMain.on(channels.prepared, (event, input) => {
      try {
        this.sender(event);
        const value = z
          .object({
            nonce: z.string().regex(/^[a-f0-9]{32}$/),
            ok: z.boolean(),
          })
          .strict()
          .parse(input);
        const pending = this.prepared.get(event.sender.id);
        if (pending?.nonce === value.nonce) pending.resolve(value.ok);
      } catch {
        /* forged/stale close acknowledgement */
      }
    });
  }
  private backgroundColor() {
    const theme = this.preferences.read().theme;
    return isThemeId(theme) ? themes[theme].darkBackground : themes["tokyo-night"].darkBackground;
  }
  private sender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) {
    const owner = [...this.owned.values()].find(
      (o) => o.window.webContents === event.sender,
    );
    if (!owner) throw new UntrustedSender("unregistered");
    assertSender({
      registered: true,
      destroyed: owner.window.isDestroyed() || event.sender.isDestroyed(),
      sessionMatches: event.sender.session === owner.session,
      mainFrame:
        event.senderFrame !== null &&
        event.senderFrame === event.sender.mainFrame,
      url: event.senderFrame?.url ?? "",
      scope: owner.scope,
    });
    return owner;
  }
  private async capability(scope: Scope) {
    if (scope.kind === "launcher") return this.backend.rootToken;
    const response = await fetch(
      `${this.backend.origin}/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}`,
      {
        headers: {
          Authorization: `Bearer ${this.backend.rootToken}`,
          Origin: this.backend.origin,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error("Workspace lookup failed");
    const list = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response)),
    );
    const item = z
      .array(
        z.object({ id: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/) }),
      )
      .parse(list)
      .find((item) => item.id === scope.id);
    if (!item) throw new Error("Workspace no longer exists");
    return item.token;
  }
  async open(scope: Scope, record?: WindowRecord) {
    if (!this.accepting || this.quitting) throw new Error("Desktop closing");
    scope = scopeSchema.parse(scope);
    const key = scopeKey(scope);
    if (this.managing.has(key)) throw new Error("Strategy operation in progress");
    const existing = this.owned.get(key);
    if (existing) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return;
    }
    const pending = this.opening.get(key);
    if (pending) return pending;
    const task = this.create(scope, record);
    this.opening.set(key, task);
    try {
      await task;
    } finally {
      this.opening.delete(key);
    }
  }
  private async create(scope: Scope, record?: WindowRecord) {
    if (this.quitting || !this.accepting) throw new Error("Desktop closing");
    const capability = await this.capability(scope);
    if (this.quitting || !this.accepting) throw new Error("Desktop closing");
    const identity = storageIdentity(this.config.root, scope),
      key = scopeKey(scope);
    let partition = this.partitions.get(key);
    if (!partition) {
      const storageRoot = ownedDirectory(this.config.desktop, "chromium");
      partition = session.fromPath(ownedDirectory(storageRoot, identity), {
        cache: false,
      });
      this.partitions.set(key, partition);
      partition.protocol.handle("pi-research", (request) =>
        assetResponse(request.url, request.method, this.config.assets, scope),
      );
      partition.setPermissionCheckHandler(() => false);
      partition.setPermissionRequestHandler((_web, _permission, callback) =>
        callback(false),
      );
      partition.setDevicePermissionHandler(() => false);
      partition.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try {
          const u = new URL(details.url);
          allowed =
            (u.protocol === "pi-research:" &&
              u.hostname === "app" &&
              !u.port &&
              !u.username &&
              !u.password) ||
            false;
        } catch {}
        callback({ cancel: !allowed });
      });
      partition.on("will-download", (event) => event.preventDefault());
    }
    const window = new BrowserWindow({
      ...clampBounds(
        record?.bounds,
        screen.getAllDisplays().map((d) => d.workArea),
      ),
      minWidth: 960,
      minHeight: 640,
      show: false,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 12, y: 10 },
          }
        : {}),
      // Current app theme's desktop colour; avoids a flash before the renderer paints.
      backgroundColor: this.backgroundColor(),
      title:
        scope.kind === "launcher"
          ? "Pi Research"
          : "Pi Research · " + scope.kind,
      webPreferences: {
        preload: this.config.preload,
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    let markReady!: () => void, failReady!: () => void;
    const rendererReady = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = () => reject(new Error("Renderer initialization failed"));
    });
    void rendererReady.catch(() => {});
    const readyTimer = setTimeout(failReady, 15000);
    const owner: Owned = {
      window,
      scope,
      session: partition,
      capability,
      context: { version: 1, scope, viewId: identity, desktop: true },
      pending: 0,
      markReady,
      failReady,
    };
    this.owned.set(key, owner);
    window.webContents.on("preload-error", () =>
      this.loadFailure(owner, "preload-error"),
    );
    window.webContents.on("render-process-gone", () =>
      this.loadFailure(owner, "renderer-exited"),
    );
    window.webContents.on("did-fail-load", (_event, code) => {
      if (code !== -3) this.loadFailure(owner, "renderer-load-failed");
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.webContents.on("will-navigate", (event, url) => {
      if (!documentURL(url, scope)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame || !documentURL(event.url, scope))
        event.preventDefault();
    });
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      void this.close(owner);
    });
    window.on("closed", () => {
      this.owned.delete(key);
      if (scope.kind !== "launcher") this.terminals.closeWhere(`${scopeKey(scope)}:`);
      if (!this.quitting) this.persist();
    });
    window.on("move", () => this.persist());
    window.on("resize", () => this.persist());
    try {
      this.config.diagnose?.("window-created");
      await window.loadURL("pi-research://app" + scopePath(scope));
      this.config.diagnose?.("renderer-loaded");
      await rendererReady;
      if (record?.maximized) window.maximize();
      window.show();
      this.persist();
    } catch (error) {
      window.destroy();
      throw error;
    } finally {
      clearTimeout(readyTimer);
    }
  }
  private loadFailure(owner: Owned, code: string) {
    this.config.diagnose?.(code);
    owner.failReady();
    if (owner.loadFailed || owner.window.isDestroyed() || this.quitting) return;
    owner.loadFailed = true;
    owner.window.show();
    dialog.showErrorBox(
      "Pi Research view unavailable",
      "The desktop view failed to load or stopped. Quit and reopen the app; no action was replayed. Private startup diagnostics contain only bounded event codes.",
    );
  }
  private persist() {
    if (this.quitting) return;
    try {
      saveWindowState(
        this.stateFile,
        [...this.owned.values()]
          .filter((o) => !o.window.isDestroyed())
          .map((o) => ({
            scope: o.scope,
            bounds: o.window.getNormalBounds(),
            maximized: o.window.isMaximized(),
          })),
      );
      this.stateWarning = false;
    } catch {
      if (!this.stateWarning) {
        this.stateWarning = true;
        dialog.showErrorBox(
          "Window layout was not saved",
          "Check lab storage permissions/free space. This layout failure is not evidence that drafts or research writes were saved.",
        );
      }
    }
  }
  async restore() {
    const saved = readWindowState(this.stateFile);
    await this.open(
      { kind: "launcher" },
      saved.find((r) => r.scope.kind === "launcher"),
    );
    for (const record of saved)
      if (record.scope.kind !== "launcher")
        try {
          await this.open(record.scope, record);
        } catch {
          this.config.diagnose?.("restore-scope-failed");
          dialog.showErrorBox(
            "Workspace restore skipped",
            "A saved workspace could not be opened. Use the launcher to reopen it; no Pi session was connected.",
          );
        }
  }
  private prepare(owner: Owned): Promise<boolean> {
    return (owner.preparing ??= this.prepareOnce(owner).finally(() => {
      owner.preparing = undefined;
    }));
  }
  private cancelPreparation(owner: Owned) {
    if (!owner.window.isDestroyed())
      owner.window.webContents.send(channels.cancelled);
  }
  private async prepareOnce(owner: Owned) {
    if (owner.window.isDestroyed()) return true;
    const nonce = randomBytes(16).toString("hex");
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      this.prepared.set(owner.window.webContents.id, {
        nonce,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      });
      owner.window.webContents.send(channels.prepare, nonce);
    });
    if (this.prepared.get(owner.window.webContents.id)?.nonce === nonce)
      this.prepared.delete(owner.window.webContents.id);
    if (owner.window.isDestroyed()) return true;
    if (!ok) {
      const answer = await dialog.showMessageBox(owner.window, {
        type: "warning",
        message: "The view did not confirm draft preparation.",
        detail:
          "Close anyway may lose the latest editor changes. Cancel to return to the view. Pending operations are never replayed.",
        buttons: ["Cancel", "Close anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) {
        this.cancelPreparation(owner);
        return false;
      }
    }
    owner.session.flushStorageData();
    return true;
  }
  private close(owner: Owned) {
    return (owner.closing ??= (async () => {
      const ok = await this.prepare(owner);
      if (ok) owner.window.destroy();
      else owner.closing = undefined;
      return ok;
    })());
  }
  async prepareQuit() {
    if (this.quitting) return true;
    this.accepting = false;
    await Promise.allSettled(this.opening.values());
    for (const owner of this.owned.values())
      if (!(await (owner.closing ?? this.prepare(owner)))) {
        this.accepting = true;
        for (const open of this.owned.values()) this.cancelPreparation(open);
        return false;
      }
    this.persist();
    this.quitting = true;
    this.terminals.closeAll();
    for (const owner of this.owned.values()) owner.session.flushStorageData();
    return true;
  }
  destroy() {
    this.quitting = true;
    this.terminals.closeAll();
    for (const owner of this.owned.values()) owner.window.destroy();
  }
  async focusLauncher() {
    await this.open({ kind: "launcher" });
  }
}
