/** Linked installed-Pi host wire contract. No SDK code is bundled into the client. */
export const PI_PROTOCOL_VERSION = 1 as const;
export const piLimits = {
  text: 131072,
  frame: 786432,
  replayBytes: 2097152,
  replayEvents: 512,
  historyPage: 100,
  terminalInput: 8192,
} as const;
export type PiOperation =
  | { type: "queue"; message: string; behavior: "steer" | "followUp"; images?: { mimeType: string; data: string }[] }
  | { type: "retrieve_queue" }
  | { type: "shortcut"; key: string }
  | { type: "cycle_model"; direction: "forward" | "backward" }
  | { type: "prompt"; message: string }
  | { type: "command"; name: string; args?: string }
  | { type: "set_model"; provider: string; modelId: string }
  | {
      type: "set_thinking";
      /** Validated against the current installed SDK/model's available levels. */
      level: string;
    }
  | { type: "editor_state"; text: string }
  | {
      type: "ui_response";
      requestId: string;
      cancelled?: boolean;
      value?: string | boolean;
    }
  | { type: "terminal_input"; surfaceId: string; data: string }
  | {
      type: "terminal_resize";
      surfaceId: string;
      columns: number;
      rows: number;
    }
  | { type: "terminal_cancel"; surfaceId: string }
  | { type: "resync_ui" }
  | { type: "detach_view" }
  | { type: "cancel" }
  | { type: "reload" };
export interface PiEvent {
  version: 1;
  generation: number;
  seq: number;
  type: string;
  [key: string]: unknown;
}
export type PiUIEvent =
  | { type: "ui_request"; request: PiDialog }
  | { type: "ui_closed"; requestId: string }
  | { type: "ui_state"; key: string; value?: unknown }
  | {
      type: "notification";
      message: string;
      notifyType: "info" | "warning" | "error";
    }
  | {
      type: "terminal_open";
      surfaceId: string;
      kind:
        | "custom"
        | "header"
        | "footer"
        | "widget"
        | "editor"
        | "tool"
        | "message"
        | "entry";
      columns: number;
      rows: number;
    }
  | { type: "terminal_frame"; surfaceId: string; data: string }
  | { type: "terminal_closed"; surfaceId: string }
  | { type: "editor_submit"; text: string; requiresExplicitSend: true };
export type PiStreamEvent =
  | { type: "agent_start" | "agent_settled" }
  | { type: "message_start" | "message_end"; message: unknown }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent: {
        type: string;
        delta?: string;
        [key: string]: unknown;
      };
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: "entry_appended"; entry: unknown };
export type PiKnownEvent = (
  | PiUIEvent
  | PiStreamEvent
  | {
      type: "diagnostic";
      severity: "info" | "warning" | "error";
      code: string;
      message: string;
    }
  | {
      type: "projection_truncated";
      originalType: string;
      resyncRequired: true;
      message: string;
    }
  | { type: "command_end"; name: string; isStreaming: boolean; error?: string }
  | {
      type: "prompt_end";
      requestId: string;
      isStreaming: boolean;
      error?: string;
    }
  | {
      type: "runtime_closed";
      message: string;
      submissionMayBeUncertain: boolean;
    }
) & { version: 1; generation: number; seq: number };
/** Backend-to-host only. Never expose these internal requests as a renderer RPC tunnel. */
export type PiHostCommand = (
  | PiOperation
  | { type: "get_state" | "get_ui" | "get_commands" | "get_available_models" }
  | { type: "complete"; text: string }
  | { type: "bind_session"; requestId: string; error?: string }
) & { version: 1; id: string };
export type PiSurfaceDescriptor = Omit<
  Extract<PiUIEvent, { type: "terminal_open" }>,
  "type"
>;
export interface PiUIState {
  editor: string;
  state: Record<string, unknown>;
  pending: PiDialog[];
  surfaces: PiSurfaceDescriptor[];
  viewDetached: boolean;
}
export interface PiDialog {
  secret?: boolean;
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}
export interface PiSubmission {
  id: string;
  kind: "prompt" | "command";
  status: "pending" | "accepted" | "settled" | "failed" | "uncertain";
  at: string;
  detail?: string;
  /** Explicit acknowledgement does not change the uncertain outcome into success. */
  acknowledgedAt?: string;
}
export interface PiCoordinationState {
  turn: number;
  pid: number;
  nonce: string;
  complete: boolean;
  recoveryRequired: boolean;
}
export interface PiLeaseIdentity {
  nonce: string;
  pid: number;
  generation: number;
  mode: "desktop" | "handoff";
}
export interface PiRecoveryRequest {
  expectedGeneration: number;
  lease: PiLeaseIdentity | null;
  coordination: PiCoordinationState | null;
  submissionId: string | null;
  historyReviewed: true;
  unmanagedWritersStopped: true;
  note: string;
}
export interface PiBinding {
  version: 1;
  workspace: string;
  tab: string;
  logicalSessionId: string;
  generation: number;
  canonical?: { id: string; path: string; cwd?: string };
  lastSubmission?: PiSubmission;
  recovery?: { at: string; auditFile: string };
  updatedAt: string;
}
export interface PiRuntimeState {
  extensionShortcuts?: string[];
  doubleEscapeAction?: "tree" | "fork" | "none";
  keybindings?: Record<string, string | string[]>;
  queue?: { steering: string[]; followUp: string[] };
  sessionStats?: unknown;
  context?: string | null;
  editorCheckpoint?: {
    revision: number;
    inputId: string | null;
    inputStatus: "idle" | "pending" | "acknowledged";
  };
  ready: boolean;
  isStreaming: boolean;
  model?: { id: string; provider: string; name?: string };
  thinkingLevel?: string;
  availableThinkingLevels: string[];
  sessionId?: string;
  sessionFile?: string;
  pendingUI: boolean;
}
export interface PiSnapshot {
  ui?: PiUIState;
  runtimeState?: PiRuntimeState;
  version: 1;
  /** Null only for a newly created portfolio before explicit conversation initialization. */
  logicalSessionId: string | null;
  binding?: PiBinding;
  connected: boolean;
  generation: number;
  through: number;
  events: PiEvent[];
  /** Retention/projection loss occurred; a caught-up cursor need not resync again. */
  truncated: boolean;
  /** Canonical history is authoritative; GET history is bounded, explicit and never starts Pi. */
  resyncRequired: boolean;
}
export interface PiRuntimeIdentity {
  executable: string;
  packageRoot: string;
  version: string;
  node: string;
  agentDir: string;
  sdk: string;
  tui: string;
}
