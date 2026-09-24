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
      const { revision, artifacts, annotations, batches, deleted = [], importance = {} } = store.get(id);
      res.json({
        revision,
        artifacts,
        importance,
        annotations,
        batches,
        deleted: deleted.map((d) => ({ artifact: d.artifact, annotations: d.annotations.length, at: d.at })),
        ideas: store.ideaBoard(id),
        science: platform.strategyView(id),
      });
    });
    if (!portfolio) {
      for (const name of Object.keys(reviewMutationSchemas)) {
        app.post(base + "/reviews/" + name, async (req, res) => {
          res.json(await workbench.call(z.uuid().parse(req.params.id), name, req.body));
        });
      }

      // Idea board edits from the window (agents use the same Workbench).
      app.post(base + "/ideas", (req, res) => {
        const sid = z.uuid().parse(req.params.id);
        res.json({ ideas: workbench.applyBoard(sid, ideaBoardOpSchema.parse(req.body)) });
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
        const q = z.object({ active: z.string(), page: z.string(), idea: z.string(), open: z.string() }).strict().parse(req.query);
        workbench.view.setContext(
          sid,
          viewContextSchema.parse({
            activeArtifact: q.active || null,
            page: Number(q.page) || undefined,
            ideaTarget: q.idea || null,
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
