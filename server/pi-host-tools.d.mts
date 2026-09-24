// Types for the Pi-host tool adapter (plain .mjs, loaded by the Pi host process).
import type { ToolManifest } from "./workbench/tools.ts";
export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
export function createWorkbenchTools(options: {
  specs: ToolManifest[] | undefined;
  instructions?: string;
  emit: (event: Record<string, unknown>) => void;
  calls: Map<string, PendingCall>;
  timeoutMs?: number;
}): any[];
export function resolveToolReply(calls: Map<string, PendingCall>, command: any): boolean;
