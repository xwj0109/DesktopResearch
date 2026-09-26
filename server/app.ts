import express from "express";
import { fileURLToPath } from "node:url";
import { nativeRoutes } from "./native-routes.ts";
import path from "node:path";
import fs from "node:fs";
import { z, ZodError } from "zod";
import { Store, Fault, tabSchema, tabStateSchema } from "./store.ts";
import { PiPool } from "./pi.ts";
import { Platform } from "./platform.ts";
import { PortfolioConversations } from "./portfolio-conversation.ts";
import { platformRoutes } from "./platform-routes.ts";
import { limits } from "../src/shared.ts";
import { productLocations } from "./locations.ts";
import { uncertainPublication } from "./durable.ts";
import { Workbench, isStage } from "./workbench/tools.ts";
import { McpAccess, mcpHandle } from "./workbench/mcp.ts";
import { conversationRoutes } from "./conversation-routes.ts";
export function createApp(
  store: Store,
  pool: PiPool,
  origin: string,
  dist = productLocations().dist,
  platform = new Platform(store),
  workbench = new Workbench(store, platform),
) {
  const app = express();
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (req.headers.host !== new URL(origin).host)
      return res.status(403).json({ error: "Invalid Host" });
    if (req.headers.origin && req.headers.origin !== origin)
      return res.status(403).json({ error: "Origin denied" });
    if (
      req.path.startsWith("/api") &&
      req.method !== "GET" &&
      req.headers.origin !== origin
    )
      return res.status(403).json({ error: "Same-origin request required" });
    next();
  });
  app.use("/api", (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const match = req.path.match(/^\/strategies\/([^/]+)/);
      const portfolio = req.path.match(/^\/portfolios\/([^/]+)/);
      if (portfolio)
        platform.authPortfolio(token, decodeURIComponent(portfolio[1]));
      else store.auth(token, match ? decodeURIComponent(match[1]) : undefined);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", (req, res, next) => {
    // Cover every companion mutation response, including errors after a
    // publication. Do not mutate the canonical Strategy to attach API metadata.
    const receipt: { persistence?: ReturnType<typeof uncertainPublication> } =
      {};
    const json = res.json.bind(res);
    res.json = (body) => {
      if (req.method !== "GET" && receipt.persistence) {
        const { warning } = receipt.persistence;
        res.set("X-Herdr-Durability", "uncertain");
        return json({
          ...body,
          warning,
          runtimeError: body?.runtimeError ?? warning,
          persistence: receipt.persistence,
        });
      }
      return json(body);
    };
    // Async-local provenance prevents an unrelated background Pi save from
    // falsely labelling a concurrent, rejected HTTP mutation as committed.
    store.storage.observePublication(receipt, next);
  });
  app.use(express.json({ limit: "5mb" }));
  const conversations = new PortfolioConversations(store, platform);
  pool.attachPortfolios(conversations);
  platformRoutes(app, platform, pool, conversations);
  conversationRoutes(app, pool);
  pool.attachWorkbench(workbench);
  nativeRoutes(app, store, pool, platform, workbench);
  // External agents (MCP). Off until the user enables it for a strategy.
  const mcp = new McpAccess(store, origin);
  workbench.assertStrategyDeletable = sid => pool.assertStrategyDeletable(sid);
  workbench.strategyDeleted = sid => { try { mcp.disable(sid); } catch { /* Catalog revocation is authoritative; stale access files cannot reopen a deleted strategy. */ } };
  for (const action of ["rename", "delete"] as const) {
    // Root/launcher capability: this path deliberately is not a strategy proxy.
    app.post(`/api/strategy-management/:sid/${action}`, async (req, res) => {
      try { res.json(await workbench.call(z.uuid().parse(req.params.sid), `strategy_${action}`, req.body)); }
      catch (error) {
        if (error instanceof Fault) throw error;
        throw new Fault(409, "Strategy operation refused", { code: "strategy-busy" });
      }
    });
  }

  // Same relative location in development (server/) and the bundled app (backend/).
  const bridge = fileURLToPath(new URL("../scripts/pi-research-mcp.mjs", import.meta.url));
  // The desktop's conversation pane: tools for the Pi CLI it starts (capability-authenticated).
  app.post("/api/strategies/:id/native/agent-tools", (req, res) => {
    const sid = z.uuid().parse(req.params.id);
    res.json({ url: `${origin}/mcp/${sid}`, token: mcp.session(sid) });
  });
  app.get("/api/strategies/:id/native/mcp-access", (req, res) => {
    const sid = z.uuid().parse(req.params.id);
    store.get(sid);
    res.json({ enabled: mcp.enabled(sid), file: mcp.file(sid), bridge });
  });
  app.post("/api/strategies/:id/native/mcp-access", (req, res) => {
    const sid = z.uuid().parse(req.params.id);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    if (enabled) mcp.enable(sid);
    else mcp.disable(sid);
    res.json({ enabled: mcp.enabled(sid), file: mcp.file(sid), bridge });
  });
  app.post("/mcp/:id", async (req, res) => {
    const sid = z.uuid().parse(req.params.id);
    try {
      mcp.check(sid, req.headers.authorization);
    } catch (error) {
      return res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: (error as Error).message } });
    }
    // Optional ?stage= (the desktop's Pi pane sets it) selects that stage's guidance.
    const stage = isStage(req.query.stage) ? req.query.stage : undefined;
    const idea = typeof req.query.idea === "string" && /^r:[0-9a-f-]{36}$/.test(req.query.idea) ? req.query.idea : undefined;
    const out = await mcpHandle(workbench, sid, req.body, stage, idea);
    if (out === undefined) return res.status(202).end();
    res.json(out);
  });
  app.get("/mcp/:id", (_req, res) => res.status(405).set("Allow", "POST").end());
  app.get("/api/strategies", (_req, res) =>
    res.json(
      Object.values(store.db.strategies).map((s) => ({
        id: s.id,
        name: s.name,
        lifecycle: s.lifecycle,
        token: store.db.tokens[s.id],
      })),
    ),
  );
  app.post("/api/strategies", (req, res) => {
    const s = store.create(req.body.name);
    res.status(201).json({ id: s.id, token: store.db.tokens[s.id] });
  });
  app.get("/api/strategies/:sid", (req, res) =>
    res.json({
      ...store.get(req.params.sid),
      runtimeError: pool.warning(req.params.sid) ?? store.storage.warning,
    }),
  );
  app.patch("/api/strategies/:sid", async (req, res) => {
    const d = z
      .object({
        revision: z.number().int(),
        lifecycle: z.enum(["active", "parked"]),
      })
      .parse(req.body);
    const s = store.change(req.params.sid, d.revision, (s) => {
      s.lifecycle = d.lifecycle;
      store.event(s, `Strategy ${d.lifecycle}`);
    });
    if (d.lifecycle === "parked") await pool.stop(s.id);
    res.json(store.get(s.id));
  });
  app.put("/api/strategies/:sid/tabs/:tab", (req, res) => {
    const t = tabSchema.parse(req.params.tab);
    const d = z
      .object({ revision: z.number().int(), state: tabStateSchema })
      .parse(req.body);
    res.json(
      store.change(req.params.sid, d.revision, (s) => {
        for (const a of d.state.open) store.artifact(s, a);
        if (d.state.selected) store.artifact(s, d.state.selected);
        if (d.state.commentAnchor && !d.state.selected)
          throw new Fault(400, "Select a document for this anchor");
        if (
          d.state.editingAnnotationId &&
          !s.annotations.some(
            (a) =>
              a.id === d.state.editingAnnotationId &&
              a.artifactId === d.state.selected,
          )
        )
          throw new Fault(
            404,
            "Annotation draft does not belong to this document/strategy",
          );
        Object.assign(s.tabs[t], d.state);
      }),
    );
  });
  app.post(
    "/api/strategies/:sid/artifacts",
    express.raw({ type: "application/octet-stream", limit: limits.upload }),
    (req, res) => {
      const rev = z.coerce.number().int().parse(req.headers["x-revision"]);
      const name = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
      if (!Buffer.isBuffer(req.body))
        throw new Fault(400, "Raw upload required");
      res.status(201).json(store.import(req.params.sid, rev, name, req.body));
    },
  );
  app.post("/api/strategies/:sid/artifacts/:aid/delete", (req, res) => {
    const revision = z.number().int().nonnegative().parse(req.body?.revision);
    res.json(
      store.removeArtifact(req.params.sid, revision, req.params.aid, (ids) =>
        platform.citations(req.params.sid, ids),
      ),
    );
  });
  app.post("/api/strategies/:sid/artifacts/:aid/restore", (req, res) => {
    const revision = z.number().int().nonnegative().parse(req.body?.revision);
    res.json(store.restoreArtifact(req.params.sid, revision, req.params.aid));
  });
  app.get("/api/strategies/:sid/artifacts/:aid", (req, res) => {
    const s = store.get(req.params.sid);
    const a = store.artifact(s, req.params.aid);
    const b = store.bytes(s, a.id);
    res.set("Content-Type", a.mime);
    res.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
    res.send(b);
  });
  app.post("/api/strategies/:sid/annotations", (req, res) =>
    res.json(
      store.annotate(
        req.params.sid,
        z.number().int().parse(req.body.revision),
        req.body.annotation,
        (ids) => platform.citations(req.params.sid, ids),
      ),
    ),
  );
  app.post("/api/strategies/:sid/annotations/:nid/delete", (req, res) => {
    const revision = z.number().int().nonnegative().parse(req.body?.revision);
    res.json(
      store.removeAnnotation(req.params.sid, revision, req.params.nid, (ids) =>
        platform.citations(req.params.sid, ids),
      ),
    );
  });
  app.post("/api/strategies/:sid/batches", (req, res) =>
    res
      .status(201)
      .json(
        store.batch(
          req.params.sid,
          z.number().int().parse(req.body.revision),
          req.body,
        ),
      ),
  );
  app.post("/api/strategies/:sid/discussions", (req, res) =>
    res
      .status(201)
      .json(
        store.discussion(
          req.params.sid,
          z.number().int().parse(req.body.revision),
          req.body,
        ),
      ),
  );
  app.get("/api/strategies/:sid/batches/:bid", (req, res) => {
    const b = store
      .get(req.params.sid)
      .batches.find((b) => b.id === req.params.bid);
    if (!b) throw new Fault(404, "Batch not found");
    res.json(b);
  });
  app.post("/api/strategies/:sid/batches/:bid/send", async (req, res) => {
    await pool.send(req.params.sid, req.params.bid);
    res.json(store.get(req.params.sid));
  });
  app.get("/api/strategies/:sid/pi", (req, res) =>
    res.json(pool.info(req.params.sid)),
  );
  app.post("/api/strategies/:sid/pi/:tab/connect", async (req, res) =>
    res.json(
      await pool.handshake(req.params.sid, tabSchema.parse(req.params.tab)),
    ),
  );
  app.post("/api/strategies/:sid/pi/:tab/stop", async (req, res) => {
    const body = z
      .object({ generation: z.number().int().nonnegative().optional() })
      .strict()
      .parse(req.body ?? {});
    await pool.stopView(
      req.params.sid,
      tabSchema.parse(req.params.tab),
      body.generation,
    );
    res.json(store.get(req.params.sid));
  });
  app.get("/api/strategies/:sid/events", (req, res) =>
    res.json(store.get(req.params.sid).events),
  );
  // Serve regular built files only; reject symlinks at the root, directories and leaf.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      throw new Fault(400, "Invalid path");
    }
    const relative =
      decoded === "/" || /^\/(lab|portfolio)\/[0-9a-f-]+\/?$/.test(decoded)
        ? "index.html"
        : decoded.slice(1);
    const parts = relative.split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p.startsWith(".") ||
          p.includes(String.fromCharCode(92)) ||
          p.includes("\u0000"),
      )
    )
      throw new Fault(403, "Invalid public path");
    const root = path.resolve(dist),
      file = path.resolve(root, ...parts);
    if (!file.startsWith(root + path.sep))
      throw new Fault(403, "Public path escape");
    store.rejectSymlink(file);
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
      throw error;
    }
    try {
      if (!fs.fstatSync(fd).isFile()) return next();
      res.type(path.extname(file)).send(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((err: any, _req: any, res: any, _next: any) =>
    res
      .status(
        err instanceof Fault
          ? err.status
          : err instanceof ZodError
            ? 400
            : err.status === 413
              ? 413
              : 500,
      )
      .json({
        error:
          err instanceof ZodError
            ? err.issues.map((i) => i.message).join("; ")
            : err instanceof Fault
              ? err.message
              : err.status === 413
                ? "Request exceeds size limit"
                : "Operation failed; check configuration or local file permissions",
        ...(err instanceof Fault && err.refusal ? { refusal: err.refusal } : {}),
      }),
  );
  return app;
}
