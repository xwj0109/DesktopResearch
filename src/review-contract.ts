import { z } from "zod";
import { tabs } from "./shared.ts";

export const reviewPrepareSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    annotationIds: z.array(z.uuid()).min(1).max(100),
    destination: z.enum(tabs),
    instruction: z.string().trim().min(1).max(40000),
    behavior: z.literal("followUp").default("followUp"),
  })
  .strict();
export const reviewReferenceSchema = z
  .object({
    reviewId: z.uuid(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const reviewDuplicateSchema = reviewReferenceSchema.extend({
  revision: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(40000),
});
export const reviewDeleteSchema = reviewReferenceSchema.extend({
  revision: z.number().int().nonnegative(),
});
export const reviewIdeaSchema = reviewReferenceSchema.extend({
  title: z.string().trim().min(1).max(500),
  response: z.string().trim().min(1).max(12000),
});
export const reviewMutationSchemas = {
  review_delete: reviewDeleteSchema,
  review_prepare: reviewPrepareSchema,
  review_duplicate: reviewDuplicateSchema,
  review_create_idea: reviewIdeaSchema,
} as const;
