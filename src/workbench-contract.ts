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
/** Window draft holding the idea the window works on ("r:<id>"). Literature's
 * focus and Research Development's idea are this one choice. */
export const CURRENT_IDEA = "idea:current";
/** Window draft: "1" while Literature shows all pursued ideas instead of the current one. */
export const LITERATURE_OVERVIEW = "literature:overview";
/** Older windows kept Literature's focus and Research Development's idea apart; still read as a fallback. */
export const LITERATURE_FOCUS = "literature:focus";
export const RESEARCH_IDEA = "research:idea";
/** The idea the window chose, if it is still pursued. */
export function chosenIdea<T extends { target: string }>(pursued: T[], drafts: Record<string, string>): T | undefined {
  for (const key of [CURRENT_IDEA, RESEARCH_IDEA, LITERATURE_FOCUS]) {
    const p = pursued.find((x) => x.target === drafts[key]);
    if (p) return p;
  }
  return undefined;
}
/** Literature's focus: the current idea, unless it shows all pursued ideas. */
export const literatureFocus = <T extends { target: string }>(pursued: T[], drafts: Record<string, string>) =>
  drafts[LITERATURE_OVERVIEW] === "1" ? undefined : chosenIdea(pursued, drafts);
/** The Pi conversation a stage shows (docs/WORKFLOW-REDESIGN-PLAN.md §7.2): one
 * per idea, `research:<id>`, shared by Develop (the current idea), Explore (the
 * focused idea) and Release (the release candidate's idea). Explore's
 * overview, Release without a candidate, Ideas and the legacy stages keep their
 * stage's own. Null: Develop with no pursued idea yet. */
export function conversationFor(
  stage: string,
  view: { pursued?: { target: string }[]; production?: { current?: { idea: string } | null } } | null | undefined,
  drafts: Record<string, string>,
): string | null {
  const pursued = view?.pursued ?? [];
  const idea = (t: string) => `research:${t.slice(2)}`;
  if (stage === "research") {
    const t = chosenIdea(pursued, drafts)?.target ?? pursued[0]?.target;
    return t ? idea(t) : null;
  }
  if (stage === "literature") {
    const f = literatureFocus(pursued, drafts);
    return f ? idea(f.target) : stage;
  }
  if (stage === "data" && view?.production?.current) return idea(view.production.current.idea);
  return stage;
}
/** Make an idea the window's current one (Literature then focuses it too). */
export function chooseIdea(setDraft: (key: string, value: string) => void, target: string) {
  setDraft(CURRENT_IDEA, target);
  setDraft(LITERATURE_OVERVIEW, "");
  setDraft(LITERATURE_FOCUS, "");
  setDraft(RESEARCH_IDEA, "");
}
