import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {CommandReceipt} from "../src/platform.ts";

export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable refusal for routes whose desktop DTO passes it through. */
    public refusal?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const uncertainPublication = (warning: string) => ({
  committed: true as const,
  durability: "uncertain" as const,
  warning,
  retry: "do-not-replay" as const,
});
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const contentHash = (value: unknown) => digest(canonical(value));
export function noSymlink(file: string) {
  let p = path.resolve(file);
  for (;;) {
    try {
      if (fs.lstatSync(p).isSymbolicLink())
        throw new Fault(403, "Symlink access denied");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
}
export function safePath(root: string, ...parts: string[]) {
  if (parts.some((p) => !p || p === "." || p === ".." || /[/\\\x00]/.test(p)))
    throw new Fault(403, "Invalid storage path");
  const p = path.join(root, ...parts);
  noSymlink(p);
  return p;
}
export function mkdir(p: string) {
  p = path.resolve(p);
  noSymlink(p);
  if (fs.existsSync(p)) {
    if (!fs.lstatSync(p).isDirectory())
      throw new Fault(409, "Storage directory is not a directory");
    // Existence is not a durability receipt: an earlier mkdir may have succeeded
    // just before its parent fsync failed (including across process restart).
    syncDir(path.dirname(p));
    return;
  }
  const parent = path.dirname(p);
  mkdir(parent);
  fs.mkdirSync(p, { mode: 0o700 });
  syncDir(parent);
  noSymlink(p);
}
export function syncDir(p: string) {
  noSymlink(p);
  const fd = fs.openSync(p, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** OS metadata dropped by file browsers (Finder `.DS_Store`, `._*` resource
 * forks). The data root is a user-visible folder, so these must not be
 * mistaken for journal records or blobs. Real unexpected files still fail. */
export const isOsMetadata = (name: string) => name === ".DS_Store" || name.startsWith("._");
export function readFile(p: string, max = 8 * 1024 * 1024) {
  noSymlink(p);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max)
      throw new Fault(413, "Invalid file or size bound exceeded");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomic(p: string, data: string | Buffer) {
  noSymlink(p);
  mkdir(path.dirname(p));
  const tmp = p + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    noSymlink(p);
    fence(p);
    fs.renameSync(tmp, p);
    syncDir(path.dirname(p));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
const owners = new Map<string, string>();
export function own(root: string) {
  root = path.resolve(root);
  mkdir(root);
  const p = safePath(root, "writer.lock");
  if (owners.has(root)) {
    const saved = JSON.parse(readFile(p).toString());
    if (saved.nonce !== owners.get(root))
      throw new Fault(409, "Writer ownership changed");
    return;
  }
  // All acquisition and stale-owner replacement is serialized by an exclusive directory.
  // A crash inside this tiny acquisition section requires explicit operator inspection,
  // never a second unsafe automatic reclamation protocol.
  const guard = safePath(root, "writer-acquisition.lock");
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Fault(
        409,
        "Writer ownership acquisition in progress or interrupted; inspect acquisition lock before recovery",
      );
    throw e;
  }
  try {
    syncDir(root);
    if (fs.existsSync(p)) {
      const old = z
        .object({ pid: z.number().int().positive(), nonce: z.uuid() })
        .strict()
        .parse(JSON.parse(readFile(p).toString()));
      try {
        process.kill(old.pid, 0);
        throw new Fault(409, "Another server owns this storage root");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      fs.unlinkSync(p);
      syncDir(root);
    }
    const nonce = randomUUID();
    const fd = fs.openSync(p, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDir(root);
    owners.set(root, nonce);
  } finally {
    fs.rmdirSync(guard);
    syncDir(root);
  }
}
function fence(file: string) {
  const target = path.resolve(file);
  for (const [root, nonce] of owners)
    if (target === root || target.startsWith(root + path.sep)) {
      const current = z
        .object({ pid: z.number().int().positive(), nonce: z.uuid() })
        .strict()
        .parse(JSON.parse(readFile(safePath(root, "writer.lock")).toString()));
      if (current.pid !== process.pid || current.nonce !== nonce)
        throw new Fault(409, "Writer ownership changed; publication refused");
    }
}
export class Blobs {
  constructor(
    public root: string,
    readonly maxBytes = 24 * 1024 * 1024,
  ) {
    mkdir(root);
  }
  put(data: Buffer | string) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > this.maxBytes)
      throw new Fault(413, `Blob exceeds ${this.maxBytes} byte bound`);
    const h = digest(bytes),
      p = safePath(this.root, h);
    if (fs.existsSync(p)) {
      if (digest(readFile(p, this.maxBytes)) !== h)
        throw new Fault(409, "Blob integrity mismatch");
      // A previous attempt may have published this blob but failed directory fsync.
      // Confirm that entry before a later transaction can reference it.
      syncDir(this.root);
    } else {
      const files = fs.readdirSync(this.root).filter((f) => !isOsMetadata(f));
      let total = 0;
      for (const f of files) {
        const fp = safePath(this.root, f);
        const stat = fs.lstatSync(fp);
        if (!stat.isFile()) throw new Fault(409, "Invalid blob entry");
        total += stat.size;
      }
      if (total + bytes.length > 512 * 1024 * 1024)
        throw new Fault(413, "512 MiB resource blob quota reached");
      atomic(p, bytes);
    }
    return h;
  }
  get(h: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(h);
    const b = readFile(safePath(this.root, h), this.maxBytes);
    if (digest(b) !== h) throw new Fault(409, "Blob integrity mismatch");
    return b;
  }
  /** Remove a blob no longer referenced by any record (caller's responsibility). */
  remove(h: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(h);
    const p = safePath(this.root, h);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      syncDir(this.root);
    }
  }
  json(h: string): unknown {
    return JSON.parse(this.get(h).toString());
  }
  putJSON(value: unknown) {
    return this.put(canonical(value));
  }
}
const eventSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().positive(),
    operationId: z.uuid(),
    requestHash: z.string().length(64),
    type: z.string().min(1).max(100),
    at: z.iso.datetime(),
    previous: z.string(),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().length(64),
  })
  .strict();
export type JournalEvent = z.infer<typeof eventSchema>;
/** Immutable per-resource commit files are authority; snapshot.json is dispensable. */
export class Journal<T> {
  readonly blobs: Blobs;
  readonly events: JournalEvent[] = [];
  state: T;
  warning: string | null = null;
  private uncertain = false;
  constructor(
    public root: string,
    private schema: z.ZodType<T>,
    initial: T,
  ) {
    mkdir(root);
    mkdir(safePath(root, "journal"));
    this.blobs = new Blobs(safePath(root, "blobs"));
    this.state = schema.parse(initial);
    this.replay();
  }
  get revision() {
    return this.events.length;
  }
  get durability() {
    return this.uncertain ? "uncertain" as const : "durable" as const;
  }
  assertDurable() {
    if (this.uncertain)
      throw new Fault(503, "Commit durability uncertain; restart and verify storage before further writes or execution");
  }
  replay() {
    const dir = safePath(this.root, "journal");
    const files = fs
      .readdirSync(dir)
      .filter((f) => !f.endsWith(".tmp") && !isOsMetadata(f))
      .sort();
    if (files.length > 10000)
      throw new Fault(413, "Journal record bound exceeded");
    this.events.length = 0;
    for (const f of files) {
      const expected =
        String(this.events.length + 1).padStart(8, "0") + ".json";
      if (f !== expected) throw new Fault(409, "Journal gap or unknown file");
      const e = eventSchema.parse(
        JSON.parse(readFile(safePath(dir, f), 16384).toString()),
      );
      const { hash, ...body } = e;
      if (
        e.revision !== this.revision + 1 ||
        e.previous !== (this.events.at(-1)?.hash ?? "") ||
        contentHash(body) !== hash ||
        this.events.some((x) => x.operationId === e.operationId)
      )
        throw new Fault(409, "Journal integrity mismatch");
      this.state = this.schema.parse(this.blobs.json(e.stateHash));
      this.events.push(e);
    }
    // Restart can observe an earlier published-but-unsynced entry; confirm it
    // before permitting new canonical mutations in this instance.
    syncDir(dir);
    syncDir(this.blobs.root);
  }
  commit(
    operationId: string,
    expected: number,
    type: string,
    request: unknown,
    next: T,
  ) {
    z.uuid().parse(operationId);
    const requestHash = contentHash({ type, request });
    const prior = this.events.find((e) => e.operationId === operationId);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new Fault(409, "Operation ID reused for different input");
      return prior;
    }
    this.assertDurable();
    if (expected !== this.revision)
      throw new Fault(
        409,
        "Scientific revision conflict; retain your draft and reload",
      );
    const disk = fs
      .readdirSync(safePath(this.root, "journal"))
      .filter((f) => !f.endsWith(".tmp") && !isOsMetadata(f)).length;
    if (disk !== this.revision)
      throw new Fault(409, "Another view committed; reopen before saving");
    if (this.revision >= 10000)
      throw new Fault(413, "10000 scientific event limit");
    const state = this.schema.parse(next),
      encoded = canonical(state);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
      throw new Fault(413, "4 MiB scientific metadata limit");
    const stateHash = this.blobs.put(encoded);
    const body = {
      version: 2 as const,
      revision: this.revision + 1,
      operationId,
      requestHash,
      type,
      at: new Date().toISOString(),
      previous: this.events.at(-1)?.hash ?? "",
      stateHash,
    };
    const event = { ...body, hash: contentHash(body) },
      p = safePath(
        this.root,
        "journal",
        String(body.revision).padStart(8, "0") + ".json",
      );
    // Publication is the commit point. Never report a committed operation as rolled back.
    try {
      atomic(p, canonical(event));
    } catch (e) {
      if (!fs.existsSync(p) || readFile(p).toString() !== canonical(event))
        throw e;
      this.uncertain = true;
      this.warning =
        "Commit published but directory sync failed; verify durable storage before continuing";
    }
    this.state = state;
    this.events.push(event);
    if (this.uncertain) return event;
    try {
      this.project();
    } catch {
      this.warning =
        "Journal committed; projection unavailable. Rebuild from journal.";
    }
    return event;
  }
  receipt(operationId: string): CommandReceipt {
    const index=this.events.findIndex(event=>event.operationId===operationId);
    if(index<0)throw new Fault(404,"Committed operation not found in this resource");
    const event=this.events[index];
    const current=this.schema.parse(this.blobs.json(event.stateHash)) as Record<string,unknown>;
    const previous=index?this.schema.parse(this.blobs.json(this.events[index-1].stateHash)) as Record<string,unknown>:{};
    const created:CommandReceipt["created"]=[];
    // Derive from the original committed snapshots, never from today's last row.
    // id+hash distinguishes subsequent immutable versions in one lineage.
    for(const [collection,rows] of Object.entries(current)){
      if(!Array.isArray(rows))continue;
      const before=new Set((Array.isArray(previous[collection])?previous[collection] as any[]:[]).map(row=>row&&typeof row.id==="string"?canonical({id:row.id,hash:row.hash}):""));
      for(const row of rows)if(row&&typeof row.id==="string"&&!before.has(canonical({id:row.id,hash:row.hash})))
        created.push({collection,id:row.id,...(typeof row.hash==="string"?{hash:row.hash}:{})});
    }
    return {operationId:event.operationId,committedRevision:event.revision,created};
  }
  project() {
    try {
      atomic(
        safePath(this.root, "snapshot.json"),
        canonical({
          projection: true,
          revision: this.revision,
          journalHash: this.events.at(-1)?.hash ?? "",
          state: this.state,
        }),
      );
      if (this.warning?.startsWith("Journal committed; projection"))
        this.warning = null;
    } catch {
      this.warning =
        "Journal committed; projection unavailable. Rebuild from journal.";
    }
  }
}
