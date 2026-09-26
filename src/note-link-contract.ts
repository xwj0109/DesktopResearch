import { z } from "zod";

/** Notes linked to ideas, with a stance (docs/RESEARCH-FLOW.md, step 3).
 *
 * Links sit beside the notes, never inside them: a note cited by a scientific
 * record stays unchanged, and linking is organisation. A link belongs to the
 * idea (not one version) and records the version it was judged against, so
 * later stages can see "noted on v1, idea now v3". Stance is optional: a note
 * can be linked first and judged later. */
export const stances = ["supports", "contradicts", "refines"] as const;
export type Stance = (typeof stances)[number];
export const noteLinkSchema = z
  .object({
    stance: z.enum(stances).nullable(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    at: z.iso.datetime(),
  })
  .strict();
export type NoteLink = z.infer<typeof noteLinkSchema>;
/** By note id, then saved idea id. */
export const noteLinksSchema = z.record(z.uuid(), z.record(z.uuid(), noteLinkSchema));
export const noteLinkInputSchema = z
  .object({
    noteId: z.uuid(),
    idea: z
      .string()
      .regex(/^r:[0-9a-f-]{36}$/)
      .optional()
      .describe("Saved idea (r:<id>). Omit to use the Literature focus idea."),
    stance: z
      .enum([...stances, "unclassified", "none"])
      .describe('"unclassified" links without a stance yet; "none" removes the link.'),
  })
  .strict();

/** Add a note to an idea as evidence, as an unsaved revision (step 5). */
export const ideaAddNoteSchema = z
  .object({
    noteId: z.uuid(),
    idea: z
      .string()
      .regex(/^(d|r):[0-9a-f-]{36}$/)
      .optional()
      .describe("Idea to revise (r:<id> saved, d:<id> draft). Omit to use the Literature focus."),
    show: z.boolean().optional().describe("Open the idea in the Idea pane (default true)."),
  })
  .strict();
