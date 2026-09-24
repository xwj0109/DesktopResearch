import { z } from "zod";
export const uuid = z.uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().trim().min(1).max(12000);
export const refSchema = z.object({ id: uuid, hash: sha }).strict();
export type Ref = z.infer<typeof refSchema>;
export const evidenceSchema = z
  .object({
    category: z.enum(["cited", "derived", "assumed", "conjectured", "tested"]),
    reference: refSchema,
    description: text,
  })
  .strict();
export const conventionsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    frequency: z.literal("daily"),
    annualisation: z.number().int().min(1).max(366),
    timezone: z.literal("UTC"),
    calendar: z.string().min(1).max(100),
    returnBasis: z.literal("simple-net"),
    capital: z.literal("unit-equity"),
    rebalance: z.literal("prior-close-fixed-weight"),
    costs: z.literal("turnover-linear"),
  })
  .strict();
const evidence = z.array(evidenceSchema).max(50);
export const ideaSchema = z
  .object({
    title: text,
    rationale: text,
    universe: text,
    horizon: text,
    falsification: text,
    uncertainty: z.enum([
      "assumed",
      "conjectured",
      "derived",
      "cited",
      "tested",
    ]),
    evidence,
  })
  .strict();
export const bibliographySchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            artifact: refSchema,
            citation: text,
            identifiers: z.array(z.string().max(300)).max(10),
            sourceVersion: text,
            provenance: text,
            authenticity: z.enum(["unverified", "human-checked"]),
            verificationEvidence: z.string().max(4000),
            decision: z.enum(["include", "exclude", "undecided"]),
            reason: text,
            tags: z.array(z.string().max(80)).max(20),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const searchBriefSchema = z
  .object({
    goal: text,
    methods: text,
    universe: text,
    inclusion: text,
    exclusion: text,
    sources: text,
    budget: text,
    stopping: text,
    acquisition: z.literal("manual"),
  })
  .strict();
export const specSchema = z
  .object({
    question: text,
    sources: evidence,
    assumptions: z.array(text).max(50),
    falsification: text,
    baseline: text,
    universe: text,
    timing: z.literal("prior-close-only"),
    dataRequirements: text,
    signalRules: text,
    riskRules: text,
    costs: text,
    partitions: text,
    validation: text,
    acceptance: text,
    engine: z.literal("reference-close-v1"),
    supportedRules: z
      .array(z.enum(["buy-hold", "exogenous", "moving-average"]))
      .min(1)
      .max(3),
    unsupportedRequirements: z.array(text).max(20),
  })
  .strict();
export const contractSchema = z
  .object({
    spec: refSchema,
    provider: text,
    license: text,
    provenance: text,
    universe: text,
    units: z.literal("positive-close-price"),
    columns: z.enum(["date,close", "date,close,signal"]),
    frequency: z.literal("daily"),
    timezone: z.literal("UTC"),
    calendar: text,
    availability: z.literal("at-close"),
    missingness: z.literal("reject-no-fill"),
    start: z.iso.date(),
    end: z.iso.date(),
    conventions: conventionsSchema,
  })
  .strict()
  .refine((x) => x.start <= x.end, "Range reversed");
export const graphSchema = z
  .object({
    spec: refSchema,
    nodes: z
      .array(
        z
          .object({
            id: uuid,
            label: text,
            stage: z.enum([
              "data",
              "feature",
              "signal",
              "risk",
              "execution",
              "evaluation",
            ]),
            inputs: z.array(z.string().max(100)).max(20),
            outputs: z.array(z.string().max(100)).max(20),
            assumptions: z.array(text).max(20),
            code: z
              .array(
                z
                  .object({ version: refSchema, symbol: z.string().max(200) })
                  .strict(),
              )
              .max(20),
            evidence,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    edges: z
      .array(
        z.object({ from: uuid, to: uuid, label: z.string().max(200) }).strict(),
      )
      .max(300),
  })
  .strict();
export const codeSchema = z
  .object({
    filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/),
    language: z.enum(["typescript", "javascript", "text"]),
    source: z.string().max(128000),
    symbols: z.array(z.string().min(1).max(200)).max(100),
    evidence,
  })
  .strict();
export const conclusionSchema = z
  .object({
    title: text,
    interpretation: text,
    supporting: z.array(refSchema).max(30),
    contradicting: z.array(refSchema).max(30),
    limitations: z.array(text).min(1).max(30),
    scientificStatus: z.enum(["unreviewed", "human-interpreted"]),
  })
  .strict();
export const versionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idea"), content: ideaSchema }).strict(),
  z
    .object({ kind: z.literal("bibliography"), content: bibliographySchema })
    .strict(),
  z
    .object({ kind: z.literal("search-brief"), content: searchBriefSchema })
    .strict(),
  z.object({ kind: z.literal("spec"), content: specSchema }).strict(),
  z.object({ kind: z.literal("contract"), content: contractSchema }).strict(),
  z.object({ kind: z.literal("graph"), content: graphSchema }).strict(),
  z.object({ kind: z.literal("code"), content: codeSchema }).strict(),
  z
    .object({ kind: z.literal("conclusion"), content: conclusionSchema })
    .strict(),
]);
export type VersionInput = z.infer<typeof versionInput>;
export const runConfigSchema = z
  .object({
    spec: refSchema,
    contract: refSchema,
    dataset: refSchema,
    graph: refSchema,
    rule: z.enum(["buy-hold", "exogenous", "moving-average"]),
    window: z.number().int().min(2).max(252),
    feeBps: z.number().min(0).max(1000),
    slippageBps: z.number().min(0).max(1000),
    partition: z.enum(["training", "validation", "holdout"]),
    start: z.iso.date(),
    end: z.iso.date(),
    seed: z.literal(0),
  })
  .strict()
  .refine((x) => x.start < x.end, "Run needs at least two dates");
