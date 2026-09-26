import { z } from "zod";

/** A run: the workspace code of one checkpoint, executed by the app, with what
 * actually ran recorded (commit, command, data, environment, hardware) and its
 * outputs and metrics collected. Runs are append-only records under
 * <strategy>/Runs/<id>/ (docs/WORKFLOW-REDESIGN-PLAN.md §6.2). */

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const runStatuses = ["queued", "preparing", "running", "succeeded", "failed", "cancelled", "lost"] as const;
export type RunStatus = (typeof runStatuses)[number];
export const finished = (s: RunStatus) => s === "succeeded" || s === "failed" || s === "cancelled" || s === "lost";

export const runSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    idea: z.string().regex(/^r:[0-9a-f-]{36}$/),
    title: z.string().max(300),
    /** The research.toml entry, when the run came from one. */
    entry: z.string().max(40).nullable(),
    command: z.string().min(1).max(1000),
    commit: sha,
    checkpointMessage: z.string().max(500),
    /** The app recorded a checkpoint for this run because the workspace had changes. */
    autoCheckpoint: z.boolean(),
    /** Release candidate number this run validates, if any. */
    candidate: z.number().int().min(1).nullable(),
    note: z.string().max(2000).optional(),
    origin: z.enum(["user", "agent"]),
    wallSeconds: z.number().int().min(10).max(86400),
    status: z.enum(runStatuses),
    /** Why it ended as it did, in words (exit code, time limit, interrupted). */
    reason: z.string().max(500).optional(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    exitCode: z.number().int().optional(),
    pid: z.number().int().optional(),
    environment: z
      .object({
        lock: z.object({ file: z.string().max(200), sha256: hash }).nullable(),
        /** Environment files present at the commit (pyproject.toml, requirements.txt, …). */
        files: z.array(z.string().max(200)).max(20),
        shell: z.string().max(200),
      })
      .strict(),
    hardware: z.object({ platform: z.string(), arch: z.string(), cpu: z.string(), cores: z.number().int(), memoryBytes: z.number() }).strict(),
    snapshots: z.array(z.object({ name: z.string().max(120), sha256: z.string().max(64) }).strict()).max(200),
    usage: z.object({ wallSeconds: z.number(), peakMemoryBytes: z.number().optional() }).strict().optional(),
    /** From outputs/metrics.json: flat names → numbers or short strings. */
    metrics: z.record(z.string().max(80), z.union([z.number(), z.string().max(200)])).optional(),
    outputs: z.array(z.object({ path: z.string().max(500), bytes: z.number(), sha256: hash }).strict()).max(2000).optional(),
    outputsTruncated: z.boolean().optional(),
  })
  .strict();
export type Run = z.infer<typeof runSchema>;

export const runSubmitSchema = z
  .object({
    idea: z.string().regex(/^r:[0-9a-f-]{36}$/).optional().describe("Saved idea (r:<id>) whose workspace to run. Omit for the idea Research Development is working on."),
    entry: z.string().max(40).optional().describe("A [run.<entry>] of the workspace's research.toml. Give entry or command."),
    command: z.string().trim().min(1).max(1000).optional().describe("A shell command run in the workspace checkout, e.g. \"uv run python train.py\". Give entry or command."),
    wallMinutes: z.number().int().min(1).max(1440).optional().describe("Time limit; the run is stopped when it is reached (default 60)."),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type RunSubmit = z.infer<typeof runSubmitSchema>;

/** How many runs and how much run time an agent may use in any hour without the user. */
export const runLimitSchema = z.object({ runs: z.number().int().min(0).max(100), minutes: z.number().int().min(0).max(1440) }).strict();
export type RunLimit = z.infer<typeof runLimitSchema>;
export const DEFAULT_RUN_LIMIT: RunLimit = { runs: 5, minutes: 60 };
