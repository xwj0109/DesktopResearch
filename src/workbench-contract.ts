/** Presentation events a strategy window receives from agents (via the
 * backend's view channel). Research changes never travel this way. */
export type ViewEvent =
  | { seq: number; type: "open-source"; artifactId: string; page?: number }
  | { seq: number; type: "find"; artifactId: string; query: string; occurrence: number; page: number }
  | { seq: number; type: "close-source" | "pin-source" | "unpin-source"; artifactId: string }
  | { seq: number; type: "open-idea"; target: string }
  | { seq: number; type: "focus-idea"; target: string | null }
  | { seq: number; type: "develop-idea"; target: string | null }
  | { seq: number; type: "refresh" };
/** A pending jump in the PDF reader (page or find occurrence), keyed by id. */
export interface SourceNavigation { id: string; artifactId: string; page?: number; query?: string; occurrence?: number }
export const SOURCE_NAVIGATION = "sources:navigation";
/** Window draft holding Literature's focus idea ("r:<id>", or empty for all pursued). */
export const LITERATURE_FOCUS = "literature:focus";
/** Window draft holding the idea Research Development works on ("r:<id>"). */
export const RESEARCH_IDEA = "research:idea";
