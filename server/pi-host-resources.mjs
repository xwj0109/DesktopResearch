import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const put = (target, key, value) =>
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
function differences(before, after, prefix = []) {
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const keys = [...prefix, key];
    if (!Object.hasOwn(after, key)) changes.push({ keys, remove: true });
    else if (
      object(after[key]) &&
      !Object.keys(after[key]).length &&
      !object(before[key])
    )
      changes.push({ keys, value: {} });
    else if (object(after[key]))
      changes.push(
        ...differences(
          object(before[key]) ? before[key] : {},
          after[key],
          keys,
        ),
      );
    else if (
      !Object.hasOwn(before, key) ||
      JSON.stringify(before[key]) !== JSON.stringify(after[key])
    )
      changes.push({ keys, value: after[key] });
  }
  return changes;
}
function applyChanges(disk, changes) {
  const value = JSON.parse(JSON.stringify(disk));
  for (const change of changes.values()) {
    let target = value;
    for (const key of change.keys.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !object(target[key]))
        put(target, key, {});
      target = target[key];
    }
    const key = change.keys.at(-1);
    if (change.remove) delete target[key];
    else put(target, key, change.value);
  }
  return value;
}
/** Fresh disk on every read; only changed fields are session-local, never whole-scope snapshots. */
export function readThroughSettings(cwd, agentDir) {
  const overlays = new Map();
  return {
    withLock(scope, fn) {
      const file =
        scope === "global"
          ? path.join(agentDir, "settings.json")
          : path.join(cwd, ".pi/settings.json");
      let disk;
      try {
        disk = fs.readFileSync(file, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (disk !== undefined && !object(JSON.parse(disk))) throw new Error("Pi settings must be an object");
      const changes = overlays.get(scope) ?? new Map();
      const current = changes.size
        ? JSON.stringify(applyChanges(JSON.parse(disk ?? "{}"), changes))
        : disk;
      const result = fn(current);
      if (result !== undefined && result !== current) {
        const before = JSON.parse(current ?? "{}"),
          after = JSON.parse(result);
        if (!object(before) || !object(after))
          throw new Error("Pi settings must be an object");
        for (const change of differences(before, after)) {
          for (const [key, prior] of changes) {
            const prefix = (a, b) =>
              a.every((part, index) => part === b[index]);
            if (
              prefix(prior.keys, change.keys) ||
              prefix(change.keys, prior.keys)
            )
              changes.delete(key);
          }
          changes.set(JSON.stringify(change.keys), change);
        }
        overlays.set(scope, changes);
      }
    },
  };
}
/** Offline loader is mandatory too: preflight alone is not protection against an install race. */
export function preflightPackages({
  PackageManager,
  settings,
  cwd,
  agentDir,
  semver,
}) {
  if (process.env.PI_OFFLINE !== "1")
    throw new Error("Offline resource resolution guard missing");
  const pm = new PackageManager({ cwd, agentDir, settingsManager: settings });
  const sources = [
    ["user", settings.getGlobalSettings()],
    ...(settings.isProjectTrusted()
      ? [["project", settings.getProjectSettings()]]
      : []),
  ];
  const provenance = [];
  for (const [scope, values] of sources) {
    for (const pkg of values.packages ?? []) {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      const installedPath = pm.getInstalledPath(source, scope);
      if (!installedPath || !fs.existsSync(installedPath))
        throw new Error(
          `Missing configured Pi resource ${source}; install through the CLI explicitly, then reconnect`,
        );
      if (source.startsWith("npm:")) {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(installedPath, "package.json"), "utf8"),
        );
        const spec = source.slice(4),
          at = spec.indexOf("@", 1),
          range = at === -1 ? undefined : spec.slice(at + 1);
        if (
          !manifest.version ||
          (range &&
            semver.validRange(range) &&
            !semver.satisfies(manifest.version, range))
        )
          throw new Error(
            `Installed Pi resource does not satisfy ${source}; explicit CLI update required`,
          );
      }
      provenance.push({ source, scope, path: fs.realpathSync(installedPath) });
    }
  }
  return provenance;
}

