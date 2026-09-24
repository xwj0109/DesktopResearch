import { z } from "zod";
import {
  uuid,
  sha,
  refSchema,
  runConfigSchema,
  conventionsSchema,
  type StrategyScience,
  type PortfolioState,
} from "../src/platform.ts";
const at = z.iso.datetime(),
  short = z.string().max(12000),
  refs = z.array(refSchema).max(100);
const status = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const rowSchema = z
  .object({
    date: z.iso.date(),
    close: z.number().finite().positive(),
    signal: z.number().min(-1).max(1).optional(),
  })
  .strict();
export const rowsSchema = z.array(rowSchema).min(2).max(10000);
export const metricsSchema = z
  .object({
    samples: z.number().int().positive(),
    totalReturn: z.number().finite().gt(-1),
    annualizedVolatility: z.number().finite().min(0).nullable(),
    maxDrawdown: z.number().min(0).max(1),
    mean: z.number().finite(),
  })
  .strict();
export const pointSchema = z
  .object({
    date: z.iso.date(),
    periodStart: z.iso.date(),
    return: z.number().finite().gt(-1),
    equity: z.number().finite().positive(),
    drawdown: z.number().min(0).max(1),
    position: z.number().min(-1).max(1),
    turnover: z.number().min(0).max(2),
    cost: z.number().min(0).max(1),
  })
  .strict();
export const outputSchema = z
  .object({
    points: z.array(pointSchema).min(1).max(10000),
    metrics: metricsSchema,
    conventions: conventionsSchema,
    limitations: z.array(short).max(50),
  })
  .strict();
export const runInputSchema = z
  .object({
    schema: z.literal("herdr-run-input-v1"),
    config: runConfigSchema,
    rowsHash: sha,
    sourceHash: sha,
    engine: z
      .object({
        id: z.literal("reference-close-v1"),
        sourceHash: sha,
        version: z.literal(1),
      })
      .strict(),
    environment: z
      .object({
        node: z.string().max(100),
        platform: z.string().max(100),
        arch: z.string().max(100),
      })
      .strict(),
    approvals: z.array(uuid).max(10),
    authoredCode: z.array(refSchema).max(100),
    authoredCodeExecuted: z.literal(false),
    conventions: conventionsSchema,
    limitations: z.array(short).max(50),
  })
  .strict();
export const scienceSchema: z.ZodType<StrategyScience> = z
  .object({
    version: z.literal(2),
    id: uuid,
    versions: z
      .array(
        z
          .object({
            id: uuid,
            hash: sha,
            kind: z.enum([
              "idea",
              "bibliography",
              "search-brief",
              "spec",
              "contract",
              "graph",
              "code",
              "conclusion",
            ]),
            version: z.number().int().positive(),
            created: at,
            blob: sha,
            sourcePresent: z.boolean(),
            checksExecuted: z.literal(false),
            checksPassedAtVersion: z.null(),
            scientificValidation: z.literal("not-established"),
          })
          .strict(),
      )
      .max(500),
    approvals: z
      .array(
        z
          .object({
            id: uuid,
            target: refSchema,
            decision: z.enum(["approve", "reject"]),
            reason: short,
            at,
          })
          .strict(),
      )
      .max(1000),
    decisions: z
      .array(
        z
          .object({
            id: uuid,
            target: refSchema,
            decision: z.enum(["pursue", "revise", "reject"]),
            reason: short,
            at,
          })
          .strict(),
      )
      .max(1000),
    handoffs: z
      .array(
        z
          .object({
            id: uuid,
            spec: refSchema,
            contract: refSchema,
            approvalId: uuid,
            contractApprovalId: uuid,
            at,
            note: short,
          })
          .strict(),
      )
      .max(500),
    feasibility: z
      .array(
        z
          .object({
            id: uuid,
            handoff: uuid,
            feasible: z.boolean(),
            findings: z.array(short).max(30),
            at,
          })
          .strict(),
      )
      .max(500),
    datasets: z
      .array(
        z
          .object({
            id: uuid,
            hash: sha,
            contract: refSchema,
            handoff: uuid,
            sourceHash: sha,
            rowsHash: sha.nullable(),
            parser: z.literal("strict-close-csv-v1"),
            status: z.enum(["accepted", "rejected"]),
            findings: z.array(short).max(100),
            warnings: z.array(short).max(30),
            count: z.number().int().min(0).max(10000),
            sample: z.array(rowSchema).max(10),
          })
          .strict(),
      )
      .max(500),
    runs: z
      .array(
        z
          .object({
            id: uuid,
            hash: sha,
            inputHash: sha,
            status,
            history: z
              .array(z.object({ status, at, detail: short }).strict())
              .min(1)
              .max(10),
            outputHash: sha.nullable(),
            exposures: z
              .array(
                z
                  .object({
                    kind: z.literal("application-disclosure"),
                    at,
                    reason: short,
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .max(500),
    exports: z
      .array(z.object({ id: uuid, hash: sha, runId: uuid }).strict())
      .max(500),
    proposalReviews: z
      .array(
        z
          .object({
            id: uuid,
            proposalHash: sha,
            decision: z.enum(["accept-for-review", "reject"]),
            reason: short,
            at,
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const portfolioSchema: z.ZodType<PortfolioState> = z
  .object({
    version: z.literal(2),
    id: uuid,
    name: z.string().trim().min(1).max(120),
    imports: z
      .array(
        z
          .object({
            id: uuid,
            hash: sha,
            strategyId: uuid,
            runId: uuid,
            at,
            authenticity: z.literal("unverified-external-package"),
          })
          .strict(),
      )
      .max(200),
    analyses: z
      .array(
        z.object({ id: uuid, hash: sha, blob: sha, imports: refs }).strict(),
      )
      .max(500),
    proposals: z
      .array(
        z
          .object({ id: uuid, hash: sha, targetStrategyId: uuid, blob: sha })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const analysisSchema = z
  .object({
    schema: z.literal("herdr-analysis-v1"),
    imports: refs,
    dates: z.array(z.iso.date()).max(10000),
    alignment: z
      .array(
        z
          .object({
            id: uuid,
            original: z.number().int(),
            retained: z.number().int(),
            dropped: z.number().int(),
          })
          .strict(),
      )
      .max(20),
    weights: z.array(z.number().min(0).max(1)).max(20),
    allocation: z
      .object({
        method: z.enum(["equal", "inverse-volatility", "manual"]),
        cap: z.number().positive().max(1),
        weights: z.array(z.number()).optional(),
      })
      .strict(),
    individual: z.array(metricsSchema).max(20),
    correlations: z
      .array(
        z
          .object({
            a: z.number().int(),
            b: z.number().int(),
            n: z.number().int(),
            value: z.number().min(-1).max(1).nullable(),
            reason: short.nullable(),
          })
          .strict(),
      )
      .max(210),
    points: z.array(pointSchema).max(10000),
    metrics: metricsSchema,
    convention: z.literal("fixed-weight-rebalanced-diagnostic-blend"),
    limitations: z.array(short).max(50),
  })
  .strict();