export type RunConfig = z.infer<typeof runConfigSchema>;
export const strategyCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("version.create"),
      id: uuid.optional(),
      value: versionInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.record"),
      target: refSchema,
      decision: z.enum(["approve", "reject"]),
      reason: text,
    })
    .strict(),
  z
    .object({
      type: z.literal("idea.decide"),
      target: refSchema,
      decision: z.enum(["pursue", "revise", "reject"]),
      reason: text,
    })
    .strict(),
  // Permanent removal of an uncited idea: all versions and the decisions on them.
  z.object({ type: z.literal("idea.delete"), id: uuid }).strict(),
  z
    .object({
      type: z.literal("handoff.create"),
      spec: refSchema,
      contract: refSchema,
      note: text,
    })
    .strict(),
  z
    .object({
      type: z.literal("feasibility.record"),
      handoff: uuid,
      feasible: z.boolean(),
      findings: z.array(text).min(1).max(30),
    })
    .strict(),
  z
    .object({
      type: z.literal("dataset.ingest"),
      contract: refSchema,
      handoff: uuid,
      csv: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024),
    })
    .strict(),
  z.object({ type: z.literal("run.queue"), config: runConfigSchema }).strict(),
  z.object({ type: z.literal("run.cancel"), runId: uuid }).strict(),
  z
    .object({ type: z.literal("run.expose"), runId: uuid, reason: text })
    .strict(),
  z
    .object({
      type: z.literal("export.create"),
      runId: uuid,
      limitations: z.array(text).min(1).max(30),
    })
    .strict(),
  z
    .object({
      type: z.literal("proposal.review"),
      proposal: z.unknown(),
      decision: z.enum(["accept-for-review", "reject"]),
      reason: text,
    })
    .strict(),
]);
export type StrategyCommand = z.infer<typeof strategyCommandSchema>;
export const envelopeSchema = z
  .object({
    operationId: uuid,
    revision: z.number().int().min(0),
    command: strategyCommandSchema,
  })
  .strict();
