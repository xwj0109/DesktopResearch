import fs from "node:fs";
import path from "node:path";

export function rejectSessionSymlinks(file) {
  for (let current = path.resolve(file);;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink in managed session path"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
/** Validate before SessionManager.open or constructing resources, not after binding ACK. */
export function validateManagedSessionFile(file, sessionDir, cwd, { existing = true, id } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.dirname(file) !== path.resolve(sessionDir) || !file.endsWith(".jsonl")) throw new Error("Session switching outside this managed conversation is unsupported");
  rejectSessionSymlinks(file);
  if (!fs.existsSync(file)) { if (existing) throw new Error("Managed session file is missing"); return; }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Managed session is not a regular file");
    const buffer = Buffer.alloc(65536), bytes = fs.readSync(fd, buffer, 0, buffer.length, 0), end = buffer.indexOf(10);
    if (end < 0 || end >= bytes) throw new Error("Managed session header missing or oversized");
    const header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    if (header.type !== "session" || typeof header.id !== "string" || id && header.id !== id || typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(cwd)) throw new Error("Managed session identity/cwd mismatch; resources were not loaded");
    return header;
  } finally { fs.closeSync(fd); }
}

/** Materialize a blank SDK session, then use its public resume API to enable appends.
 * Never mutate SessionManager's private flushed state. Preserve setup/fork entries and leaf.
 */
export function ensureCanonicalSession(manager) {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Canonical session path missing");
  if (fs.existsSync(file)) return;
  for (const method of ["setSessionFile", "getHeader", "getEntries", "getLeafId", "branch", "resetLeaf"])
    if (typeof manager[method] !== "function") throw new Error(`Installed SessionManager API incompatible: ${method}`);
  const header = manager.getHeader(), entries = manager.getEntries(), leaf = manager.getLeafId();
  if (header?.type !== "session" || header.id !== manager.getSessionId()) throw new Error("Invalid SDK session header");
  const fd = fs.openSync(file, "wx", 0o600);
  try { for (const entry of [header, ...entries]) fs.writeFileSync(fd, JSON.stringify(entry) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  // Public resume establishes append state; an unflushed manager would try open("wx").
  manager.setSessionFile(file);
  if (leaf === null) manager.resetLeaf(); else manager.branch(leaf);
}
