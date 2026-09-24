import { ExternalEditor } from "./pi-host-editor.mjs";
import { runtimeCommands, runRuntimeCommand } from "./pi-host-commands.mjs";
import { RuntimeQueue } from "./pi-host-queue.mjs";
import { createWorkbenchTools, resolveToolReply } from "./pi-host-tools.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { createHostUI } from "./pi-host-ui.mjs";
import {
  ensureCanonicalSession,
  validateManagedSessionFile,
  rejectSessionSymlinks,
} from "./pi-host-session.mjs";
import {
  readThroughSettings,
  preflightPackages as preflightPackageSources,
  preflightExplicitResources,
  assertSettingsHealthy,
} from "./pi-host-resources.mjs";

const config = JSON.parse(process.env.HERDR_PI_HOST ?? "{}");
delete process.env.HERDR_PI_HOST;
if (!config.identity || !Number.isSafeInteger(config.generation))
  throw new Error("Missing trusted host configuration");
// Package resolution must never install/refresh during connect or reload. Not a network sandbox.
process.env.PI_OFFLINE = "1";
const rawWrite = process.stdout.write.bind(process.stdout);
let sequence = 0,
  runtime,
  bridge,
  unsubscribe,
  stopping = false,
  runtimeReady = false,
  active = false,
  commandActive = false;
let uiEpoch = 0;
let runtimeKeys = {};
let extensionKeys = new Map();
let builtinContext;
let commandAbort;
const messageQueue = new RuntimeQueue(() => runtime.session);
const externalEditor = new ExternalEditor(value => emit(value), config.cwd);
const uiSnapshot = () => { const value = bridge?.snapshot() ?? { editor: "", pending: [], surfaces: [], state: {} }; return { ...value, surfaces: [...value.surfaces, ...externalEditor.surfaces()] }; };
// Host-owned expanded editor checkpoint. Persist before acknowledging each raw input;
// an interrupted input keeps the last saved text and an unresolved input watermark.
let editorCheckpoint = {
  version: 1,
  revision: 0,
  text: "",
  inputId: null,
  inputStatus: "idle",
};
function saveEditor(
  text = bridge?.ui.getEditorText() ?? editorCheckpoint.text,
  inputId = editorCheckpoint.inputId,
  inputStatus = editorCheckpoint.inputStatus,
) {
  if (!config.editorFile) return;
  if (typeof text !== "string" || Buffer.byteLength(text) > 131072)
    throw new Error("Expanded editor exceeds durable bound");
  rejectSessionSymlinks(config.editorFile);
  const directory = path.dirname(config.editorFile);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = fs.openSync(path.dirname(directory), "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }
  const next = {
    version: 1,
    revision: editorCheckpoint.revision + 1,
    text,
    inputId,
    inputStatus,
  };
  const tmp = config.editorFile + "." + randomUUID() + ".tmp",
    fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(next));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, config.editorFile);
  const dir = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
  editorCheckpoint = next;
}
function restoreEditor() {
  if (!config.editorFile) return;
  rejectSessionSymlinks(config.editorFile);
  if (!fs.existsSync(config.editorFile)) return;
  const stat = fs.statSync(config.editorFile);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("Invalid expanded editor checkpoint");
  const value = JSON.parse(fs.readFileSync(config.editorFile, "utf8"));
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.text !== "string" ||
    Buffer.byteLength(value.text) > 131072 ||
    !["idle", "pending", "acknowledged"].includes(value.inputStatus)
  )
    throw new Error("Invalid expanded editor checkpoint");
  editorCheckpoint = value;
}
const bindings = new Map();
let queuedBytes = 0;
function output(value) {
  let frame;
  try {
    frame = JSON.stringify(value);
  } catch {
    frame = JSON.stringify({
      type: "diagnostic",
      severity: "error",
      code: "unserializable_projection",
      message: "Event is not JSON serializable; inspect canonical history",
      version: 1,
      generation: config.generation,
      seq: ++sequence,
    });
  }
  if (Buffer.byteLength(frame) > 786432)
    frame = JSON.stringify(
      value.type === "response"
        ? {
            type: "response",
            id: value.id,
            command: value.command,
            success: false,
            error:
              "Response projection exceeds limit; resync canonical history in bounded pages",
          }
        : {
            type: "projection_truncated",
            originalType: value.type,
            version: 1,
            generation: config.generation,
            seq: value.seq ?? ++sequence,
            resyncRequired: true,
            message:
              "Substantive event exceeded projection limit; canonical history remains authoritative",
          },
    );
  if (queuedBytes > 4194304 || process.stdout.writableLength > 4194304) {
    if (!stopping) {
      process.send?.({
        type: "diagnostic",
        severity: "error",
        code: "transport_backpressure",
        version: 1,
        generation: config.generation,
        seq: ++sequence,
        message:
          "Projection delivery saturated; host stopping without replay. Resync canonical history.",
      });
      void shutdown(1);
    }
    return;
  }
  if (process.send && process.connected) {
    const bytes = Buffer.byteLength(frame);
    queuedBytes += bytes;
    process.send(JSON.parse(frame), () => {
      queuedBytes -= bytes;
    });
  } else if (!process.send) rawWrite(frame + "\n");
}
const emit = (value) => {
  if (
    ["terminal_open", "terminal_closed", "ui_request", "ui_closed"].includes(
      value.type,
    )
  )
    uiEpoch++;
  if (value.type === "ui_state" && value.key === "editor")
    saveEditor(value.value);
  output({
    ...value,
    version: 1,
    generation: config.generation,
    seq: ++sequence,
  });
};
const response = (command, data, error) =>
  output({
    type: "response",
    id: command.id,
    command: command.type,
    success: !error,
    ...(error ? { error: String(error.message ?? error) } : { data }),
  });