/** SettingsManager queues load/write errors instead of throwing. {} fallback is not readiness. */
export function assertSettingsHealthy(settings) {
  if (typeof settings.drainErrors !== "function") throw new Error("Installed SettingsManager API incompatible: drainErrors");
  const errors = settings.drainErrors();
  if (errors.length) throw new Error("Pi settings failed: " + errors.map(({ scope, error }) => `${scope}: ${error?.message ?? error}`).join("; "));
}

/** Independent filesystem-only explicit-root gate. Settings globs FILTER, never discover. */
export function preflightExplicitResources({ settings, cwd, agentDir, minimatch }) {
  const sources = [["user", agentDir, settings.getGlobalSettings()], ...(settings.isProjectTrusted() ? [["project", path.join(cwd, ".pi"), settings.getProjectSettings()]] : [])];
  const provenance = [], posix = value => value.replaceAll("\\", "/");
  for (const [scope, base, values] of sources) for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    const entries = values[kind] ?? [];
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) throw new Error(`Invalid ${scope} ${kind} settings`);
    const isPattern = entry => /^[!+-]/.test(entry) || /[*?]/.test(entry);
    const patterns = entries.filter(isPattern), plain = entries.filter(entry => !isPattern(entry));
    const matches = (file, pattern, exact = false) => {
      const candidates = [posix(path.relative(base, file)), posix(file)];
      if (!exact) candidates.push(path.basename(file));
      if (path.basename(file) === "SKILL.md") { candidates.push(posix(path.relative(base, path.dirname(file))), posix(path.dirname(file))); if (!exact) candidates.push(path.basename(path.dirname(file))); }
      const normalized = posix(exact ? pattern.replace(/^\.[/\\]/, "") : pattern);
      return candidates.some(candidate => exact ? candidate === normalized : minimatch(candidate, normalized));
    };
    const enabled = file => {
      const includes = patterns.filter(pattern => !/^[!+-]/.test(pattern));
      let result = !includes.length || includes.some(pattern => matches(file, pattern));
      if (patterns.some(pattern => pattern[0] === "!" && matches(file, pattern.slice(1)))) result = false;
      if (patterns.some(pattern => pattern[0] === "+" && matches(file, pattern.slice(1), true))) result = true;
      if (patterns.some(pattern => pattern[0] === "-" && matches(file, pattern.slice(1), true))) result = false;
      return result;
    };
    for (const entry of plain) {
      const trimmed = entry.trim(), expanded = trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
      if (!expanded) throw new Error(`Empty explicit ${scope} ${kind} resource`);
      const file = path.resolve(base, expanded);
      let stat;
      try { stat = fs.statSync(file); }
      catch (error) {
        // A missing extensionless root might be a directory whose children match a
        // positive filter. Do not silently discard that ambiguous configured root.
        const possibleDirectory = !path.extname(file) && patterns.some(pattern => !/^[!+-]/.test(pattern));
        if (!enabled(file) && !possibleDirectory) continue;
        throw new Error(`Missing/unreadable configured Pi ${kind} resource (${scope}): ${entry}; ${error.code ?? "stat failed"}`);
      }
      if (stat.isFile() && !enabled(file)) continue;
      // Directory roots expand to candidates: an exact root exclusion does not exclude children.
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Configured Pi ${kind} resource is not a file/directory: ${entry}`);
      try { fs.accessSync(file, fs.constants.R_OK); if (stat.isDirectory()) fs.readdirSync(file); }
      catch (error) { throw new Error(`Unreadable configured Pi ${kind} resource (${scope}): ${entry}; ${error.code ?? "read failed"}`); }
      provenance.push({ source: entry, kind, scope, path: fs.realpathSync(file) });
    }
  }
  return provenance;
}
