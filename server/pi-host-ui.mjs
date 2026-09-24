import { randomUUID } from "node:crypto";

/** A real installed pi-tui renderer drives this virtual Terminal; no process terminal is exposed. */
export class VirtualTerminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  constructor(id, emit, unsupported) {
    this.id = id;
    this.emit = emit;
    this.unsupported = unsupported;
  }
  start(input, resize) {
    if (this.stopped) throw new Error("Virtual terminal was disposed");
    this.input = input;
    this.resize = resize;
  }
  stop() {
    this.stopped = true;
    this.input = undefined;
    this.resize = undefined;
  }
  async drainInput() {}
  write(data) {
    if (this.stopped) return;
    if (/\x1b_G|\x1bP|\x1b\]1337;File=/.test(data))
      this.unsupported(
        "Terminal graphics/sixel/kitty images are not supported",
      );
    for (let i = 0; i < data.length; i += 32768)
      this.emit({
        type: "terminal_frame",
        surfaceId: this.id,
        data: data.slice(i, i + 32768),
      });
  }
  moveBy(lines) {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  hideCursor() {
    this.write("\x1b[?25l");
  }
  showCursor() {
    this.write("\x1b[?25h");
  }
  clearLine() {
    this.write("\x1b[2K");
  }
  clearFromCursor() {
    this.write("\x1b[J");
  }
  clearScreen() {
    this.write("\x1b[2J\x1b[H");
  }
  setTitle(title) {
    this.emit({ type: "ui_state", key: "title", value: title });
  }
  setProgress(active) {
    this.emit({ type: "ui_state", key: "progress", value: active });
  }
}
export function createHostUI({
  tuiModule,
  themeModule,
  keybindings,
  emit,
  footerProvider,
  onToolsExpanded,
  createAutocompleteProvider,
}) {
  const pending = new Map(),
    surfaces = new Map(),
    state = new Map(),
    listeners = new Set(),
    statuses = new Map();
  let editorText = "",
    editorFactory,
    expanded = false,
    disposed = false,
    viewDetached = false,
    autocompleteProvider;
  const autocompleteWrappers = [];
  const unsupported = (message) => {
    emit({
      type: "diagnostic",
      severity: "error",
      code: "unsupported_ui",
      message,
    });
    throw new Error(message);
  };
  const update = (key, value) => {
    state.set(key, value);
    emit({ type: "ui_state", key, value });
  };
  const captureEditor = component => {
    editorText = component?.getExpandedText?.() ?? component?.getText?.() ?? editorText;
    update("editor", editorText);
  };
  const descriptor = (id, s) => ({ surfaceId: id, kind: s.kind, columns: s.terminal.columns, rows: s.terminal.rows });
  function refreshAutocomplete() {
    if (!createAutocompleteProvider) {
      if (autocompleteWrappers.length) unsupported("Autocomplete composition requires a host base provider");
      return;
    }
    let provider = createAutocompleteProvider();
    const triggers = [];
    for (const wrap of autocompleteWrappers) {
      provider = wrap(provider);
      triggers.push(...(provider?.triggerCharacters ?? []));
    }
    if (typeof provider?.getSuggestions !== "function" || typeof provider?.applyCompletion !== "function")
      throw new Error("Autocomplete factory must return a synchronous provider");
    if (triggers.length) provider.triggerCharacters = [...new Set(triggers)];
    autocompleteProvider = provider;
    surfaces.get("editor")?.component?.setAutocompleteProvider?.(provider);
  }
  const disposeSurface = (id) => {
    const s = surfaces.get(id);
    if (!s) return;
    if (id === "editor") captureEditor(s.component);
    surfaces.delete(id);
    s.active = false;
    for (const cleanup of [
      () => s.tui.stop(),
      () => s.component?.dispose?.(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        emit({
          type: "diagnostic",
          severity: "error",
          code: "component_dispose_failed",
          message: String(error),
        });
      }
    }
    emit({ type: "terminal_closed", surfaceId: id });
  };
  function dialog(method, fields, opts) {
    if (disposed || viewDetached)
      return Promise.reject(new Error("UI detached; no answer supplied"));
    if (opts?.signal?.aborted)
      return Promise.resolve(method === "confirm" ? false : undefined);
    if (pending.size >= 16)
      return Promise.reject(
        new Error("UI request limit reached; no answer supplied"),
      );
    if (Buffer.byteLength(JSON.stringify(fields)) > 131072) {
      emit({
        type: "diagnostic",
        severity: "error",
        code: "oversize_dialog",
        message: "Dialog exceeds native projection limit; no answer supplied",
      });
      return Promise.reject(
        new Error("Dialog exceeds native projection limit"),
      );
    }
    const id = randomUUID(),
      request = { id, method, ...fields, timeout: opts?.timeout };
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", cancel);
        emit({ type: "ui_closed", requestId: id });
        resolve(value);
      };
      const cancel = () => finish(method === "confirm" ? false : undefined);
      pending.set(id, { request, finish, cancel });
      opts?.signal?.addEventListener("abort", cancel, { once: true });
      if (opts?.timeout !== undefined)
        timer = setTimeout(cancel, Math.max(0, opts.timeout));
      emit({ type: "ui_request", request });
    });
  }
  function surface(id, kind, factory, args = [], options) {
    disposeSurface(id);
    if (disposed || viewDetached)
      throw new Error("UI detached; component was not mounted");
    const historical = ["tool", "message", "entry"].includes(kind);
    // Bound derived history separately. It must not consume the capacity needed
    // for a later interactive approval; canonical history is never evicted here.
    const history = [...surfaces].filter(([, s]) => s.historical);
    while ((historical && history.length >= 48 || surfaces.size >= 64) && history.length) disposeSurface(history.shift()[0]);
    if (surfaces.size >= 64) unsupported("Interactive TUI surface limit reached; native history remains available");
    const terminal = new VirtualTerminal(id, emit, unsupported);
    const tui = new tuiModule.TuiMainScreen(terminal);
    const record = { terminal, tui, kind, historical, component: undefined, active: true };
    surfaces.set(id, record);
    tui.addInputListener?.((data) => {
      for (const listener of listeners) {
        const result = listener(data);
        if (result?.consume) return result;
        if (result?.data !== undefined) data = result.data;
      }
      return { data };
    });
    emit({
      type: "terminal_open",
      surfaceId: id,
      kind,
      columns: terminal.columns,
      rows: terminal.rows,
    });
    const mount = (component) => {
      if (!record.active) {
        component?.dispose?.();
        return;
      }
      if (!component && options?.optional) {
        disposeSurface(id);
        return;
      }
      if (!component || typeof component.render !== "function") {
        disposeSurface(id);
        throw new Error("Extension factory did not return a TUI component");
      }
      record.component = component;
      if (options?.overlay) {
        const handle = tui.showOverlay(
          component,
          typeof options.overlayOptions === "function"
            ? options.overlayOptions()
            : options.overlayOptions,
        );
        options.onHandle?.(handle);
      } else {
        tui.addChild(component);
        tui.setFocus(component);
      }
      tui.start();
      tui.requestRender();
    };
    try {
      const value = factory(
        tui,
        kind === "editor" ? themeModule.getEditorTheme() : themeModule.theme,
        ...args,
      );
      if (value?.then)
        value.then(mount).catch((error) => {
          record.reject?.(error);
          if (!record.active || surfaces.get(id) !== record) return;
          disposeSurface(id);
          emit({
            type: "diagnostic",
            severity: "error",
            code: "factory_error",
            message: String(error),
          });
        });
      else mount(value);
    } catch (error) {
      disposeSurface(id);
      throw error;
    }
    return record;
  }
  const setEditor = (text) => {
    editorText = text;
    const s = surfaces.get("editor");
    s?.component?.setText?.(text);
    s?.tui.requestRender();
    update("editor", text);
  };
  const footerData = footerProvider ?? {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(statuses),
    getAvailableProviderCount: () => 0,
    onBranchChange: () => {
      unsupported("Installed footer data provider unavailable");
    },
  };
  const ui = {
    select: (title, options, opts) =>
      dialog("select", { title, options }, opts),
    confirm: (title, message, opts) =>
      dialog("confirm", { title, message }, opts),
    input: (title, placeholder, opts) =>
      dialog("input", { title, placeholder, ...(opts?.secret ? { secret: true } : {}) }, opts),
    editor: (title, prefill, opts) =>
      dialog("editor", { title, prefill }, opts),
    notify: (message, notifyType = "info") =>
      emit({ type: "notification", message, notifyType }),
    onTerminalInput: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    setStatus: (key, text) => {
      text === undefined ? statuses.delete(key) : statuses.set(key, text);
      footerProvider?.setExtensionStatus(key, text);
      update("status:" + key, text);
      surfaces.get("footer")?.tui.requestRender();
    },
    setTitle: (title) => update("title", title),
    setWorkingMessage: (value) => update("workingMessage", value),
    setWorkingVisible: (value) => update("workingVisible", value),
    setWorkingIndicator: (value) => update("workingIndicator", value),
    setHiddenThinkingLabel: (value) => update("hiddenThinkingLabel", value),
    setWidget: (key, content, options) => {
      const id = "widget:" + key;
      disposeSurface(id);
      if (typeof content === "function") {
        update(id, { factory: true, placement: options?.placement });
        surface(id, "widget", content);
      } else
        update(id, {
          lines: content,
          placement: options?.placement,
          ...(content === undefined ? { cleared: true } : {}),
        });
    },
    setHeader: (factory) => {
      disposeSurface("header");
      if (factory) surface("header", "header", factory);
    },
    setFooter: (factory) => {
      disposeSurface("footer");
      if (factory) surface("footer", "footer", factory, [footerData]);
    },
    custom: (factory, options) =>
      new Promise((resolve, reject) => {
        const id = randomUUID();
        let finished = false;
        const done = (result) => {
          if (finished) return;
          finished = true;
          disposeSurface(id);
          resolve(result);
        };
        try {
          const s = surface(
            id,
            "custom",
            factory,
            [keybindings, done],
            options,
          );
          s.cancel = () => {
            if (finished) return;
            finished = true;
            disposeSurface(id);
            reject(
              new Error("Custom UI cancelled; no approval result supplied"),
            );
          };
          s.reject = reject;
          // Factories may call done synchronously before mount returns.
          if (finished) disposeSurface(id);
        } catch (e) {
          reject(e);
        }
      }),
    setEditorText: setEditor,
    getEditorText: () =>
      surfaces.get("editor")?.component?.getExpandedText?.() ??
      surfaces.get("editor")?.component?.getText?.() ??
      editorText,
    pasteToEditor: (text) => {
      const s = surfaces.get("editor"),
        editor = s?.component;
      if (editor?.handleInput) {
        editor.handleInput(`\x1b[200~${text}\x1b[201~`);
        editorText = editor.getExpandedText?.() ?? editor.getText();
        update("editor", editorText);
        s.tui.requestRender();
      } else setEditor(editorText + text);
    },
    setEditorComponent: (factory) => {
      disposeSurface("editor");
      editorFactory = factory;
      if (factory) {
        const s = surface("editor", "editor", factory, [keybindings]);
        s.component?.setText?.(editorText);
        if (s.component) {
          // CLI owns the provider pipeline independently of the editor. Wrappers
          // can register before a custom editor and editors need only a setter.
          if (!autocompleteProvider) refreshAutocomplete();
          else s.component.setAutocompleteProvider?.(autocompleteProvider);
          s.component.onChange = (text) => {
            if (disposed || viewDetached || surfaces.get("editor") !== s) return;
            editorText = s.component?.getExpandedText?.() ?? text;
            update("editor", editorText);
          };
          s.component.onSubmit = (text) => {
            if (disposed || viewDetached || surfaces.get("editor") !== s) return;
            emit({ type: "editor_submit", text: s.component?.getExpandedText?.() ?? text, requiresExplicitSend: true });
          };
        }
      }
    },
    getEditorComponent: () => editorFactory,
    addAutocompleteProvider: (factory) => {
      if (typeof factory !== "function") throw new Error("Autocomplete wrapper must be a function");
      autocompleteWrappers.push(factory);
      try { refreshAutocomplete(); }
      catch (error) { autocompleteWrappers.pop(); throw error; }
    },
    get theme() {
      return themeModule.theme;
    },
    getAllThemes: () => themeModule.getAvailableThemesWithPaths(),
    getTheme: (name) => themeModule.getThemeByName(name),
    setTheme: (theme) => {
      const result =
        typeof theme === "string"
          ? themeModule.setTheme(theme, false)
          : (themeModule.setThemeInstance(theme), { success: true });
      for (const s of surfaces.values()) {
        s.tui.invalidate();
        s.tui.requestRender();
      }
      return result;
    },
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value) => {
      expanded = value;
      update("toolsExpanded", value);
      onToolsExpanded?.(value);
      for (const [id, s] of [...surfaces]) if (s.renderFactory) render(id, s.kind, s.renderFactory);
    },
  };
  function render(id, kind, factory) {
    if (disposed || viewDetached) return;
    const existing = surfaces.get(id);
    if (!existing) {
      const created = surface(id, kind, factory, [], { optional: true });
      if (surfaces.get(id) === created) created.renderFactory = factory;
      return created;
    }
    existing.renderFactory = factory;
    // A renderer may reuse lastComponent with its own width/content cache.
    // Invalidate the existing tree before rebuilding, as installed Pi does.
    existing.tui.invalidate();
    const component = factory(existing.tui, themeModule.theme, existing.component);
    if (!component) { disposeSurface(id); return; }
    if (typeof component.render !== "function") throw new Error("Renderer must return a synchronous TUI component");
    if (component !== existing.component) {
      existing.tui.removeChild(existing.component); existing.component?.dispose?.();
      existing.component = component; existing.tui.addChild(component); existing.tui.setFocus(component);
    }
    existing.tui.requestRender(); return existing;
  }
  const fencedUI = new Proxy(ui, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args) => {
            if (disposed) {
              // Reload must detach components before runner invalidation, but
              // installed shutdown hooks still remove their status/widgets.
              // Idempotent removals are inert: no events, factories or mutations
              // of either the retired bridge or its replacement are permitted.
              const clearingNamed = (key === "setStatus" || key === "setWidget") &&
                (args[1] === undefined || key === "setWidget" && Array.isArray(args[1]) && args[1].length === 0);
              const clearingFactory = ["setHeader", "setFooter", "setEditorComponent"].includes(key) && args[0] === undefined;
              const restoringWorkingVisibility = key === "setWorkingVisible" && args[0] === true;
              if (clearingNamed || clearingFactory || restoringWorkingVisibility) return;
              emit({
                type: "diagnostic",
                severity: "error",
                code: "stale_ui_callback",
                message:
                  "Ignored callback from invalidated extension UI context",
              });
              throw new Error("Extension UI context invalidated");
            }
            return value.apply(target, args);
          }
        : value;
    },
  });
  return {
    ui: fencedUI,
    unsupported,
    setProviderCount(count) {
      footerProvider?.setAvailableProviderCount?.(count);
    },
    respond({ requestId, cancelled, value }) {
      const p = pending.get(requestId);
      if (!p) throw new Error("UI request expired or unknown");
      if (cancelled) {
        p.cancel();
        return;
      }
      const method = p.request.method;
      if (
        method === "confirm"
          ? typeof value !== "boolean"
          : typeof value !== "string" || Buffer.byteLength(value) > 131072
      )
        throw new Error("Invalid UI response");
      if (method === "select" && !p.request.options.includes(value))
        throw new Error("Selection not in requested options");
      p.finish(value);
    },
    terminal({ type, surfaceId, data, columns, rows }) {
      const s = surfaces.get(surfaceId);
      if (!s) throw new Error("TUI surface expired or unknown");
      if (type === "terminal_cancel") {
        if (!s.cancel) throw new Error("Only custom dialogs may be cancelled");
        s.cancel();
      } else if (type === "terminal_resize") {
        if (
          !Number.isInteger(columns) ||
          columns < 20 ||
          columns > 400 ||
          !Number.isInteger(rows) ||
          rows < 5 ||
          rows > 200
        )
          throw new Error("Invalid terminal size");
        s.terminal.columns = columns;
        s.terminal.rows = rows;
        s.terminal.resize?.();
      } else {
        if (typeof data !== "string" || Buffer.byteLength(data) > 8192)
          throw new Error("Invalid terminal input");
        s.terminal.input?.(data);
        if (surfaceId === "editor") {
          captureEditor(s.component);
        }
      }
    },
    render,
    refreshAutocomplete,
    async complete(text) {
      if (!autocompleteProvider) refreshAutocomplete();
      if (!autocompleteProvider) return [];
      const result = await autocompleteProvider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: false });
      return (result?.items ?? []).slice(0, 20).map(item => {
        const applied = autocompleteProvider.applyCompletion([text], 0, text.length, item, result.prefix);
        return { label: item.label, detail: item.description, insert: applied.lines.join("\n"), caret: applied.lines.slice(0, applied.cursorLine).reduce((n, line) => n + line.length + 1, 0) + applied.cursorCol };
      });
    },
    hasSurface(id) { return !disposed && !viewDetached && surfaces.has(id); },
    rerender(id) { const s = surfaces.get(id); if (s?.renderFactory && !disposed && !viewDetached) return render(id, s.kind, s.renderFactory); },
    snapshot() {
      return {
        editor: ui.getEditorText(),
        state: Object.fromEntries(state),
        pending: [...pending.values()].map((p) => p.request),
        surfaces: [...surfaces].map(([id, s]) => descriptor(id, s)),
        viewDetached,
      };
    },
    quiesce() {
      viewDetached = true;
      this.cancel();
    },
    detachView() {
      viewDetached = true;
      this.cancel();
      for (const id of [...surfaces.keys()]) disposeSurface(id);
      emit({
        type: "diagnostic",
        severity: "info",
        code: "view_detached",
        message:
          "Dialogs cancelled and TUI components disposed. Reattach is read-only; use explicit idle Reload to recreate extension factory UI.",
      });
    },
    attachView() {
      if (disposed) throw new Error("UI lifecycle disposed");
      viewDetached = false;
      this.redraw();
    },
    get busy() {
      return pending.size > 0 || [...surfaces.values()].some((s) => s.cancel);
    },
    cancel() {
      for (const p of [...pending.values()]) p.cancel();
      for (const s of [...surfaces.values()]) s.cancel?.();
    },
    detach() {
      if (disposed) return;
      try {
        this.cancel();
        for (const id of [...surfaces.keys()]) disposeSurface(id);
        listeners.clear();
        state.clear();
        statuses.clear();
        footerProvider?.dispose();
      } finally {
        disposed = true;
      }
    },
    redraw() {
      for (const [id, s] of surfaces) {
        emit({ type: "terminal_open", ...descriptor(id, s) });
        s.terminal.clearScreen();
        s.tui.invalidate();
        s.tui.requestRender(true);
      }
    },
  };
}
