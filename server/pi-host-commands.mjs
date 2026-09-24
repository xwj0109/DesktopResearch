import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const exec = promisify(execFile);
import fs from "node:fs";
import path from "node:path";
/** Built-in conversation commands delegated to the installed SDK.
 * Dialogs use the same host UI as extensions; replacements use the existing
 * managed binding barrier. No renderer implements session mutations. */
export const runtimeCommands = [
  ["editor", "Edit the draft in the configured external editor"],
  ["share", "Share a conversation export as a secret GitHub gist"],
  ["login", "Authenticate a model provider"],
  ["logout", "Sign out of a model provider"],
  ["import", "Import a JSONL conversation into this workspace"],
  ["trust", "Save project trust for this workspace"],
  ["changelog", "Show installed Pi release notes"],
  ["shell", "Run a shell command (! or !!)"],
  ["new", "Start a new conversation session"],
  ["resume", "Resume a session in this research conversation"],
  ["tree", "Navigate this session's branches"],
  ["fork", "Fork from an earlier user message"],
  ["clone", "Clone the active branch"],
  ["name", "Name this conversation session"],
  ["session", "Session, tokens and cost"],
  ["compact", "Compact context with optional instructions"],
  ["settings", "Runtime delivery, transport, retry and compaction settings"],
  ["scoped-models", "Choose models for keyboard cycling"],
  ["export", "Export this conversation to HTML or JSONL"],
].map(([name, description]) => ({
  name,
  description,
  source: "builtin",
  mayInvokeModel: ["compact", "tree"].includes(name),
}));
const text = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ");
export async function runRuntimeCommand(
  name,
  args,
  {
    runtime,
    ui,
    replace,
    guardFile,
    SessionManager,
    cwd,
    sessionDir,
    signal,
    packageRoot,
    saveTrust,
    editExternal,
  },
) {
  const session = runtime.session,
    manager = session.sessionManager;
  const notify = (value) =>
    ui.notify(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      "info",
    );
  const choose = async (title, entries) => {
    if (!entries.length) {
      notify("No entries available.");
      return;
    }
    // Search narrows large histories without truncating away selectable entries.
    if (entries.length > 200) {
      const query = await ui.input(
        `${title}: search ${entries.length} entries`,
        "Name, text or entry ID",
      );
      if (query === undefined) return;
      entries = entries.filter((entry) =>
        entry.label.toLowerCase().includes(query.toLowerCase()),
      );
      if (entries.length > 200) {
        notify(
          "More than 200 matches. Repeat the command with a narrower search.",
        );
        return;
      }
    }
    const labels = entries.map(
      (entry, index) => `${index + 1}. ${entry.label}`,
    );
    const selected = await ui.select(title, labels);
    return selected === undefined
      ? undefined
      : entries[labels.indexOf(selected)]?.value;
  };
  switch (name) {
    case "editor":
      return editExternal(args);
    case "share": {
      if (
        !(await ui.confirm(
          "Share conversation",
          "Upload this conversation as a secret GitHub gist? Anyone with its link can read the exported messages.",
        ))
      )
        return;
      await exec("gh", ["auth", "status"], { signal, maxBuffer: 65536 });
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "pi-research-share-"),
      );
      try {
        const file = path.join(directory, "conversation.html");
        await session.exportToHtml(file);
        const result = await exec(
          "gh",
          [
            "gist",
            "create",
            "--desc",
            session.sessionName || "Pi conversation",
            file,
          ],
          { signal, maxBuffer: 65536 },
        );
        notify(result.stdout.trim());
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      return;
    }

    case "login": {
      const modelRuntime = session.modelRuntime;
      const providers = modelRuntime
        .getProviders()
        .filter(
          (provider) =>
            !args.trim() ||
            `${provider.id} ${provider.name}`
              .toLowerCase()
              .includes(args.trim().toLowerCase()),
        );
      const provider = await choose(
        "Provider",
        providers.map((provider) => ({
          label: `${provider.name} (${provider.id})`,
          value: provider,
        })),
      );
      if (!provider) return;
      const methods = [
        provider.auth.oauth && "oauth",
        provider.auth.apiKey && "api_key",
      ].filter(Boolean);
      const method =
        methods.length === 1
          ? methods[0]
          : await ui.select("Authentication method", methods);
      if (!method) return;
      await modelRuntime.login(provider.id, method, {
        signal,
        prompt: async (prompt) => {
          let value;
          if (prompt.type === "select") {
            const label = await ui.select(
              prompt.message,
              prompt.options.map((option) => option.label),
            );
            value = prompt.options.find((option) => option.label === label)?.id;
          } else
            value = await ui.input(prompt.message, prompt.placeholder, {
              secret: true,
            });
          if (value === undefined) throw new Error("Login cancelled");
          return value;
        },
        notify: (event) =>
          notify(
            [
              event.message,
              event.url,
              event.instructions,
              event.userCode,
              event.verificationUri,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      });
      return notify(`Signed in to ${provider.name}.`);
    }
    case "logout": {
      const providers = session.modelRuntime
        .getProviders()
        .filter((provider) =>
          session.modelRuntime.hasConfiguredAuth(provider.id),
        );
      const id = await choose(
        "Sign out of provider",
        providers.map((provider) => ({
          label: `${provider.name} (${provider.id})`,
          value: provider.id,
        })),
      );
      if (id) {
        await session.modelRuntime.logout(id, { signal });
        notify(`Signed out of ${id}.`);
      }
      return;
    }
    case "import": {
      const file =
        args.trim() ||
        (await ui.input("Import session JSONL", "Absolute file path"));
      if (!file) return;
      if (
        !path.isAbsolute(file) ||
        fs.lstatSync(file).isSymbolicLink() ||
        !fs.statSync(file).isFile() ||
        fs.statSync(file).size > 32 * 1024 * 1024
      )
        throw new Error("Select a regular JSONL file smaller than 32 MB.");
      // Import as a new SDK-managed identity; never overwrite an existing
      // canonical session or adopt another workspace's working directory.
      const imported = SessionManager.forkFrom(file, cwd, sessionDir);
      guardFile(imported.getSessionFile());
      return replace(() => runtime.switchSession(imported.getSessionFile()));
    }
    case "trust": {
      const choice = await ui.select(
        "Project trust for this research workspace",
        [
          "Trust this workspace",
          "Do not trust this workspace",
          "Remove saved decision",
        ],
      );
      if (choice === undefined) return;
      await saveTrust(
        choice === "Remove saved decision"
          ? null
          : choice === "Trust this workspace",
      );
      return notify("Project trust saved. Reload or reconnect to apply it.");
    }
    case "changelog":
      return notify(
        fs
          .readFileSync(path.join(packageRoot, "CHANGELOG.md"), "utf8")
          .slice(0, 24000),
      );
    case "shell": {
      const excluded = args.startsWith("!");
      const command = excluded ? args.slice(1) : args;
      if (!command.trim()) return;
      await session.executeBash(command, undefined, {
        excludeFromContext: excluded,
      });
      return;
    }

    case "new":
      return replace(() => runtime.newSession());
    case "clone": {
      const leaf = manager.getLeafId();
      if (!leaf) return notify("Nothing to clone yet.");
      return replace(() => runtime.fork(leaf, { position: "at" }));
    }
    case "resume": {
      const sessions = await SessionManager.list(cwd, sessionDir);
      const file = await choose(
        "Resume conversation session",
        sessions.map((item) => ({
          label: `${item.name || item.firstMessage || item.id} · ${item.modified ?? item.created}`,
          value: item.path,
        })),
      );
      if (!file) return;
      guardFile(file);
      return replace(() => runtime.switchSession(file));
    }
    case "fork": {
      const messages = session.getUserMessagesForForking();
      const id = await choose(
        "Fork from user message",
        messages.map((item) => ({
          label: `${item.entryId}: ${item.text}`,
          value: item.entryId,
        })),
      );
      if (!id) return;
      const result = await replace(() => runtime.fork(id));
      if (!result?.cancelled && result?.selectedText)
        ui.setEditorText(result.selectedText);
      return;
    }
    case "tree": {
      const entries = manager.getEntries();
      const id = await choose(
        "Navigate session tree",
        entries.map((entry) => ({
          label: `${entry.id} ← ${entry.parentId ?? "root"} · ${manager.getLabel(entry.id) ?? ""} ${entry.message?.role ?? entry.type} ${text(entry.message).slice(0, 180)}`,
          value: entry.id,
        })),
      );
      if (!id) return;
      const mode = await ui.select("Navigate branch", [
        "Navigate without summary",
        "Summarize abandoned branch",
        "Edit label",
      ]);
      if (mode === undefined) return;
      if (mode === "Edit label") {
        const label = await ui.input(
          "Entry label (empty removes label)",
          manager.getLabel(id) ?? "",
        );
        if (label !== undefined)
          manager.appendLabelChange(id, label || undefined);
        return;
      }
      const result = await session.navigateTree(id, {
        summarize: mode === "Summarize abandoned branch",
      });
      if (result?.editorText) ui.setEditorText(result.editorText);
      return;
    }
    case "name": {
      const value =
        args.trim() ||
        (await ui.input("Session name", session.sessionName ?? ""));
      if (value !== undefined) session.setSessionName(value);
      return;
    }
    case "session":
      return notify({
        name: session.sessionName,
        id: session.sessionId,
        ...session.getSessionStats(),
        context: session.getContextUsage(),
      });
    case "compact":
      await session.compact(args.trim() || undefined);
      return notify("Context compacted. Full history remains in the session.");
    case "export": {
      const format =
        args.trim() ||
        (await ui.select("Export conversation", ["HTML", "JSONL"]));
      if (!format) return;
      const file = /jsonl$/i.test(format)
        ? session.exportToJsonl(format === "JSONL" ? undefined : format)
        : await session.exportToHtml(format === "HTML" ? undefined : format);
      return notify(`Exported conversation: ${file}`);
    }
    case "scoped-models": {
      const available = session.modelRuntime.getAvailableSnapshot();
      const chosen = new Set(
        session.scopedModels.map(
          (item) => `${item.model.provider}/${item.model.id}`,
        ),
      );
      while (true) {
        const keys = available.map((model) => `${model.provider}/${model.id}`);
        const choice = await ui.select("Models for cycling", [
          "Save selection",
          "Enable all",
          "Clear all",
          ...keys.map((key) => `${chosen.has(key) ? "✓" : "○"} ${key}`),
        ]);
        if (choice === undefined) return;
        if (choice === "Save selection") break;
        if (choice === "Enable all") keys.forEach((key) => chosen.add(key));
        else if (choice === "Clear all") chosen.clear();
        else {
          const key = choice.slice(2);
          if (chosen.has(key)) chosen.delete(key);
          else chosen.add(key);
        }
      }
      session.setScopedModels(
        available
          .filter((model) => chosen.has(`${model.provider}/${model.id}`))
          .map((model) => ({ model, thinkingLevel: session.thinkingLevel })),
      );
      runtime.services.settingsManager.setEnabledModels([...chosen]);
      await runtime.services.settingsManager.flush();
      return;
    }
    case "settings": {
      const settings = runtime.services.settingsManager;
      const key = await ui.select("Runtime settings", [
        "Steering delivery",
        "Follow-up delivery",
        "Transport",
        "Automatic compaction",
        "Automatic retry",
        "Double Escape",
        "Image resizing",
        "Block image input",
        "Skill commands",
        "HTTP idle timeout",
      ]);
      if (!key) return;
      if (key === "Steering delivery" || key === "Follow-up delivery") {
        const mode = await ui.select(key, ["one-at-a-time", "all"]);
        if (mode)
          key === "Steering delivery"
            ? session.setSteeringMode(mode)
            : session.setFollowUpMode(mode);
      } else if (key === "Transport") {
        const mode = await ui.select(
          `Transport (currently ${settings.getTransport()})`,
          ["auto", "sse", "websocket"],
        );
        if (mode) settings.setTransport(mode);
      } else if (key === "Double Escape") {
        const action = await ui.select(key, ["tree", "fork", "none"]);
        if (action) settings.setDoubleEscapeAction(action);
      } else if (key === "HTTP idle timeout") {
        const value = await ui.input(
          "HTTP idle timeout in milliseconds",
          String(settings.getHttpIdleTimeoutMs()),
        );
        if (value !== undefined) {
          const milliseconds = Number(value);
          if (
            !Number.isSafeInteger(milliseconds) ||
            milliseconds < 0 ||
            milliseconds > 3600000
          )
            throw new Error("Enter a timeout from 0 to 3600000 milliseconds.");
          settings.setHttpIdleTimeoutMs(milliseconds);
        }
      } else if (
        ["Image resizing", "Block image input", "Skill commands"].includes(key)
      ) {
        const choice = await ui.select(key, ["Enabled", "Disabled"]);
        if (choice) {
          const enabled = choice === "Enabled";
          if (key === "Image resizing") settings.setImageAutoResize(enabled);
          if (key === "Block image input") settings.setBlockImages(enabled);
          if (key === "Skill commands")
            settings.setEnableSkillCommands(enabled);
        }
      } else {
        const enabled = await ui.select(key, ["Enabled", "Disabled"]);
        if (enabled)
          key === "Automatic compaction"
            ? session.setAutoCompactionEnabled(enabled === "Enabled")
            : session.setAutoRetryEnabled(enabled === "Enabled");
      }
      await settings.flush();
      return;
    }
    default:
      throw new Error("Unknown built-in runtime command");
  }
}
