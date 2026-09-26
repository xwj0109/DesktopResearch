import { z } from "zod";

/** Risks: what could make an idea unusable in practice (data, timing, compute,
 * latency, cost), each with how well it is known. The AI drafts the first few
 * when an idea is framed; runs and notes are their evidence
 * (docs/WORKFLOW-REDESIGN-PLAN.md §6.2). Risks belong to the idea, not one
 * version, and are organisation: stored beside the idea, never inside it. */
export const riskKinds = ["data", "timing", "compute", "latency", "cost", "other"] as const;
export const riskStatuses = ["unknown", "estimated", "measured-ok", "failed", "waived"] as const;
export type RiskStatus = (typeof riskStatuses)[number];

export const riskEvidenceSchema = z
  .object({
    run: z.uuid().optional(),
    note: z.uuid().optional(),
    text: z.string().trim().max(2000).optional(),
  })
  .strict();
export const riskSchema = z
  .object({
    id: z.uuid(),
    text: z.string().trim().min(1).max(500),
    kind: z.enum(riskKinds),
    status: z.enum(riskStatuses),
    evidence: riskEvidenceSchema.optional(),
    /** A waiver's or a failure's reason, in words. */
    reason: z.string().trim().max(2000).optional(),
    by: z.enum(["user", "agent"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Risk = z.infer<typeof riskSchema>;
/** By saved idea id; at most 30 risks an idea, in the order they were added. */
export const risksSchema = z.record(z.uuid(), z.array(riskSchema).max(30));

const idea = z.string().regex(/^r:[0-9a-f-]{36}$/).optional().describe("Saved idea (r:<id>). Omit for the window's current idea.");
export const riskAddSchema = z
  .object({
    idea,
    text: z.string().trim().min(1).max(500).describe("One sentence: what could make the idea unusable, e.g. \"Funding is published 8 h late, after the decision time\"."),
    kind: z.enum(riskKinds),
    status: z.enum(riskStatuses).optional().describe("Default unknown. estimated: a reasoned guess; measured-ok / failed: tested, with evidence."),
    evidence: riskEvidenceSchema.optional(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
export const riskSetSchema = z
  .object({
    idea,
    risk: z.uuid(),
    text: z.string().trim().min(1).max(500).optional(),
    kind: z.enum(riskKinds).optional(),
    status: z.enum(riskStatuses).optional(),
    evidence: riskEvidenceSchema.nullable().optional().describe("A run (run id), a note (note id) or text; null clears it."),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
export const riskDeleteSchema = z.object({ idea, risk: z.uuid() }).strict();

/** Worst first: failed, unknown, estimated, waived, measured-ok. */
export const riskOrder: Record<RiskStatus, number> = { failed: 0, unknown: 1, estimated: 2, waived: 3, "measured-ok": 4 };
