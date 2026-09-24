import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { z } from "zod";
import {
  atomic,
  Blobs,
  canonical,
  digest,
  Fault,
  mkdir,
  own,
  readFile,
  safePath,
  uncertainPublication,
} from "./durable.ts";
import type { Strategy } from "../src/shared.ts";
export interface Database {
  version: 1;
  rootToken: string;
  tokens: Record<string, string>;
  strategies: Record<string, Strategy>;
}
const manifestSchema = z
  .object({
    version: z.literal(2),
    generation: z.number().int().positive(),
    rootToken: z.string().regex(/^[a-f0-9]{64}$/),
    tokens: z.record(z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)),
    strategies: z.record(z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)),
    migration: z.string().nullable(),
  })
  .strict();
/** catalog.json is the atomic authority switch; v1 source is never overwritten. */
export class CompanionStorage {
  generation = 0;
  migration: string | null = null;
  warning: string | null = null;
  private uncertain = false;
  private publications = new AsyncLocalStorage<{ persistence?: ReturnType<typeof uncertainPublication> }>();
  observePublication<T>(receipt: { persistence?: ReturnType<typeof uncertainPublication> }, work: () => T) {
    return this.publications.run(receipt, work);
  }
  constructor(
    public runtime: string,
    public workspaces: string,
    private validate: (x: unknown) => Database,
  ) {
    own(runtime);
    own(workspaces);
  }
  strategyRoot(id: string) {
    z.uuid().parse(id);
    return safePath(this.workspaces, "strategies", id);
  }
  blobs(id: string) {
    return new Blobs(
      safePath(this.strategyRoot(id), "meta", "companion-blobs"),
      64 * 1024 * 1024,
    );
  }
  load(initial: Database): Database {
    const legacy = safePath(this.runtime, "state.json"),
      catalog = safePath(this.runtime, "catalog.json");
    if (fs.existsSync(catalog)) {
      const m = manifestSchema.parse(JSON.parse(readFile(catalog).toString()));
      this.generation = m.generation;
      this.migration = m.migration;
      const strategies: Record<string, Strategy> = {};
      for (const [id, h] of Object.entries(m.strategies))
        strategies[id] = this.blobs(id).json(h) as Strategy;
      return this.validate({
        version: 1,
        rootToken: m.rootToken,
        tokens: m.tokens,
        strategies,
      });
    }
    const bytes = fs.existsSync(legacy)
      ? readFile(legacy, 64 * 1024 * 1024)
      : Buffer.from(JSON.stringify(initial));
    const db = this.validate(JSON.parse(bytes.toString()));
    // Validate ALL bytes before publishing any authority. Stage is retryable and content-addressed.
    for (const s of Object.values(db.strategies))
      for (const a of s.artifacts) {
        const source = readFile(
          safePath(this.runtime, s.id, a.hash),
          24 * 1024 * 1024,
        );
        if (source.length !== a.bytes || digest(source) !== a.hash)
          throw new Fault(409, "Migration artifact integrity mismatch");
      }
    if (fs.existsSync(legacy)) {
      this.migration = digest(bytes);
      const backup = safePath(
        this.runtime,
        "migration-v1-" + this.migration + ".json",
      );
      if (!fs.existsSync(backup)) atomic(backup, bytes);
      else if (!readFile(backup, 64 * 1024 * 1024).equals(bytes))
        throw new Fault(409, "Migration backup integrity mismatch");
    } else atomic(legacy, bytes); // compatibility source marker, frozen after first creation
    for (const s of Object.values(db.strategies))
      for (const a of s.artifacts)
        this.artifactBlobs(s.id).put(
          readFile(safePath(this.runtime, s.id, a.hash), 24 * 1024 * 1024),
        );
    this.save(db);
    return db;
  }
  artifactBlobs(id: string) {
    return new Blobs(
      safePath(this.strategyRoot(id), "Reference-Papers", "blobs"),
    );
  }
  get durability() {
    return this.uncertain ? "uncertain" as const : "durable" as const;
  }
  assertDurable() {
    if (this.uncertain)
      throw new Fault(
        503,
        "Catalog publication durability uncertain; restart and verify storage before further writes or external activity",
      );
  }
  save(db: Database) {
    this.assertDurable();
    this.validate(db);
    const catalog = safePath(this.runtime, "catalog.json");
    const actual = fs.existsSync(catalog)
      ? manifestSchema.parse(JSON.parse(readFile(catalog).toString()))
          .generation
      : 0;
    if (actual !== this.generation)
      throw new Fault(
        409,
        "Companion changed in another Store; reload before saving",
      );
    const strategies: Record<string, string> = {};
    for (const s of Object.values(db.strategies)) {
      const root = this.strategyRoot(s.id);
      for (const d of [
        "meta",
        "Reference-Papers",
        "Research-Development",
        "Data",
        "Design",
        "Code-implementation",
        "Experiments",
        "Results",
      ])
        mkdir(safePath(root, d));
      const blobs = this.blobs(s.id);
      strategies[s.id] = blobs.putJSON(s);
      blobs.get(strategies[s.id]); // Verify staged bytes before the authority switch.
    }
    const next = canonical({
      version: 2,
      generation: this.generation + 1,
      rootToken: db.rootToken,
      tokens: db.tokens,
      strategies,
      migration: this.migration,
    });
    try {
      atomic(catalog, next);
    } catch (e) {
      if (!fs.existsSync(catalog) || readFile(catalog).toString() !== next)
        throw e;
      this.uncertain = true;
      this.warning = "Catalog published; directory sync uncertain";
      const receipt = this.publications.getStore();
      if (receipt) receipt.persistence = uncertainPublication(this.warning);
    }
    this.generation++;
    if (this.uncertain) return; // Old catalog may reappear after crash: preserve ALL referenced blobs.
    // GC noncanonical companion snapshots: UI churn is not scientific history.
    for (const [id, h] of Object.entries(strategies)) {
      try {
        const dir = this.blobs(id).root;
        for (const f of fs.readdirSync(dir))
          if (f !== h && /^[a-f0-9]{64}$/.test(f))
            fs.unlinkSync(safePath(dir, f));
      } catch {
        this.warning = "Companion garbage collection deferred";
      }
    }
  }
}
