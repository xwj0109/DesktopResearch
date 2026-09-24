import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {fixture,pipeline,command,version,externalPackage} from "./platform-fixtures.ts";

test("stage projections are useful, reconstructible, scoped, and omit operational secrets/transcripts",async t=>{
 const {store,platform:p}=fixture(t),s=store.create("Projection lab");
 store.discussion(s.id,store.get(s.id).revision,{destination:"Ideas",instruction:"PRIVATE-CONVERSATION-NOT-FOR-PROJECTIONS"});
 store.import(s.id,store.get(s.id).revision,"cc0-note.txt",Buffer.from("User supplied original source"));
 const f=pipeline(p,s.id),code=version(p,s.id,{kind:"code",content:{filename:"authored.ts",language:"typescript",source:"throw new Error('MUST-NOT-EXECUTE');\n",symbols:["declared"],evidence:[]}});
 let integrity=p.projectionIntegrity("strategy",s.id);
 for(const required of ["meta/AGENTS.md","meta/CONTEXT.md","Reference-Papers/INDEX.md","Research-Development/INDEX.md","Data/INDEX.md","Design/INDEX.md","Code-implementation/INDEX.md","Experiments/INDEX.md","Results/INDEX.md"]){assert.ok(integrity.files.some(x=>x.file===required&&x.status==="current"),required);}
 const source=integrity.files.find(x=>x.file.endsWith("-authored.ts"))!;
 assert.match(p.projection("strategy",s.id,source.file).text,/NOT AUTHORITATIVE/);
 assert.match(p.projection("strategy",s.id,source.file).text,/not compiled, executed or tested/);
 assert.match(p.projection("strategy",s.id,source.file).text,/MUST-NOT-EXECUTE/);
 const all=integrity.files.map(x=>p.projection("strategy",s.id,x.file).text).join("\n");
 assert.ok(!all.includes(store.db.rootToken));assert.ok(!all.includes(store.db.tokens[s.id]));assert.ok(!all.includes(store.root));assert.ok(!all.includes(s.tabs.Ideas.sessionId));assert.ok(!all.includes("PRIVATE-CONVERSATION-NOT-FOR-PROJECTIONS"));
 assert.throws(()=>p.projection("strategy",s.id,"meta/science/blobs/"+code.hash),/allowlisted/);
 assert.throws(()=>p.projection("strategy",s.id,"../../catalog.json"),/allowlisted/);
 const run=command(p,s.id,{type:"run.queue",config:f.config}).state.runs.at(-1)!;await p.idle();
 integrity=p.projectionIntegrity("strategy",s.id);assert.ok(!integrity.files.some(x=>x.file===`Results/runs/${run.id}.json`));
 const input=p.projection("strategy",s.id,`Experiments/runs/${run.id}.json`).text;assert.ok(!input.includes('"metrics"'));assert.ok(!input.includes('"points"'));assert.match(input,/requiresExposure/);
 command(p,s.id,{type:"run.expose",runId:run.id,reason:"Explicit disclosure for projection inspection"});
 assert.match(p.projection("strategy",s.id,`Results/runs/${run.id}.json`).text,/"metrics"/);
 const exportId=command(p,s.id,{type:"export.create",runId:run.id,limitations:["CC0 fixture, not investment evidence"]}).state.exports[0].id;
 assert.match(p.projection("strategy",s.id,`Results/exports/${exportId}.json`).text,/herdr-portfolio-export-v1/);
 const context=path.join(store.storage.strategyRoot(s.id),"meta","CONTEXT.md");fs.writeFileSync(context,"MANUAL EDIT MUST NOT BECOME AUTHORITY");
 assert.equal(p.projectionIntegrity("strategy",s.id).files.find(x=>x.file==="meta/CONTEXT.md")!.status,"modified-or-stale");
 assert.throws(()=>p.projection("strategy",s.id,"meta/CONTEXT.md"),/differs/);
 const revision=p.strategyView(s.id).revision;p.rebuild("strategy",s.id);assert.equal(p.strategyView(s.id).revision,revision);assert.match(fs.readFileSync(context,"utf8"),/GENERATED PROJECTION/);
});

test("projection symlinks fail closed without rolling back committed scientific versions",t=>{
 const {store,platform:p,root}=fixture(t),s=store.create("Projection boundary"),file=path.join(store.storage.strategyRoot(s.id),"meta","CONTEXT.md"),outside=path.join(root,"outside-sentinel.txt");
 fs.writeFileSync(outside,"untouched");fs.unlinkSync(file);fs.symlinkSync(outside,file);
 const saved=command(p,s.id,{type:"version.create",value:{kind:"code",content:{filename:"safe.ts",language:"typescript",source:"// source only",symbols:[],evidence:[]}}});
 assert.equal(saved.state.versions.length,1);assert.match(saved.warning!,/Derived projections unavailable/);assert.equal(fs.readFileSync(outside,"utf8"),"untouched");assert.throws(()=>p.projectionIntegrity("strategy",s.id),/Symlink/);assert.throws(()=>p.rebuild("strategy",s.id),/Symlink/);
 fs.unlinkSync(file);const rebuilt=p.rebuild("strategy",s.id);assert.equal(rebuilt.warning,null);assert.ok(rebuilt.integrity.files.every(f=>f.status==="current"));assert.equal(p.strategyView(s.id).state.versions.length,1);
});

test("portfolio projections contain copied evidence/analyses/requests, never source or private conversation authority",t=>{
 const {store,platform:p}=fixture(t),a=p.createPortfolio("Projected portfolio"),b=p.createPortfolio("Other");
 const pkg=externalPackage(["2026-01-02","2026-01-03"],[.1,-.1]);
 const run=(command:any)=>p.portfolioCommand(a.id,{operationId:randomUUID(),revision:p.portfolioView(a.id).revision,command});
 const imported=run({type:"import.add",package:pkg}).state.imports[0],ref={id:imported.id,hash:imported.hash};
 const analysis=run({type:"analysis.create",imports:[ref],allocation:{method:"equal",cap:1}}).state.analyses[0];
 const proposal=run({type:"proposal.create",analysis:{id:analysis.id,hash:analysis.hash},targetStrategyId:pkg.body.strategyId,request:"Review the declared costs"}).state.proposals[0];
 const list=p.projectionIntegrity("portfolio",a.id);for(const name of [`imports/${imported.id}.json`,`analyses/${analysis.id}.json`,`proposals/${proposal.id}.json`])assert.ok(list.files.some(x=>x.file===name&&x.status==="current"));
 const texts=list.files.map(x=>p.projection("portfolio",a.id,x.file).text).join("\n");assert.ok(!texts.includes(a.token));assert.ok(!texts.includes(store.db.rootToken));assert.ok(!texts.includes(store.root));assert.equal(Object.keys(store.db.strategies).length,0);
 assert.throws(()=>p.projection("portfolio",b.id,`imports/${imported.id}.json`),/allowlisted/);
 const prior=p.projection("portfolio",a.id,`imports/${imported.id}.json`).text;pkg.body.points[0].return=.5;assert.equal(p.projection("portfolio",a.id,`imports/${imported.id}.json`).text,prior);
});
