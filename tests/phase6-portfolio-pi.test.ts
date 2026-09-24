import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:http";
import {Store} from "../server/store.ts";
import {Platform} from "../server/platform.ts";
import {PiPool} from "../server/pi.ts";
import {Rpc} from "../server/rpc.ts";
import {PortfolioConversations} from "../server/portfolio-conversation.ts";
import {createApp} from "../server/app.ts";
import {digest} from "../server/durable.ts";
import {externalPackage} from "./platform-fixtures.ts";
const fake=fileURLToPath(new URL("./fake-rpc.mjs",import.meta.url));
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(fn:()=>boolean){for(let i=0;i<250;i++){if(fn())return;await sleep(20);}throw new Error("Portfolio fixture condition timed out");}
function setup(t:any,hold=false){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lab-native-portfolio-"))),store=new Store(root),platform=new Platform(store),a=platform.createPortfolio("Native A"),b=platform.createPortfolio("Native B"),sid=store.create("Real strategy").id;
 const launches:{args:string[];cwd:string;env:any}[]=[],prompts:string[]=[],release:((e:Error)=>void)[]=[];
 const pool=new PiPool(store,process.execPath,(_exe,args,cwd,env)=>{launches.push({args,cwd,env});const rpc=new Rpc(spawn(process.execPath,[fake],{cwd,env,stdio:"pipe"}),15000,150);const request=rpc.request.bind(rpc);rpc.request=(type,fields,id)=>{if(type==="prompt"){prompts.push(String(fields?.message));if(hold)return new Promise((_resolve,reject)=>release.push(reject));}return request(type,fields,id);};return rpc;});
 const conversations=new PortfolioConversations(store,platform);pool.attachPortfolios(conversations);
 t.after(async()=>{for(const reject of release)reject(new Error("Test stopped held fake request"));await pool.close();await platform.close();fs.rmSync(root,{recursive:true,force:true});});
 const configure=(pid:string)=>{const s=conversations.state(pid);return conversations.edit(pid,{revision:s.revision,lifecycle:s.lifecycle,provider:"test-only",model:"fixture",draft:"Explicit private draft"});};
 const snapshot=(pid:string,instruction:string,extra:object={})=>{const s=conversations.state(pid);return conversations.snapshot(pid,{revision:s.revision,operationId:randomUUID(),instruction,...extra}).messages.at(-1)!;};
 return {root,store,platform,pool,conversations,a,b,sid,launches,prompts,configure,snapshot};
}
test("portfolio adapter opens/restores/prepares context without model calls, then explicitly sends only selected copied evidence",async t=>{
 const x=setup(t);assert.equal(x.launches.length,0);assert.equal(x.prompts.length,0);assert.equal(Object.keys(x.store.db.strategies).length,1);
 x.store.import(x.sid,x.store.get(x.sid).revision,"private-source.txt",Buffer.from("UNRELATED STRATEGY PRIVATE SOURCE"));
 const pkg=externalPackage(["2026-01-02","2026-01-03"],[.1,-.1]);
 const imported=x.platform.portfolioCommand(x.a.id,{operationId:randomUUID(),revision:0,command:{type:"import.add",package:pkg}}).state.imports[0];
 const request={role:"portfolio" as const,task:"Explain this explicitly imported fixture",selected:[{id:imported.id,hash:imported.hash}],unresolved:["No fill model"],budget:16384};
 const capsule=x.platform.capsule("portfolio",x.a.id,request);x.configure(x.a.id);const message=x.snapshot(x.a.id,"Compare only the selected imported evidence",{capsuleRequest:request,capsuleHash:capsule.hash});
 assert.equal(x.launches.length,0);assert.equal(message.status,"draft");assert.equal(message.hash,digest(message.prompt));assert.ok(message.prompt.includes(capsule.text.replace(/\n/g,"\\n").slice(0,40)));assert.ok(!message.prompt.includes("UNRELATED STRATEGY PRIVATE SOURCE"));assert.ok(!message.prompt.includes(x.store.db.rootToken));assert.ok(!message.prompt.includes(x.store.root));
 const connected=await x.pool.handshake("portfolio:"+x.a.id,"Portfolio");assert.equal(x.prompts.length,0);assert.equal(connected.models[0].provider,"test-only");
 const launch=x.launches[0];for(const flag of ["--no-tools","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--offline","--no-approve"])assert.ok(launch.args.includes(flag));assert.ok(launch.args[launch.args.indexOf("--session-dir")+1].includes(path.join("portfolio-sessions",x.a.id)));assert.equal(launch.env.PI_CODING_AGENT_DIR,path.join(x.root,"pi-agent"));assert.equal(launch.cwd,path.join(x.root,"empty"));
 await x.pool.send("portfolio:"+x.a.id,message.id);await until(()=>x.conversations.state(x.a.id).messages[0].status==="completed");
 assert.equal(x.prompts.length,1);assert.equal(x.prompts[0],message.prompt);assert.match(x.conversations.state(x.a.id).messages[0].response,/not real inference/);
 await assert.rejects(x.pool.send("portfolio:"+x.a.id,message.id),/Already attempted/);
 await assert.rejects(x.pool.send("portfolio:"+x.b.id,message.id),/Batch not found/);
 assert.equal(Object.keys(x.store.db.strategies).length,1,"No hidden strategy created for portfolio transport");
});
test("strategy and portfolio conversations share the same two-process bound and preserve ownership through stop",async t=>{
 const x=setup(t,true);x.store.change(x.sid,x.store.get(x.sid).revision,s=>{s.tabs.Ideas.provider="test-only";s.tabs.Ideas.model="fixture";});x.store.discussion(x.sid,x.store.get(x.sid).revision,{destination:"Ideas",instruction:"Held fake strategy request"});x.configure(x.a.id);x.configure(x.b.id);const a=x.snapshot(x.a.id,"Held fake portfolio request");
 await Promise.all([x.pool.handshake(x.sid,"Ideas"),x.pool.handshake("portfolio:"+x.a.id,"Portfolio")]);
 await x.pool.send(x.sid,x.store.get(x.sid).batches[0].id);await x.pool.send("portfolio:"+x.a.id,a.id);await until(()=>x.prompts.length===2);
 await assert.rejects(x.pool.handshake("portfolio:"+x.b.id,"Portfolio"),/pool full/);assert.equal(x.pool.info().active,2);assert.equal(x.launches.length,2);
 await x.pool.stop("portfolio:"+x.a.id);assert.equal(x.pool.info().active,1);assert.equal(x.conversations.state(x.a.id).messages[0].status,"delivery-uncertain");
 await x.pool.handshake("portfolio:"+x.b.id,"Portfolio");assert.equal(x.pool.info().active,2);assert.equal(x.launches.length,3);assert.equal(x.prompts.length,2);
});
test("portfolio snapshot idempotency, stale edit recovery, capsule ownership and restart never replay submissions",async t=>{
 const x=setup(t);const initial=x.configure(x.a.id),envelope={revision:initial.revision,operationId:randomUUID(),instruction:"Saved exact question"};const first=x.conversations.snapshot(x.a.id,envelope);x.conversations.snapshot(x.a.id,envelope);assert.equal(x.conversations.state(x.a.id).messages.length,1);assert.throws(()=>x.conversations.snapshot(x.a.id,{...envelope,instruction:"Different"}),/reused/);assert.throws(()=>x.conversations.edit(x.a.id,{revision:initial.revision,lifecycle:"active",provider:"test-only",model:"fixture",draft:"stale"}),/changed/);assert.equal(x.conversations.state(x.a.id).draft,"Explicit private draft");
 assert.throws(()=>x.snapshot(x.a.id,"No foreign context",{capsuleRequest:{role:"portfolio",task:"Foreign",selected:[{id:randomUUID(),hash:"a".repeat(64)}],unresolved:[],budget:1000},capsuleHash:"a".repeat(64)}),/not owned/);
 x.conversations.delivery(x.a.id,first.messages[0].id,{status:"pending",attempts:1});const restarted=new PortfolioConversations(x.store,x.platform);assert.equal(restarted.state(x.a.id).messages[0].status,"delivery-uncertain");assert.equal(restarted.state(x.a.id).messages[0].prompt,first.messages[0].prompt);assert.equal(x.prompts.length,0);assert.equal(x.launches.length,0);
});
for(const stage of ["pending","requestId"] as const)test(`portfolio ${stage} directory-sync uncertainty preserves published state and sends zero prompts`,async t=>{
 const x=setup(t);x.configure(x.a.id);const m=x.snapshot(x.a.id,"Never send from an uncertain audit trail");await x.pool.handshake(x.sid,"Ideas");await x.pool.handshake("portfolio:"+x.a.id,"Portfolio");
 const rename=fs.renameSync,sync=fs.fsyncSync;let published=false;
 fs.renameSync=(from,to)=>{rename(from,to);if(String(to)===path.join(x.root,"portfolio-conversations",x.a.id+".json")){const candidate=JSON.parse(fs.readFileSync(String(to),"utf8")).messages[0];if(candidate.status==="pending"&&(stage==="pending"||candidate.requestId))published=true;}};
 fs.fsyncSync=fd=>{if(published&&fs.fstatSync(fd).isDirectory())throw new Error("Injected portfolio publication fsync failure");sync(fd);};
 try{if(stage==="pending")await assert.rejects(x.pool.send("portfolio:"+x.a.id,m.id),/uncertain/);else await x.pool.send("portfolio:"+x.a.id,m.id);await until(()=>x.pool.info().active===1);}finally{fs.renameSync=rename;fs.fsyncSync=sync;}
 assert.equal(published,true);assert.equal(x.prompts.length,0);assert.equal(x.pool.info().active,1,"Affected idle portfolio child exited; unrelated strategy child remains owned");assert.equal(x.pool.warning(x.sid),undefined);assert.equal(x.conversations.state(x.a.id).messages[0].status,"pending");assert.match(x.conversations.view(x.a.id).warning!,/uncertain/);await assert.rejects(x.pool.send("portfolio:"+x.a.id,m.id),/uncertain/);
});
for(const action of ["edit","snapshot"] as const)test(`portfolio ${action} uncertain publication immediately closes only its connected idle child`,async t=>{
 const x=setup(t);x.configure(x.a.id);await x.pool.handshake(x.sid,"Ideas");await x.pool.handshake("portfolio:"+x.a.id,"Portfolio");assert.equal(x.pool.info().active,2);
 const before=x.conversations.state(x.a.id),rename=fs.renameSync,sync=fs.fsyncSync;let published=false,result:any;
 fs.renameSync=(from,to)=>{rename(from,to);if(String(to)===path.join(x.root,"portfolio-conversations",x.a.id+".json"))published=true;};
 fs.fsyncSync=fd=>{if(published&&fs.fstatSync(fd).isDirectory())throw new Error("Injected edit/snapshot fsync uncertainty");sync(fd);};
 try{result=action==="edit"?x.conversations.edit(x.a.id,{revision:before.revision,lifecycle:"active",provider:"test-only",model:"fixture",draft:"Published private edit"}):x.conversations.snapshot(x.a.id,{revision:before.revision,operationId:randomUUID(),instruction:"Published immutable snapshot"});await until(()=>x.pool.info().active===1);}finally{fs.renameSync=rename;fs.fsyncSync=sync;}
 assert.equal(published,true);assert.equal(result.persistence.committed,true);assert.equal(result.persistence.durability,"uncertain");assert.equal(x.conversations.state(x.a.id).revision,before.revision+1);assert.equal(x.pool.warning(x.sid),undefined);assert.match(x.pool.warning("portfolio:"+x.a.id)!,/persistence failed/);assert.equal(x.prompts.length,0);
 if(action==="edit")assert.equal(x.conversations.state(x.a.id).draft,"Published private edit");else assert.equal(x.conversations.state(x.a.id).messages.at(-1)!.prompt,result.messages.at(-1).prompt);
 await assert.rejects(x.pool.handshake("portfolio:"+x.a.id,"Portfolio"),/uncertain/);assert.equal(x.pool.info().active,1);
});

