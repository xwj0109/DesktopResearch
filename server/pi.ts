import type { Workbench } from "./workbench/tools.ts";
import { WORKBENCH_INSTRUCTIONS } from "./workbench/tools.ts";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Rpc, RpcRejected } from "./rpc.ts";
import { Store, Fault, hash } from "./store.ts";
import { type Batch, limits } from "../src/shared.ts";
import type {
  ConversationTab,
  ConversationWorkspace,
} from "../src/conversation.ts";
import type { ConversationWorkspaceAdapter } from "./portfolio-conversation.ts";
import { discoverPi, launchLinkedPi } from "./pi-runtime.ts";
import { PiBindings, type PiLease } from "./pi-bindings.ts";
import {
  piLimits,
  type PiEvent,
  type PiOperation,
  type PiSnapshot,
  type PiSubmission,
  type PiRecoveryRequest,
} from "../src/pi-protocol.ts";
interface Entry {
  rpc: Rpc;
  sid: string;
  tab: ConversationTab;
  ready: boolean;
  busy?: string;
  last: number;
  queue: string[];
  abort?: (error: Error) => void;
  storageFailed: boolean;
  lease?: PiLease;
  nativeBusy?: boolean;
  commandPending?: boolean;
  controlBusy?: boolean;
  uiBusy?: boolean;
  pendingUI: Set<string>;
  submission?: PiSubmission;
}
interface Projection {
  generation: number;
  through: number;
  events: PiEvent[];
  bytes: number;
  truncated: boolean;
}
type DeliveryPatch = Parameters<Store["delivery"]>[2];
/** Run a Pi tool call through the workbench registry and reply to the host
 * with the backend's own result or refusal (never an optimistic success). */
