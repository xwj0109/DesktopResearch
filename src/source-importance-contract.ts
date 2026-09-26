import { z } from "zod";

/** How much a source matters to the strategy. The library groups it into
 * Primary, Secondary and Other sources, in that order; new sources start in
 * Other. Stored beside the immutable artifacts (never inside them), so moving
 * a paper changes no fingerprint or frozen history. */
export const importanceLevels = ["primary", "secondary"] as const;
export type Importance = (typeof importanceLevels)[number];
export type Section = Importance | "other";
export const sections: Section[] = [...importanceLevels, "other"];
export const importanceLabels: Record<Section, string> = {
  primary: "Primary",
  secondary: "Secondary",
  other: "Other",
};
export const importanceMapSchema = z.record(z.uuid(), z.enum(importanceLevels));
/** Ranks for one idea, by source id. "other" is stored explicitly because a
 * source the idea cites counts as primary for it until ranked otherwise. */
export const ideaImportanceSchema = z.record(z.uuid(), z.record(z.uuid(), z.enum(sections)));
export const sourceImportanceSchema = z
  .object({
    artifactId: z.uuid(),
    importance: z.enum(sections).describe('"other" is the default section for sources not marked primary or secondary.'),
    idea: z
      .string()
      .regex(/^r:[0-9a-f-]{36}$/)
      .optional()
      .describe("A saved idea (r:<id>) to rank the source for, as Literature does per idea. Omit for the library-wide sections."),
  })
  .strict();
/** Ranks one idea gives the library: explicit ranks over "cited = primary". */
export function ideaRanks(explicit: Record<string, Section> | undefined, cited: Iterable<string>): Record<string, Section> {
  const out: Record<string, Section> = {};
  for (const id of cited) out[id] = "primary";
  return { ...out, ...(explicit ?? {}) };
}
