import { z } from "zod";

/** Idea drafts live in the strategy store (not the window), so any agent or
 * window edits the same board. Drafts may be incomplete; saving a version
 * still validates against the strict ideaSchema. */
const level = z.enum(["assumed", "conjectured", "derived", "cited", "tested"]);
const field = z.string().max(12000);
export const ideaDraftContentSchema = z
  .object({
    title: field,
    rationale: field,
    universe: field,
    horizon: field,
    falsification: field,
    uncertainty: level,
    evidence: z
      .array(
        z
          .object({
            category: level,
            reference: z.object({ id: z.string().max(100), hash: z.string().max(64) }).strict(),
            description: field,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type IdeaDraftContent = z.infer<typeof ideaDraftContentSchema>;
export const ideaDraftPatchSchema = ideaDraftContentSchema.partial();
export const ideaDraftCardSchema = z
  .object({ key: z.uuid(), content: ideaDraftContentSchema, updated: z.iso.datetime() })
  .strict();
export const ideaBoardSchema = z
  .object({
    cards: z.array(ideaDraftCardSchema).max(100),
    /** Pending next-version edits of saved ideas, by record id. */
    edits: z.record(z.uuid(), ideaDraftContentSchema),
    /** Saved ideas hidden from the board (never deleted by archiving). */
    archived: z.array(z.uuid()).max(500),
  })
  .strict();
export type IdeaBoardState = z.infer<typeof ideaBoardSchema>;
export const emptyIdeaBoard = (): IdeaBoardState => ({ cards: [], edits: {}, archived: [] });
/** "d:<draft key>" or "r:<saved record id>". */
export const ideaTargetSchema = z.string().regex(/^(d|r):[0-9a-f-]{36}$/);
const targetField = ideaTargetSchema
  .optional()
  .describe('Idea target from ideas_list, "d:<id>" for a draft or "r:<id>" for a saved idea. Omit to use the idea open in the window.');
/** Save, decide and delete: the same operations for the Idea pane and agents. */
export const ideaSaveInputSchema = z.object({ target: targetField }).strict();
export const ideaDecideInputSchema = z
  .object({
    target: targetField,
    decision: z.enum(["pursue", "revise", "reject"]),
    reason: z.string().trim().min(1).max(12000),
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe("Hash of the version you inspected (idea_get); refused if the idea has a newer version since."),
  })
  .strict();
export const ideaDeleteInputSchema = z.object({ target: z.string().regex(/^r:[0-9a-f-]{36}$/).describe("An archived saved idea (r:<id>).") }).strict();
export const ideaBoardOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), key: z.uuid(), content: ideaDraftContentSchema }).strict(),
  z.object({ op: z.literal("patch"), target: ideaTargetSchema, patch: ideaDraftPatchSchema }).strict(),
  z.object({ op: z.literal("delete"), key: z.uuid() }).strict(),
  z.object({ op: z.literal("restore"), card: ideaDraftCardSchema, index: z.number().int().min(0).max(100) }).strict(),
  z.object({ op: z.literal("discard"), recordId: z.uuid() }).strict(),
  z.object({ op: z.literal("archive"), recordId: z.uuid() }).strict(),
  z.object({ op: z.literal("unarchive"), recordId: z.uuid() }).strict(),
  /** One-time adoption of a board that older builds kept in window drafts. */
  z.object({ op: z.literal("adopt"), board: ideaBoardSchema }).strict(),
]);
export type IdeaBoardOp = z.infer<typeof ideaBoardOpSchema>;

export type IdeaDecisionKind = "pursue" | "revise" | "reject";
interface VersionRef { id: string; hash: string; version: number }
interface DecisionRef { target: { id: string; hash: string }; decision: string; reason: string; at: string }
/** An idea's status from its saved versions and recorded decisions (one rule
 * for the backend, every agent and the Idea pane).
 *
 * Pursue belongs to the idea: revising a pursued idea keeps it pursued, so
 * iterating between Ideas, Literature and Research Development never drops it.
 * Revise and reject are answered by a new version, which returns the idea to
 * "to decide". The idea's most recent decision counts. */
export function ideaStatus(latest: VersionRef, versions: readonly VersionRef[], decisions: readonly DecisionRef[]) {
  const d = decisions
    .filter((x) => x.target.id === latest.id)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1);
  if (!d) return { status: "to-decide" as const, decision: null };
  const onVersion = versions.find((v) => v.id === latest.id && v.hash === d.target.hash)?.version ?? null;
  const current = d.target.hash === latest.hash;
  const decision = { decision: d.decision as IdeaDecisionKind, reason: d.reason, at: d.at, onVersion, carried: !current };
  if (current || d.decision === "pursue") return { status: d.decision as IdeaDecisionKind, decision };
  return { status: "to-decide" as const, decision };
}
