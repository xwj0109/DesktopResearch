export const tabs = [
  "Ideas",
  "Literature",
  "Research Development",
  "Data",
  "Design & Code",
  "Backtests",
  "Results",
] as const;
export type Tab = (typeof tabs)[number];
export const scopes: Record<Tab, string> = {
  Ideas: "Form and challenge ideas",
  Literature: "Discover, screen, annotate and curate",
  "Research Development":
    "Develop original hypotheses, mathematics and strategy definitions",
  Data: "Assess feasibility, acquire and validate",
  "Design & Code": "Plan and implement",
  Backtests: "Execute controlled experiments",
  Results: "Interpret and compare evidence",
};
export interface Anchor {
  page: number;
  quote: string;
  rect?: [number, number, number, number];
  rotation: 0;
}
export interface Annotation {
  id: string;
  artifactId: string;
  hash: string;
  anchor: Anchor;
  comment: string;
  author: string;
  created: string;
  updated: string;
  status: "draft" | "submitted" | "addressed" | "dismissed";
  version: number;
}
export interface Artifact {
  id: string;
  name: string;
  hash: string;
  bytes: number;
  kind: "pdf" | "text" | "image" | "unsupported";
  mime: string;
  created: string;
}
export interface TabState {
  sessionId: string;
  open: string[];
  selected: string;
  page: number;
  zoom: number;
  pinned: boolean;
  draft: string;
  notes: string;
  commentDraft: string;
  commentAnchor: Anchor | null;
  editingAnnotationId: string | null;
  width: number;
  provider: string;
  model: string;
}
export type Delivery =
  | "draft"
  | "pending"
  | "accepted/queued"
  | "working"
  | "completed"
  | "failed"
  | "delivery-uncertain";
export interface Batch {
  id: string;
  created: string;
  destination: Tab;
  sessionId: string;
  instruction: string;
  behavior: "followUp" | "steer";
  model: { provider: string; id: string };
  annotations: Annotation[];
  documents: Artifact[];
  prompt: string;
  hash: string;
  status: Delivery;
  detail: string;
  response: string;
  requestId?: string;
  attempts: number;
}
export interface Activity {
  id: string;
  at: string;
  text: string;
}
export interface PublicationUncertainty {
  committed: true;
  durability: "uncertain";
  warning: string;
  retry: "do-not-replay";
}
export interface Strategy {
  runtimeError?: string;
  warning?: string;
  persistence?: PublicationUncertainty;
  id: string;
  name: string;
  lifecycle: "active" | "parked";
  revision: number;
  created: string;
  tabs: Record<Tab, TabState>;
  artifacts: Artifact[];
  annotations: Annotation[];
  batches: Batch[];
  events: Activity[];
  /** Recently deleted sources (newest first, at most 20), restorable with identity. */
  deleted?: DeletedSource[];
  /** Idea drafts, pending edits of saved ideas and archived ideas. */
  ideas?: import("./idea-board-contract").IdeaBoardState;
  /** Importance by source id (unrated sources are absent). */
  importance?: Record<string, import("./source-importance-contract").Importance>;
  /** Per-idea ranks by saved idea id, then source id (Literature's focus idea). */
  ideaImportance?: Record<string, Record<string, import("./source-importance-contract").Section>>;
  /** Notes linked to ideas, by note id then saved idea id. */
  noteLinks?: Record<string, Record<string, import("./note-link-contract").NoteLink>>;
  /** The idea sent to production (and earlier commits). */
  production?: import("./production-contract").Production;
  /** How much an agent may run without the user (runs and run minutes per hour). */
  runLimit?: import("./run-contract").RunLimit;
  /** Risks per saved idea (docs/WORKFLOW-REDESIGN-PLAN.md §6.2). */
  risks?: Record<string, import("./risk-contract").Risk[]>;
}
export interface DeletedSource {
  artifact: Artifact;
  annotations: Annotation[];
  at: string;
}
export const limits = {
  upload: 20 * 1024 * 1024,
  text: 1024 * 1024,
  prompt: 128 * 1024,
  event: 1024 * 1024,
  state: 8 * 1024 * 1024,
};
