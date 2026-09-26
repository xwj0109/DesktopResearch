import { reviewMutationSchemas, reviewPrepareSchema } from "../src/review-contract.ts";
import { ideaBoardOpSchema, ideaDecideInputSchema, ideaDeleteInputSchema, ideaSaveInputSchema } from "../src/idea-board-contract.ts";
import { sourceImportanceSchema } from "../src/source-importance-contract.ts";
import { ideaAddNoteSchema, noteLinkInputSchema } from "../src/note-link-contract.ts";
import { productionCommitInputSchema } from "../src/production-contract.ts";
import { feedCreateSchema, feedDeleteSchema, feedServiceSchema, feedUpdateSchema } from "../src/feed-contract.ts";
import { recoverySchema } from "../src/recovery-contract.ts";
import { z } from "zod";
import type { Scope, LabRequest } from "./contracts.ts";
import { uuid } from "./contracts.ts";
import {
  nativeActionSchema,
  envelopeSchema,
  portfolioEnvelopeSchema,
} from "../src/native-contract.ts";
/** Method and path are checked before adding the main-owned scoped capability. */
export function researchRequest(scope: Scope, request: LabRequest): boolean {
  if (scope.kind === "launcher") return false;
  const base = `/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}/${scope.id}`;
  if (!request.path.startsWith(base + "/")) return false;
  const tail = request.path.slice(base.length);
  let schema: z.ZodType | undefined,
    binary = false,
    read = false;
  const stages =
    scope.kind === "portfolio"
      ? "portfolio"
      : "ideas|literature|research|data|code|backtests|results";
  const conversation = `/native/conversations/(${stages})`;
  if (tail === "/native/research") read = true;
  else if (new RegExp(`^${conversation}/recovery$`).test(tail)) {
    if (request.method === "GET") read = true;
    else schema = recoverySchema;
  } else if (
    new RegExp(
      `^${conversation}(\\?after=\\d{1,16}&generation=\\d{1,16})?$`,
    ).test(tail)
  )
    read = true;
  else if (
    new RegExp(
      `^${conversation}/history\\?cursor=\\d{1,16}(&context=[a-f0-9]{64})?$`,
    ).test(tail)
  )
    read = true;
  else if (new RegExp(`^${conversation}/complete\\?text=[^&]{0,1500}&generation=\\d{1,16}$`).test(tail)) read = true;
  else if (new RegExp(`^${conversation}/receipts/${uuid}$`).test(tail))
    read = true;
  else if (new RegExp(`^${conversation}/receipts/${uuid}/seal$`).test(tail))
    schema = z.object({}).strict();
  else if (new RegExp(`^${conversation}/actions$`).test(tail))
    schema = nativeActionSchema;
  else if (scope.kind === "strategy") {
    if (new RegExp(`^/native/view-events\\?after=-?\\d{1,12}$`).test(tail)) read = true;
    else if (
      new RegExp(
        `^/native/view-context\\?active=(${uuid})?&page=\\d{0,6}&idea=((d|r):${uuid})?&open=(${uuid}(,${uuid}){0,11})?(&focus=(r:${uuid})?)?(&develop=(r:${uuid})?)?$`,
      ).test(tail)
    )
      read = true;
    else if (tail.startsWith("/native/reviews/")) schema = reviewMutationSchemas[tail.slice("/native/reviews/".length) as keyof typeof reviewMutationSchemas];
    else if (tail === "/native/ideas") schema = ideaBoardOpSchema;
    else if (tail === "/native/idea-save") schema = ideaSaveInputSchema;
    else if (tail === "/native/idea-decide") schema = ideaDecideInputSchema;
    else if (tail === "/native/idea-delete") schema = ideaDeleteInputSchema;
    else if (tail === "/native/source-importance") schema = sourceImportanceSchema;
    else if (tail === "/native/note-links") schema = noteLinkInputSchema;
    else if (tail === "/native/idea-note") schema = ideaAddNoteSchema;
    else if (tail === "/native/production/commit") schema = productionCommitInputSchema;
    else if (tail === "/native/feeds") read = true;
    else if (/^\/native\/feeds\/(rows\?id=[a-z0-9-]{1,80}|partitions\?id=[a-z0-9-]{1,80}(&limit=\d{1,4})?)$/.test(tail)) read = true;
    else if (tail === "/native/feeds/create") schema = feedCreateSchema;
    else if (tail === "/native/feeds/update") schema = feedUpdateSchema;
    else if (tail === "/native/feeds/delete") schema = feedDeleteSchema;
    else if (tail === "/native/feeds/service") schema = feedServiceSchema;
    else if (new RegExp(`^/native/production/preview\\?idea=r:${uuid}$`).test(tail)) read = true;
    else if (new RegExp(`^/native/rd/(files|changes)\\?idea=r:${uuid}$`).test(tail)) read = true;
    else if (new RegExp(`^/native/rd/history\\?idea=r:${uuid}(&sha=[0-9a-f]{7,40})?$`).test(tail)) read = true;
    else if (new RegExp(`^/native/rd/file\\?idea=r:${uuid}&path=[^&#]{1,1500}$`).test(tail)) read = true;
    else if (new RegExp(`^/native/rd/diff\\?idea=r:${uuid}&path=[^&#]{1,1500}(&sha=[0-9a-f]{7,40})?$`).test(tail)) read = true;
    else if (tail === "/native/data/snapshots" || tail === "/native/data/jobs") read = true;
    else if (/^\/native\/data\/preview\?name=[a-z0-9-]{1,120}$/.test(tail)) read = true;
    else if (/^\/native\/data\/symbols\?source=(binance-archive|binance|coinbase|fred)&q=[A-Za-z0-9_.%-]{0,60}(&market=(spot|um|cm|option)&dataset=[A-Za-z]{1,40})?$/.test(tail)) read = true;
    else if (/^\/native\/data\/estimate\?market=(spot|um|cm|option)&dataset=[A-Za-z]{1,40}&symbol=[A-Z0-9_]{3,30}(&interval=[0-9a-z]{1,4})?&start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(tail)) read = true;
    else if (tail === "/native/data/fetch")
      schema = z
        .object({
          source: z.enum(["binance", "coinbase", "fred", "binance-archive"]),
          symbol: z.string().trim().min(1).max(40),
          interval: z.string().max(4).optional(),
          market: z.enum(["spot", "um", "cm", "option"]).optional(),
          dataset: z.string().max(40).optional(),
          start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          title: z.string().max(200).optional(),
        })
        .strict();
    else if (tail === "/native/data/cancel") schema = z.object({ job: z.uuid() }).strict();
    else if (tail === "/native/data/delete") schema = z.object({ name: z.string().regex(/^[a-z0-9-]{1,120}$/) }).strict();
    else if (tail === "/native/data/register")
      schema = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/), path: z.string().min(1).max(500), title: z.string().trim().min(1).max(200), note: z.string().max(2000).optional() }).strict();
    else if (tail === "/native/rd/checkpoint")
      schema = z.object({ idea: z.string().regex(/^r:[0-9a-f-]{36}$/), message: z.string().trim().min(1).max(500) }).strict();
    else if (tail === "/native/mcp-access") {
      if (request.method === "GET") read = true;
      else schema = z.object({ enabled: z.boolean() }).strict();
    } else if (tail === "/science/commands") schema = envelopeSchema;
    else if (
      new RegExp(
        `^/science/(versions/${uuid}/[a-f0-9]{64}|operations/${uuid}|runs/${uuid}|exports/${uuid}|datasets/${uuid}|datasets/${uuid}/source)$`,
      ).test(tail)
    )
      read = true;
    else if (new RegExp(`^/artifacts/${uuid}$`).test(tail)) read = true;
    else if (tail === "/artifacts") binary = true;
    else if (
      new RegExp(`^/artifacts/${uuid}/(delete|restore)$`).test(tail) ||
      new RegExp(`^/annotations/${uuid}/delete$`).test(tail)
    )
      schema = z.object({ revision: z.number().int().nonnegative() }).strict();
    else if (tail === "/annotations")
      schema = z
        .object({
          revision: z.number().int().nonnegative(),
          annotation: z
            .object({
              id: z.uuid().optional(),
              artifactId: z.uuid(),
              anchor: z
                .object({
                  page: z.number().int().positive(),
                  quote: z.string().max(12000),
                  rect: z
                    .tuple([z.number(), z.number(), z.number(), z.number()])
                    .optional(),
                  rotation: z.literal(0),
                })
                .strict(),
              comment: z.string().min(1).max(12000),
              status: z.enum(["draft", "addressed", "dismissed"]),
            })
            .strict(),
        })
        .strict();
    else if (tail === "/batches")
      schema = reviewPrepareSchema;
  } else {
    if (tail === "/commands") schema = portfolioEnvelopeSchema;
    else if (tail === "/preflight") schema = z.unknown();
    else if (
      new RegExp(`^/(operations|imports|analyses|proposals)/${uuid}$`).test(
        tail,
      )
    )
      read = true;
  }
  if (read) {
    if (
      request.method !== "GET" ||
      request.body ||
      Object.keys(request.headers).length
    )
      throw new Error("Invalid read request");
    return true;
  }
  if (!schema && !binary) return false;
  if (request.method !== "POST" || !request.body)
    throw new Error("Invalid mutation request");
  if (binary) {
    if (
      request.headers["content-type"] !== "application/octet-stream" ||
      !request.headers["x-filename"] ||
      !request.headers["x-revision"]
    )
      throw new Error("Invalid artifact upload");
  } else {
    if (
      request.headers["content-type"] !== "application/json" ||
      Object.keys(request.headers).length !== 1 ||
      request.body.length > 5 * 1024 * 1024
    )
      throw new Error("Invalid JSON request");
    const value = schema!.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      ),
    ) as any;
    if (
      request.requestId &&
      ((value?.intent?.id && value.intent.id !== request.requestId) ||
        (value?.operationId && value.operationId !== request.requestId))
    )
      throw new Error("Request identity mismatch");
  }
  return true;
}
