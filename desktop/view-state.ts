import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  emptyView,
  viewStateSchema,
  type ViewState,
  type Scope,
} from "./contracts.ts";
import { storageIdentity } from "./window-state.ts";
import { ownedDirectory } from "../server/lifecycle.ts";
export const MAX_VIEW_BYTES = 5 * 1024 * 1024;
/** Native-owned, bounded plain composer drafts. Not custom Pi editor durability. */
export class ViewStore {
  private directory: string;
  constructor(
    private root: string,
    desktop: string,
  ) {
    this.directory = ownedDirectory(desktop, "views");
  }
  private file(scope: Scope) {
    return path.join(
      this.directory,
      storageIdentity(this.root, scope) + ".json",
    );
  }
  read(scope: Scope): ViewState {
    const file = this.file(scope);
    if (!fs.existsSync(file)) return emptyView();
    if (
      fs.lstatSync(file).isSymbolicLink() ||
      fs.statSync(file).size > MAX_VIEW_BYTES
    )
      throw new Error("Invalid saved view");
    return viewStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  save(scope: Scope, input: unknown) {
    const value = viewStateSchema.parse(input);
    if (scope.kind === "launcher") throw new Error("No launcher drafts");
    const keys = Object.keys(value.drafts);
    if (
      keys.some((k) =>
        scope.kind === "portfolio" ? k !== "portfolio" : k === "portfolio",
      )
    )
      throw new Error("Draft outside scope");
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.byteLength > MAX_VIEW_BYTES)
      throw new Error("Saved view exceeds byte limit");
    const file = this.file(scope),
      tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
      const dir = fs.openSync(this.directory, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}
