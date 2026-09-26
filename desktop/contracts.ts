import { z } from "zod";
export const uuid =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const scopeSchema = z.union([
  z.object({ kind: z.literal("launcher") }).strict(),
  z
    .object({
      kind: z.enum(["strategy", "portfolio"]),
      id: z.string().regex(new RegExp(`^${uuid}$`)),
    })
    .strict(),
]);
export type Scope = z.infer<typeof scopeSchema>;
export const MAX_BODY = 20 * 1024 * 1024,
  MAX_RESPONSE = 32 * 1024 * 1024;
export const apiRequestSchema = z
  .object({
    path: z.string().min(1).max(2048),
    requestId: z.uuid().optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH"]),
    headers: z
      .object({
        "content-type": z
          .enum(["application/json", "application/octet-stream"])
          .optional(),
        "x-filename": z.string().max(2048).optional(),
        "x-revision": z
          .string()
          .regex(/^\d{1,12}$/)
          .optional(),
      })
      .strict(),
    body: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength <= MAX_BODY)
      .optional(),
  })
  .strict();
export type LabRequest = z.infer<typeof apiRequestSchema>;
export interface LabResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface DesktopContext {
  version: 1;
  scope: Scope;
  viewId: string;
  desktop: true;
}
export interface RequestRecord {
  id: string;
  path: string;
  hash: string;
  at: string;
  status: "pending" | "responded" | "uncertain";
}
export interface ViewFault {
  fault: "error" | "rejection";
  /** App asset the error came from (e.g. "xterm", "workbench"), never a message. */
  source: string;
}
export const viewFaultSchema = z
  .object({ fault: z.enum(["error", "rejection"]), source: z.string().regex(/^[a-z]{1,20}$/) })
  .strict();
export interface DesktopBridge {
  /** True when macOS window controls overlay the app header. */
  integratedTitlebar?: boolean;
  readRequests?(): Promise<RequestRecord[]>;
  exportFile?(value: { name: string; text: string }): Promise<void>;
  bootstrap(): Promise<DesktopContext>;
  lab(request: LabRequest): Promise<LabResponse>;
  openWorkspace(scope: Exclude<Scope, { kind: "launcher" }>): Promise<void>;
  focusLauncher(): Promise<void>;
  /** "failed" means the view is unusable (shows the error dialog). A fault is
   * a stray error after the view is working: recorded as a bounded code only. */
  reportViewStatus(status: "ready" | "failed" | ViewFault): Promise<void>;
  readView(): Promise<ViewState>;
  saveView(state: ViewState): Promise<void>;
  onCloseCancelled(handler: () => void): () => void;
  onPrepareClose(handler: () => Promise<void>): () => void;
  /** App-wide theme id (null until chosen); shared by every window. */
  readTheme?(): Promise<string | null>;
  saveTheme?(theme: string): Promise<void>;
  onThemeChanged?(handler: (theme: string) => void): () => void;
  /** Explicit user-initiated download of one arXiv ID/link or https PDF link,
   * performed in main; returns bytes for the ordinary artifact import. */
  fetchPaper?(source: string): Promise<FetchedPaperDTO>;
  /** arXiv title/author suggestions for typed words (main, rate-limited);
   * null when superseded by a newer query from this window. */
  searchPapers?(text: string): Promise<PaperHitDTO[] | null>;
  /** The real Pi CLI for a stage of this window (one PTY per stage). */
  terminalOpen?(stage: string, cols: number, rows: number): Promise<TerminalOpenDTO>;
  terminalRestart?(stage: string, cols: number, rows: number): Promise<TerminalOpenDTO>;
  terminalInput?(stage: string, data: string): void;
  terminalResize?(stage: string, cols: number, rows: number): void;
  onTerminal?(handler: (event: TerminalEventDTO) => void): () => void;
  /** Pi's session file for a stage, read incrementally (reading view). */
  terminalTranscript?(stage: string, since: number): Promise<TerminalTranscriptDTO>;
  /** Stop the pane's Pi and continue the same session in Terminal.app. */
  terminalHandoff?(stage: string): Promise<void>;
  /** Filesystem path of a dropped file (Electron webUtils). */
  pathForFile?(file: File): string;
}
export interface TerminalTranscriptDTO {
  text: string;
  offset: number;
  reset: boolean;
  file?: string;
  running: boolean;
}
export interface TerminalOpenDTO {
  label?: string;
  replay: string;
  exited: number | null;
  cwd: string;
  sessionId: string;
  reused: boolean;
}
export type TerminalEventDTO = { stage: string; type: "output"; data: string } | { stage: string; type: "exit"; code: number };
export interface PaperHitDTO {
  id: string;
  title: string;
  authors: string[];
  authorCount: number;
  year?: string;
  category?: string;
}
export interface FetchedPaperDTO {
  name: string;
  bytes: Uint8Array;
  source: string;
  title?: string;
  authors?: string[];
  published?: string;
  arxivId?: string;
}
export const channels = {
  exportFile: "pi-research:export-file",
  requests: "pi-research:requests",
  bootstrap: "pi-research:bootstrap",
  lab: "pi-research:lab",
  open: "pi-research:open",
  launcher: "pi-research:launcher",
  status: "pi-research:view-status",
  readView: "pi-research:read-view",
  saveView: "pi-research:save-view",
  prepare: "pi-research:prepare-close",
  prepared: "pi-research:prepared",
  cancelled: "pi-research:close-cancelled",
  readTheme: "pi-research:read-theme",
  saveTheme: "pi-research:save-theme",
  themeChanged: "pi-research:theme-changed",
  fullScreen: "pi-research:full-screen",
  fetchPaper: "pi-research:fetch-paper",
  searchPapers: "pi-research:search-papers",
  terminalOpen: "pi-research:terminal-open",
  terminalRestart: "pi-research:terminal-restart",
  terminalInput: "pi-research:terminal-input",
  terminalResize: "pi-research:terminal-resize",
  terminalEvent: "pi-research:terminal-event",
  terminalTranscript: "pi-research:terminal-transcript",
  terminalHandoff: "pi-research:terminal-handoff",
} as const;
export const bootSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("boot"),
    root: z.string().max(4096),
    assets: z.string().max(4096),
    executable: z.string().max(4096),
    handoffLauncher: z.string().max(4096),
  })
  .strict();
