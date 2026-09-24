import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { PiBinding, PiSubmission, PiRecoveryRequest } from "../src/pi-protocol.ts";
import { PiCoordination, definitelyDead } from "./pi-coordination.ts";

export interface PiLease {
  version: 1;
  pid: number;
  nonce: string;
  generation: number;
  mode: "desktop" | "handoff";
  acquiredAt: string;
}
function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(file: string, value: unknown) {
  const tmp = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Advisory managed ownership only. Unmanaged CLI processes and arbitrary extensions are not sandboxed. */
export class PiBindings {
  constructor(readonly root: string) {
    this.safe(root);
  }
  private safe(file: string) {
    let current = path.resolve(file);
    while (true) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error("Symlink in Pi binding path");
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  file(workspace: string, tab: string) {
    return path.join(
      this.root,
      createHash("sha256")
        .update(workspace + "\0" + tab)
        .digest("hex") + ".json",
    );
  }
  get(workspace: string, tab: string): PiBinding | undefined {
    const file = this.file(workspace, tab);
    this.safe(file);
    if (!fs.existsSync(file)) return;
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      v.version !== 1 ||
      v.workspace !== workspace ||
      v.tab !== tab ||
      !Number.isSafeInteger(v.generation) || v.generation < 0 || typeof v.logicalSessionId !== "string" || !v.logicalSessionId ||
      v.lastSubmission && (typeof v.lastSubmission.id !== "string" || !v.lastSubmission.id || !["prompt", "command"].includes(v.lastSubmission.kind) || !["pending", "accepted", "settled", "failed", "uncertain"].includes(v.lastSubmission.status))
    )
      throw new Error("Invalid Pi binding; manual reconciliation required");
    return v;
  }
  validateCanonical(workspace: string, tab: string, sessionDir: string, expectedCwd?: string) {
    const canonical = this.get(workspace, tab)?.canonical;
    if (!canonical) return;
    if (
      !path.isAbsolute(canonical.path) ||
      path.dirname(canonical.path) !== path.resolve(sessionDir) ||
      !canonical.path.endsWith(".jsonl")
    )
      throw new Error(
        "Bound canonical session is outside its managed directory; reconciliation required",
      );
    this.safe(canonical.path);
    if (!fs.existsSync(canonical.path))
      throw new Error(
        "Bound canonical session file is missing; reconciliation required (identity will not be recreated)",
      );
    const fd = fs.openSync(
      canonical.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      if (!fs.fstatSync(fd).isFile())
        throw new Error("Bound canonical session is not a regular file");
      const buffer = Buffer.alloc(65536),
        bytes = fs.readSync(fd, buffer, 0, buffer.length, 0),
        end = buffer.indexOf(10);
      if (end < 0 || end >= bytes)
        throw new Error(
          "Bound canonical session header is missing or oversized",
        );
      const header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      if (
        header.type !== "session" ||
        header.id !== canonical.id ||
        typeof header.cwd !== "string" ||
        !path.isAbsolute(header.cwd) ||
        !!(expectedCwd ?? canonical.cwd) && path.resolve(header.cwd) !== path.resolve((expectedCwd ?? canonical.cwd)!)
      )
        throw new Error(
          "Bound canonical session header identity mismatch; reconciliation required",
        );
      return { ...canonical, cwd: header.cwd as string };
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Root-relative form of an absolute runtime path ("sessions/…/x.jsonl"),
   * found by the runtime directory name, so an old root's path can be
   * compared with the current root's. Undefined if it isn't a runtime path. */
  private runtimeSuffix(file: string) {
    const runtime = path.dirname(path.resolve(this.root));
    const marker = path.sep + path.basename(runtime) + path.sep;
    const at = path.resolve(file).lastIndexOf(marker);
    return at < 0 ? undefined : path.resolve(file).slice(at + marker.length);
  }
  /** Read-only: where a bound canonical session lives now. If the data root was
   * moved, the recorded absolute path is gone but the same root-relative file
   * exists under the current root. Never writes. */
  locate(canonical: { path: string }) {
    if (fs.existsSync(canonical.path)) return canonical.path;
    const suffix = this.runtimeSuffix(canonical.path);
    if (!suffix) return canonical.path;
    const moved = path.join(path.dirname(path.resolve(this.root)), suffix);
    return fs.existsSync(moved) ? moved : canonical.path;
  }
  /** Explicit, evidence-checked repair after the whole data root was moved
   * (e.g. Library → ~/Pi Research Data). Applies only when no managed writer
   * lease exists, the recorded file is gone from its old absolute location
   * (a copy is refused: two live roots must not share an identity), the same
   * file with the same session id exists in the current managed directory, and
   * both the old path and the header cwd have exactly the current root-relative
   * location. Rewrites only the header's cwd — every later byte is preserved —
   * keeps an audit record of the previous binding and header, then rebinds. */
  relocate(workspace: string, tab: string, sessionDir: string, cwd: string): { from: string; to: string } | undefined {
    return this.coordinator(workspace, tab).run(transaction => {
      const binding = this.get(workspace, tab);
      const canonical = binding?.canonical;
      if (!binding || !canonical) return undefined;
      const target = path.join(path.resolve(sessionDir), path.basename(canonical.path));
      if (path.resolve(canonical.path) === target) return undefined;
      const refuse = (why: string): never => {
        throw new Error(`Relocated Pi session not reconciled: ${why}`);
      };
      // Not evidence of a move of this data root: leave it to validateCanonical,
      // which reports escaped/missing/mismatched bindings with its own errors.
      const oldSuffix = this.runtimeSuffix(canonical.path);
      if (!oldSuffix || oldSuffix !== this.runtimeSuffix(target)) return undefined;
      this.safe(target);
      if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) return undefined;
      if (fs.existsSync(canonical.path)) refuse("the original session file still exists (copied, not moved)");
      if (fs.existsSync(this.file(workspace, tab) + ".lease")) refuse("a managed writer lease exists");
      const bytes = fs.readFileSync(target);
      const end = bytes.indexOf(10);
      if (end < 0 || end > 65536) refuse("session header is missing or oversized");
      const headerLine = bytes.subarray(0, end).toString("utf8");
      const header = JSON.parse(headerLine);
      if (header.type !== "session" || header.id !== canonical.id || typeof header.cwd !== "string")
        refuse("session header identity mismatch");
      const oldCwd = this.runtimeSuffix(header.cwd);
      if (!oldCwd || oldCwd !== this.runtimeSuffix(cwd)) refuse("session working directory is not the moved workspace");
      transaction.dirty();
      const audit = path.join(path.dirname(path.resolve(this.root)), "relocations");
      fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
      this.safe(audit);
      atomic(path.join(audit, `${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(workspace + "\0" + tab).digest("hex").slice(0, 12)}.json`), {
        version: 1,
        at: new Date().toISOString(),
        workspace,
        tab,
        previous: { canonical, header: headerLine },
        next: { path: target, cwd: path.resolve(cwd) },
      });
      const rewritten = Buffer.concat([
        Buffer.from(JSON.stringify({ ...header, cwd: path.resolve(cwd) }), "utf8"),
        bytes.subarray(end),
      ]);
      const tmp = target + "." + randomUUID() + ".tmp";
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, rewritten);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
      syncDir(path.dirname(target));
      atomic(this.file(workspace, tab), {
        ...binding,
        canonical: { ...canonical, path: target, cwd: path.resolve(cwd) },
        updatedAt: new Date().toISOString(),
      });
      return { from: canonical.path, to: target };
    });
  }
  coordinator(workspace: string, tab: string) { return new PiCoordination(this.file(workspace, tab) + ".coord"); }
  readLease(workspace: string, tab: string): PiLease | null {
    const file = this.file(workspace, tab) + ".lease"; this.safe(file);
    if (!fs.existsSync(file)) return null;
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lease.version !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || !Number.isSafeInteger(lease.generation) || lease.generation < 1 || typeof lease.nonce !== "string" || !lease.nonce || !["desktop", "handoff"].includes(lease.mode)) throw new Error("Malformed or unknown Pi lease owner; recovery refused");
    return lease;
  }
  requiresRecovery(binding?: PiBinding) { return !!binding?.lastSubmission && ["pending", "accepted", "uncertain"].includes(binding.lastSubmission.status) && !binding.lastSubmission.acknowledgedAt; }
  inspect(workspace: string, tab: string, sessionDir?: string, expectedCwd?: string) {
    const binding = this.get(workspace, tab);
    let lease: PiLease | null = null, leaseError: string | undefined, canonicalError: string | undefined;
    try { lease = this.readLease(workspace, tab); } catch (error) { leaseError = String(error); }
    if (sessionDir) try { this.validateCanonical(workspace, tab, sessionDir, expectedCwd); } catch (error) { canonicalError = String(error); }
    const coordination = this.coordinator(workspace, tab).inspect();
    return { binding, lease, leaseError, canonicalError, coordination, ownerDefinitelyDead: !!lease && definitelyDead(lease.pid), recoveryRequired: this.requiresRecovery(binding) || !!lease || !!leaseError || !!coordination && (!coordination.complete || coordination.recoveryRequired), unmanagedWriterProtection: false };
  }
  acquire(
    workspace: string,
    tab: string,
    logicalSessionId: string,
    mode: PiLease["mode"] = "desktop",
  ) {
    return this.coordinator(workspace, tab).run(transaction => {
    this.safe(this.root);
    const file = this.file(workspace, tab),
      lock = file + ".lease";
    this.safe(lock);
    // Authoritative binding read occurs only AFTER exclusive cross-process coordination.
    const previous = this.get(workspace, tab);
    if (previous && previous.logicalSessionId !== logicalSessionId)
      throw new Error(
        "Logical Pi identity changed; refusing historical rebinding",
      );
    if (mode === "handoff" && this.requiresRecovery(previous)) throw new Error("Uncertain native submission requires explicit reconciliation before CLI handoff");
    // Never automatically steal even a dead lease: an orphan child may still own the session.
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as PiLease;
      throw new Error(
        `Managed ${owner.mode} writer lease exists (${alive(owner.pid) ? "alive" : "stale/uncertain"}); stop or explicitly reconcile before reconnecting`,
      );
    }
    const lease: PiLease = {
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
      generation: (previous?.generation ?? 0) + 1,
      mode,
      acquiredAt: new Date().toISOString(),
    };
    const fd = fs.openSync(lock, "wx", 0o600);
    transaction.dirty();
    try {
      fs.writeFileSync(fd, JSON.stringify(lease));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDir(this.root);
    const binding: PiBinding = {
      ...previous,
      version: 1,
      workspace,
      tab,
      logicalSessionId,
      generation: lease.generation,
      updatedAt: new Date().toISOString(),
    };
    // On uncertain publication keep the lease: do not let another writer guess.
    atomic(file, binding);
    return { binding, lease };
    });
  }
  assert(workspace: string, tab: string, lease: PiLease) {
    const lock = this.file(workspace, tab) + ".lease";
    this.safe(lock);
    const current = JSON.parse(fs.readFileSync(lock, "utf8")) as PiLease;
    if (
      current.nonce !== lease.nonce ||
      current.generation !== lease.generation ||
      current.pid !== lease.pid ||
      current.mode !== lease.mode
    )
      throw new Error("Pi writer fenced by changed lease");
  }
  setPid(workspace: string, tab: string, lease: PiLease, pid: number) {
    return this.coordinator(workspace, tab).run(transaction => {
      this.assert(workspace, tab, lease);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid managed writer PID");
      const next = { ...lease, pid }; transaction.dirty();
      atomic(this.file(workspace, tab) + ".lease", next);
      Object.assign(lease, next);
    });
  }
  bind(
    workspace: string,
    tab: string,
    lease: PiLease,
    canonical: { id: string; path: string; cwd?: string },
    sessionDir: string,
  ) {
    return this.coordinator(workspace, tab).run(transaction => {
    this.assert(workspace, tab, lease);
    if (
      !canonical.id ||
      path.dirname(path.resolve(canonical.path)) !== path.resolve(sessionDir) ||
      !canonical.path.endsWith(".jsonl")
    )
      throw new Error("Canonical session outside managed directory");
    this.safe(canonical.path);
    const binding = this.get(workspace, tab)!;
    transaction.dirty();
    atomic(this.file(workspace, tab), {
      ...binding,
      canonical,
      updatedAt: new Date().toISOString(),
    });
    });
  }
  submission(
    workspace: string,
    tab: string,
    lease: PiLease,
    submission: PiSubmission,
  ) {
    return this.coordinator(workspace, tab).run(transaction => {
    this.assert(workspace, tab, lease);
    const binding = this.get(workspace, tab)!;
    const previous = binding.lastSubmission;
    if (submission.status === "pending" && previous?.id !== submission.id && this.requiresRecovery(binding)) throw new Error("Previous native submission requires explicit reconciliation before another send");
    if (submission.status !== "pending" && previous?.id !== submission.id)
      throw new Error("Stale native submission callback");
    if (
      submission.status === "accepted" &&
      previous &&
      ["settled", "failed", "uncertain"].includes(previous.status)
    )
      return;
    transaction.dirty();
    atomic(this.file(workspace, tab), {
      ...binding,
      lastSubmission: submission,
      updatedAt: new Date().toISOString(),
    });
    });
  }
  release(workspace: string, tab: string, lease: PiLease) {
    return this.coordinator(workspace, tab).run(transaction => {
      this.assert(workspace, tab, lease); transaction.dirty();
      fs.unlinkSync(this.file(workspace, tab) + ".lease"); syncDir(this.root);
    });
  }
  reconcile(workspace: string, tab: string, logicalSessionId: string, sessionDir: string, request: PiRecoveryRequest, expectedCwd?: string) {
    if (request.historyReviewed !== true || request.unmanagedWritersStopped !== true || !request.note.trim()) throw new Error("Explicit history and unmanaged-writer acknowledgements required");
    return this.coordinator(workspace, tab).run(transaction => {
      // Binding/lease CAS reads are authoritative only AFTER exclusive acquisition.
      const binding = this.get(workspace, tab), lease = this.readLease(workspace, tab);
      if ((binding?.generation ?? 0) !== request.expectedGeneration || (binding?.lastSubmission?.id ?? null) !== request.submissionId) throw new Error("Stale binding/submission inspection; inspect again");
      if (binding && binding.logicalSessionId !== logicalSessionId) throw new Error("Logical session identity mismatch");
      if (lease ? !request.lease || lease.nonce !== request.lease.nonce || lease.pid !== request.lease.pid || lease.generation !== request.lease.generation || lease.mode !== request.lease.mode : request.lease !== null) throw new Error("Stale lease inspection; inspect again");
      if (lease && !definitelyDead(lease.pid)) throw new Error("Lease PID is alive or cannot be established dead; recovery refused");
      if (!lease && !this.requiresRecovery(binding) && !request.coordination?.recoveryRequired && request.coordination?.complete !== false) throw new Error("No unresolved managed ownership or submission to reconcile");
      this.validateCanonical(workspace, tab, sessionDir, expectedCwd);
      transaction.dirty();
      const at = new Date().toISOString(), auditFile = path.join(this.coordinator(workspace, tab).root, String(transaction.owner.turn).padStart(12, "0") + ".recovery.json");
      // Retain the original receipt/outcome BEFORE changing the gate or removing ownership.
      atomic(auditFile, { version: 1, at, binding: binding ?? null, lease, request, owner: transaction.owner });
      const next: PiBinding = { ...binding, version: 1, workspace, tab, logicalSessionId, generation: Math.max(binding?.generation ?? 0, lease?.generation ?? 0) + 1, updatedAt: at, lastSubmission: binding?.lastSubmission ? { ...binding.lastSubmission, acknowledgedAt: at } : undefined, recovery: { at, auditFile } };
      atomic(this.file(workspace, tab), next);
      if (lease) { this.assert(workspace, tab, lease); fs.unlinkSync(this.file(workspace, tab) + ".lease"); syncDir(this.root); }
      return next;
    }, { expected: request.coordination });
  }
  /** Bounded canonical JSONL page, including header. No SDK or process startup on reads. */
  history(workspace: string, tab: string, cursor = 0, limit = 50, raw = false) {
    const binding = this.get(workspace, tab);
    const file = binding?.canonical && this.locate(binding.canonical);
    if (!file || !fs.existsSync(file))
      return { entries: [], cursor, next: null, truncated: false };
    this.safe(file);
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const size = fs.fstatSync(fd).size;
      if (cursor < 0 || cursor > size)
        throw new Error("Invalid history byte cursor");
      const buffer = Buffer.alloc(Math.min(786432, size - cursor));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, cursor);
      if (raw)
        return {
          entries: [],
          cursor,
          next: cursor + bytes < size ? cursor + bytes : null,
          truncated: false,
          rawChunk: buffer.subarray(0, bytes).toString("base64"),
          rawNext: cursor + bytes,
          size,
        };
      const entries: unknown[] = [];
      let start = 0,
        offset = 0;
      while (entries.length < Math.min(limit, 100)) {
        const end = buffer.indexOf(10, start);
        if (end < 0 || end >= bytes) break;
        entries.push(JSON.parse(buffer.subarray(start, end).toString("utf8")));
        offset = end + 1;
        start = offset;
      }
      // Oversize entries are visible and retrievable as bounded raw chunks, never silently skipped.
      if (!offset && bytes)
        return {
          entries: [],
          cursor,
          next: cursor,
          truncated: true,
          rawChunk: buffer.subarray(0, bytes).toString("base64"),
          rawNext: cursor + bytes,
          size,
        };
      return {
        entries,
        cursor,
        next: cursor + offset < size ? cursor + offset : null,
        truncated: false,
        size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
}
