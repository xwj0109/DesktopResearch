import { z } from "zod";
const coordination = z
  .object({
    turn: z.number().int().positive(),
    pid: z.number().int().positive(),
    nonce: z.string().uuid(),
    complete: z.boolean(),
    recoveryRequired: z.boolean(),
  })
  .strict();
export const recoverySchema = z
  .object({
    expectedGeneration: z.number().int().nonnegative(),
    lease: z
      .object({
        nonce: z.string().uuid(),
        pid: z.number().int().positive(),
        generation: z.number().int().positive(),
        mode: z.enum(["desktop", "handoff"]),
      })
      .strict()
      .nullable(),
    coordination: coordination.nullable(),
    submissionId: z.string().uuid().nullable(),
    historyReviewed: z.literal(true),
    unmanagedWritersStopped: z.literal(true),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();
