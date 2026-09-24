import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { atomic, contentHash, mkdir, readFile } from "../server/durable.ts";
import type { Scope, LabRequest, RequestRecord } from "./contracts.ts";
import { storageIdentity } from "./window-state.ts";
export class RequestJournal {
  constructor(
    private root: string,
    private desktop: string,
  ) {}
  private directory(scope: Scope) {
    const dir = path.join(
      this.desktop,
      "requests",
      storageIdentity(this.root, scope),
    );
    mkdir(dir);
    return dir;
  }
  list(scope: Scope): RequestRecord[] {
    const dir = this.directory(scope);
    return fs
      .readdirSync(dir)
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map((f) =>
        z
          .object({
            id: z.uuid(),
            path: z.string().max(2048),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            at: z.iso.datetime(),
            status: z.enum(["pending", "responded", "uncertain"]),
          })
          .parse(JSON.parse(readFile(path.join(dir, f), 8192).toString())),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 200);
  }
  async dispatch<T>(
    scope: Scope,
    req: LabRequest,
    send: () => Promise<T>,
  ): Promise<T> {
    if (!req.requestId)
      throw new Error("A durable request identity is required");
    const dir = this.directory(scope),
      file = path.join(dir, req.requestId + ".json");
    if (fs.existsSync(file))
      throw new Error(
        "Request already recorded; inspect receipt instead of replaying",
      );
    if (fs.readdirSync(dir).length >= 50000)
      throw new Error("Request journal full");
    const entry = {
      id: req.requestId,
      path: req.path,
      hash: contentHash({
        path: req.path,
        method: req.method,
        headers: req.headers,
        body: Buffer.from(req.body ?? []).toString("base64"),
      }),
      at: new Date().toISOString(),
      status: "pending",
    };
    atomic(file, JSON.stringify(entry));
    try {
      const result = await send();
      atomic(file, JSON.stringify({ ...entry, status: "responded" }));
      return result;
    } catch (error) {
      atomic(file, JSON.stringify({ ...entry, status: "uncertain" }));
      throw error;
    }
  }
}