test("every new portfolio conversation/preflight/projection route uses exact capability; park is explicit and stops owned Pi",async t=>{
 const x=setup(t),dist=path.join(x.root,"public");fs.mkdirSync(dist);fs.writeFileSync(path.join(dist,"index.html"),"<html>scoped fixture host</html>");const server=createServer().listen(0,"127.0.0.1");await once(server,"listening");const origin="http://127.0.0.1:"+(server.address() as any).port;server.on("request",createApp(x.store,x.pool,origin,dist,x.platform));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const call=(route:string,token:string,method="GET",body?:unknown)=>fetch(origin+route,{method,headers:{Origin:origin,Authorization:"Bearer "+token,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)});
 const root=`/api/portfolios/${x.a.id}`;
 for(const [route,method] of [["/conversation","GET"],["/conversation","PUT"],["/conversation/snapshots","POST"],["/conversation/messages/"+randomUUID()+"/send","POST"],["/pi","GET"],["/pi/connect","POST"],["/pi/stop","POST"],["/preflight","POST"],["/projections","GET"],["/projection?file=meta%2FCONTEXT.md","GET"],["/health","GET"]])for(const token of [x.store.db.rootToken,x.store.db.tokens[x.sid],x.b.token])assert.equal((await call(root+route,token,method,method==="GET"?undefined:{})).status,403,route);
 assert.equal(x.launches.length,0);assert.equal((await call(`/portfolio/${x.a.id}`,"no-api-key")).status,200);
 const before=await (await call(root+"/conversation",x.a.token)).json() as any;assert.equal(before.automaticCalls,false);assert.equal(before.scope,"portfolio");assert.equal(x.prompts.length,0);
 assert.equal((await call(root+"/pi/connect",x.a.token,"POST",{})).status,200);assert.equal(x.pool.info().active,1);
 const parked=await call(root+"/conversation",x.a.token,"PUT",{revision:before.revision,lifecycle:"parked",provider:"test-only",model:"fixture",draft:"retained"});assert.equal(parked.status,200);assert.equal(x.pool.info().active,0);assert.equal((await call(root+"/pi/connect",x.a.token,"POST",{})).status,409);assert.equal(x.prompts.length,0);
 assert.equal((await call(root+"/projection?file=..%2F..%2Fcatalog.json",x.a.token)).status,404);
});
