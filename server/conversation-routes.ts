import { recoverySchema as recovery } from "../src/recovery-contract.ts";
import type { Express } from "express";
import { z } from "zod";
import { tabSchema } from "./store.ts";
import type { PiPool } from "./pi.ts";
import type { ConversationTab } from "../src/conversation.ts";

const text = z.string().max(131072);
const operation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), message: text.min(1) }).strict(),
  z
    .object({
      type: z.literal("command"),
      name: z.string().regex(/^[^\s/\u0000-\u001f]{1,128}$/u),
      args: text.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_model"),
      provider: z.string().min(1).max(200),
      modelId: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_thinking"),
      level: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ type: z.literal("editor_state"), text }).strict(),
  z
    .object({
      type: z.literal("ui_response"),
      requestId: z.string().uuid(),
      cancelled: z.boolean().optional(),
      value: z.union([text, z.boolean()]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal_input"),
      surfaceId: z.string().max(300),
      data: z.string().max(8192),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal_resize"),
      surfaceId: z.string().max(300),
      columns: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal_cancel"),
      surfaceId: z.string().max(300),
    })
    .strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("resync_ui") }).strict(),
  z.object({ type: z.literal("detach_view") }).strict(),
]);
const cursor = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
/** Mounted behind createApp's exact strategy/portfolio capability and same-origin guards. */
export function conversationRoutes(app: Express, pool: PiPool) {
  for (const scope of ["strategies", "portfolios"] as const) {
    const base = `/api/${scope}/:id/conversations/:tab`;
    const target = (
      params: Record<string, string | string[]>,
    ): [string, ConversationTab] =>
      scope === "strategies"
        ? [z.string().parse(params.id), tabSchema.parse(params.tab)]
        : ["portfolio:" + params.id, z.literal("Portfolio").parse(params.tab)];
    const snapshot = (req: any) =>
      pool.snapshot(
        ...target(req.params),
        cursor.parse(req.query.after ?? 0),
        cursor.optional().parse(req.query.generation),
      );
    app.get(base, async (req, res) => res.json(await snapshot(req)));
    app.get(base + "/events", async (req, res) =>
      res.json(await snapshot(req)),
    );
    app.get(base + "/history", (req, res) =>
      res.json(
        pool.history(
          ...target(req.params),
          cursor.parse(req.query.cursor ?? 0),
          z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(req.query.limit ?? 50),
          z.enum(["true", "false"]).parse(req.query.raw ?? "false") === "true",
        ),
      ),
    );
    app.get(base + "/commands", async (req, res) =>
      res.json(await pool.commandCatalog(...target(req.params))),
    );
    app.post(base + "/connect", async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.json(await pool.handshake(...target(req.params)));
    });
    app.post(base + "/operation", async (req, res) => {
      const body = z
        .object({ generation: z.number().int().positive(), operation })
        .strict()
        .parse(req.body);
      const dest = target(req.params),
        snapshot = await pool.snapshot(...dest);
      if (snapshot.generation !== body.generation) {
        res
          .status(409)
          .json({ error: "Stale runtime generation; refresh read-only state" });
        return;
      }
      res.json({
        result: await pool.operate(...dest, body.operation, body.generation),
      });
    });
    app.get(base + "/ownership", (req, res) =>
      res.json(pool.ownership(...target(req.params))),
    );
    app.post(base + "/reconcile", (req, res) =>
      res.json(pool.reconcile(...target(req.params), recovery.parse(req.body))),
    );
    app.post(base + "/stop", async (req, res) => {
      const body = z
        .object({ generation: z.number().int().nonnegative() })
        .strict()
        .parse(req.body);
      await pool.stopView(...target(req.params), body.generation);
      res.json({ stopped: true, generation: body.generation });
    });
    app.post(base + "/handoff", async (req, res) => {
      const body = z
        .object({ generation: z.number().int().nonnegative() })
        .strict()
        .parse(req.body);
      res.json(await pool.handoff(...target(req.params), body.generation));
    });
  }
}
