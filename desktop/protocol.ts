import { z } from "zod";
import { researchRequest } from "./research-routes.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { type Scope, type LabResponse, MAX_RESPONSE } from "./contracts.ts";
import { allowedRequest, documentURL } from "./security.ts";
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'none'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";
export const assetHeaders = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
export async function assetResponse(
  url: string,
  method: string,
  assets: string,
  scope: Scope,
) {
  if (method !== "GET")
    return new Response(null, { status: 405, headers: assetHeaders });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return new Response(null, { status: 403 });
  }
  if (
    u.protocol !== "pi-research:" ||
    u.hostname !== "app" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    return new Response(null, { status: 403 });
  let relative: string;
  if (documentURL(url, scope)) relative = "index.html";
  else if (
    /^\/assets\/[a-zA-Z0-9_.-]+\.(m?js|css|woff2?|png|svg)$/.test(u.pathname)
  )
    relative = u.pathname.slice(1);
  else return new Response(null, { status: 404, headers: assetHeaders });
  try {
    const assetRoot = await fs.realpath(assets);
    const file = await fs.realpath(path.join(assetRoot, relative));
    if (!file.startsWith(assetRoot + path.sep))
      throw new Error("Asset escapes bundle");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_RESPONSE)
      throw new Error("Invalid asset");
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    return new Response(await fs.readFile(file), {
      headers: { ...assetHeaders, "Content-Type": mime[path.extname(file)] },
    });
  } catch {
    return new Response(null, { status: 404, headers: assetHeaders });
  }
}
export async function boundedBytes(response: Response, max = MAX_RESPONSE) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > max) throw new Error("Lab response too large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
/** Positive DTO projection: internal tokens, paths, sessions and nested errors never cross IPC. */
export function workspaceDTO(
  value: unknown,
  scope: Scope,
  method: string,
): unknown {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("Invalid workspace response");
    return v as Record<string, unknown>;
  };
  const item = (v: unknown, create = false) => {
    const o = object(v);
    if (
      typeof o.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        o.id,
      )
    )
      throw new Error("Invalid workspace identity");
    if (!create && (typeof o.name !== "string" || o.name.length > 120))
      throw new Error("Invalid workspace name");
    return {
      id: o.id,
      ...(create ? {} : { name: o.name }),
      ...(o.persistence ? { durabilityUncertain: true } : {}),
    };
  };
  if (scope.kind === "launcher") {
    if (method === "POST") return item(value, true);
    if (!Array.isArray(value) || value.length > 100)
      throw new Error("Invalid workspace list");
    return value.map((v) => item(v));
  }
  const o = object(value),
    metadata = scope.kind === "portfolio" ? object(o.state) : o;
  const result = item(metadata) as { id: string };
  if (result.id !== scope.id) throw new Error("Workspace identity mismatch");
  return result;
}
export async function labRequest(
  scope: Scope,
  input: unknown,
  origin: string,
  capability: string,
): Promise<LabResponse> {
  const req = allowedRequest(scope, input);
  const response = await fetch(origin + req.path, {
    method: req.method,
    headers: {
      ...req.headers,
      Authorization: `Bearer ${capability}`,
      Origin: origin,
    },
    body: req.body as BodyInit | undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const isResearch = researchRequest(scope, req);
  const binary =
    isResearch &&
    req.method === "GET" &&
    /\/artifacts\/[a-f0-9-]+$/.test(req.path);
  const headers = {
    "content-type": binary
      ? (response.headers.get("content-type") ?? "application/octet-stream")
      : "application/json",
  };
  const raw = await boundedBytes(response);
  if (binary && response.ok)
    return { status: response.status, headers, body: raw };
  const refusal = isResearch && !response.ok ? sourceRefusal(raw, req.path) : undefined;
  // Never surface backend error text (may include private filesystem/credential details).
  if (scope.kind === "launcher" && /^\/api\/strategy-management\//.test(req.path)) {
    const data = JSON.parse(new TextDecoder().decode(raw));
    const value = response.ok ? { id: z.uuid().parse(data.id), ...(req.path.endsWith("/rename") ? { name: z.string().min(1).max(120).parse(data.name) } : { deleted: z.literal(true).parse(data.deleted), filesRetained: true }), ...(data.persistence ? { durabilityUncertain: true } : {}) }
      : { error: data.refusal?.code === "strategy-busy" ? "Stop connected sessions and finish or cancel experiments. Resolve any uncertain delivery or session ownership, then try again." : "Strategy changed or the action was refused. Refresh the list before retrying." };
    return { status: response.status, headers, body: new TextEncoder().encode(JSON.stringify(value)) };
  }
  const value = response.ok
    ? isResearch
      ? researchDTO(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
          req.path,
        )
      : workspaceDTO(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
          scope,
          req.method,
        )
    : {
        error:
          response.status === 409
            ? "The action was refused because state or ownership changed. Refresh and inspect its receipt before retrying."
            : response.status === 400
              ? "The request did not meet the research contract. Check the fields and references."
              : "The request failed. Inspect its receipt before retrying; no action is automatically replayed.",
        ...(refusal ? { refusal } : {}),
      };
  const body = new TextEncoder().encode(JSON.stringify(value));
  return { status: response.status, headers, body };
}

/** Source/idea delete refusals are shown to the user, so they cross the
 * boundary only as strictly shaped data (no free text from the backend). */
const refusalSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("frozen-batch"), batch: z.string().regex(/^[a-f0-9]{10}$/) }).strict(),
  z
    .object({
      code: z.literal("cited"),
      records: z.array(z.string().regex(/^[a-z-]{1,24}( v\d{1,6})? \([0-9a-f]{8}\)$/)).min(1).max(20),
    })
    .strict(),
  z.object({ code: z.literal("review-in-flight") }).strict(),
  z.object({ code: z.literal("review-draft-cited") }).strict(),
  z.object({ code: z.literal("not-restorable") }).strict(),
  z.object({ code: z.literal("full") }).strict(),
]);
export function sourceRefusal(raw: Uint8Array, route: string) {
  if (!/\/(artifacts\/[0-9a-f-]{36}\/(delete|restore)|annotations(\/[0-9a-f-]{36}\/delete)?|science\/commands|native\/reviews\/review_delete|native\/idea-delete)$/.test(route))
    return undefined;
  try {
    const parsed = refusalSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)).refusal);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Authority-bearing backend metadata cannot be smuggled alongside a research DTO.
 * User-authored content and canonical Pi messages remain content, not credentials. */