export const shutdownSchema = z
  .object({ version: z.literal(1), type: z.literal("shutdown") })
  .strict();
export const childSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("ready"),
      origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
      rootToken: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ version: z.literal(1), type: z.literal("closed") }).strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("fatal"),
      message: z.string().max(1000),
    })
    .strict(),
]);

export const stageIds = [
  "ideas",
  "literature",
  "research",
  "data",
  "code",
  "backtests",
  "results",
] as const;
export const viewStateSchema = z
  .object({
    version: z.literal(1),
    stage: z.enum(stageIds),
    tab: z.enum(["note", "code", "graph", "evidence"]),
    paneOpen: z.boolean(),
    railOpen: z.boolean(),
    paneWidth: z.number().int().min(240).max(650),
    /** Renderer palette id; unknown ids fall back to the default theme. */
    theme: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    /** Per-stage split ratios, active pane tabs, hidden/zoomed slots. */
    layouts: z
      .partialRecord(
        z.enum([...stageIds, "portfolio"]),
        z
          .object({
            split: z.number().min(0.15).max(0.85),
            stack: z.number().min(0.15).max(0.85),
            tabs: z.partialRecord(
              z.enum(["a", "b", "c"]),
              z.string().regex(/^[a-z-]{1,24}$/),
            ),
            hidden: z.array(z.enum(["a", "b", "c"])).max(3),
            zoom: z.enum(["a", "b", "c"]).nullable(),
            slots: z.partialRecord(
              z.enum(["a", "b", "c"]),
              z.array(z.string().regex(/^[a-z-]{1,24}$/)).min(1).max(12),
            ),
            outer: z.enum(["row", "column"]),
            inner: z.enum(["row", "column"]),
            /** A second pane of the same tile shown below its current tab. */
            below: z.partialRecord(z.enum(["a", "b", "c"]), z.string().regex(/^[a-z-]{1,24}$/)),
          })
          .partial()
          .strict(),
      )
      .optional(),
    /** Open, active and pinned source artifacts shared by every stage. */
    companion: z
      .object({
        open: z.array(z.string().regex(new RegExp(`^${uuid}$`))).max(12),
        pinned: z.array(z.string().regex(new RegExp(`^${uuid}$`))).max(12),
        active: z
          .string()
          .regex(new RegExp(`^${uuid}$`))
          .nullable(),
      })
      .strict()
      .optional(),
    researchDrafts: z
      .record(z.string().max(120), z.string().max(500000))
      .refine((v) => Object.keys(v).length <= 30)
      .optional(),
    drafts: z.partialRecord(
      z.enum([...stageIds, "portfolio"]),
      z.string().max(100000),
    ),
  })
  .strict();
export type ViewState = z.infer<typeof viewStateSchema>;
/** Make a window snapshot storable. Parts that fail the schema (a layout
 * entry, a draft slot, the open-papers list) are left out and reported, so
 * one bad entry can never block every later save. The live view keeps them;
 * they are persisted again once valid. Core fields must be valid. */
export function storableView(state: unknown): { value: ViewState; skipped: string[] } {
  const draft: any = structuredClone(state);
  const skipped: string[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = viewStateSchema.safeParse(draft);
    if (result.success) return { value: result.data, skipped };
    const [top, key] = result.error.issues[0].path;
    const container = typeof top === "string" ? draft?.[top] : undefined;
    if ((top === "layouts" || top === "researchDrafts" || top === "drafts") && key !== undefined && container && typeof container === "object") {
      delete container[key as string];
      skipped.push(`${top}.${String(key)}`);
    } else if (top === "researchDrafts" && key === undefined && container && typeof container === "object") {
      draft.researchDrafts = Object.fromEntries(Object.entries(container).slice(0, 30));
      skipped.push(top);
    } else if (top === "layouts" || top === "companion" || top === "theme" || top === "researchDrafts") {
      delete draft[top];
      skipped.push(top);
    } else throw result.error;
  }
  return { value: viewStateSchema.parse(draft), skipped };
}
export const emptyView = (): ViewState => ({
  version: 1,
  stage: "literature",
  tab: "note",
  paneOpen: true,
  railOpen: true,
  paneWidth: 440,
  drafts: {},
});
