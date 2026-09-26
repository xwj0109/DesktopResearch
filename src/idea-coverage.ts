import type { Section } from "./source-importance-contract";
import type { NoteLink, Stance } from "./note-link-contract";

/** How well the literature covers one pursued idea (docs/RESEARCH-FLOW.md,
 * step 4). Computed once, in the backend, from the idea's paper ranks and the
 * notes linked to it; the window and every agent read the same result. */
export interface IdeaCoverage {
  papers: { primary: number; secondary: number; withNotes: number };
  notes: Record<Stance | "unclassified", number> & { total: number };
  /** Linked notes judged on an earlier version of the idea. */
  stale: number;
  gaps: CoverageGap[];
  /** The most useful next step, phrased as an action (from the first gap). */
  next: string | null;
}
export type CoverageGapCode = "no-papers" | "no-evidence" | "no-contradicting" | "unjudged" | "stale" | "unread-primary";
export interface CoverageGap {
  code: CoverageGapCode;
  text: string;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function ideaCoverage(
  ranks: Record<string, Section>,
  /** Notes linked to this idea, on live sources. */
  linked: { artifactId: string; link: NoteLink }[],
  currentVersion: number,
): IdeaCoverage {
  const ranked = (r: Section) => Object.keys(ranks).filter((id) => ranks[id] === r);
  const primary = ranked("primary"),
    secondary = ranked("secondary");
  const withNotes = new Set(linked.map((l) => l.artifactId));
  const count = (s: Stance | null) => linked.filter((l) => l.link.stance === s).length;
  const notes = { supports: count("supports"), contradicts: count("contradicts"), refines: count("refines"), unclassified: count(null), total: linked.length };
  const stale = linked.filter((l) => l.link.version < currentVersion).length;
  const unreadPrimary = primary.filter((id) => !withNotes.has(id)).length;

  const gaps: CoverageGap[] = [];
  if (!primary.length && !secondary.length) gaps.push({ code: "no-papers", text: "No primary or secondary papers yet" });
  if (!notes.total) gaps.push({ code: "no-evidence", text: "No evidence noted yet" });
  else if (notes.supports && !notes.contradicts) gaps.push({ code: "no-contradicting", text: "Supporting evidence only: nothing contradicts it yet" });
  if (notes.unclassified) gaps.push({ code: "unjudged", text: `${plural(notes.unclassified, "note")} without a stance` });
  if (stale) gaps.push({ code: "stale", text: `${plural(stale, "note")} judged on an earlier version` });
  if (unreadPrimary) gaps.push({ code: "unread-primary", text: `${plural(unreadPrimary, "primary paper")} without notes` });

  // One suggestion, most fundamental first: papers, then evidence, then balance, then upkeep.
  const order: CoverageGapCode[] = ["no-papers", "no-evidence", "no-contradicting", "unread-primary", "unjudged", "stale"];
  const first = order.find((c) => gaps.some((g) => g.code === c));
  const next =
    first === "no-papers"
      ? "Find papers for this idea"
      : first === "no-evidence"
        ? primary.length
          ? `Read and note evidence in the ${plural(primary.length, "primary paper")}`
          : "Read the papers and note evidence"
        : first === "no-contradicting"
          ? "Look for evidence that could contradict it"
          : first === "unread-primary"
            ? `Note evidence in ${plural(unreadPrimary, "unread primary paper")}`
            : first === "unjudged"
              ? `Give ${plural(notes.unclassified, "note")} a stance`
              : first === "stale"
                ? `Re-judge ${plural(stale, "note")} against the current version`
                : null;

  return { papers: { primary: primary.length, secondary: secondary.length, withNotes: withNotes.size }, notes, stale, gaps, next };
}
