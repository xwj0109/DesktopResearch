import { strategyRenameSchema, strategyDeleteSchema } from "../src/strategy-management-contract.ts";
import { researchRequest } from "./research-routes.ts";
import {
  apiRequestSchema,
  scopeSchema,
  type Scope,
  type LabRequest,
} from "./contracts.ts";
export function scopePath(scope: Scope) {
  return scope.kind === "launcher" ? "/" : `/${scope.kind}/${scope.id}`;
}
export function scopeKey(scope: Scope) {
  return scope.kind === "launcher" ? "launcher" : `${scope.kind}-${scope.id}`;
}
export function documentURL(value: string, scope: Scope) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "pi-research:" &&
      u.hostname === "app" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === scopePath(scope)
    );
  } catch {
    return false;
  }
}
export interface SenderProof {
  registered: boolean;
  destroyed: boolean;
  sessionMatches: boolean;
  mainFrame: boolean;
  url: string;
  scope: Scope;
}
/** Which sender check failed; bounded codes safe for diagnostics. */
export type SenderRejection = "unregistered" | "destroyed" | "session" | "frame" | "url";
export class UntrustedSender extends Error {
  constructor(readonly reason: SenderRejection) {
    super("Untrusted desktop sender");
  }
}
export function assertSender(proof: SenderProof) {
  scopeSchema.parse(proof.scope);
  const reason: SenderRejection | undefined = !proof.registered
    ? "unregistered"
    : proof.destroyed
      ? "destroyed"
      : !proof.sessionMatches
        ? "session"
        : !proof.mainFrame
          ? "frame"
          : !documentURL(proof.url, proof.scope)
            ? "url"
            : undefined;
  if (reason) throw new UntrustedSender(reason);
}
/** Explicit native and research endpoints; no generic Pi RPC or root proxy. */
export function allowedRequest(scope: Scope, input: unknown): LabRequest {
  scopeSchema.parse(scope);
  const request = apiRequestSchema.parse(input);
  if (researchRequest(scope, request)) return request;
  if (scope.kind === "launcher" && /^\/api\/strategy-management\/[0-9a-f-]{36}\/(rename|delete)$/.test(request.path)) {
    if (request.method !== "POST" || !request.body || request.body.length > 4096 || request.headers["content-type"] !== "application/json" || Object.keys(request.headers).length !== 1) throw new Error("Invalid strategy management request");
    const schema = request.path.endsWith("/rename") ? strategyRenameSchema : strategyDeleteSchema;
    schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
    return request;
  }

  const paths =
    scope.kind === "launcher"
      ? ["/api/strategies", "/api/portfolios"]
      : [
          `/api/${scope.kind === "strategy" ? "strategies" : "portfolios"}/${scope.id}`,
        ];
  if (
    !paths.includes(request.path) ||
    !(
      request.method === "GET" ||
      (scope.kind === "launcher" && request.method === "POST")
    )
  )
    throw new Error("Lab route outside window scope/allowlist");
  if (request.method === "GET") {
    if (request.body || Object.keys(request.headers).length)
      throw new Error("GET payload denied");
  } else {
    if (
      request.headers["content-type"] !== "application/json" ||
      Object.keys(request.headers).length !== 1 ||
      !request.body ||
      request.body.length > 4096
    )
      throw new Error("Invalid create payload");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 1 ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 120
    )
      throw new Error("Invalid workspace name");
  }
  return request;
}
