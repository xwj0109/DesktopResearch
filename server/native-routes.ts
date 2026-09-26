import { reviewMutationSchemas } from "../src/review-contract.ts";
import { ideaBoardOpSchema } from "../src/idea-board-contract.ts";
import type { Workbench } from "./workbench/tools.ts";
import { recoverySchema as recovery } from "../src/recovery-contract.ts";
import type { Express } from "express";
import { z } from "zod";
import {
  nativeActionSchema,
  completionQuerySchema,
  conversationStages,
} from "../src/native-contract.ts";
import type { ConversationTab } from "../src/conversation.ts";
import type { PiPool } from "./pi.ts";
import type { Store } from "./store.ts";
import type { Platform } from "./platform.ts";
import { NativeIntents } from "./native-intents.ts";
import { Fault } from "./durable.ts";
export const viewContextSchema = z
  .object({
    activeArtifact: z.uuid().nullable().optional(),
    page: z.number().int().min(1).max(100000).optional(),
    openArtifacts: z.array(z.uuid()).max(12).optional(),
    ideaTarget: z.string().regex(/^(d|r):[0-9a-f-]{36}$/).nullable().optional(),
    focusIdea: z.string().regex(/^r:[0-9a-f-]{36}$/).nullable().optional(),
    developIdea: z.string().regex(/^r:[0-9a-f-]{36}$/).nullable().optional(),
    /** The stage the window shows (ideas, literature, research, data, …). */
    stage: z.string().regex(/^[a-z]{1,12}$/).nullable().optional(),
  })
  .strict();
