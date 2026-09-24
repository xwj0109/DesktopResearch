import fs from "node:fs";
import {
  atomic,
  contentHash,
  mkdir,
  readFile,
  safePath,
  Fault,
} from "./durable.ts";
import type { IntentReceipt } from "../src/native-contract.ts";
/** Retained tombstones: no eviction can turn an old request into a new dispatch. */
export class NativeIntents {
  constructor(private root: string) {
    mkdir(root);
  }
  private file(scope: string, id: string) {
    return safePath(this.root, contentHash({ scope, id }) + ".json");
  }
  read(scope: string, id: string): IntentReceipt | null {
    const file = this.file(scope, id);
    return fs.existsSync(file)
      ? JSON.parse(readFile(file, 6 * 1024 * 1024).toString())
      : null;
  }
  private write(scope: string, receipt: IntentReceipt) {
    atomic(this.file(scope, receipt.id), JSON.stringify(receipt));
  }
  seal(scope: string, id: string) {
    const existing = this.read(scope, id);
    if (existing) return existing;
    const receipt: IntentReceipt = { id, hash: "", status: "sealed" };
    this.write(scope, receipt);
    return receipt;
  }
  async run(
    scope: string,
    id: string,
    request: unknown,
    execute: () => Promise<unknown>,
  ): Promise<IntentReceipt> {
    const hash = contentHash(request),
      old = this.read(scope, id);
    if (old) {
      if (old.status === "sealed")
        throw new Fault(409, "Request was sealed and cannot dispatch");
      if (old.hash !== hash)
        throw new Fault(409, "Request identity reused with different content");
      return old; // Pending/uncertain is inspection only; never replay.
    }
    // A full ledger blocks new work instead of forgetting replay protection.
    if (fs.readdirSync(this.root).length >= 50000)
      throw new Fault(
        409,
        "Request ledger capacity reached; retained receipts require archival before new work",
      );
    this.write(scope, { id, hash, status: "pending" });
    try {
      const result = await execute();
      const receipt: IntentReceipt = { id, hash, status: "acknowledged", ...(result === undefined ? {} : { result }) };
      this.write(scope, receipt);
      return receipt;
    } catch (error) {
      this.write(scope, { id, hash, status: "uncertain" });
      throw error;
    }
  }
}
