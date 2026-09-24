import type { Express } from "express";
import { z } from "zod";
import { Platform } from "./platform.ts";
import { refSchema } from "../src/platform.ts";
import type {PiPool} from "./pi.ts";
import type {PortfolioConversations} from "./portfolio-conversation.ts";
export function platformRoutes(app: Express, p: Platform, pool: PiPool, conversations: PortfolioConversations) {
  const s = "/api/strategies/:sid/science",
    f = "/api/portfolios/:pid";
  app.get("/api/health", (_req,res)=>res.json(p.health()));
  app.get("/api/strategies/:sid/health", (req,res)=>res.json(p.health("strategy",String(req.params.sid))));
  app.get(f+"/health", (req,res)=>{const pid=String(req.params.pid),health=p.health("portfolio",pid);res.json({...health,durable:health.durable&&conversations.isDurable(pid),conversation:conversations.isDurable(pid)?"durable":"uncertain"});});
  app.get(s, (req, res) => res.json(p.strategyView(String(req.params.sid))));
  app.post(s + "/commands", (req, res) =>
    res.json(p.command(String(req.params.sid), req.body)),
  );
  app.get(s+"/operations/:operationId",(req,res)=>res.json(p.operationReceipt("strategy",String(req.params.sid),z.uuid().parse(req.params.operationId))));
  app.get(s + "/projections", (req,res)=>res.json(p.projectionIntegrity("strategy",String(req.params.sid))));
  app.get(s + "/projection", (req,res)=>res.json(p.projection("strategy",String(req.params.sid),z.string().parse(req.query.file))));
  app.get(s + "/events", (req, res) =>
    res.json(
      p.events(
        "strategy",
        String(req.params.sid),
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.query.after ?? 0),
      ),
    ),
  );
  app.get(s + "/versions/:id/:hash", (req, res) =>
    res.json(
      p.versionContent(
        String(req.params.sid),
        refSchema.parse({ id: String(req.params.id), hash: req.params.hash }),
      ),
    ),
  );
  app.get(s + "/datasets/:id", (req, res) =>
    res.json(
      p.datasetRows(
        String(req.params.sid),
        String(req.params.id),
        z.coerce.number().parse(req.query.offset ?? 0),
        z.coerce.number().parse(req.query.limit ?? 100),
      ),
    ),
  );
  app.get(s + "/datasets/:id/source", (req, res) =>
    res.json(p.datasetSource(String(req.params.sid), String(req.params.id))),
  );
  app.get(s + "/proposal-reviews/:id", (req, res) =>
    res.json(p.reviewedProposal(String(req.params.sid), String(req.params.id))),
  );
  app.post(s + "/rebuild", (req, res) =>
    res.json(p.rebuild("strategy", String(req.params.sid))),
  );
  app.get(s + "/runs/:id", (req, res) =>
    res.json(p.runDetails(String(req.params.sid), String(req.params.id))),
  );
  app.get(s + "/exports/:id", (req, res) =>
    res.json(p.exportPackage(String(req.params.sid), String(req.params.id))),
  );
  app.post(s + "/context", (req, res) =>
    res.json(p.capsule("strategy", String(req.params.sid), req.body)),
  );
  app.get(s + "/ui", (req, res) => res.json(p.readUI(String(req.params.sid))));
  app.put(s + "/ui", (req, res) =>
    res.json(p.saveUI(String(req.params.sid), req.body)),
  );
  app.get("/api/portfolios", (_req, res) => res.json(p.listPortfolios()));
  app.post("/api/portfolios", (req, res) =>
    res
      .status(201)
      .json(
        p.createPortfolio(
          z.object({ name: z.string() }).strict().parse(req.body).name,
        ),
      ),
  );
  app.get(f, (req, res) => res.json(p.portfolioView(String(req.params.pid))));
  app.post(f + "/preflight",(req,res)=>res.json(p.portfolioPreflight(String(req.params.pid),req.body)));
  app.post(f + "/commands", (req, res) =>
    res.json(p.portfolioCommand(String(req.params.pid), req.body)),
  );
  app.get(f+"/operations/:operationId",(req,res)=>res.json(p.operationReceipt("portfolio",String(req.params.pid),z.uuid().parse(req.params.operationId))));
  app.get(f + "/projections", (req,res)=>res.json(p.projectionIntegrity("portfolio",String(req.params.pid))));
  app.get(f + "/projection", (req,res)=>res.json(p.projection("portfolio",String(req.params.pid),z.string().parse(req.query.file))));
  app.get(f + "/events", (req, res) =>
    res.json(
      p.events(
        "portfolio",
        String(req.params.pid),
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.query.after ?? 0),
      ),
    ),
  );
  app.get(f + "/imports/:id", (req, res) =>
    res.json(p.importedPackage(String(req.params.pid), String(req.params.id))),
  );
  app.get(f + "/analyses/:id", (req, res) =>
    res.json(p.analysis(String(req.params.pid), String(req.params.id))),
  );
  app.get(f + "/proposals/:id", (req, res) =>
    res.json(p.proposal(String(req.params.pid), String(req.params.id))),
  );
  app.post(f + "/rebuild", (req, res) =>
    res.json(p.rebuild("portfolio", String(req.params.pid))),
  );
  app.post(f + "/context", (req, res) =>
    res.json(p.capsule("portfolio", String(req.params.pid), req.body)),
  );
  app.get(f + "/conversation", (req,res) => {
    const state=conversations.view(String(req.params.pid)),transport=pool.info("portfolio:"+req.params.pid);
    res.json({...state,status:transport.configured?"native-tool-free":"manual-context-export",modelConfigured:!!state.model,transport});
  });
  app.put(f + "/conversation", async (req,res) => {
    const pid=String(req.params.pid), state=conversations.edit(pid,req.body);
    if(state.lifecycle==="parked")await pool.stop("portfolio:"+pid);
    res.json(conversations.view(pid));
  });
  app.post(f + "/conversation/snapshots", (req,res) => res.status(201).json(conversations.snapshot(String(req.params.pid),req.body)));
  app.post(f + "/conversation/messages/:id/send", async (req,res) => {
    const pid=String(req.params.pid);await pool.send("portfolio:"+pid,String(req.params.id));res.json(conversations.view(pid));
  });
  app.get(f + "/pi", (req,res) => res.json(pool.info("portfolio:"+req.params.pid)));
  app.post(f + "/pi/connect", async (req,res) => res.json(await pool.handshake("portfolio:"+req.params.pid,"Portfolio")));
  app.post(f + "/pi/stop", async (req,res) => {const body=z.object({generation:z.number().int().nonnegative().optional()}).strict().parse(req.body??{});await pool.stopView("portfolio:"+req.params.pid,"Portfolio",body.generation);res.json(conversations.view(String(req.params.pid)));});
}
