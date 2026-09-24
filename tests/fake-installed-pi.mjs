// Purpose-built SDK fixture, NOT copied/vendor Pi code. Never invokes providers or tools.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
if (process.env.HERDR_FIXTURE_IMPORT_PROBE) fs.appendFileSync(process.env.HERDR_FIXTURE_IMPORT_PROBE, "SDK module imported\n");
export class SettingsManager {
  static fromStorage(storage) {
    const s = new SettingsManager();
    s.storage = storage;
    s.trusted = false; s.errors = []; s.global = {}; s.project = {};
    s.reload();
    return s;
  }
  readScope(scope) {
    if (scope === "project" && !this.trusted) { this.project = {}; return; }
    try { this.storage.withLock(scope, value => { this[scope] = JSON.parse(value ?? "{}"); }); }
    catch (error) { this.errors.push({ scope, error }); }
  }
  reload() { this.readScope("global"); this.readScope("project"); }
  drainErrors() { const errors = this.errors; this.errors = []; return errors; }
  async flush() {}
  getGlobalSettings() {
    return this.global;
  }
  getProjectSettings() {
    return this.project;
  }
  isProjectTrusted() {
    return this.trusted;
  }
  setProjectTrusted(value) {
    if (this.trusted === value) return;
    this.trusted = value; this.readScope("project");
  }
  getTheme() {
    return "dark";
  }
  setDefaultModelAndProvider(provider, model) {
    this.storage.withLock("global", (value) =>
      JSON.stringify({
        ...JSON.parse(value ?? "{}"),
        defaultProvider: provider,
        defaultModel: model,
      }),
    );
  }
}
export class DefaultPackageManager {
  constructor(options) {
    this.options = options;
  }
  getInstalledPath(source, scope) {
    const p = path.resolve(
      scope === "user" ? this.options.agentDir : this.options.cwd,
      source.replace(/^npm:/, ""),
    );
    return fs.existsSync(p) ? p : undefined;
  }
}
export class ProjectTrustStore {
  get() {
    return null;
  }
}
export async function resolveProjectTrusted(options) {
  if (fs.existsSync(path.join(options.cwd, "ask-trust")))
    return options.projectTrustContext.ui.confirm(
      "Trust project?",
      "Fixture trust hook",
    );
  return false;
}
export const theme = {
  fg: (_key, text) => text,
  bg: (_key, text) => text,
  bold: (text) => text,
};
export function initTheme() {}
export function setRegisteredThemes() {}
export function getEditorTheme() {
  return theme;
}
export function getAvailableThemesWithPaths() {
  return [{ name: "dark" }];
}
export function getThemeByName() {
  return theme;
}
export function setTheme() {
  return { success: true };
}
export function setThemeInstance() {}
export class FooterDataProvider {
  constructor() {
    this.statuses = new Map();
  }
  getGitBranch() {
    return null;
  }
  getExtensionStatuses() {
    return this.statuses;
  }
  getAvailableProviderCount() {
    return 1;
  }
  onBranchChange() {
    return () => {};
  }
  setExtensionStatus(key, value) {
    value === undefined
      ? this.statuses.delete(key)
      : this.statuses.set(key, value);
  }
  dispose() {}
}
// Authored autocomplete seam; no filesystem discovery or SDK implementation.
export class CombinedAutocompleteProvider {
  constructor(commands = []) { this.commands = commands; }
  async getSuggestions(lines, line, column) {
    const prefix = lines[line].slice(0, column);
    return { prefix, items: this.commands.filter(command => ("/" + command.name).startsWith(prefix)).map(command => ({ value: command.name, label: command.name })) };
  }
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; }
}
export class KeybindingsManager {
  static create() {
    return new KeybindingsManager();
  }
  matches(data, key) {
    return data === key;
  }
}
export class TuiMainScreen {
  constructor(terminal) {
    this.terminal = terminal;
    this.listeners = [];
  }
  addInputListener(fn) {
    this.listeners.push(fn);
  }
  addChild(component) {
    this.component = component;
  }
  removeChild(component) {
    if (this.component === component) this.component = undefined;
  }
  setFocus(component) {
    this.focus = component;
  }
  start() {
    this.terminal.start(
      (data) => {
        for (const listener of this.listeners) {
          const result = listener(data);
          if (result?.consume) return;
          data = result?.data ?? data;
        }
        this.focus?.handleInput?.(data);
        this.requestRender();
      },
      () => this.requestRender(),
    );
  }
  stop() {
    this.terminal.stop();
  }
  invalidate() {
    this.component?.invalidate?.();
  }
  requestRender() {
    if (this.component)
      this.terminal.write(
        this.component.render(this.terminal.columns).join("\n"),
      );
  }
  showOverlay(component) {
    this.component = component;
    this.focus = component;
    return {
      hide() {},
      setHidden() {},
      isHidden: () => false,
      focus() {},
      unfocus() {},
      isFocused: () => true,
    };
  }
}
export class SessionManager {
  static create(cwd, dir) {
    const s = new SessionManager();
    s.cwd = cwd;
    s.dir = dir;
    s.id = randomUUID();
    s.file = path.join(dir, s.id + ".jsonl");
    s.header = {
      type: "session",
      version: 3,
      id: s.id,
      cwd,
      timestamp: new Date().toISOString(),
    };
    s.entries = [];
    s.flushed = false;
    s.leaf = null;
    return s;
  }
  static open(file, dir, cwd) {
    const s = new SessionManager();
    s.dir = dir;
    s.setSessionFile(file);
    s.cwd = cwd ?? s.header.cwd;
    return s;
  }
  setSessionFile(file) {
    const [header, ...entries] = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    this.file = file;
    this.header = header;
    this.id = header.id;
    this.entries = entries;
    this.flushed = true;
    this.leaf = entries.at(-1)?.id ?? null;
  }
  getEntries() {
    return [...this.entries];
  }
  getBranch() {
    const branch = []; let id = this.leaf;
    while (id) { const entry = this.entries.find(e => e.id === id); if (!entry) break; branch.unshift(entry); id = entry.parentId; }
    return branch;
  }
  getLeafId() {
    return this.leaf;
  }
  branch(id) {
    if (!this.entries.some((entry) => entry.id === id))
      throw new Error("Unknown branch");
    this.leaf = id;
  }
  resetLeaf() {
    this.leaf = null;
  }
  append(entry) {
    entry = { ...entry, id: randomUUID(), parentId: this.leaf };
    this.entries.push(entry);
    this.leaf = entry.id;
    if (this.flushed)
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    else if (
      this.entries.some(
        (value) =>
          value.type === "message" && value.message.role === "assistant",
      )
    ) {
      // Deliberately models the installed SDK's exclusive first flush. A host-created
      // header without the public setSessionFile transition must fail this fixture.
      const fd = fs.openSync(this.file, "wx");
      try {
        fs.writeFileSync(
          fd,
          [this.header, ...this.entries]
            .map((value) => JSON.stringify(value))
            .join("\n") + "\n",
        );
      } finally {
        fs.closeSync(fd);
      }
      this.flushed = true;
    }
    return entry.id;
  }
  appendModelChange(provider, modelId) {
    return this.append({ type: "model_change", provider, modelId });
  }
  appendThinkingLevelChange(thinkingLevel) {
    return this.append({ type: "thinking_level_change", thinkingLevel });
  }
  appendCustomEntry(customType, data) {
    return this.append({ type: "custom", customType, data });
  }
  appendMessage(message) {
    return this.append({ type: "message", message });
  }
  getCwd() { return this.header.cwd; }
  getSessionDir() { return this.dir; }
  getSessionId() {
    return this.id;
  }
  getSessionFile() {
    return this.file;
  }
  getHeader() {
    return this.header;
  }
}
export class ModelRuntime {
  getAvailableSnapshot() {
    return [
      { id: "fixture", provider: "fake", name: "Fake model (no inference)" },
    ];
  }
  getModel(provider, id) {
    return provider === "fake" && id === "fixture"
      ? { id, provider }
      : undefined;
  }
  stream() {
    throw new Error("Fixture has no inference implementation");
  }
  streamSimple() {
    throw new Error("Fixture has no inference implementation");
  }
}
const commandNames = [
  "ui",
  "custom",
  "factories",
  "new",
  "large",
  "noisy",
  "slow",
  "direct-stdin",
  "renderers", "foreign-cwd", "foreign-agent", "symlink-session", "foreign-header", "tool-flood", "hidden-message", "expanded", "release-renderer", "inspect-renderer-contexts",
];
const fixtureExtensionCache = new Map();
export async function createAgentSessionServices({
  cwd,
  agentDir,
  settingsManager,
  resourceLoaderReloadOptions,
}) {
  fs.appendFileSync(path.join(agentDir, "fixture-services.log"), cwd + "\n");
  const trusted = await resourceLoaderReloadOptions.resolveProjectTrust({
    extensionsResult: { errors: [] },
  });
  if (settingsManager.getGlobalSettings().requireTrust && !trusted)
    throw new Error("Project trust declined");
  const cache = fixtureExtensionCache; let loaded = false;
  const resourceLoader = {
    async reload() {
      await settingsManager.reload();
      if (loaded) cache.clear();
      for (const entry of settingsManager.getGlobalSettings().extensions ?? []) {
        const file = path.resolve(agentDir, entry);
        if (!cache.has(file) && fs.existsSync(file) && fs.statSync(file).isFile()) cache.set(file, fs.readFileSync(file, "utf8"));
      }
      loaded = true;
    },
    factoryVersions: () => [...cache.values()],
    getExtensions: () => ({ errors: [] }),
    getThemes: () => ({ themes: [] }),
    getSkills: () => ({ skills: ["fixture-skill", ...(settingsManager.getGlobalSettings().skills ?? [])].map(name => ({ name, filePath: "/fixture/" + name + "/SKILL.md" })) }),
  };
  await resourceLoader.reload();
  return { cwd, agentDir, settingsManager, modelRuntime: new ModelRuntime(), diagnostics: [], resourceLoader };
}
class Session {
  constructor(services, manager) {
    this.services = services;
    this.sessionManager = manager;
    this.sessionId = manager.id;
    this.sessionFile = manager.file;
    this.modelRuntime = services.modelRuntime;
    const defaults = services.settingsManager.getGlobalSettings();
    this.model = {
      id: defaults.defaultModel ?? "fixture",
      provider: defaults.defaultProvider ?? "fake",
    };
    this.level = defaults.defaultThinkingLevel ?? "off";
    this.isStreaming = false;
    this.listeners = new Set();
    this.messages = [];
    this.makeRunner = () => ({
      contextValid: true,
      invalidateSessionContext() { this.contextValid = false; },
      setUIContext: ui => { this.options.uiContext = ui; },
      getRegisteredCommands: () =>
        [
          ...commandNames,
          ...(services.settingsManager.getGlobalSettings().extensions ?? []),
        ].map((name) => ({
          name,
          description: "Fake command " + name,
        })),
      getMessageRenderer: () => (message, options, _theme) => {
        if (message.display === false) throw new Error("Hidden renderer was invoked");
        const text = "CUSTOM MESSAGE expanded=" + options.expanded; return { render: () => [text] };
      },
      getEntryRenderer: () => (_entry, _options, _theme) => ({
        render: () => ["CUSTOM ENTRY"],
      }),
    });
    this.extensionRunner = this.makeRunner();
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event) {
    for (const fn of this.listeners) fn(event);
  }
  async start(reason) {
    const settings = this.services.settingsManager.getGlobalSettings();
    this.emit({ type: "fixture_lifecycle", phase: "start", reason });
    if (settings.fixtureEmitFactoryVersions) this.options.uiContext.notify("factory:" + this.services.resourceLoader.factoryVersions().join("|"));
    if (settings.startupDialog) await this.options.uiContext.confirm("Startup approval", "Must remain pending until explicit response");
  }
  async bindExtensions(options) { this.options = options; await this.start("resume"); }
  async reload({ beforeSessionStart } = {}) {
    this.emit({ type: "fixture_lifecycle", phase: "shutdown", reason: "reload" });
    // Actual AgentSession.reload invalidates before awaited resource loading,
    // NOT at the later beforeSessionStart callback.
    this.extensionRunner.invalidateSessionContext();
    await this.services.settingsManager.reload();
    await this.services.resourceLoader.reload();
    this.extensionRunner = this.makeRunner();
    await beforeSessionStart?.();
    await this.start("reload");
  }
  getAllTools() {
    return [{ name: "fixture-tool", description: "Never executed by fixture" }];
  }
  probeRendererContext(slot, ctx, component) {
    if (this.services.settingsManager.getGlobalSettings().fixtureRendererContexts)
      (this.rendererContextProbe ??= []).push({ slot, ctx, lastComponent: ctx.lastComponent });
    component.fixtureSlot = slot;
    return component;
  }
  getToolDefinition() {
    return {
      renderCall: (_args, _theme, ctx) => {
        const settings = this.services.settingsManager.getGlobalSettings();
        if (settings.fixtureAsyncRenderer && !ctx.state.scheduled) {
          ctx.state.scheduled = true;
          const callback = ctx.invalidate;
          const complete = () => { ctx.state.asyncReady = true; callback(); };
          if (settings.fixtureDeferredRenderer) (this.deferredRenderers ??= []).push(complete); else setTimeout(complete, 40);
        }
        // Freeze the text: requestRender alone cannot simulate a renderer rebuild.
        const text = `TOOL CALL ${ctx.toolCallId} expanded=${ctx.expanded} error=${ctx.isError} async=${!!ctx.state.asyncReady}`;
        return this.probeRendererContext("call", ctx, { render: () => [text] });
      },
      renderResult: (_result, options, _theme, ctx) => {
        const text = `TOOL RESULT ${ctx.toolCallId} partial=${options.isPartial} expanded=${options.expanded}`;
        return this.probeRendererContext("result", ctx, { render: () => [text] });
      },
    };
  }
  async setModel(model) {
    this.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.services.settingsManager.setDefaultModelAndProvider(
      model.provider,
      model.id,
    );
  }
  get thinkingLevel() { return this.level; }
  getAvailableThinkingLevels() { return this.services.settingsManager.getGlobalSettings().fixtureThinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; }
  setThinkingLevel(level) {
    this.level = this.services.settingsManager.getGlobalSettings().fixtureEffectiveThinking ?? level;
    this.sessionManager.appendThinkingLevelChange(this.level);
  }
  async waitForIdle() {
    if (this.services.settingsManager.getGlobalSettings().fixtureAbortPersistence) this.sessionManager.appendCustomEntry("fixture-idle", {});
  }
  async abort() {
    if (this.services.settingsManager.getGlobalSettings().fixtureAbortPersistence) {
      await new Promise(resolve => setTimeout(resolve, 40));
      this.sessionManager.appendCustomEntry("fixture-abort", {}); this.abortComplete = true;
    }
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
  }
  async navigateTree() {
    return { cancelled: false };
  }
  async prompt(message, options = {}) {
    const ui = this.options.uiContext;
    if (message.startsWith("/")) {
      const cmd = message.split(" ")[0];
      if (cmd === "/ui") {
        const selected = await ui.select("Pick", ["one", "two"]);
        const confirmed = await ui.confirm("Approve?", selected ?? "cancelled");
        const input = await ui.input("Name");
        const editor = await ui.editor("Edit", input);
        ui.notify(JSON.stringify({ selected, confirmed, input, editor }));
      }
      if (cmd === "/custom") {
        const result = await ui.custom((tui, theme, keys, done) => ({
          render: (width) => ["custom width=" + width],
          handleInput: (data) => {
            if (data === "y") done({ secret: () => "host-only-result" });
          },
          dispose: () => ui.notify("custom disposed"),
        }));
        ui.notify(result.secret());
      }
      if (cmd === "/factories") {
        const runner = this.extensionRunner;
        const dispose = kind => {
          if (this.services.settingsManager.getGlobalSettings().fixtureReloadOrder)
            this.sessionManager.appendCustomEntry("fixture-component-dispose", { kind, stale: !runner.contextValid });
        };
        ui.setHeader(() => ({ render: () => ["HEADER"], dispose: () => dispose("header") }));
        ui.setFooter(() => ({ render: () => ["FOOTER"], dispose: () => dispose("footer") }));
        ui.setWidget("fixture", () => ({ render: () => ["WIDGET"], dispose: () => dispose("widget") }));
        ui.setEditorComponent(() => {
          let value = "";
          return {
            render: () => ["EDITOR:" + value],
            getText: () => value,
            setText: (text) => {
              value = text;
            },
            handleInput: (data) => {
              value += data;
            },
            dispose: () => dispose("editor"),
          };
        });
        ui.setEditorText("seed");
      }
      if (cmd === "/inspect-renderer-contexts") {
        const records = this.rendererContextProbe ?? [];
        ui.notify(JSON.stringify({
          contexts: records.length,
          uniqueContexts: new Set(records.map(r => r.ctx)).size,
          stableLastComponent: records.every(r => r.ctx.lastComponent === r.lastComponent),
          correctSlot: records.every(r => !r.lastComponent || r.lastComponent.fixtureSlot === r.slot),
          sharedState: new Set(records.map(r => r.ctx.state)).size === 1,
        }));
      }
      if (cmd === "/renderers") {
        this.emit({
          type: "message_end",
          message: {
            role: "custom",
            customType: "fixture",
            timestamp: 1,
            content: "message",
          },
        });
        this.emit({
          type: "entry_appended",
          entry: { type: "custom", id: "entry-1", customType: "fixture" },
        });
      }
      if (cmd === "/expanded") ui.setToolsExpanded(true);
      if (cmd === "/release-renderer") { for (const callback of this.deferredRenderers ?? []) callback(); this.deferredRenderers = []; }
      if (cmd === "/hidden-message") this.emit({ type: "message_end", message: { role: "custom", customType: "hidden", display: false, timestamp: 123, content: "must not render" } });
      if (cmd === "/tool-flood") for (let i = 0; i < 100; i++) {
        this.emit({ type: "tool_execution_start", toolCallId: "flood-" + i, toolName: "fixture-tool", args: {} });
        this.emit({ type: "tool_execution_end", toolCallId: "flood-" + i, toolName: "fixture-tool", result: { content: [{ type: "text", text: "done" }] } });
      }
      if (cmd === "/foreign-cwd") return this.options.commandContextActions.newSession({ cwd: this.services.settingsManager.getGlobalSettings().fixtureForeignCwd });
      if (cmd === "/foreign-agent") return this.options.commandContextActions.newSession({ agentDir: this.services.settingsManager.getGlobalSettings().fixtureForeignCwd });
      if (cmd === "/symlink-session") return this.options.commandContextActions.switchSession(path.join(this.sessionManager.dir, "outside-link.jsonl"));
      if (cmd === "/foreign-header") return this.options.commandContextActions.switchSession(path.join(this.sessionManager.dir, "foreign.jsonl"));
      if (cmd === "/new")
        return this.options.commandContextActions.newSession();
      if (cmd === "/large")
        this.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(900000) }],
          },
        });
      if (cmd === "/noisy") {
        console.log("ordinary extension stdout");
        console.error("ordinary extension stderr");
      }
      if (cmd === "/slow") await ui.confirm("Slow", "Cancel does not Stop");
      if (cmd === "/direct-stdin") process.stdin.on("data", () => {});
      return;
    }
    if (this.services.settingsManager.getGlobalSettings().fixtureHandledInput) {
      options.preflightResult?.(true);
      this.sessionManager.appendCustomEntry("fixture-input-handled", {});
      if (this.services.settingsManager.getGlobalSettings().fixtureHandledInput === "fail")
        throw new Error("Fixture handled-input failure after preflight");
      return; // input action:'handled': deliberately no agent_start/agent_settled
    }
    this.isStreaming = true;
    options.preflightResult?.(true);
    this.emit({ type: "agent_start" });
    this.emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "fixture answer" },
    });
    this.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "fixture thinking",
      },
    });
    this.emit({
      type: "tool_execution_start",
      toolCallId: "fake-tool-id",
      toolName: "fixture-tool",
      args: {},
    });
    this.emit({
      type: "tool_execution_update",
      toolCallId: "fake-tool-id",
      toolName: "fixture-tool",
      partialResult: { content: [{ type: "text", text: "update" }] },
    });
    this.emit({
      type: "tool_execution_end",
      toolCallId: "fake-tool-id",
      toolName: "fixture-tool",
      isError: !!this.services.settingsManager.getGlobalSettings().fixtureToolError,
      result: { content: [{ type: "text", text: "done" }] },
    });
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "fixture answer" }],
    };
    this.messages.push(reply);
    this.sessionManager.appendMessage(reply);
    this.emit({ type: "message_end", message: reply });
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
  }
  dispose() {
    if (this.services.settingsManager.getGlobalSettings().fixtureAbortPersistence) this.sessionManager.appendCustomEntry("fixture-dispose", { abortComplete: this.abortComplete === true });
    this.listeners.clear();
  }
}
export async function createAgentSessionFromServices({
  services,
  sessionManager,
}) {
  return {
    session: new Session(services, sessionManager),
    extensionsResult: { errors: [] },
  };
}
class Runtime {
  constructor(result, factory) {
    this.session = result.session;
    this.services = result.services;
    this.factory = factory;
    this.cwd = this.services.cwd;
  }
  setBeforeSessionInvalidate(fn) {
    this.before = fn;
  }
  setRebindSession(fn) {
    this.rebind = fn;
  }
  async dispose() {
    // Faithful to installed Runtime.dispose: caller must await abort/idle first.
    this.before?.();
    this.session.dispose();
  }
  async replace(manager) {
    await this.session.abort();
    await this.dispose();
    const r = await this.factory({
      cwd: this.cwd,
      agentDir: this.services.agentDir,
      sessionManager: manager,
    });
    this.session = r.session;
    this.services = r.services;
    await this.rebind();
    return { cancelled: false };
  }
  async switchSession(file) {
    return this.replace(
      SessionManager.open(file, this.session.sessionManager.dir, this.cwd),
    );
  }
  async newSession() {
    return this.replace(
      SessionManager.create(this.cwd, this.session.sessionManager.dir),
    );
  }
  async fork() {
    return this.newSession();
  }
}
export async function createAgentSessionRuntime(factory, options) {
  return new Runtime(await factory(options), factory);
}
