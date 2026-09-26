import { z } from "zod";

/** "Send to production" (docs/RESEARCH-FLOW.md): the moment an idea leaves
 * Research Development. It freezes the exact idea version, the idea
 * workspace's checkpoint (its code and findings) and the data snapshots the
 * work used. From then on Data, Design & Code, Backtests and Results work on
 * that committed idea. A later commit replaces it; earlier ones are kept. */
export const productionCommitSchema = z
  .object({
    idea: z.string().regex(/^r:[0-9a-f-]{36}$/),
    title: z.string().max(12000),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    checkpoint: z.string().regex(/^[0-9a-f]{40}$/),
    checkpointMessage: z.string().max(500),
    snapshots: z.array(z.object({ name: z.string().max(120), sha256: z.string().max(64) }).strict()).max(200),
    note: z.string().max(2000).optional(),
    committedAt: z.iso.datetime(),
    /** Release candidate number (also its git tag candidate/<n>); absent on commits made before numbering. */
    number: z.number().int().min(1).optional(),
    /** What validation runs: a research.toml entry or a command. */
    entry: z.string().max(1000).optional(),
  })
  .strict();
export type ProductionCommit = z.infer<typeof productionCommitSchema>;
export const productionSchema = z
  .object({ current: productionCommitSchema.nullable(), history: z.array(productionCommitSchema).max(50) })
  .strict();
export type Production = z.infer<typeof productionSchema>;
export const productionCommitInputSchema = z
  .object({
    idea: z.string().regex(/^r:[0-9a-f-]{36}$/).optional().describe("Pursued idea (r:<id>). Omit for the idea Research Development is working on."),
    snapshots: z.array(z.string().regex(/^[a-z0-9-]{1,120}$/)).max(200).optional().describe("Data snapshots the work used. Omit to take those the idea's workspace code references."),
    note: z.string().trim().max(2000).optional(),
    entry: z.string().trim().min(1).max(1000).optional().describe("What validating the candidate runs: a research.toml [run.<entry>] name or a command. Default: the entry named validate, else the only entry."),
  })
  .strict();
