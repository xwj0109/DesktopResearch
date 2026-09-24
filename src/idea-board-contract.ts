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