export type StrategyEnvelope = z.infer<typeof envelopeSchema>;
export interface Version extends Ref {
  kind: VersionInput["kind"];
  version: number;
  created: string;
  blob: string;
  sourcePresent: boolean;
  checksExecuted: false;
  checksPassedAtVersion: null;
  scientificValidation: "not-established";
}
export interface Approval {
  id: string;
  target: Ref;
  decision: "approve" | "reject";
  reason: string;
  at: string;
}
export interface Dataset extends Ref {
  contract: Ref;
  handoff: string;
  sourceHash: string;
  rowsHash: string | null;
  parser: "strict-close-csv-v1";
  status: "accepted" | "rejected";
  findings: string[];
  warnings: string[];
  count: number;
  sample: Row[];
}
export interface Row {
  date: string;
  close: number;
  signal?: number;
}
export interface Metrics {
  samples: number;
  totalReturn: number;
  annualizedVolatility: number | null;
  maxDrawdown: number;
  mean: number;
}
export interface Point {
  date: string;
  periodStart: string;
  return: number;
  equity: number;
  drawdown: number;
  position: number;
  turnover: number;
  cost: number;
}
export interface RunOutput {
  points: Point[];
  metrics: Metrics;
  conventions: z.infer<typeof conventionsSchema>;
  limitations: string[];
}
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface Run extends Ref {
  inputHash: string;
  status: RunStatus;
  history: { status: RunStatus; at: string; detail: string }[];
  outputHash: string | null;
  exposures: { kind: "application-disclosure"; at: string; reason: string }[];
}
export interface StrategyScience {
  version: 2;
  id: string;
  versions: Version[];
  approvals: Approval[];
  decisions: {
    id: string;
    target: Ref;
    decision: "pursue" | "revise" | "reject";
    reason: string;
    at: string;
  }[];
  handoffs: {
    id: string;
    spec: Ref;
    contract: Ref;
    approvalId: string;
    contractApprovalId: string;
    at: string;
    note: string;
  }[];
  feasibility: {
    id: string;
    handoff: string;
    feasible: boolean;
    findings: string[];
    at: string;
  }[];
  datasets: Dataset[];
  runs: Run[];
  exports: { id: string; hash: string; runId: string }[];
  proposalReviews: {
    id: string;
    proposalHash: string;
    decision: string;
    reason: string;
    at: string;
  }[];
}
export interface CommandReceipt {
  operationId: string;
  committedRevision: number;
  created: {collection: string; id: string; hash?: string}[];
}
export interface ScientificView<T> {
  revision: number;
  state: T;
  warning: string | null;
  receipt?: CommandReceipt;
}
export const exportBodySchema = z
  .object({
    schema: z.literal("herdr-portfolio-export-v1"),
    strategyId: uuid,
    runId: uuid,
    inputHash: sha,
    outputHash: sha,
    spec: refSchema,
    dataset: refSchema,
    graph: refSchema,
    engine: z
      .object({
        id: z.literal("reference-close-v1"),
        sourceHash: sha,
        version: z.literal(1),
      })
      .strict(),
    config: runConfigSchema,
    conventions: conventionsSchema,
    points: z
      .array(
        z
          .object({
            date: z.iso.date(),
            periodStart: z.iso.date(),
            return: z.number().finite().gt(-1),
            position: z.number().min(-1).max(1),
            turnover: z.number().min(0).max(2),
            cost: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    costs: z
      .object({
        feeBps: z.number().min(0).max(1000),
        slippageBps: z.number().min(0).max(1000),
        leverage: z.literal(1),
      })
      .strict(),
    trialContext: z
      .object({
        attempts: z.number().int().positive(),
        partition: z.enum(["training", "validation", "holdout"]),
        exposed: z.boolean(),
        exposurePolicy: z.literal(
          "application-recorded-disclosure-not-a-secrecy-proof",
        ),
        trials: z
          .array(
            z
              .object({
                id: uuid,
                inputHash: sha,
                status: z.enum([
                  "queued",
                  "running",
                  "completed",
                  "failed",
                  "cancelled",
                  "interrupted",
                ]),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    limitations: z.array(text).min(1).max(50),
  })
  .strict();
export const exportSchema = z
  .object({ body: exportBodySchema, hash: sha })
  .strict();
export type ExportPackage = z.infer<typeof exportSchema>;
export const allocationSchema = z
  .object({
    method: z.enum(["equal", "inverse-volatility", "manual"]),
    cap: z.number().positive().max(1),
    weights: z.array(z.number().min(0).max(1)).max(20).optional(),
  })
  .strict();
export type Allocation = z.infer<typeof allocationSchema>;
export interface Analysis {
  id: string;
  hash: string;
  blob: string;
  imports: Ref[];
}
export interface PortfolioState {
  version: 2;
  id: string;
  name: string;
  imports: {
    id: string;
    hash: string;
    strategyId: string;
    runId: string;
    at: string;
    authenticity: "unverified-external-package";
  }[];
  analyses: Analysis[];
  proposals: {
    id: string;
    hash: string;
    targetStrategyId: string;
    blob: string;
  }[];
}
export const proposalSchema = z
  .object({
    schema: z.literal("herdr-proposal-v1"),
    portfolioId: uuid,
    targetStrategyId: uuid,
    imports: z.array(refSchema).min(1).max(20),
    analysis: refSchema,
    request: text,
    limitations: z.literal(
      "Request only; cannot approve, edit or execute strategy work",
    ),
  })
  .strict();
export const proposalPackageSchema = z
  .object({ body: proposalSchema, hash: sha })
  .strict();
export const portfolioCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("import.add"), package: exportSchema }).strict(),
  z
    .object({
      type: z.literal("analysis.create"),
      imports: z.array(refSchema).min(1).max(20),
      allocation: allocationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("proposal.create"),
      analysis: refSchema,
      targetStrategyId: uuid,
      request: text,
    })
    .strict(),
]);
export type PortfolioCommand = z.infer<typeof portfolioCommandSchema>;
export const portfolioEnvelopeSchema = z
  .object({
    operationId: uuid,
    revision: z.number().int().min(0),
    command: portfolioCommandSchema,
  })
  .strict();
export type PortfolioEnvelope = z.infer<typeof portfolioEnvelopeSchema>;
export const capsuleRequestSchema = z
  .object({
    role: z.enum([
      "ideas",
      "literature",
      "research",
      "data",
      "design",
      "backtests",
      "results",
      "portfolio",
    ]),
    task: text,
    selected: z.array(refSchema).max(20),
    unresolved: z.array(z.string().max(1000)).max(20),
    budget: z.number().int().min(512).max(16384),
  })
  .strict();
export type CapsuleRequest = z.infer<typeof capsuleRequestSchema>;
export interface Capsule {
  schema: "herdr-context-v1";
  text: string;
  hash: string;
  bytes: number;
  status: "prepared-not-submitted";
}
export interface AlignmentAnalysis {
  schema: "herdr-analysis-v1";
  imports: Ref[];
  dates: string[];
  alignment: {
    id: string;
    original: number;
    retained: number;
    dropped: number;
  }[];
  weights: number[];
  allocation: Allocation;
  individual: Metrics[];
  correlations: {
    a: number;
    b: number;
    n: number;
    value: number | null;
    reason: string | null;
  }[];
  points: Point[];
  metrics: Metrics;
  convention: "fixed-weight-rebalanced-diagnostic-blend";
  limitations: string[];
}
