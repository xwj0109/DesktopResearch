import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { scopeSchema, type Scope } from "./contracts.ts";
import { scopeKey } from "./security.ts";
export const boundsSchema = z
  .object({
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
    width: z.number().int().min(400).max(10000),
    height: z.number().int().min(300).max(10000),
  })
  .strict();
const recordSchema = z
  .object({ scope: scopeSchema, bounds: boundsSchema, maximized: z.boolean() })
  .strict();
const stateSchema = z
  .object({ version: z.literal(1), windows: z.array(recordSchema).max(201) })
  .strict();
export type WindowRecord = z.infer<typeof recordSchema>;
export function storageIdentity(root: string, scope: Scope) {
  return createHash("sha256")
    .update(fs.realpathSync(root) + "\0" + scopeKey(scope))
    .digest("hex");
}
export function readWindowState(file: string): WindowRecord[] {
  try {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 65536)
      return [];
    const parsed = stateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const seen = new Set<string>();
    return parsed.windows.filter((r) => {
      const k = scopeKey(r.scope);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return [];
  }
}
export function saveWindowState(file: string, windows: WindowRecord[]) {
  const value = stateSchema.parse({ version: 1, windows });
  const tmp = file + ".tmp";
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
export function clampBounds(
  bounds: WindowRecord["bounds"] | undefined,
  displays: Array<WindowRecord["bounds"]>,
) {
  const first = displays[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  const display = bounds
    ? (displays.find(
        (d) =>
          bounds.x < d.x + d.width &&
          bounds.y < d.y + d.height &&
          bounds.x + bounds.width > d.x &&
          bounds.y + bounds.height > d.y,
      ) ?? first)
    : first;
  const width = Math.min(bounds?.width ?? 1200, display.width),
    height = Math.min(bounds?.height ?? 850, display.height);
  return {
    width,
    height,
    x: Math.max(
      display.x,
      Math.min(bounds?.x ?? display.x, display.x + display.width - width),
    ),
    y: Math.max(
      display.y,
      Math.min(bounds?.y ?? display.y, display.y + display.height - height),
    ),
  };
}