export function researchDTO(value: any, route: string): unknown {
  const pick = (object: any, keys: string[]) =>
    Object.fromEntries(
      keys.filter((k) => object?.[k] !== undefined).map((k) => [k, object[k]]),
    );
  if (/\/native\/research$/.test(route))
    return pick(value, [
      "revision",
      "artifacts",
      "annotations",
      "batches",
      "science",
      "deleted",
      "ideas",
      "importance",
      "pursued",
      "noteLinks",
      "ideaTitles",
      "production",
    ]);
  if (/\/native\/reviews\/review_(prepare|duplicate)$/.test(route)) return pick(value, ["review", "revision", "persistence"]);
  if (/\/native\/reviews\/review_delete$/.test(route)) return pick(value, ["deleted", "revision", "persistence"]);
  if (/\/native\/reviews\/review_create_idea$/.test(route)) return pick(value, ["target", "review"]);
  if (/\/native\/ideas$/.test(route)) return pick(value, ["ideas"]);
  if (/\/native\/idea-(save|decide|delete)$/.test(route)) return pick(value, ["saved", "version", "decided", "onVersion", "deleted"]);
  if (/\/native\/source-importance$/.test(route)) return pick(value, ["artifactId", "importance"]);
  if (/\/native\/note-links$/.test(route)) return pick(value, ["noteId", "idea", "stance", "onVersion", "removed"]);
  if (/\/native\/idea-note$/.test(route)) return pick(value, ["idea", "added", "evidence", "shown"]);
  if (/\/native\/feeds$/.test(route)) return pick(value, ["service", "feeds"]);
  if (/\/native\/feeds\/rows\?/.test(route)) return pick(value, ["columns", "types", "rows", "series", "valueColumn"]);
  if (/\/native\/feeds\/partitions\?/.test(route)) return pick(value, ["partitions", "outages"]);
  if (/\/native\/feeds\/(create|update)$/.test(route)) return value;
  if (/\/native\/feeds\/delete$/.test(route)) return pick(value, ["deleted", "keptData", "bytes"]);
  if (/\/native\/feeds\/service$/.test(route)) return pick(value, ["mode", "enabled", "running", "heartbeatAt", "pid", "feeds", "label", "log"]);
  if (/\/native\/production\/preview\?/.test(route)) return pick(value, ["idea", "title", "version", "pursued", "checkpoint", "pending", "snapshots", "current", "entries", "defaultEntry", "risks", "failedRisks"]);
  if (/\/native\/production\/commit$/.test(route)) return pick(value, ["idea", "title", "version", "hash", "checkpoint", "checkpointMessage", "snapshots", "note", "committedAt", "number", "entry", "risks", "acceptedFailedRisks"]);
  // Runs: records the backend wrote from what executed (no credentials or paths beyond the run's own).
  if (/\/native\/runs\?idea=/.test(route)) return pick(value, ["idea", "entries", "manifestError", "runs", "limit", "agentUsage"]);
  if (/\/native\/runs\/(status\?|submit$|cancel$)/.test(route)) return value;
  if (/\/native\/runs\/log\?/.test(route)) return pick(value, ["text", "offset", "next", "size"]);
  if (/\/native\/runs\/compare\?/.test(route)) return pick(value, ["a", "b", "differences", "warnings", "metrics", "usage"]);
  if (/\/native\/runs\/output\?/.test(route)) return pick(value, ["path", "kind", "bytes", "mime", "base64", "text", "truncated", "tooLarge"]);
  if (/\/native\/runs\/limit$/.test(route)) return pick(value, ["runs", "minutes"]);
  if (/\/native\/risks\?idea=/.test(route)) return pick(value, ["idea", "risks", "counts"]);
  if (/\/native\/risks\/(add|set)$/.test(route)) return pick(value, ["idea", "risk"]);
  if (/\/native\/risks\/delete$/.test(route)) return pick(value, ["deleted"]);
  if (/\/native\/candidate$/.test(route)) return pick(value, ["current", "checks", "state", "validationRuns", "earlier"]);
  if (/\/native\/candidate\/validate$/.test(route)) return value;
  if (/\/native\/rd\/files\?/.test(route)) return pick(value, ["idea", "files"]);
  if (/\/native\/data\/snapshots$/.test(route)) return pick(value, ["folder", "snapshots"]);
  if (/\/native\/data\/jobs$/.test(route)) return pick(value, ["jobs"]);
  if (/\/native\/data\/symbols\?/.test(route)) return pick(value, ["symbols", "total"]);
  if (/\/native\/data\/estimate\?/.test(route)) return pick(value, ["files", "bytes", "first", "last", "missing", "missingCount", "freeBytes"]);
  if (/\/native\/data\/fetch$/.test(route)) return pick(value, ["job"]);
  if (/\/native\/data\/cancel$/.test(route)) return pick(value, ["job", "status"]);
  if (/\/native\/data\/delete$/.test(route)) return pick(value, ["deleted", "bytes", "references"]);
  if (/\/native\/data\/(preview\?|register$)/.test(route))
    return pick(value, ["version", "name", "title", "file", "format", "source", "query", "createdAt", "rows", "columns", "types", "first", "last", "bytes", "sha256", "parts", "missing", "preview", "references", "retainedBy"]);
  if (/\/native\/rd\/file\?/.test(route)) return pick(value, ["path", "kind", "bytes", "mime", "base64", "text", "truncated", "tooLarge"]);
  if (/\/native\/rd\/changes\?/.test(route)) return pick(value, ["files", "added", "removed"]);
  if (/\/native\/rd\/history\?/.test(route)) return pick(value, ["checkpoints", "sha", "files", "added", "removed"]);
  if (/\/native\/rd\/diff\?/.test(route)) return pick(value, ["path", "sha", "diff", "truncated", "binary"]);
  if (/\/native\/rd\/checkpoint$/.test(route)) return pick(value, ["sha", "at", "message", "stat"]);
  if (/\/native\/view-events\?/.test(route)) return pick(value, ["seq", "events"]);
  if (/\/native\/view-context\?/.test(route)) return pick(value, ["ok"]);
  if (/\/native\/mcp-access$/.test(route)) return pick(value, ["enabled", "file", "bridge"]);
  if (/\/artifacts\/[0-9a-f-]{36}\/(delete|restore)$/.test(route))
    return pick(value, ["removed", "restored", "artifactId", "annotationsRemoved", "annotationsRestored", "revision"]);
  if (/\/annotations\/[0-9a-f-]{36}\/delete$/.test(route)) return pick(value, ["removed", "annotation", "revision"]);
  if (/\/native\/conversations\/[^/?]+(\?|$)/.test(route))
    return pick(value, [
      "version",
      "logicalSessionId",
      "connected",
      "generation",
      "through",
      "events",
      "truncated",
      "resyncRequired",
      "ui",
      "runtimeState",
      "context",
      "lastSubmission",
      "models",
      "commands",
    ]);
  if (/\/recovery$/.test(route))
    return pick(value, [
      "expectedGeneration",
      "lease",
      "coordination",
      "submissionId",
      "recoveryRequired",
      "reconciled",
    ]);
  if (/\/complete\?/.test(route)) return pick(value, ["items"]);
  if (/\/history\?/.test(route))
    return pick(value, [
      "mode",
      "context",
      "entries",
      "cursor",
      "next",
      "truncated",
    ]);
  const receiptDTO = (receipt: any) => ({
    ...pick(receipt, ["id", "hash", "status"]),
    ...(Array.isArray(receipt?.result?.queue) ? { result: { queue: receipt.result.queue.map((item: any) => ({
      message: String(item.message ?? ""),
      ...(Array.isArray(item.images) ? { images: item.images.map((image: any) => pick(image, ["mimeType", "data"])) } : {}),
    })) } } : {}),
  });
  if (/\/actions$/.test(route)) return receiptDTO(value);
  if (/\/receipts\//.test(route))
    return {
      receipt: value.receipt
        ? receiptDTO(value.receipt)
        : null,
    };
  // Scientific routes own immutable content and receipts; they never contain root tokens.
  // Companion mutation routes return a Strategy; expose only research-owned fields.
  if (/\/(artifacts|annotations|batches)$/.test(route))
    return pick(value, [
      "id",
      "revision",
      "artifacts",
      "annotations",
      "batches",
      "persistence",
    ]);
  return value;
}