export async function relayWorkbenchTool(
  workbench: Workbench | undefined,
  sid: string,
  event: { requestId?: unknown; name?: unknown; input?: unknown },
  rpc: { request: (type: string, fields?: Record<string, unknown>) => Promise<unknown> },
) {
  let reply: Record<string, unknown>;
  try {
    if (!workbench) throw new Error("Workbench tools are unavailable in this backend.");
    reply = { requestId: event.requestId, result: await workbench.call(sid, String(event.name), event.input, { origin: "agent" }) };
  } catch (error) {
    reply = { requestId: event.requestId, error: String((error as Error)?.message ?? error).slice(0, 2000) };
  }
  await rpc.request("workbench_tool_reply", reply).catch(() => {});
}
export class PiPool {
  /** Workbench operations offered to Pi as tools (see workbench/tools.ts). */
  private workbench?: Workbench;
  attachWorkbench(workbench: Workbench) {
    this.workbench = workbench;
  }
  private portfolioAdapter?: ConversationWorkspaceAdapter;
  private detachPortfolioObserver?: () => void;
  attachPortfolios(adapter: ConversationWorkspaceAdapter) {
    this.detachPortfolioObserver?.();
    this.portfolioAdapter = adapter;
    this.detachPortfolioObserver = adapter.onUncertain?.((id, warning) => {
      const sid = "portfolio:" + id,
        key = sid + ":Portfolio";
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      for (const entry of this.entries.values())
        if (entry.sid === sid)
          this.persistenceFailure(entry, new Fault(503, warning));
    });
  }
  private workspace(key: string): ConversationWorkspace {
    if (!key.startsWith("portfolio:")) return this.store.get(key);
    if (!this.portfolioAdapter)
      throw new Fault(503, "Portfolio conversation adapter unavailable");
    return this.portfolioAdapter.get(key.slice(10));
  }
  private durable(key: string) {
    this.store.storage.assertDurable();
    if (key.startsWith("portfolio:")) {
      if (!this.portfolioAdapter)
        throw new Fault(503, "Portfolio conversation adapter unavailable");
      this.portfolioAdapter.assertDurable(key.slice(10));
    }
  }
  private session(key: string, tab: ConversationTab) {
    const session = this.workspace(key).tabs[tab];
    if (!session)
      throw new Fault(404, "Conversation destination not owned by workspace");
    return session.sessionId;
  }
  private viewSession(key: string, tab: ConversationTab): string | null {
    if (!key.startsWith("portfolio:") || !this.portfolioAdapter?.peek)
      return this.session(key, tab);
    if (tab !== "Portfolio")
      throw new Fault(404, "Conversation destination not owned by workspace");
    return (
      this.portfolioAdapter.peek(key.slice(10))?.tabs[tab]?.sessionId ?? null
    );
  }
  private deliver(key: string, bid: string, patch: DeliveryPatch) {
    if (key.startsWith("portfolio:")) {
      if (!this.portfolioAdapter)
        throw new Fault(503, "Portfolio conversation adapter unavailable");
      this.portfolioAdapter.delivery(key.slice(10), bid, patch);
    } else this.store.delivery(key, bid, patch);
  }
  private entries = new Map<string, Entry>();
  private creating = new Map<string, Promise<Entry>>();
  private warnings = new Map<string, string>();
  private generations = new Map<string, number>();
  private shuttingDown = false;
  private assertCurrent(key: string, generation: number) {
    this.durable(key.slice(0, key.lastIndexOf(":")));
    if (this.shuttingDown) throw new Fault(503, "Pi pool is shutting down");
    if ((this.generations.get(key) ?? 0) !== generation)
      throw new Fault(409, "Pi connection cancelled by Stop");
  }
  private projections = new Map<string, Projection>();
  private _bindings?: PiBindings;
  private get bindings() {
    return (this._bindings ??= new PiBindings(this.store.safe("pi-bindings")));
  }
  private sweep: NodeJS.Timeout;
  constructor(
    private store: Store,
    private executable = process.env.LAB_PI_EXECUTABLE,
    private launch?: typeof Rpc.launch,
    private handoffLauncher = fileURLToPath(
      new URL("../scripts/desktop-pi-handoff.ts", import.meta.url),
    ),
  ) {
    this.sweep = setInterval(() => {
      for (const e of this.entries.values())
        if (
          e.ready &&
          !e.busy &&
          !e.nativeBusy &&
          !e.uiBusy &&
          !e.controlBusy &&
          Date.now() - e.last > 300000
        )
          void e.rpc.close();
    }, 30000);
    this.sweep.unref();
  }
  warning(sid: string) {
    return this.warnings.get(sid);
  }
  info(sid?: string) {
    return {
      configured:
        this.executable === ""
          ? false
          : this.executable
            ? true
            : (() => {
                try {
                  discoverPi();
                  return true;
                } catch {
                  return false;
                }
              })(),
      active: this.entries.size,
      terminating: [...this.entries.values()].filter((e) => e.rpc.isClosed)
        .length,
      limit: 2,
      warning: sid ? this.warning(sid) : undefined,
      mode: this.launch
        ? "Injected test transport; no inference on restore"
        : "Linked installed Pi; native UI; on-demand sessions; no inference on restore",
    };
  }
  private nativeReceipt(
    e: Entry,
    status: PiSubmission["status"],
    detail?: string,
  ) {
    if (!e.lease || !e.submission) return;
    this.bindings.submission(e.sid, e.tab, e.lease, {
      ...e.submission,
      status,
      detail,
    });
    if (["settled", "failed", "uncertain"].includes(status))
      e.submission = undefined;
  }
  private persistenceFailure(e: Entry, error: unknown) {
    e.storageFailed = true;
    this.warnings.set(
      e.sid,
      "Delivery persistence failed. Pi has been stopped; no automatic retry. The last saved status may be stale. Restore disk access and restart to reconcile uncertain work. " +
        (error instanceof Error ? error.message : "Storage error"),
    );
    void e.rpc.close();
  }
  private persist(e: Entry, bid: string, patch: DeliveryPatch) {
    if (e.storageFailed) throw new Error("Delivery storage unavailable");
    try {
      this.deliver(e.sid, bid, patch);
      // The publication may be visible but not confirmed durable. Retain it,
      // but never send or advance the external process on that audit trail.
      this.durable(e.sid);
    } catch (error) {
      this.persistenceFailure(e, error);
      throw error;
    }
  }
  async entry(sid: string, tab: ConversationTab): Promise<Entry> {
    const key = sid + ":" + tab;
    const generation = this.generations.get(key) ?? 0;
    this.assertCurrent(key, generation);
    if (this.creating.has(key)) return this.creating.get(key)!;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.rpc.isClosed)
        throw new Fault(
          429,
          "Owned Pi process is still terminating; wait before reconnecting",
        );
      return existing;
    }
    const promise = this.create(sid, tab, key, generation);
    this.creating.set(key, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(key);
    }
  }
  private async create(
    sid: string,
    tab: ConversationTab,
    key: string,
    generation: number,
  ): Promise<Entry> {
    this.assertCurrent(key, generation);
    if (this.executable === "")
      throw new Fault(
        503,
        "Pi unavailable. Export the saved batch for manual use.",
      );
    if (this.executable && !path.isAbsolute(this.executable))
      throw new Fault(
        503,
        "LAB_PI_EXECUTABLE must be an absolute server-configured path",
      );
    if (this.workspace(sid).lifecycle === "parked")
      throw new Fault(409, "Resume strategy before connecting");
    if (this.warnings.has(sid)) throw new Fault(503, this.warnings.get(sid)!);
    if (this.entries.size >= 2) {
      const idle = [...this.entries.values()].find(
        (e) =>
          e.ready &&
          !e.busy &&
          !e.nativeBusy &&
          !e.uiBusy &&
          !e.controlBusy &&
          !e.queue.length &&
          !e.rpc.isClosed,
      );
      if (idle) await idle.rpc.close();
      else
        throw new Fault(
          429,
          "Pi pool full (2), including starting or terminating processes",
        );
    }
    // Stop/shutdown can cancel this creation while eviction awaited actual exit.
    this.assertCurrent(key, generation);
    // Recheck after waiting for actual process exit; no slot is released on logical close.
    if (this.entries.size >= 2) throw new Fault(429, "Pi pool full (2)");
    if (this.workspace(sid).lifecycle === "parked")
      throw new Fault(409, "Strategy parked while connecting");
    const sessionId = this.session(sid, tab);
    const dir = sid.startsWith("portfolio:")
      ? this.store.safe("portfolio-sessions", sid.slice(10), sessionId)
      : this.store.safe("sessions", sid, sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.store.rejectSymlink(dir);
    const cwd = this.launch
      ? this.store.safe("empty")
      : this.store.safe("pi-workspaces", hash(sid));
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const config = this.store.safe("pi-agent");
    if (this.launch) fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    const knownCanonical = !this.launch
      ? this.bindings.get(sid, tab)?.canonical
      : undefined;
    // A moved data root leaves absolute paths from the old location; repair
    // only on evidence of a move (see PiBindings.relocate) before validating.
    if (knownCanonical) {
      this.bindings.relocate(sid, tab, dir, cwd);
      this.bindings.validateCanonical(sid, tab, dir, cwd);
    }
    const files = knownCanonical
      ? []
      : fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    let session: string | undefined;
    if (files.length > 1)
      throw new Fault(
        409,
        "Multiple session files found; inspect private storage before reconnecting",
      );
    if (files.length === 1) {
      session = path.join(dir, files[0]);
      this.store.rejectSymlink(session);
      if (!fs.lstatSync(session).isFile())
        throw new Fault(403, "Invalid session file");
    }
    const args = [
      "--mode",
      "rpc",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--offline",
      "--no-approve",
      "--session-dir",
      dir,
      ...(session ? ["--session", session] : ["--session-id", sessionId]),
    ];
    this.assertCurrent(key, generation);
    let lease: PiLease | undefined;
    let rpc: Rpc;
    if (this.launch)
      rpc = this.launch(this.executable!, args, cwd, {
        ...process.env,
        PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      });
    else {
      const identity = discoverPi(this.executable);
      const ownership = this.bindings.acquire(sid, tab, sessionId);
      lease = ownership.lease;
      session = ownership.binding.canonical?.path ?? session;
      try {
        if (ownership.binding.canonical)
          this.bindings.validateCanonical(sid, tab, dir, cwd);
        rpc = launchLinkedPi({
          identity,
          cwd,
          sessionDir: dir,
          session,
          generation: lease.generation,
          editorFile: this.store.safe(
            "native-editor",
            hash(sid + ":" + tab) + ".json",
          ),
          noInference: process.env.LAB_PI_NO_INFERENCE === "1",
          ...(this.workbench && !sid.startsWith("portfolio:")
            ? { tools: this.workbench.manifest(), toolInstructions: WORKBENCH_INSTRUCTIONS }
            : {}),
        });
        if (rpc.child.pid) this.bindings.setPid(sid, tab, lease, rpc.child.pid);
      } catch (error) {
        // If a child was created it must exit before ownership can be released.
        if (rpc!) await rpc.close();
        this.bindings.release(sid, tab, lease);
        throw error;
      }
      this.projections.set(key, {
        generation: lease.generation,
        through: 0,
        events: [],
        bytes: 0,
        truncated: false,
      });
    }
    const e: Entry = {
      rpc,
      sid,
      tab,
      ready: false,
      last: Date.now(),
      queue: [],
      storageFailed: false,
      pendingUI: new Set(),
      lease,
    };
    this.entries.set(key, e);
    if (lease)
      rpc.on("event", (event: any) => {
        if (this.entries.get(key) !== e || rpc.isClosed) return;
        try {
          this.bindings.assert(sid, tab, lease!);
          const projection = this.projections.get(key)!;
          if (
            event.version !== 1 ||
            event.generation !== projection.generation ||
            !Number.isSafeInteger(event.seq) ||
            event.seq <= projection.through
          )
            return;
          projection.through = event.seq;
          if (event.type === "workbench_tool_request") {
            void relayWorkbenchTool(this.workbench, sid, event, rpc);
            return;
          }
          if (event.type === "binding_request") {
            this.bindings.bind(sid, tab, lease!, event.canonical, dir);
            void rpc
              .request("bind_session", { requestId: event.requestId })
              .catch((error) => this.persistenceFailure(e, error));
            return;
          }
          if (event.type === "agent_start") e.nativeBusy = true;
          if (event.type === "agent_settled" && !e.commandPending) {
            e.nativeBusy = false;
            this.nativeReceipt(
              e,
              "settled",
              "Agent settled; inspect canonical messages for result or cancellation",
            );
          }
          if (
            event.type === "prompt_end" &&
            e.submission?.kind === "prompt" &&
            event.requestId === e.submission.id
          ) {
            e.nativeBusy = !!event.isStreaming;
            this.nativeReceipt(
              e,
              event.error ? "failed" : "settled",
              event.error
                ? String(event.error).slice(0, 1000)
                : "SDK prompt handler returned; input may have been consumed without model work",
            );
          }
          if (event.type === "command_end") {
            e.commandPending = false;
            e.nativeBusy = !!event.isStreaming;
            this.nativeReceipt(
              e,
              event.error ? "failed" : "settled",
              event.error
                ? String(event.error).slice(0, 1000)
                : "Registered command returned; not proof of model reasoning",
            );
          }
          projection.events.push(event);
          projection.bytes += Buffer.byteLength(JSON.stringify(event));
          if (event.type === "projection_truncated")
            projection.truncated = true;
          while (
            projection.events.length > piLimits.replayEvents ||
            projection.bytes > piLimits.replayBytes
          ) {
            projection.bytes -= Buffer.byteLength(
              JSON.stringify(projection.events.shift()),
            );
            projection.truncated = true;
          }
          if (event.type === "ui_request") e.pendingUI.add(event.request.id);
          if (event.type === "terminal_open" && event.kind === "custom")
            e.pendingUI.add("terminal:" + event.surfaceId);
          if (event.type === "ui_closed") e.pendingUI.delete(event.requestId);
          if (event.type === "terminal_closed")
            e.pendingUI.delete("terminal:" + event.surfaceId);
          e.uiBusy = e.pendingUI.size > 0;
        } catch (error) {
          this.persistenceFailure(e, error);
        }
      });
    rpc.once("exited", () => {
      if (lease) {
        try {
          this.bindings.release(sid, tab, lease);
        } catch (error) {
          this.warnings.set(
            sid,
            (this.warnings.get(sid) ? this.warnings.get(sid) + " " : "") +
              "Pi exited but writer lease release is uncertain: " +
              String(error),
          );
        }
      }
      if (this.entries.get(key) === e) this.entries.delete(key);
    });
    rpc.once("closed", (error: Error) => {
      if (!e.storageFailed) {
        try {
          this.nativeReceipt(
            e,
            "uncertain",
            "Host closed before terminal completion; never automatically replayed",
          );
        } catch (error) {
          e.storageFailed = true;
          this.warnings.set(
            sid,
            "Native submission receipt persistence is uncertain: " +
              String(error),
          );
        }
      }
      const p = this.projections.get(key);
      if (lease && p?.generation === lease.generation) {
        const event: PiEvent = {
          version: 1,
          generation: p.generation,
          seq: ++p.through,
          type: "runtime_closed",
          message: error.message,
          submissionMayBeUncertain: !!e.nativeBusy,
        };
        p.events.push(event);
        p.bytes += Buffer.byteLength(JSON.stringify(event));
        while (
          p.events.length > piLimits.replayEvents ||
          p.bytes > piLimits.replayBytes
        ) {
          p.bytes -= Buffer.byteLength(JSON.stringify(p.events.shift()));
          p.truncated = true;
        }
      }
      e.abort?.(error);
      const queued = e.queue.splice(0);
      for (const bid of queued) {
        if (e.storageFailed) break;
        try {
          this.persist(e, bid, {
            status: "failed",
            detail: "Connection closed before transport; not sent",
          });
        } catch {
          break;
        }
      }
    });
    try {
      const state = await rpc.request("get_state");
      this.assertCurrent(key, generation);
      if (state?.isStreaming)
        throw new Fault(
          409,
          "Owned Pi unexpectedly busy on connection; stopped without submitting",
        );
      e.ready = true;
      return e;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
  async handshake(sid: string, tab: ConversationTab) {
    const e = await this.entry(sid, tab);
    e.last = Date.now();
    try {
      const [state, data] = await Promise.all([
        e.rpc.request("get_state"),
        e.rpc.request("get_available_models"),
      ]);
      const models = (Array.isArray(data) ? data : (data?.models ?? [])).map(
        (m: any) => ({
          id: String(m.id),
          provider: String(m.provider),
          name: String(m.name ?? m.id),
        }),
      );
      return {
        sessionId: this.session(sid, tab),
        isStreaming: !!state?.isStreaming,
        models,
        selectedModel: state?.model,
        thinkingLevel: state?.thinkingLevel,
        availableThinkingLevels: state?.availableThinkingLevels,
        runtimeState: e.lease ? state : undefined,
        canonical: e.lease ? this.bindings.get(sid, tab)?.canonical : undefined,
        generation: e.lease?.generation,
        notice: e.lease
          ? "No prompt sent. Uses installed Pi resources and authentication. Settings/model choices are session-local; extensions retain their normal user-level authority."
          : "No prompt sent. Injected test transport.",
      };
    } catch (error) {
      await e.rpc.close();
      throw error;
    }
  }
  async send(sid: string, bid: string) {
    this.durable(sid);
    const s = this.workspace(sid),
      b = s.batches.find((b) => b.id === bid);
    if (!b) throw new Fault(404, "Batch not found");
    if (b.behavior !== "followUp")
      throw new Fault(
        400,
        "Live steering is deferred; create a follow-up snapshot",
      );
    if (b.status !== "draft")
      throw new Fault(
        409,
        "Already attempted. Create a new explicit snapshot for any retry; inspect possible duplicate delivery first.",
      );
    if (!b.model.id || !b.model.provider)
      throw new Fault(
        400,
        "Snapshot has no model. Connect, choose a model, save tab and create a new snapshot.",
      );
    if (s.lifecycle === "parked") throw new Fault(409, "Strategy parked");
    if (this.warnings.has(sid)) throw new Fault(503, this.warnings.get(sid)!);
    if (
      !this.launch &&
      this.bindings.requiresRecovery(this.bindings.get(sid, b.destination))
    )
      throw new Fault(
        409,
        "Previous native submission requires explicit reconciliation before sending a batch",
      );
    this.deliver(sid, bid, {
      status: "pending",
      detail: "Waiting for owned Pi connection",
      attempts: b.attempts + 1,
    });
    try {
      this.durable(sid);
    } catch (error) {
      for (const entry of this.entries.values())
        if (this.store.storage.durability === "uncertain" || entry.sid === sid)
          this.persistenceFailure(entry, error);
      throw error;
    }
    let e: Entry;
    try {
      e = await this.entry(sid, b.destination);
    } catch (error) {
      try {
        this.deliver(sid, bid, {
          status: "failed",
          detail: (error as Error).message,
        });
      } catch {
        this.warnings.set(
          sid,
          "Could not persist connection failure; no prompt sent. Restore disk access and restart.",
        );
      }
      throw error;
    }
    if (e.rpc.isClosed || this.workspace(sid).lifecycle === "parked") {
      this.persist(e, bid, {
        status: "failed",
        detail: "Connection stopped before transport; not sent",
      });
      throw new Fault(409, "Connection stopped");
    }
    if ((e.nativeBusy && !e.busy) || e.uiBusy || e.controlBusy) {
      this.persist(e, bid, {
        status: "failed",
        detail: "Native conversation or UI is active; batch not sent",
      });
      throw new Fault(409, "Native conversation or approval is active");
    }
    if (e.busy) {
      if (e.queue.length >= 5) {
        this.persist(e, bid, {
          status: "failed",
          detail: "Local queue full (5); no prompt sent",
        });
        throw new Fault(429, "Queue full");
      }
      e.queue.push(bid);
      this.persist(e, bid, {
        detail:
          "Locally queued; not yet accepted by Pi. Serialized for exact completion correlation.",
      });
    } else this.start(e, bid);
  }
  private start(e: Entry, bid: string) {
    // Every detached task has a final containment boundary, including synchronous persistence errors.
    void this.run(e, bid).catch((error) => this.persistenceFailure(e, error));
  }
  private async run(e: Entry, bid: string) {
    e.busy = bid;
    e.last = Date.now();
    const b = this.workspace(e.sid).batches.find((b) => b.id === bid)!;
    let ack = false,
      settled = false,
      failed = "",
      response = "",
      transportStarted = false,
      finished = false;
    let timer: NodeJS.Timeout | undefined;
    const seen = new Set<string>();
    const requestId = randomUUID();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      e.rpc.off("event", onEvent);
      e.abort = undefined;
    };
    const finish = (
      status: Batch["status"],
      detail: string,
      continueQueue = true,
    ) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!e.storageFailed) {
        try {
          this.persist(e, bid, { status, detail, response });
        } catch {
          /* persistenceFailure closed the process */
        }
      }
      e.busy = undefined;
      e.last = Date.now();
      if (status === "delivery-uncertain" || e.storageFailed) {
        void e.rpc.close();
        return;
      }
      if (continueQueue && !e.rpc.isClosed) {
        const next = e.queue.shift();
        if (next) this.start(e, next);
      }
    };
    const complete = () => {
      if (ack && settled)
        finish(
          failed ? "failed" : response ? "completed" : "delivery-uncertain",
          failed ||
            (!response
              ? "Pi settled without a terminal assistant response; inspect session before retrying."
              : "Pi acknowledged and fully settled with an assistant response."),
        );
    };
    const onEvent = (v: any) => {
      if (
        !transportStarted ||
        finished ||
        (v.requestId && v.requestId !== requestId)
      )
        return;
      try {
        if (
          [
            "message_end",
            "agent_settled",
            "agent_start",
            "error",
            "agent_error",
          ].includes(v.type)
        ) {
          const fingerprint = hash(JSON.stringify(v));
          if (seen.has(fingerprint)) return;
          if (seen.size >= 1000) {
            finish(
              "delivery-uncertain",
              "Terminal event count exceeded 1000; stopped without truncating",
            );
            return;
          }
          seen.add(fingerprint);
        }
        if (v.type === "agent_start" && ack)
          this.persist(e, bid, {
            status: "working",
            detail: "Pi agent started",
          });
        if (v.type === "message_end" && v.message?.role === "assistant") {
          const m = v.message;
          if (
            m.stopReason === "error" ||
            m.stopReason === "aborted" ||
            m.errorMessage
          )
            failed = String(m.errorMessage ?? m.stopReason).slice(0, 2000);
          const text = Array.isArray(m.content)
            ? m.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n")
            : "";
          if (Buffer.byteLength(response + text + "\n") > limits.prompt) {
            finish(
              "delivery-uncertain",
              "Assistant response exceeded 128 KiB storage limit; process stopped, inspect session",
            );
            return;
          }
          if (text) response += text + "\n";
        }
        if (v.type === "error" || v.type === "agent_error")
          failed = String(v.error ?? v.message ?? "Pi error").slice(0, 2000);
        if (
          v.type === "agent_settled" ||
          (v.type === "prompt_end" && v.requestId === requestId)
        ) {
          if (v.error) failed = String(v.error).slice(0, 2000);
          settled = true;
          complete();
        }
      } catch (error) {
        this.persistenceFailure(e, error);
        finish(
          "delivery-uncertain",
          "Delivery event persistence failed",
          false,
        );
      }
    };
    e.abort = (error) =>
      finish(
        transportStarted ? "delivery-uncertain" : "failed",
        error.message,
        false,
      );
    try {
      this.persist(e, bid, { requestId });
      e.rpc.on("event", onEvent);
      timer = setTimeout(
        () =>
          finish(
            "delivery-uncertain",
            "No full settlement within 10 minutes; stopped and never automatically retried",
          ),
        600000,
      );
      await e.rpc.request("set_model", {
        provider: b.model.provider,
        modelId: b.model.id,
      });
      if (finished || e.rpc.isClosed) return;
      this.durable(e.sid);
      transportStarted = true;
      await e.rpc.request(
        "prompt",
        { message: b.prompt, streamingBehavior: b.behavior },
        requestId,
      );
      if (finished) return;
      ack = true;
      this.persist(e, bid, {
        status: "accepted/queued",
        detail: "Correlated prompt ACK; not proof of successful reasoning",
      });
      complete();
    } catch (error) {
      finish(
        transportStarted && !(error instanceof RpcRejected)
          ? "delivery-uncertain"
          : "failed",
        (error as Error).message,
      );
    }
  }
  /** View restoration is read-only: never call entry() from a snapshot/history route. */
  async snapshot(
    sid: string,
    tab: ConversationTab,
    after = 0,
    expectedGeneration?: number,
  ): Promise<PiSnapshot> {
    const logicalSessionId = this.viewSession(sid, tab),
      key = sid + ":" + tab;
    const e = this.entries.get(key);
    const [ui, runtimeState] =
      e && !e.rpc.isClosed && e.lease
        ? await Promise.all([
            e.rpc.request("get_ui"),
            e.rpc.request("get_runtime_snapshot"),
          ])
        : [undefined, undefined];
    const cached = this.projections.get(key);
    const binding = this.launch ? undefined : this.bindings.get(sid, tab);
    const p =
      cached && (!binding || cached.generation === binding.generation)
        ? cached
        : undefined;
    const earliest = p?.events[0]?.seq ?? 0;
    const generation = p?.generation ?? binding?.generation ?? 0;
    const cursorGap =
      (!!cached && !p) ||
      (expectedGeneration !== undefined && expectedGeneration !== generation) ||
      after > (p?.through ?? 0) ||
      (after > 0 && after < earliest - 1);
    const unreviewedProjectionLoss =
      p?.events.some(
        (event) => event.seq > after && event.type === "projection_truncated",
      ) ?? false;
    return {
      version: 1,
      logicalSessionId,
      binding,
      connected: !!e && !e.rpc.isClosed,
      generation,
      through: p?.through ?? 0,
      events: p?.events.filter((event) => event.seq > after) ?? [],
      truncated: !!p?.truncated, // retention metadata, not a permanent resync demand
      resyncRequired:
        cursorGap ||
        unreviewedProjectionLoss ||
        (!!binding?.canonical && (!p || after === 0)),
      ui: this.entries.get(key) === e ? ui : undefined,
      runtimeState: this.entries.get(key) === e ? runtimeState : undefined,
    };
  }
  history(
    sid: string,
    tab: ConversationTab,
    cursor = 0,
    limit = 50,
    raw = false,
  ) {
    const logical = this.viewSession(sid, tab);
    if (logical) {
      const dir = sid.startsWith("portfolio:")
        ? this.store.safe("portfolio-sessions", sid.slice(10), logical)
        : this.store.safe("sessions", sid, logical);
      this.bindings.validateCanonical(
        sid,
        tab,
        dir,
        this.store.safe("pi-workspaces", hash(sid)),
      );
    }
    return this.bindings.history(sid, tab, cursor, limit, raw);
  }
  async nativeHistory(
    sid: string,
    tab: ConversationTab,
    cursor = 0,
    context?: string,
  ) {
    const e = this.entries.get(sid + ":" + tab);
    if (e && !e.rpc.isClosed && e.ready)
      return e.rpc.request("get_native_history", { cursor, context });
    const page = this.history(sid, tab, cursor);
    return {
      mode: "offline-append-log",
      context: null,
      entries: page.entries,
      cursor: page.cursor,
      next: page.next,
      truncated: page.truncated,
    };
  }
  async nativeModels(sid: string, tab: ConversationTab) {
    const e = this.entries.get(sid + ":" + tab);
    if (!e || e.rpc.isClosed || !e.ready) return [];
    const data = await e.rpc.request("get_available_models");
    return (data?.models ?? []).map((m: any) => ({
      id: String(m.id),
      provider: String(m.provider),
      name: String(m.name ?? m.id),
    }));
  }
  async operate(
    sid: string,
    tab: ConversationTab,
    operation: PiOperation,
    generation?: number,
    intent?: { id: string; context: string | null; sessionId?: string },
  ) {
    this.durable(sid);
    this.session(sid, tab);
    const e = this.entries.get(sid + ":" + tab);
    if (!e || e.rpc.isClosed || !e.lease)
      throw new Fault(
        409,
        "Explicit Connect required for linked Pi operations",
      );
    if (generation !== undefined && generation !== e.lease.generation)
      throw new Fault(409, "Stale runtime generation");
    this.bindings.assert(sid, tab, e.lease);
    const passive = [
      "queue",
      "retrieve_queue",
      "ui_response",
      "terminal_input",
      "terminal_resize",
      "terminal_cancel",
      "cancel",
      "editor_state",
      "resync_ui",
      "detach_view",
    ].includes(operation.type);
    if (
      !passive &&
      (e.busy || e.nativeBusy || e.uiBusy || e.controlBusy || e.queue.length)
    )
      throw new Fault(409, "Conversation is busy");
    if (
      this.workspace(sid).lifecycle === "parked" &&
      operation.type !== "cancel"
    )
      throw new Fault(409, "Workspace is parked");
    if (operation.type === "queue" && (e.busy || e.controlBusy || e.commandPending || e.queue.length))
      throw new Fault(409, "Wait for the current submission or research batch before queuing input");
    e.last = Date.now();
    if (operation.type === "prompt" || operation.type === "command") {
      if (this.bindings.requiresRecovery(this.bindings.get(sid, tab)))
        throw new Fault(
          409,
          "Previous native submission requires explicit reconciliation before another send",
        );
      e.submission = {
        id: intent?.id ?? randomUUID(),
        kind: operation.type,
        status: "pending",
        at: new Date().toISOString(),
      };
      try {
        this.nativeReceipt(
          e,
          "pending",
          "Explicit native submission intent saved before transport",
        );
      } catch (error) {
        this.persistenceFailure(e, error);
        throw error;
      }
      e.nativeBusy = true;
    }
    if (operation.type === "command") e.commandPending = true;
    const { type, ...fields } = operation;
    const submission = e.submission;
    if (!passive) e.controlBusy = true;
    try {
      const result = await e.rpc.request(
        type,
        {
          ...fields,
          ...(intent
            ? { ...(["queue", "retrieve_queue", "cancel"].includes(type) && intent.sessionId ? { expectedSessionId: intent.sessionId } : { expectedContext: intent.context }), inputId: intent.id }
            : {}),
        },
        submission && (type === "prompt" || type === "command")
          ? submission.id
          : undefined,
      );
      if (
        submission &&
        (type === "prompt" || type === "command") &&
        e.submission?.id === submission.id
      )
        this.nativeReceipt(
          e,
          "accepted",
          "Host acknowledged dispatch; not proof of completion",
        );
      return result;
    } catch (error) {
      if (type === "queue" && !(error instanceof RpcRejected)) {
        this.nativeReceipt(e, "uncertain", "Queued input acceptance is uncertain; inspect history before retrying");
        await e.rpc.close();
      }
      if (
        (type === "prompt" || type === "command") &&
        !(error instanceof RpcRejected)
      ) {
        // Completion can precede a lost transport ACK. A durable terminal receipt
        // for this exact generation/submission must not become an unreconcilable
        // workspace warning (nor be downgraded or replayed). Keep the request
        // error visible; canonical history and its receipt remain authoritative.
        let terminalReceipt = false;
        if (!e.storageFailed && submission) {
          try {
            const binding = this.bindings.get(sid, tab);
            terminalReceipt =
              binding?.generation === e.lease.generation &&
              binding.lastSubmission?.id === submission.id &&
              binding.lastSubmission.kind === type &&
              ["settled", "failed"].includes(binding.lastSubmission.status);
          } catch (receiptError) {
            this.persistenceFailure(e, receiptError);
          }
        }
        if (!terminalReceipt) {
          try {
            this.nativeReceipt(
              e,
              "uncertain",
              "Native submission acceptance is uncertain; never replayed",
            );
          } catch (receiptError) {
            this.persistenceFailure(e, receiptError);
          }
          if (!e.storageFailed)
            this.warnings.set(
              sid,
              "Native submission acceptance is uncertain; stopped and never automatically replayed. Inspect canonical history before retrying.",
            );
          await e.rpc.close();
        }
      } else if (type === "prompt" || type === "command") {
        try {
          this.nativeReceipt(e, "failed", String(error).slice(0, 1000));
        } catch (receiptError) {
          this.persistenceFailure(e, receiptError);
        }
        e.nativeBusy = false;
        e.commandPending = false;
      }
      throw error;
    } finally {
      if (!passive) e.controlBusy = false;
    }
  }
  private assertViewGeneration(
    sid: string,
    tab: ConversationTab,
    expected: number,
  ) {
    this.viewSession(sid, tab);
    const current =
      this.entries.get(sid + ":" + tab)?.lease?.generation ??
      this.bindings.get(sid, tab)?.generation ??
      0;
    if (current !== expected)
      throw new Fault(
        409,
        "Stale runtime generation; refresh before destructive operations",
      );
  }
  async stopView(sid: string, tab: ConversationTab, generation?: number) {
    // Explicitly injected legacy test transports retain their old HTTP contract.
    if (this.launch && generation === undefined) return this.stop(sid, tab);
    if (!Number.isSafeInteger(generation) || generation! < 0)
      throw new Fault(
        400,
        "Expected runtime generation is required for renderer Stop",
      );
    this.assertViewGeneration(sid, tab, generation!);
    // No await between the generation check and Stop's synchronous creation fence.
    await this.stop(sid, tab);
  }
  ownership(sid: string, tab: ConversationTab) {
    const logical = this.viewSession(sid, tab);
    const dir = logical
      ? sid.startsWith("portfolio:")
        ? this.store.safe("portfolio-sessions", sid.slice(10), logical)
        : this.store.safe("sessions", sid, logical)
      : undefined;
    return this.bindings.inspect(
      sid,
      tab,
      dir,
      this.store.safe("pi-workspaces", hash(sid)),
    );
  }
  reconcile(sid: string, tab: ConversationTab, request: PiRecoveryRequest) {
    this.durable(sid);
    const logical = this.viewSession(sid, tab),
      key = sid + ":" + tab;
    if (!logical) throw new Fault(409, "Conversation has not been initialized");
    if (this.entries.has(key) || this.creating.has(key))
      throw new Fault(
        409,
        "Stop and wait for actual managed child exit before reconciliation",
      );
    const dir = sid.startsWith("portfolio:")
      ? this.store.safe("portfolio-sessions", sid.slice(10), logical)
      : this.store.safe("sessions", sid, logical);
    let binding;
    try {
      binding = this.bindings.reconcile(
        sid,
        tab,
        logical,
        dir,
        request,
        this.store.safe("pi-workspaces", hash(sid)),
      );
    } catch (error) {
      throw new Fault(
        409,
        error instanceof Error
          ? error.message
          : "Pi reconciliation failed closed",
      );
    }
    // Only this narrow transport warning is cleared. Storage/durability failures remain gated.
    if (
      this.warnings.get(sid) ===
      "Native submission acceptance is uncertain; stopped and never automatically replayed. Inspect canonical history before retrying."
    )
      this.warnings.delete(sid);
    return { binding, warning: this.warnings.get(sid) };
  }
  async handoff(sid: string, tab: ConversationTab, generation?: number) {
    this.durable(sid);
    this.session(sid, tab);
    if (this.launch)
      throw new Fault(409, "CLI handoff requires linked installed Pi");
    if (generation !== undefined)
      this.assertViewGeneration(sid, tab, generation);
    await this.stop(sid, tab);
    if (generation !== undefined)
      this.assertViewGeneration(sid, tab, generation);
    const binding = this.bindings.get(sid, tab);
    if (!binding?.canonical)
      throw new Fault(409, "Connect once before CLI handoff");
    const logicalSessionId = this.session(sid, tab);
    const dir = sid.startsWith("portfolio:")
      ? this.store.safe("portfolio-sessions", sid.slice(10), logicalSessionId)
      : this.store.safe("sessions", sid, logicalSessionId);
    const cwd = this.store.safe("pi-workspaces", hash(sid));
    this.bindings.relocate(sid, tab, dir, cwd);
    this.bindings.validateCanonical(sid, tab, dir, cwd);
    if (this.bindings.requiresRecovery(binding))
      throw new Fault(
        409,
        "Reconcile the uncertain native submission before CLI handoff",
      );
    const identity = discoverPi(this.executable);
    return {
      bindingFile: this.bindings.file(sid, tab),
      executable: identity.executable,
      node: identity.node,
      canonical: this.bindings.get(sid, tab)?.canonical ?? binding.canonical,
      launcher: this.handoffLauncher,
      notice:
        "Run the managed launcher in your terminal. It acquires the same lease; reconnect is refused while it runs. Unmanaged CLI writers bypass advisory ownership and must not open this file concurrently.",
    };
  }
  async complete(sid: string, tab: ConversationTab, text: string, generation: number) {
    this.viewSession(sid, tab);
    const e = this.entries.get(sid + ":" + tab);
    if (!e?.lease || !e.ready || e.rpc.isClosed || e.lease.generation !== generation) return { items: [] };
    return e.rpc.request("complete", { text });
  }
  async commandCatalog(sid: string, tab: ConversationTab) {
    this.viewSession(sid, tab);
    const e = this.entries.get(sid + ":" + tab);
    return e?.lease && e.ready && !e.rpc.isClosed
      ? e.rpc.request("get_commands")
      : [];
  }
  assertStrategyDeletable(sid: string) {
    for (const tab of Object.keys(this.workspace(sid).tabs) as ConversationTab[]) {
      const key = sid + ":" + tab;
      if (this.entries.has(key) || this.creating.has(key))
        throw new Fault(409, "Stop connected strategy sessions before deleting.", { code: "strategy-busy" });
      if (this.ownership(sid, tab).recoveryRequired)
        throw new Fault(409, "Resolve strategy session ownership before deleting.", { code: "strategy-busy" });
    }
  }
  async stop(sid: string, tab?: ConversationTab) {
    const keys = (tab ? [tab] : Object.keys(this.workspace(sid).tabs)).map(
      (t) => sid + ":" + t,
    );
    for (const key of keys) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
    const pending = keys.flatMap((key) => {
      const p = this.creating.get(key);
      return p ? [p] : [];
    });
    await Promise.all([
      ...[...this.entries.values()]
        .filter((e) => e.sid === sid && (!tab || e.tab === tab))
        .map((e) => e.rpc.close()),
      Promise.allSettled(pending),
    ]);
  }
  async close() {
    this.shuttingDown = true;
    this.detachPortfolioObserver?.();
    clearInterval(this.sweep);
    await Promise.all([
      ...[...this.entries.values()].map((e) => e.rpc.close()),
      Promise.allSettled([...this.creating.values()]),
    ]);
  }
}
