import { useSyncExternalStore } from "react";

/** Small counts or marks on pane tabs ("Changes 5", "Documents new"), set by
 * whatever already knows them (e.g. the idea strip) and shown by StageLayout. */
const badges = new Map<string, string>();
const subs = new Set<() => void>();
export function setBadge(kind: string, text?: string) {
  if ((badges.get(kind) ?? undefined) === text) return;
  if (text) badges.set(kind, text);
  else badges.delete(kind);
  for (const s of subs) s();
}
export const useBadge = (kind: string) =>
  useSyncExternalStore(
    (cb) => (subs.add(cb), () => void subs.delete(cb)),
    () => badges.get(kind),
  );
