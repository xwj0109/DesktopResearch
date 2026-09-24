import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PiCoordinationState } from "../src/pi-protocol.ts";

export function definitelyDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function sync(dir: string) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function safe(file: string) {
  for (let current = path.resolve(file);;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink in Pi coordination path"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function same(a: PiCoordinationState | null, b: PiCoordinationState | null) {
  return a === null || b === null ? a === b : a.turn === b.turn && a.nonce === b.nonce && a.pid === b.pid && a.complete === b.complete && a.recoveryRequired === b.recoveryRequired;
}
/** Publish an immutable, fully written record with atomic create-if-absent. */
function publish(file: string, value: unknown) {
  const temp = path.join(path.dirname(file), ".claim-" + randomUUID());
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temp, file); sync(path.dirname(file)); } finally { fs.unlinkSync(temp); }
}
/**
 * Cross-process serialization without unsafe stale-lock unlink/recreate races.
 * All contenders for a successor compete for the SAME numbered immutable slot.
 * A crash exposes either no slot or complete owner metadata. Abandoned slots are
 * retained, never stolen/deleted. Only explicit recovery can supersede dead owners.
 */
export class PiCoordination {
  constructor(readonly root: string) {}
  inspect(): PiCoordinationState | null {
    safe(this.root); if (!fs.existsSync(this.root)) return null;
    const names = fs.readdirSync(this.root).filter(name => /^\d{12}\.owner\.json$/.test(name)).sort();
    if (names.length > 100000) throw new Error("Pi coordination journal requires explicit maintenance");
    const last = names.at(-1); if (!last) return null;
    const file = path.join(this.root, last); safe(file);
    const owner = JSON.parse(fs.readFileSync(file, "utf8")), turn = Number(last.slice(0, 12));
    if (owner.version !== 1 || owner.turn !== turn || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string" || !owner.nonce) throw new Error("Malformed Pi coordination owner; recovery refused");
    const done = file.replace(".owner.json", ".done.json"); safe(done);
    let complete = false, recoveryRequired = false;
    if (fs.existsSync(done)) {
      const result = JSON.parse(fs.readFileSync(done, "utf8"));
      if (result.version !== 1 || result.nonce !== owner.nonce || typeof result.recoveryRequired !== "boolean") throw new Error("Malformed Pi coordination completion; recovery refused");
      complete = true; recoveryRequired = result.recoveryRequired;
    }
    return { turn, pid: owner.pid, nonce: owner.nonce, complete, recoveryRequired };
  }
  run<T>(fn: (transaction: { owner: PiCoordinationState; dirty(): void }) => T, recovery?: { expected: PiCoordinationState | null }): T {
    safe(this.root);
    const missing: string[] = [];
    for (let current = this.root; !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const directory of missing) sync(path.dirname(directory));
    const previous = this.inspect();
    if (recovery && !same(previous, recovery.expected)) throw new Error("Stale coordination inspection; inspect again");
    if (previous && !previous.complete && (!recovery || !definitelyDead(previous.pid))) throw new Error("Pi coordination owner is active or uncertain; explicit definitely-dead owner reconciliation required");
    if (previous?.recoveryRequired && !recovery) throw new Error("Pi coordination publication is uncertain; explicit reconciliation required");
    const owner: PiCoordinationState = { turn: (previous?.turn ?? 0) + 1, pid: process.pid, nonce: randomUUID(), complete: false, recoveryRequired: false };
    const stem = String(owner.turn).padStart(12, "0");
    publish(path.join(this.root, stem + ".owner.json"), { version: 1, ...owner });
    let dirty = false, completeAttempted = false;
    const complete = (recoveryRequired: boolean) => {
      completeAttempted = true;
      publish(path.join(this.root, stem + ".done.json"), { version: 1, nonce: owner.nonce, recoveryRequired });
    };
    try { const result = fn({ owner, dirty: () => { dirty = true; } }); complete(false); return result; }
    catch (error) {
      if (!completeAttempted) {
        // A failed mutation never turns an uncertain publication into permission to acquire.
        try { complete(dirty || !!previous && (!previous.complete || previous.recoveryRequired)); } catch { /* pending immutable owner remains recoverable after its PID exits */ }
      }
      throw error;
    }
  }
}
