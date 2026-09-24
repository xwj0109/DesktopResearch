import {z} from "zod";
import type {Batch,Tab} from "./shared.ts";
import {capsuleRequestSchema,sha,uuid} from "./platform.ts";
export type ConversationTab=Tab|"Portfolio";
export type ConversationMessage=Omit<Batch,"destination">&{destination:ConversationTab};
export interface ConversationWorkspace {lifecycle:"active"|"parked";batches:ConversationMessage[];tabs:Partial<Record<ConversationTab,{sessionId:string}>>;}
export const portfolioMessageSchema=z.object({id:uuid,operationId:uuid,requestHash:sha,created:z.iso.datetime(),destination:z.literal("Portfolio"),sessionId:uuid,instruction:z.string().max(40000),behavior:z.literal("followUp"),model:z.object({provider:z.string().max(200),id:z.string().max(200)}).strict(),annotations:z.array(z.never()).max(0),documents:z.array(z.never()).max(0),prompt:z.string().max(128*1024),hash:sha,capsuleHash:sha.nullable(),status:z.enum(["draft","pending","accepted/queued","working","completed","failed","delivery-uncertain"]),detail:z.string().max(20000),response:z.string().max(128*1024),requestId:z.string().max(200).optional(),attempts:z.number().int().min(0)}).strict();
export const portfolioConversationSchema=z.object({version:z.literal(1),portfolioId:uuid,revision:z.number().int().min(0),sessionId:uuid,lifecycle:z.enum(["active","parked"]),provider:z.string().max(200),model:z.string().max(200),draft:z.string().max(40000),messages:z.array(portfolioMessageSchema).max(100)}).strict();
export type PortfolioConversation=z.infer<typeof portfolioConversationSchema>;
export const conversationEditSchema=z.object({revision:z.number().int().min(0),lifecycle:z.enum(["active","parked"]),provider:z.string().max(200),model:z.string().max(200),draft:z.string().max(40000)}).strict();
export const conversationSnapshotSchema=z.object({revision:z.number().int().min(0),operationId:uuid,instruction:z.string().trim().min(1).max(40000),capsuleRequest:capsuleRequestSchema.optional(),capsuleHash:sha.optional()}).strict().refine(x=>!!x.capsuleRequest===!!x.capsuleHash,"Supply the exact prepared capsule request and digest together");