const names: Record<string, ConversationTab> = {
  ideas: "Ideas",
  literature: "Literature",
  research: "Research Development",
  data: "Data",
  code: "Design & Code",
  backtests: "Backtests",
  results: "Results",
  portfolio: "Portfolio",
};
export function nativeRoutes(
  app: Express,
  store: Store,
  pool: PiPool,
  platform: Platform,
  workbench: Workbench,
) {
  const ledger = new NativeIntents(store.safe("native-intents"));
  for (const kind of ["strategies", "portfolios"] as const) {
    const base = `/api/${kind}/:id/native`,
      portfolio = kind === "portfolios";
    const target = (req: any): [string, ConversationTab] => {
      const id = z.uuid().parse(req.params.id),
        stage = z.enum(conversationStages).parse(req.params.stage);
      if (portfolio !== (stage === "portfolio"))
        throw new Fault(403, "Conversation outside scope");
      return [portfolio ? "portfolio:" + id : id, names[stage]];
    };
    app.get(base + "/research", (req, res) => {
      const id = String(req.params.id);
      if (portfolio) return res.json({ science: platform.portfolioView(id) });
      const { revision, artifacts, annotations, batches, deleted = [], importance = {}, noteLinks = {}, production } = store.get(id);
      res.json({
        revision,
        artifacts,
        importance,
        annotations,
        batches,
        deleted: deleted.map((d) => ({ artifact: d.artifact, annotations: d.annotations.length, at: d.at })),
        ideas: store.ideaBoard(id),
        // What Literature focuses on: the same list agents get, without full content.
        pursued: workbench.pursuedIdeas(id).map(({ content: _, ...i }) => i),
        noteLinks,
        production: production ?? { current: null, history: [] },
        // Titles for links to ideas that are not pursued (any saved idea).
        ideaTitles: Object.fromEntries(workbench.ideas(id).filter((i) => i.target.startsWith("r:")).map((i) => [i.target.slice(2), i.content.title])),
        science: platform.strategyView(id),
      });
    });
    if (!portfolio) {
      for (const name of Object.keys(reviewMutationSchemas)) {
        app.post(base + "/reviews/" + name, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), name, req.body));
        });
      }

      // Runs and the release candidate (reads are GETs: presentation, never journaled).
      app.get(base + "/runs", async (req, res) => {
        const { idea } = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/) }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "runs_list", { idea }));
      });
      app.get(base + "/runs/status", async (req, res) => {
        const { run } = z.object({ run: z.uuid() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "run_status", { run }));
      });
      app.get(base + "/runs/log", async (req, res) => {
        const { run, offset } = z.object({ run: z.uuid(), offset: z.coerce.number().int().min(0).optional() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "run_logs", { run, ...(offset !== undefined ? { offset } : {}) }));
      });
      app.get(base + "/runs/compare", async (req, res) => {
        const { a, b } = z.object({ a: z.uuid(), b: z.uuid() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "run_compare", { a, b }));
      });
      app.get(base + "/runs/output", async (req, res) => {
        const { run, path } = z.object({ run: z.uuid(), path: z.string().min(1).max(500) }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "run_output", { run, path }));
      });
      app.get(base + "/idea-context", async (req, res) => {
        const { idea } = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/) }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "idea_context", { idea }));
      });
      app.get(base + "/risks", async (req, res) => {
        const { idea } = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/) }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "risk_list", { idea }));
      });
      for (const [route, tool] of [["risks/add", "risk_add"], ["risks/set", "risk_set"], ["risks/delete", "risk_delete"]] as const)
        app.post(base + "/" + route, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), tool, req.body));
        });
      app.get(base + "/candidate", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "candidate_status", {}));
      });
      for (const [route, tool] of [["runs/submit", "run_submit"], ["runs/cancel", "run_cancel"], ["runs/limit", "run_limit_set"], ["candidate/validate", "candidate_validate"]] as const)
        app.post(base + "/" + route, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), tool, req.body));
        });
      // Save, decide and delete ideas: the registry operations agents use, with the same checks.
      for (const [route, tool] of [["idea-save", "idea_save"], ["idea-decide", "idea_decide"], ["idea-delete", "idea_delete"]] as const)
        app.post(base + "/" + route, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), tool, req.body));
        });
      // Idea board edits from the window (agents use the same Workbench).
      app.post(base + "/ideas", (req, res) => {
        const sid = z.uuid().parse(req.params.id);
        res.json({ ideas: workbench.applyBoard(sid, ideaBoardOpSchema.parse(req.body)) });
      });
      // Research Development workspaces (reads are GETs: presentation, never journaled).
      const rdQuery = (req: any) => z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/), path: z.string().max(500).optional(), sha: z.string().optional() }).strict().parse(req.query);
      app.get(base + "/rd/diff", async (req, res) => {
        const q = rdQuery(req);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_diff", { idea: q.idea, path: q.path, ...(q.sha ? { sha: q.sha } : {}) }));
      });
      app.get(base + "/rd/files", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_files", { idea: rdQuery(req).idea }));
      });
      app.get(base + "/rd/file", async (req, res) => {
        const q = rdQuery(req);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_read", { idea: q.idea, path: q.path }));
      });
      app.get(base + "/rd/changes", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_changes", { idea: rdQuery(req).idea }));
      });
      app.get(base + "/rd/history", async (req, res) => {
        const q = rdQuery(req);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_history", { idea: q.idea, ...(q.sha ? { sha: q.sha } : {}) }));
      });
      app.post(base + "/rd/checkpoint", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "rd_checkpoint", req.body));
      });
      // Data snapshots (reads are unjournaled GETs; fetch/cancel/register are actions).
      app.get(base + "/data/snapshots", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "data_snapshots", {}));
      });
      app.get(base + "/data/jobs", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "data_jobs", {}));
      });
      app.get(base + "/data/symbols", async (req, res) => {
        const q = z.object({ source: z.string(), q: z.string(), market: z.string().optional(), dataset: z.string().optional() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "data_symbols", { source: q.source, query: q.q, ...(q.market ? { market: q.market } : {}), ...(q.dataset ? { dataset: q.dataset } : {}) }));
      });
      app.get(base + "/data/estimate", async (req, res) => {
        const q = z.object({ market: z.string(), dataset: z.string(), symbol: z.string(), interval: z.string().optional(), start: z.string(), end: z.string() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "data_estimate", q));
      });
      app.get(base + "/data/preview", async (req, res) => {
        const { name } = z.object({ name: z.string() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "data_preview", { name }));
      });
      for (const [route, tool] of [["fetch", "data_fetch"], ["cancel", "data_cancel"], ["register", "data_register"], ["delete", "data_delete"]] as const)
        app.post(base + "/data/" + route, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), tool, req.body));
        });
      // The desktop's Pi pane: create (once) and locate an idea's workspace to run Pi in.
      app.post(base + "/rd/workspace", async (req, res) => {
        const { idea } = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/) }).strict().parse(req.body);
        const sid = z.uuid().parse(req.params.id);
        const { dir } = await workbench.rdWorkspace(sid, idea);
        const i = workbench.ideas(sid).find((x) => x.target === idea);
        res.json({ cwd: dir, title: i?.content.title ?? "" });
      });
      // Production feeds (reads are unjournaled GETs; changes go through the registry).
      app.get(base + "/feeds", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "feeds_list", {}));
      });
      app.get(base + "/feeds/rows", async (req, res) => {
        const { id } = z.object({ id: z.string() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "feed_rows", { id }));
      });
      app.get(base + "/feeds/partitions", async (req, res) => {
        const { id, limit } = z.object({ id: z.string(), limit: z.coerce.number().int().optional() }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "feed_partitions", { id, ...(limit !== undefined ? { limit } : {}) }));
      });
      for (const [route, tool] of [["create", "feed_create"], ["update", "feed_update"], ["delete", "feed_delete"], ["service", "feeds_service_set"]] as const)
        app.post(base + "/feeds/" + route, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), tool, req.body));
        });
      // Send an idea to production (agents use production_commit too).
      app.get(base + "/production/preview", async (req, res) => {
        const { idea } = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/) }).strict().parse(req.query);
        res.json(await workbench.call(z.uuid().parse(req.params.id), "production_preview", { idea }));
      });
      app.post(base + "/production/commit", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "production_commit", req.body));
      });
      // Revise an idea from a note (agents use idea_add_note too).
      app.post(base + "/idea-note", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "idea_add_note", req.body));
      });
      // Note ↔ idea links from the window (agents use note_link too).
      app.post(base + "/note-links", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "note_link", req.body));
      });
      // Library importance from the window (agents use source_importance too).
      app.post(base + "/source-importance", async (req, res) => {
        res.json(await workbench.call(z.uuid().parse(req.params.id), "source_importance", req.body));
      });
      // Presentation events for this strategy's window (long-poll).
      app.get(base + "/view-events", async (req, res) => {
        const sid = z.uuid().parse(req.params.id);
        store.get(sid);
        res.json(await workbench.view.next(sid, z.coerce.number().int().min(-1).parse(req.query.after ?? -1)));
      });
      // What the window shows. A GET because it is ephemeral presentation
      // state: never durable, never journaled as a research request.
      app.get(base + "/view-context", (req, res) => {
        const sid = z.uuid().parse(req.params.id);
        store.get(sid);
        const q = z.object({ active: z.string(), page: z.string(), idea: z.string(), open: z.string(), focus: z.string().optional(), develop: z.string().optional(), stage: z.string().optional() }).strict().parse(req.query);
        workbench.view.setContext(
          sid,
          viewContextSchema.parse({
            activeArtifact: q.active || null,
            page: Number(q.page) || undefined,
            ideaTarget: q.idea || null,
            focusIdea: q.focus || null,
            developIdea: q.develop || null,
            stage: q.stage || null,
            openArtifacts: q.open ? q.open.split(",") : [],
          }),
        );
        res.json({ ok: true });
      });
    }
    const conv = base + "/conversations/:stage";
    app.get(conv, async (req, res) => {
      const dest = target(req),
        snapshot = await pool.snapshot(
          ...dest,
          z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(req.query.after ?? 0),
          z.coerce
            .number()
            .int()
            .nonnegative()
            .optional()
            .parse(req.query.generation),
        );
      const { binding, runtimeState, ...state } = snapshot;
      const { sessionFile: _file, ...runtime } = runtimeState ?? {};
      const [models, commands] = snapshot.connected
        ? await Promise.all([
            pool.nativeModels(...dest),
            pool.commandCatalog(...dest),
          ])
        : [[], []];
      res.json({
        ...state,
        runtimeState: runtimeState ? runtime : undefined,
        context: runtimeState?.context ?? null,
        lastSubmission: binding?.lastSubmission
          ? {
              id: binding.lastSubmission.id,
              status: binding.lastSubmission.status,
            }
          : undefined,
        models,
        commands: commands.map((c: any) => ({
          name: c.name,
          description: c.description,
        })),
      });
    });
    app.get(conv + "/complete", async (req, res) => {
      const query = completionQuerySchema.parse(req.query);
      res.json(await pool.complete(...target(req), query.text, query.generation));
    });
    app.get(conv + "/history", async (req, res) =>
      res.json(
        await pool.nativeHistory(
          ...target(req),
          z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(req.query.cursor ?? 0),
          z.string().max(128).optional().parse(req.query.context),
        ),
      ),
    );
    app.get(conv + "/recovery", (req, res) => {
      const state = pool.ownership(...target(req));
      res.json({
        expectedGeneration: state.binding?.generation ?? 0,
        lease: state.lease
          ? {
              nonce: state.lease.nonce,
              pid: state.lease.pid,
              generation: state.lease.generation,
              mode: state.lease.mode,
            }
          : null,
        coordination: state.coordination,
        submissionId: state.binding?.lastSubmission?.id ?? null,
        recoveryRequired: state.recoveryRequired,
      });
    });
    app.post(conv + "/recovery", (req, res) => {
      pool.reconcile(...target(req), recovery.parse(req.body));
      res.json({ reconciled: true });
    });
    app.post(conv + "/actions", async (req, res) => {
      const dest = target(req),
        action = nativeActionSchema.parse(req.body),
        scope = dest.join(":");
      res.json(
        await ledger.run(scope, action.intent.id, action, async () => {
          const snap = await pool.snapshot(...dest);
          const liveInput = ["queue", "retrieve_queue", "cancel"].includes(action.operation.type);
          const sameSession = action.intent.sessionId && action.intent.sessionId === snap.runtimeState?.sessionId;
          if (
            snap.generation !== action.intent.generation ||
            (liveInput && sameSession ? false : (snap.runtimeState?.context ?? null) !== action.intent.context)
          )
            throw new Fault(
              409,
              "Conversation changed; refresh before another action",
            );
          if (action.operation.type === "connect") {
            await pool.handshake(...dest);
            return;
          }
          if (action.operation.type === "stop") {
            await pool.stopView(...dest, action.intent.generation);
            return;
          }
          const result = await pool.operate(
            ...dest,
            action.operation,
            action.intent.generation,
            action.intent,
          );
          return ["retrieve_queue", "cancel"].includes(action.operation.type) ? result : undefined;
        }),
      );
    });
    app.get(conv + "/receipts/:intentId", (req, res) =>
      res.json({
        receipt: ledger.read(
          target(req).join(":"),
          z.uuid().parse(req.params.intentId),
        ),
      }),
    );
    app.post(conv + "/receipts/:intentId/seal", (req, res) => {
      z.object({}).strict().parse(req.body);
      res.json({
        receipt: ledger.seal(
          target(req).join(":"),
          z.uuid().parse(req.params.intentId),
        ),
      });
    });
  }
}
