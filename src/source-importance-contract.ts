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
export const sourceImportanceSchema = z
  .object({
    artifactId: z.uuid(),
    importance: z.enum(sections).describe('"other" is the default section for sources not marked primary or secondary.'),
  })
  .strict();