// Extension console/raw stdout cannot corrupt JSONL or seize the real terminal.
process.stdout.write = (chunk, encoding, callback) => {
  emit({
    type: "diagnostic",
    severity: "warning",
    code: "direct_stdout",
    message:
      "Extension wrote directly to stdout; direct terminal control is unsupported",
  });
  const cb = typeof encoding === "function" ? encoding : callback;
  cb?.();
  return true;
};
const root = config.identity.packageRoot;
const load = (relative) =>
  import(pathToFileURL(path.join(root, "dist", relative + ".js")).href);
const requirePi = createRequire(path.join(root, "package.json"));
const toolCalls = new Map();
const workbenchTools = () =>
  createWorkbenchTools({ specs: config.tools, instructions: config.toolInstructions, emit, calls: toolCalls });
function need(value, name) {
  if (typeof value !== "function")
    throw new Error("Installed Pi API incompatible: " + name);
  return value;
}
function guardFile(file, options) {
  return validateManagedSessionFile(
    file,
    config.sessionDir,
    config.cwd,
    options,
  );
}
function guardContext(options = {}) {
  for (const [key, expected] of [
    ["cwd", config.cwd],
    ["cwdOverride", config.cwd],
    ["agentDir", config.identity.agentDir],
    ["sessionDir", config.sessionDir],
  ]) {
    if (
      options[key] !== undefined &&
      (typeof options[key] !== "string" ||
        path.resolve(options[key]) !== path.resolve(expected))
    )
      throw new Error(
        "Managed conversation forbids changing " +
          key +
          "; resources were not loaded",
      );
  }
  rejectSessionSymlinks(config.cwd);
  rejectSessionSymlinks(config.sessionDir);
  if (options.parentSession) guardFile(options.parentSession);
  const manager = options.sessionManager;
  if (manager) {
    if (
      path.resolve(manager.getCwd()) !== path.resolve(config.cwd) ||
      path.resolve(manager.getSessionDir()) !== path.resolve(config.sessionDir)
    )
      throw new Error(
        "Managed session cwd/directory mismatch; resources were not loaded",
      );
    guardFile(manager.getSessionFile(), {
      existing: false,
      id: manager.getSessionId(),
    });
  }
}
async function publishBinding(sessionManager) {
  const canonical = {
    id: sessionManager.getSessionId(),
    path: sessionManager.getSessionFile(),
    cwd: sessionManager.getCwd(),
  };
  if (!canonical.path)
    throw new Error("Installed Pi did not allocate canonical session path");
  guardFile(canonical.path, { existing: false, id: canonical.id });
  const requestId = randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bindings.delete(requestId);
      reject(new Error("Binding durability acknowledgement timed out"));
    }, 15000);
    bindings.set(requestId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    emit({ type: "binding_request", requestId, canonical });
  });
  ensureCanonicalSession(sessionManager);
}
async function replaceManaged(action) {
  const previousReady = runtimeReady;
  runtimeReady = false;
  try {
    await runtime.services.settingsManager.flush();
    assertSettingsHealthy(runtime.services.settingsManager);
    const result = await action();
    if (result?.cancelled) runtimeReady = previousReady;
    return result;
  } catch (error) {
    emit({
      type: "diagnostic",
      severity: "error",
      code: "replacement_failed",
      message:
        "Runtime replacement failed; stopping rather than using invalidated session: " +
        String(error),
    });
    void shutdown(1);
    throw error;
  }
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  runtimeReady = false;
  await externalEditor.close();
  commandAbort?.abort();
  bridge?.quiesce();
  try {
    saveEditor();
    if (runtime) {
      try {
        await runtime.session.abort();
        await runtime.session.waitForIdle();
      } catch (error) {
        code = 1;
        emit({
          type: "diagnostic",
          severity: "error",
          code: "abort_failed",
          message: String(error),
        });
      }
    }
    saveEditor();
    // Installed Runtime.dispose() does not await abort; settle persistence first.
    await runtime?.dispose();
  } catch (error) {
    emit({
      type: "diagnostic",
      severity: "error",
      code: "dispose_failed",
      message: String(error),
    });
    code = 1;
  } finally {
    bridge?.detach();
    unsubscribe?.();
    // Let final lifecycle events/diagnostics and correlated failures reach the IPC
    // channel before exit. This is bounded; the parent still owns kill escalation.
    await new Promise((resolve) => setImmediate(resolve));
    const drainDeadline = Date.now() + 250;
    while (process.connected && queuedBytes > 0 && Date.now() < drainDeadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    process.exitCode = code;
    rawWrite("", () => process.exit(code));
  }
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
process.on("uncaughtException", (error) => {
  emit({
    type: "diagnostic",
    severity: "error",
    code: "host_exception",
    message: String(error),
  });
  void shutdown(1);
});
process.on("unhandledRejection", (error) => {
  emit({
    type: "diagnostic",
    severity: "error",
    code: "host_rejection",
    message: String(error),
  });
  void shutdown(1);
});

let activate;
const activation = new Promise((resolve) => {
  activate = resolve;
});
const ready = (async () => {
  // The parent publishes this child's PID and installs observers BEFORE sending
  // its first readiness handshake. No installed SDK module runs before that gate.
  await activation;
  if (stopping) throw new Error("Host stopped before writer activation");
  const [
    sdk,
    settingsModule,
    packagesModule,
    trustModule,
    trustStoreModule,
    sessionModule,
    themeModule,
    keysModule,
    tuiModule,
    modelModule,
    footerModule,
  ] = await Promise.all([
    load("core/sdk"),
    load("core/settings-manager"),
    load("core/package-manager"),
    load("core/project-trust"),
    load("core/trust-manager"),
    load("core/session-manager"),
    load("modes/interactive/theme/theme"),
    load("core/keybindings"),
    import(pathToFileURL(config.identity.tui).href),
    load("core/model-runtime"),
    load("core/footer-data-provider"),
  ]);
  need(sdk.createAgentSessionRuntime, "createAgentSessionRuntime");
  need(sdk.createAgentSessionServices, "createAgentSessionServices");
  need(sdk.createAgentSessionFromServices, "createAgentSessionFromServices");
  need(tuiModule.TuiMainScreen, "TuiMainScreen");
  const semver = requirePi("semver"),
    minimatch = need(requirePi("minimatch").minimatch, "minimatch");
  const preflightPackages = (options) => {
    assertSettingsHealthy(options.settings);
    return [
      ...preflightPackageSources(options),
      ...preflightExplicitResources({ ...options, minimatch }),
    ];
  };
  if (config.noInference) {
    const blocked = () => {
      throw new Error("Inference disabled by host proof mode");
    };
    // Block all SDK model-runtime instances, including extension-created ones using this installed copy.
    modelModule.ModelRuntime.prototype.stream = blocked;
    modelModule.ModelRuntime.prototype.streamSimple = blocked;
  }
  const keybindings = keysModule.KeybindingsManager.create(
    config.identity.agentDir,
  );
  themeModule.initTheme(undefined, false);
  const freshUI = () => {
    uiEpoch++;
    const instance = createHostUI({
      tuiModule,
      themeModule,
      keybindings,
      emit,
      footerProvider: new footerModule.FooterDataProvider(config.cwd),
      createAutocompleteProvider: () => {
        const registered = new Map(
          (
            runtime?.session?.extensionRunner?.getRegisteredCommands() ?? []
          ).map((command) => [command.invocationName ?? command.name, command]),
        );
        const catalogue = runtime
          ? commands().map((command) => ({
              name: command.name,
              description: command.description,
              getArgumentCompletions: registered.get(command.name)
                ?.getArgumentCompletions,
            }))
          : [];
        const Provider = need(
          tuiModule.CombinedAutocompleteProvider,
          "CombinedAutocompleteProvider",
        );
        return new Provider(catalogue, config.cwd);
      },
      onToolsExpanded: (value) => {
        for (const state of toolStates.values())
          if (state.ui === instance) state.ctx.expanded = value;
      },
    });
    return instance;
  };
  restoreEditor();
  bridge = freshUI();
  bridge.ui.setEditorText(editorCheckpoint.text);
  let provenance = [];
  const checkResources = (services) => {
    assertSettingsHealthy(services.settingsManager);
    const diagnostics = [
      ...services.diagnostics,
      ...(services.resourceLoader.getSkills().diagnostics ?? []),
      ...(services.resourceLoader.getThemes().diagnostics ?? []),
      ...(services.resourceLoader.getPrompts?.().diagnostics ?? []),
    ];
    for (const diagnostic of diagnostics)
      emit({
        type: "diagnostic",
        severity: diagnostic.type === "error" ? "error" : "warning",
        code: "resource_diagnostic",
        message: diagnostic.message,
      });
    const errors = [
      ...diagnostics.filter((d) => d.type === "error"),
      ...(services.resourceLoader.getExtensions().errors ?? []),
    ];
    if (errors.length)
      throw new Error(
        "Pi resources failed to load: " +
          errors.map((e) => e.message ?? e.error).join("; "),
      );
    themeModule.setRegisteredThemes?.(
      services.resourceLoader.getThemes().themes,
    );
    themeModule.initTheme(services.settingsManager.getTheme?.(), false);
  };
  const settingsStores = new Map();
  const factory = async (options) => {
    guardContext(options);
    bridge ??= freshUI();
    const settingsKey = JSON.stringify([options.cwd, options.agentDir]);
    if (!settingsStores.has(settingsKey))
      settingsStores.set(
        settingsKey,
        readThroughSettings(options.cwd, options.agentDir),
      );
    const settings = settingsModule.SettingsManager.fromStorage(
      settingsStores.get(settingsKey),
      { projectTrusted: false },
    );
    assertSettingsHealthy(settings);
    const reloadSettings = settings.reload.bind(settings),
      setTrusted = settings.setProjectTrusted.bind(settings);
    // Guard SDK-internal reload/trust boundaries as well as our outer readiness gate.
    settings.reload = async () => {
      await reloadSettings();
      provenance = preflightPackages({
        PackageManager: packagesModule.DefaultPackageManager,
        settings,
        cwd: options.cwd,
        agentDir: options.agentDir,
        semver,
      });
    };
    settings.setProjectTrusted = (trusted) => {
      setTrusted(trusted);
      assertSettingsHealthy(settings);
    };
    provenance = preflightPackages({
      PackageManager: packagesModule.DefaultPackageManager,
      settings,
      cwd: options.cwd,
      agentDir: options.agentDir,
      semver,
    });
    const store = new trustStoreModule.ProjectTrustStore(options.agentDir);
    const trustStore = {
      get: (cwd) => store.get(cwd),
      set: () =>
        emit({
          type: "diagnostic",
          severity: "info",
          code: "session_only_trust",
          message:
            "Trust decision is session-local; global trust was not changed",
        }),
      setMany: () =>
        emit({
          type: "diagnostic",
          severity: "info",
          code: "session_only_trust",
          message:
            "Trust decision is session-local; global trust was not changed",
        }),
    };
    const trust = async ({ extensionsResult }) => {
      assertSettingsHealthy(settings);
      const projectTrusted = await trustModule.resolveProjectTrusted({
        cwd: options.cwd,
        trustStore,
        defaultProjectTrust: settings.getGlobalSettings().defaultProjectTrust,
        extensionsResult,
        projectTrustContext: {
          cwd: options.cwd,
          mode: "tui",
          hasUI: true,
          ui: {
            ...bridge.ui,
            select: (title, choices, opts) =>
              bridge.ui.select(
                title +
                  "\nDesktop decisions apply only to this session. Missing packages will NOT be installed.",
                choices,
                opts,
              ),
          },
        },
        onExtensionError: (message) =>
          emit({
            type: "diagnostic",
            severity: "error",
            code: "trust_hook_error",
            message,
          }),
      });
      settings.setProjectTrusted(projectTrusted);
      provenance = preflightPackages({
        PackageManager: packagesModule.DefaultPackageManager,
        settings,
        cwd: options.cwd,
        agentDir: options.agentDir,
        semver,
      });
      return projectTrusted;
    };
    const services = await sdk.createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: settings,
      resourceLoaderOptions: { extensionFactories: fs.existsSync(path.join(config.identity.packageRoot, "dist/extensions/index.js")) ? (await load("extensions/index")).builtInExtensions : [] },
      resourceLoaderReloadOptions: { resolveProjectTrust: trust },
    });
    provenance = preflightPackages({
      PackageManager: packagesModule.DefaultPackageManager,
      settings,
      cwd: options.cwd,
      agentDir: options.agentDir,
      semver,
    });
    checkResources(services);
    await publishBinding(options.sessionManager);
    const result = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      customTools: workbenchTools(),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  guardContext();
  if (config.session) guardFile(config.session);
  const manager = config.session
    ? sessionModule.SessionManager.open(
        config.session,
        config.sessionDir,
        config.cwd,
      )
    : sessionModule.SessionManager.create(config.cwd, config.sessionDir);
  runtime = await sdk.createAgentSessionRuntime(factory, {
    cwd: config.cwd,
    agentDir: config.identity.agentDir,
    sessionManager: manager,
  });
  const idle = () => {
    if (
      active ||
      commandActive ||
      runtime.session.isStreaming ||
      runtime.session.isCompacting ||
      bridge.busy
    )
      throw new Error("Operation requires idle session without pending UI");
  };
  const rebind = async () => {
    bridge ??= freshUI();
    const session = runtime.session;
    keybindings.reload?.();
    runtimeKeys = keybindings.getEffectiveConfig?.() ?? {};
    extensionKeys = session.extensionRunner.getShortcuts?.(runtimeKeys) ?? new Map();
    bridge.setProviderCount(
      new Set(
        session.modelRuntime
          .getAvailableSnapshot()
          .map((model) => model.provider),
      ).size,
    );
    bridge.refreshAutocomplete();
    unsubscribe?.();
    unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") active = true;
      if (event.type === "agent_settled") active = false;
      emit(event);
      renderEvent(event, session);
    });
    await session.bindExtensions({
      uiContext: bridge.ui,
      mode: "tui",
      abortHandler: () => {
        bridge.cancel();
        void session.abort();
      },
      shutdownHandler: () => void shutdown(),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => {
          guardContext(options);
          if (session.isStreaming || bridge.busy)
            throw new Error("New session requires idle runtime");
          return replaceManaged(() => runtime.newSession(options));
        },
        fork: async (id, options) => {
          guardContext(options);
          if (session.isStreaming || bridge.busy)
            throw new Error("Fork requires idle runtime");
          return replaceManaged(() => runtime.fork(id, options));
        },
        switchSession: async (file, options) => {
          guardContext(options);
          guardFile(file);
          if (session.isStreaming || bridge.busy)
            throw new Error("Switch requires idle runtime");
          return replaceManaged(() => runtime.switchSession(file, options));
        },
        navigateTree: async (id, options) => {
          if (config.noInference && options?.summarize)
            throw new Error("Summarization disabled in proof mode");
          return session.navigateTree(id, options);
        },
        reload: async () => {
          if (session.isStreaming || bridge.busy)
            throw new Error("Reload requires idle runtime");
          return replace();
        },
      },
      onError: (error) => emit({ type: "extension_error", ...error }),
    });
    reportRuntime();
  };
  const replace = async () => {
    const session = runtime.session,
      previousUI = bridge;
    if (session.isStreaming || session.isCompacting || previousUI.busy)
      throw new Error("Reload requires idle runtime");
    runtimeReady = false;
    try {
      await runtime.services.settingsManager.flush();
      assertSettingsHealthy(runtime.services.settingsManager);
      await runtime.services.settingsManager.reload(); // guarded preflight before invalidating the old runner
      // Capture after the awaited preflight, then synchronously detach while the
      // old runner is still valid. Installed reload invalidates it BEFORE loading
      // resources; beforeSessionStart is too late to dispose extension components.
      const text = previousUI.ui.getEditorText(),
        expanded = previousUI.ui.getToolsExpanded();
      saveEditor(text);
      previousUI.detach();
      toolStates.clear();
      let rebound = false;
      await need(session.reload, "AgentSession.reload").call(session, {
        beforeSessionStart: () => {
          checkResources(runtime.services);
          bridge = freshUI();
          bridge.ui.setEditorText(text);
          bridge.ui.setToolsExpanded(expanded);
          bridge.setProviderCount(
            new Set(
              session.modelRuntime
                .getAvailableSnapshot()
                .map((model) => model.provider),
            ).size,
          );
          keybindings.reload?.();
    runtimeKeys = keybindings.getEffectiveConfig?.() ?? {};
    extensionKeys = session.extensionRunner.getShortcuts?.(runtimeKeys) ?? new Map();
          // Reload already binds the replacement runner and emits reason:"reload".
          // Calling bindExtensions again would duplicate startup with the old reason.
          need(
            session.extensionRunner.setUIContext,
            "ExtensionRunner.setUIContext",
          ).call(session.extensionRunner, bridge.ui, "tui");
          rebound = true;
        },
      });
      if (!rebound)
        throw new Error(
          "Installed reload omitted the bound beforeSessionStart boundary",
        );
      checkResources(runtime.services);
      reportRuntime();
    } catch (error) {
      emit({
        type: "diagnostic",
        severity: "error",
        code: "reload_failed",
        message: String(error),
      });
      void shutdown(1);
      throw error;
    }
  };
  runtime.setBeforeSessionInvalidate(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    bridge?.detach();
    bridge = undefined;
    toolStates.clear();
  });
  runtime.setRebindSession(rebind);
  function reportRuntime() {
    runtimeReady = true;
    emit({
      type: "runtime_ready",
      runtimeState: runtimeSnapshot(),
      identity: config.identity,
      provenance,
      tools: runtime.session
        .getAllTools()
        .map((t) => ({ name: t.name, description: t.description })),
      commands: commands(),
      skills: runtime.services.resourceLoader
        .getSkills()
        .skills.map((s) => ({ name: s.name, filePath: s.filePath })),
      capabilities: [
        "native-dialogs",
        "editor-state",
        "virtual-tui",
        "custom-factories",
        "factory-widgets",
        "factory-header-footer-editor",
        "custom-renderers",
      ],
      limitations: [
        "Direct stdin/terminal graphics unsupported",
        "Advisory managed leases do not prevent unmanaged CLI writers",
        "Extensions retain user-level authority",
        "Settings and trust updates are session-local",
        "Proof mode blocks SDK model runtime, not arbitrary extension network/subprocess code",
      ],
    });
  }
  await rebind();
  builtinContext = () => ({ runtime, ui: bridge.ui, replace: replaceManaged, guardFile, SessionManager: sessionModule.SessionManager, cwd: config.cwd, sessionDir: config.sessionDir, packageRoot: config.identity.packageRoot, signal: commandAbort?.signal, saveTrust: value => new trustStoreModule.ProjectTrustStore(config.identity.agentDir).set(config.cwd, value), editExternal: async text => {
      const command = runtime.services.settingsManager.getExternalEditorCommand();
      const edited = await externalEditor.run(command, text, commandAbort?.signal);
      bridge.ui.setEditorText(edited);
      emit({ type: "editor_replaced", original: text, text: edited });
    } });
  return { idle, replace };
})();
function commands() {
  const session = runtime.session;
  return [
    ...runtimeCommands,
    ...session.extensionRunner.getRegisteredCommands().map((c) => ({
      name: c.invocationName ?? c.name,
      description: c.description,
      source: "extension",
      mayInvokeModel: true,
    })),
    ...(session.promptTemplates ?? []).map((c) => ({
      name: c.name,
      description: c.description,
      source: "prompt",
      mayInvokeModel: true,
    })),
    ...runtime.services.resourceLoader.getSkills().skills.map((c) => ({
      name: "skill:" + c.name,
      description: c.description,
      source: "skill",
      mayInvokeModel: true,
    })),
  ];
}
const toolStates = new Map();
function renderEvent(event, session) {
  const ui = bridge;
  try {
    if (event.type === "entry_appended" && event.entry?.type === "custom") {
      const renderer = session.extensionRunner.getEntryRenderer(
        event.entry.customType,
      );
      if (renderer)
        ui.render("entry:" + event.entry.id, "entry", (_tui, theme) =>
          renderer(event.entry, { expanded: ui.ui.getToolsExpanded() }, theme),
        );
    }
    if (
      event.type === "message_end" &&
      event.message?.role === "custom" &&
      event.message.display !== false
    ) {
      const renderer = session.extensionRunner.getMessageRenderer(
        event.message.customType,
      );
      if (renderer)
        ui.render(
          "message:" + (event.message.timestamp ?? randomUUID()),
          "message",
          (_tui, theme) =>
            renderer(
              event.message,
              { expanded: ui.ui.getToolsExpanded(), outputPad: 1 },
              theme,
            ),
        );
    }
    if (event.type.startsWith("tool_execution_")) {
      const id = event.toolCallId,
        definition = session.getToolDefinition(event.toolName);
      if (!definition) return;
      let state = toolStates.get(id);
      if (
        !state ||
        state.ui !== ui ||
        (event.type === "tool_execution_start" && state.complete)
      ) {
        state = {
          ui,
          ctx: {
            args: event.args,
            toolCallId: id,
            state: {},
            cwd: runtime.cwd,
            executionStarted: true,
            argsComplete: true,
            expanded: ui.ui.getToolsExpanded(),
            showImages: false,
          },
        };
        toolStates.set(id, state);
        // Renderer contexts are projections too; never retain an unbounded tool transcript.
        while (toolStates.size > 128)
          toolStates.delete(toolStates.keys().next().value);
      }
      const ctx = state.ctx;
      if (event.args !== undefined) ctx.args = event.args;
      ctx.isPartial = event.type === "tool_execution_update";
      ctx.isError = !!event.isError;
      state.complete = event.type === "tool_execution_end";
      const result = event.partialResult ?? event.result;
      if (result !== undefined) state.result = result;
      const current = () => bridge === ui && toolStates.get(id) === state;
      ctx.invalidate = () => {
        if (!current() || state.invalidateQueued) return;
        state.invalidateQueued = true;
        queueMicrotask(() => {
          state.invalidateQueued = false;
          if (!current()) return;
          try {
            // Rebuild both render slots, not merely their already-rendered components.
            for (const slot of ["call", "result"])
              ui.rerender("tool:" + id + ":" + slot);
          } catch (error) {
            emit({
              type: "diagnostic",
              severity: "error",
              code: "renderer_error",
              message: String(error),
            });
          }
        });
      };
      if (definition.renderCall)
        ui.render("tool:" + id + ":call", "tool", (_tui, theme, previous) => {
          if (!current()) return;
          // Each invocation owns its context snapshot and slot-local component.
          // Only renderer state is shared, matching installed getRenderContext().
          return definition.renderCall(ctx.args, theme, {
            ...ctx,
            lastComponent: previous,
          });
        });
      if (state.result !== undefined && definition.renderResult)
        ui.render("tool:" + id + ":result", "tool", (_tui, theme, previous) => {
          if (!current()) return;
          return definition.renderResult(
            state.result,
            { expanded: ctx.expanded, isPartial: ctx.isPartial },
            theme,
            { ...ctx, lastComponent: previous },
          );
        });
    }
  } catch (error) {
    emit({
      type: "diagnostic",
      severity: "error",
      code: "renderer_error",
      message: String(error),
    });
  }
}
function nativeContext() {
  const session = runtime?.session,
    manager = session?.sessionManager;
  if (!session || !manager) return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        session.sessionId,
        manager.getLeafId(),
        session.model?.provider,
        session.model?.id,
        session.thinkingLevel,
        uiEpoch,
      ]),
    )
    .digest("hex");
}
function nativeHistory(cursor = 0, expectedContext) {
  const manager = runtime?.session?.sessionManager,
    context = nativeContext();
  if (!manager || !runtimeReady) throw new Error("Runtime not ready");
  if (expectedContext && expectedContext !== context)
    throw new Error("Conversation context changed; refresh history");
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid history cursor");
  const entries = manager.getBranch();
  const page = [];
  let bytes = 0,
    next = cursor;
  while (next < entries.length && page.length < 50) {
    const entry = entries[next],
      size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 500000) break;
    page.push(entry);
    bytes += size;
    next++;
  }
  return {
    mode: "active-branch",
    context,
    entries: page,
    cursor,
    next: next < entries.length ? next : null,
    truncated: next === cursor && next < entries.length,
  };
}
function runtimeSnapshot() {
  const session = runtime?.session;
  const availableThinkingLevels = session
    ? need(
        session.getAvailableThinkingLevels,
        "AgentSession.getAvailableThinkingLevels",
      ).call(session)
    : [];
  if (
    !Array.isArray(availableThinkingLevels) ||
    availableThinkingLevels.some((level) => typeof level !== "string")
  )
    throw new Error(
      "Installed thinking-level API returned invalid capabilities",
    );
  return {
    editorCheckpoint: {
      revision: editorCheckpoint.revision,
      inputId: editorCheckpoint.inputId,
      inputStatus: editorCheckpoint.inputStatus,
    },
    context: nativeContext(),
    ready: runtimeReady,
    isStreaming: active || commandActive || !!session?.isStreaming,
    sessionId: session?.sessionId,
    sessionFile: session?.sessionFile,
    model: session?.model
      ? {
          id: session.model.id,
          provider: session.model.provider,
          name: session.model.name,
        }
      : undefined,
    thinkingLevel: session?.thinkingLevel,
    availableThinkingLevels,
    pendingUI: !!bridge?.busy,
    doubleEscapeAction: runtime?.services.settingsManager.getDoubleEscapeAction?.() ?? "tree",
    keybindings: runtimeKeys,
    extensionShortcuts: [...extensionKeys.keys()],
    queue: session ? messageQueue.snapshot() : { steering: [], followUp: [] },
  };
}
async function handle(c) {
  if (
    !c ||
    c.version !== 1 ||
    typeof c.id !== "string" ||
    typeof c.type !== "string"
  )
    throw new Error("Invalid or unsupported host protocol command");
  if (resolveToolReply(toolCalls, c)) return;
  if (c.type === "bind_session") {
    const p = bindings.get(c.requestId);
    if (!p) throw new Error("Unknown binding acknowledgement");
    bindings.delete(c.requestId);
    c.error ? p.reject(new Error(c.error)) : p.resolve();
    return;
  }
  if (c.expectedSessionId !== undefined && c.expectedSessionId !== runtime?.session.sessionId) throw new Error("Session changed; input was not dispatched");
  if (c.expectedContext !== undefined && c.expectedContext !== nativeContext())
    throw new Error("Conversation context changed; request was not dispatched");
  if (c.type === "get_native_history")
    return nativeHistory(c.cursor, c.context);
  // UI replies must work during project-trust/bootstrap, before ready resolves.
  if (c.type === "ui_response") {
    if (!bridge) throw new Error("UI unavailable");
    bridge.respond(c);
    return;
  }
  if (c.type === "get_state") activate(); // private readiness/activation handshake, not a renderer GET
  if (c.type === "get_runtime_snapshot") return runtimeSnapshot();
  if (c.type === "get_ui") return uiSnapshot();
  if (c.type === "complete") { if (typeof c.text !== "string" || c.text.length > 400) throw new Error("Invalid completion text"); return { items: await bridge.complete(c.text) }; }
  if (c.type === "detach_view") {
    bridge?.detachView();
    return;
  }
  if (c.type === "resync_ui") {
    if (!bridge) throw new Error("UI unavailable");
    bridge.attachView();
    return bridge.snapshot();
  }
  if (c.type.startsWith("terminal_")) {
    if (externalEditor.terminal(c)) return;
    if (!bridge) throw new Error("UI unavailable");
    if (c.type === "terminal_input")
      saveEditor(undefined, c.inputId ?? c.id, "pending");
    bridge.terminal(c);
    saveEditor(
      undefined,
      c.type === "terminal_input" ? (c.inputId ?? c.id) : undefined,
      c.type === "terminal_input" ? "acknowledged" : undefined,
    );
    return;
  }
  if (c.type === "cancel" || c.type === "abort") {
    commandAbort?.abort();
    await externalEditor.close();
    bridge?.cancel();
    const recovered = runtime ? messageQueue.retrieve() : { queue: [] };
    runtime?.session.abortCompaction?.();
    runtime?.session.abortBranchSummary?.();
    runtime?.session.abortBash?.();
    await runtime?.session.abort();
    return recovered;
  }
  const controls = await ready,
    session = runtime.session;
  switch (c.type) {
    case "shortcut": {
      const shortcut = extensionKeys.get(c.key);
      if (!shortcut) throw new Error("Extension shortcut is not registered");
      await shortcut.handler(session.extensionRunner.createContext());
      return;
    }
    case "queue":
      if (runtimeCommands.some(command => new RegExp(`^/${command.name}(?:\\s|$)`).test(c.message))) throw new Error("Built-in commands cannot be queued; wait for the active turn or cancel it.");
      if (config.noInference) throw new Error("Inference disabled by host proof mode");
      if (bridge.busy || commandActive) throw new Error("A command or approval is active");
      await messageQueue.submit(c);
      return;
    case "retrieve_queue":
      return messageQueue.retrieve();
    case "cycle_model":
      controls.idle();
      if (!["forward", "backward"].includes(c.direction)) throw new Error("Invalid cycling direction");
      await session.cycleModel(c.direction);
      await runtime.services.settingsManager.flush();
      return;
    case "get_state":
      return runtimeSnapshot();
    case "get_available_models":
      return {
        models: session.modelRuntime
          .getAvailableSnapshot()
          .map((m) => ({ id: m.id, provider: m.provider, name: m.name })),
      };
    case "get_commands":
      return commands();
    case "get_ui":
      return uiSnapshot();
    case "redraw":
      bridge.redraw();
      return;
    case "editor_state":
      if (typeof c.text !== "string" || Buffer.byteLength(c.text) > 131072)
        throw new Error("Invalid editor text");
      bridge.ui.setEditorText(c.text);
      saveEditor();
      return;
    case "set_model": {
      controls.idle();
      const model = session.modelRuntime.getModel(c.provider, c.modelId);
      if (!model) throw new Error("Unknown model");
      await session.setModel(model);
      await runtime.services.settingsManager.flush();
      assertSettingsHealthy(runtime.services.settingsManager);
      return runtimeSnapshot();
    }
    case "set_thinking":
      controls.idle();
      if (
        typeof c.level !== "string" ||
        c.level.length > 64 ||
        !runtimeSnapshot().availableThinkingLevels.includes(c.level)
      )
        throw new Error(
          "Thinking level is not available for the current installed SDK/model",
        );
      session.setThinkingLevel(c.level);
      await runtime.services.settingsManager.flush();
      assertSettingsHealthy(runtime.services.settingsManager);
      return runtimeSnapshot();
    case "reload":
      controls.idle();
      await controls.replace();
      return;
    case "command": {
      if (config.noInference && !["session", "name", "new", "clone"].includes(c.name))
        throw new Error(
          "Commands may invoke models and are disabled in proof mode",
        );
      if (!commands().some((command) => command.name === c.name))
        throw new Error("Unknown command; not sent as a model prompt");
      if (active || commandActive || session.isStreaming || bridge.busy)
        throw new Error("Another submission or approval is active");
      if (typeof c.args !== "string" && c.args !== undefined)
        throw new Error("Invalid command args");
      commandActive = true;
      commandAbort = new AbortController();
      const task = runtimeCommands.some(command => command.name === c.name)
        ? runRuntimeCommand(c.name, c.args ?? "", builtinContext())
        : session.prompt("/" + c.name + (c.args ? " " + c.args : ""), { source: "interactive" });
      void task
        .then(
          () => {
            commandActive = false;
            active = runtime.session.isStreaming;
            emit({ type: "command_end", name: c.name, isStreaming: active });
          },
          (error) => {
            commandActive = false;
            active = runtime.session.isStreaming;
            emit({
              type: "command_end",
              name: c.name,
              isStreaming: active,
              error: String(error),
            });
          },
        );
      return { dispatched: true, mayInvokeModel: true };
    }
    case "prompt": {
      if (config.noInference)
        throw new Error("Inference disabled by host proof mode");
      if (
        typeof c.message !== "string" ||
        !c.message.trim() ||
        Buffer.byteLength(c.message) > 131072
      )
        throw new Error("Invalid prompt");
      if (c.message.trimStart().startsWith("/"))
        throw new Error(
          "Use explicit allowlisted command execution for slash commands",
        );
      // Portable images (validated by the backend contract) become Pi image input.
      const images = Array.isArray(c.images)
        ? c.images
            .filter((i) => i && typeof i.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i.mimeType))
            .slice(0, 4)
            .map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))
        : [];
      if (active || commandActive || session.isStreaming || bridge.busy)
        throw new Error("Session busy; no automatic queue/replay");
      active = true;
      return new Promise((resolve, reject) => {
        let ack = false;
        session
          .prompt(c.message, {
            source: "interactive",
            ...(images.length ? { images } : {}),
            preflightResult: (accepted) => {
              if (accepted) {
                ack = true;
                resolve();
              }
            },
          })
          .then(() => {
            active = session.isStreaming;
            const error = ack
              ? undefined
              : "Prompt completed without acceptance acknowledgement";
            // An installed input handler may acknowledge and consume text without
            // starting an agent turn, so agent_settled is not a universal boundary.
            emit({
              type: "prompt_end",
              requestId: c.id,
              isStreaming: active,
              ...(error ? { error } : {}),
            });
            if (error) reject(new Error(error));
          })
          .catch((error) => {
            active = session.isStreaming;
            emit({
              type: "prompt_end",
              requestId: c.id,
              isStreaming: active,
              error: String(error),
            });
            if (!ack) reject(error);
            else
              emit({
                type: "agent_error",
                requestId: c.id,
                error: String(error),
              });
          });
      });
    }
    default:
      throw new Error("Host command not allowlisted");
  }
}
process.on("message", (c) => {
  void handle(c).then(
    (data) => response(c, data),
    (error) => response(c, undefined, error),
  );
});
process.on("disconnect", () => void shutdown());
if (process.send && !process.connected) void shutdown(1);
let buffer = "";
// Capture one protocol listener; extensions attempting direct stdin subscription fail visibly.
const stdinOn = process.stdin.on.bind(process.stdin);
if (!process.send)
  stdinOn("data", (bytes) => {
    buffer += bytes.toString("utf8");
    if (Buffer.byteLength(buffer) > 1048576) {
      emit({
        type: "diagnostic",
        severity: "error",
        code: "oversize_input",
        message: "Input frame exceeds limit",
      });
      void shutdown(1);
      return;
    }
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let c;
      try {
        c = JSON.parse(line);
      } catch {
        void shutdown(1);
        return;
      }
      void handle(c).then(
        (data) => response(c, data),
        (error) => response(c, undefined, error),
      );
    }
  });
stdinOn("end", () => void shutdown());
process.stdin.on = process.stdin.addListener = (event, listener) => {
  if (["data", "readable", "keypress"].includes(event)) {
    const error = new Error(
      "Direct stdin is unsupported; use ctx.ui.onTerminalInput or ctx.ui.custom",
    );
    emit({
      type: "diagnostic",
      severity: "error",
      code: "direct_stdin",
      message: error.message,
    });
    throw error;
  }
  return stdinOn(event, listener);
};
process.stdin.setRawMode = () => {
  throw new Error("Direct raw terminal mode unsupported");
};
ready.catch((error) => {
  emit({
    type: "diagnostic",
    severity: "error",
    code: "startup_failed",
    message: String(error),
  });
  void shutdown(1);
});
