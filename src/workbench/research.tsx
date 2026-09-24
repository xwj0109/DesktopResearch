import { Notice } from "./Notice";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  versionInput,
  strategyCommandSchema,
  portfolioCommandSchema,
} from "../platform";
import type { NativeClient } from "../native-client";
import type { Artifact } from "../shared";
import { ResearchForm, fieldLabel, initialValue, pruneBlankItems, type Choice } from "./ResearchForm";

export const commandLabels: Record<string, string> = {
  "idea.decide": "Record idea decision",
  "approval.record": "Approve or reject exact version",
  "handoff.create": "Create data handoff",
  "proposal.review": "Review portfolio proposal",
  "feasibility.record": "Record data feasibility",
  "dataset.ingest": "Ingest declared CSV",
  "run.queue": "Queue reference experiment",
  "run.cancel": "Cancel experiment",
  "run.expose": "Disclose experiment results",
  "export.create": "Freeze evidence export",
  "analysis.create": "Analyze frozen evidence",
  "proposal.create": "Draft producer feedback",
};
export const stageDestinations: Record<string, string> = {
  ideas: "Ideas",
  literature: "Literature",
  research: "Research Development",
  data: "Data",
  code: "Design & Code",
  backtests: "Backtests",
  results: "Results",
};

export interface Companion {
  open: string[];
  pinned: string[];
  active: string | null;
}

/** Everything a working pane needs, provided once per workspace window. */
export interface ResearchScope {
  client: NativeClient;
  portfolio: boolean;
  stage: string;
  view: any;
  loadError: string;
  refresh: () => Promise<void>;
  drafts: Record<string, string>;
  setDraft: (key: string, value: string) => void;
  /** Replace the current stage's composer draft (explicit send still required). */
  setComposer: (text: string) => void;
  /** Append a reference to the current stage's composer draft. */
  appendComposer: (text: string) => void;
  companion: Companion;
  setCompanion: (next: Companion) => void;
}
const Ctx = createContext<ResearchScope | null>(null);
export const ResearchProvider = ({
  value,
  children,
}: {
  value: ResearchScope;
  children: ReactNode;
}) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useOptionalResearch() { return useContext(Ctx); }
export function useResearch() {
  const value = useContext(Ctx);
  if (!value) throw new Error("Research pane rendered outside a workspace");
  return value;
}

/** Single sequenced poller for `/native/research` (read-only, never starts Pi). */
export function useResearchData(client?: NativeClient) {
  const [view, setView] = useState<any>(),
    [error, setError] = useState("");
  const seq = useRef(0),
    mounted = useRef(true);
  const refresh = async () => {
    if (!client) return;
    const n = ++seq.current;
    const next = await client.read("/native/research");
    if (mounted.current && n === seq.current) {
      setView(next);
      setError("");
    }
  };
  useEffect(() => {
    if (!client) return;
    mounted.current = true;
    const tick = () => void refresh().catch((e) => mounted.current && setError(String(e)));
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      mounted.current = false;
      seq.current++;
      clearInterval(timer);
    };
  }, [client]);
  return { view, error, refresh };
}

/** Plain-language form errors: "Evidence 1 / Reference: pick a source or
 * saved record from the list" rather than raw schema messages. */
export function formatIssues(e: unknown) {
  const issues = (e as any)?.issues;
  const where = (path: any[]) =>
    path
      .filter((p, i) => !(i === 0 && p === "content"))
      .map((p, i, all) => (typeof p === "number" ? null : typeof all[i + 1] === "number" ? `${fieldLabel(String(p))} ${Number(all[i + 1]) + 1}` : fieldLabel(String(p))))
      .filter(Boolean)
      .join(" / ");
  const what = (issue: any) => {
    const last = issue.path.at(-1);
    if (last === "hash" || (last === "id" && issue.format === "uuid"))
      return "pick a source or saved record from the list";
    if ((issue.code === "too_small" && issue.origin === "string") || (issue.code === "invalid_type" && issue.input === undefined))
      return "required";
    return issue.message;
  };
  return issues
    ? issues
        .slice(0, 6)
        .map((issue: any) => {
          const reason = what(issue);
          // A reference is one choice to the user: name the field, not its id/hash parts.
          const path = reason.startsWith("pick a source") ? issue.path.slice(0, -1) : issue.path;
          return `${where(path)}: ${reason}`;
        })
        .filter((line: string, i: number, all: string[]) => all.indexOf(line) === i)
        .join(" · ")
    : e instanceof Error
      ? e.message
      : String(e);
}

/** Per-pane mutation runner: one action at a time, exact receipts, visible
 * outcome. Commands are schema-validated before dispatch. */
export function useAction() {
  const scope = useResearch();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const run = async <T,>(
    fn: () => Promise<T>,
    done: string | ((result: T) => string) = "Action completed. Research mutations retain exact receipts.",
  ) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await fn();
      await scope.refresh();
      setStatus(typeof done === "function" ? done(result) : done);
      return true;
    } catch (e) {
      setError(formatIssues(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const sendCommand = async (c: unknown) => {
    const id = crypto.randomUUID();
    const parsed = (scope.portfolio ? portfolioCommandSchema : strategyCommandSchema).parse(c);
    const response = await scope.client.write(
      scope.portfolio ? "/commands" : "/science/commands",
      { operationId: id, revision: scope.view.science.revision, command: parsed },
      id,
    );
    if (response.warning)
      throw new Error(
        "The record was published with a durability warning. Do not repeat the action; inspect its receipt.",
      );
  };
  const notices = (
    <>
      {error && (
        <Notice message={error} error onDismiss={() => setError("")} />
      )}
      {status && (
        <Notice message={status} onDismiss={() => setStatus("")} />
      )}
    </>
  );
  return { busy, run, sendCommand, notices, setError, setStatus };
}

export function useChoices(): Choice[] {
  const { view } = useResearch();
  return useMemo(() => {
    const science = view?.science?.state;
    return [
      ...(science?.versions ?? []).map((v: any) => ({
        id: v.id,
        hash: v.hash,
        label: `${fieldLabel(v.kind)} · v${v.version} · ${v.hash.slice(0, 8)}`,
      })),
      ...(view?.batches ?? []).filter((b: any) => b.annotations?.length).map((b: any) => ({ id: b.id, hash: b.hash, label: `Review · ${b.instruction.slice(0, 100)}` })),
      ...(view?.artifacts ?? []).map((a: Artifact) => ({ id: a.id, hash: a.hash, label: a.name })),
      ...["handoffs", "datasets", "runs", "exports", "imports", "analyses"].flatMap((collection) =>
        (science?.[collection] ?? []).map((r: any) => ({
          id: r.id,
          hash: r.hash,
          label: `${fieldLabel(collection)} · ${r.status ?? ""} ${r.id.slice(0, 8)}`,
        })),
      ),
      ...(science?.imports ?? []).map((r: any) => ({
        id: r.strategyId,
        label: `Producer ${r.strategyId.slice(0, 8)}`,
      })),
    ];
  }, [view]);
}

/** Native research draft codec. Record drafts are stored as
 * `{nativeDraft: 1, content, id}` under `${stage}:${kind}`. */
export function useRecordDraft(key: string, schema: any) {
  const { drafts, setDraft } = useResearch();
  let raw: any;
  try {
    raw = drafts[key] ? JSON.parse(drafts[key]) : undefined;
  } catch {
    raw = undefined;
  }
  const value =
    raw?.nativeDraft === 1 ? raw.content : (raw ?? (schema ? initialValue(schema) : undefined));
  return {
    value,
    id: raw?.nativeDraft === 1 ? (raw.id as string | undefined) : undefined,
    dirty: drafts[key] !== undefined,
    set: (content: any, id = raw?.id) =>
      setDraft(key, JSON.stringify({ nativeDraft: 1, content, id })),
    setRaw: (content: any) => setDraft(key, JSON.stringify(content)),
    clear: () => setDraft(key, ""),
  };
}

/** Latest explicit decision on an exact version: approvals (approve/reject)
 * and idea decisions (pursue/revise/reject), whichever was recorded last. */
export const latestDecision = (science: any, v: { id: string; hash: string }) =>
  [...(science?.approvals ?? []), ...(science?.decisions ?? [])]
    .filter((a: any) => a.target.id === v.id && a.target.hash === v.hash)
    .sort((a: any, b: any) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
    .at(-1)?.decision as string | undefined;
export function DecisionTag({ decision }: { decision?: string }) {
  const d = (decision ?? "unreviewed").toLowerCase();
  const cls = d.startsWith("approv") || d === "pursue" ? "ok" : d.startsWith("reject") ? "warn" : d === "revise" ? "accent" : "";
  return <span className={`tag ${cls}`}>{decision ?? "unreviewed"}</span>;
}

/** Versions of the given record kinds, an exact-version reader and the
 * schema editor that saves the next immutable version. */
export function RecordEditor({
  kinds,
  editorOpen,
  intro,
  children,
}: {
  kinds: string[];
  editorOpen?: boolean;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  const scope = useResearch();
  const { busy, run, sendCommand, notices } = useAction();
  const choices = useChoices();
  const [kind, setKind] = useState(kinds[0]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<any>();
  const science = scope.view?.science?.state;
  const versions: any[] = (science?.versions ?? []).filter((v: any) => kinds.includes(v.kind));
  const schema = versionInput.options.find((s) => s.shape.kind.value === kind)?.shape.content;
  const key = `${scope.stage}:${kind}`;
  const draft = useRecordDraft(key, schema);
  const open = async (v: any) => {
    setSelected(v.id + v.hash);
    try {
      setDetail(await scope.client.read(`/science/versions/${v.id}/${v.hash}`));
    } catch (e) {
      setDetail({ error: String(e) });
    }
  };
  return (
    <div className="pane-inner">
      {intro}
      {notices}
      <section className="block">
        <h3 className="section-title">
          saved versions <span className="count">{versions.length}</span>
        </h3>
        <div className="list" role="listbox" aria-label="Saved versions">
          {[...versions].reverse().map((v) => (
            <button
              key={v.id + v.hash}
              role="option"
              aria-selected={selected === v.id + v.hash}
              className={`list-row ${selected === v.id + v.hash ? "selected" : ""}`}
              onClick={() => void open(v)}
            >
              <span className="title">
                {fieldLabel(v.kind)} · v{v.version}
                <small>{v.hash.slice(0, 16)}</small>
              </span>
              <DecisionTag decision={latestDecision(science, v)} />
            </button>
          ))}
          {!versions.length && <p className="list-empty">No saved versions yet.</p>}
        </div>
      </section>
      {detail?.error && <p className="notice error">{detail.error}</p>}
      {detail?.value && (
        <section className="block">
          <h3 className="section-title">
            {fieldLabel(detail.value.kind).toLowerCase()} · v{detail.meta.version}
          </h3>
          <dl className="kv">
            {Object.entries(detail.value.content).map(([name, v]) => (
              <div key={name}>
                <dt>{fieldLabel(name)}</dt>
                <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
          <div>
            <button
              className="btn small"
              onClick={() => {
                setKind(detail.value.kind);
                scope.setDraft(
                  `${scope.stage}:${detail.value.kind}`,
                  JSON.stringify({ nativeDraft: 1, content: detail.value.content, id: detail.meta.id }),
                );
              }}
            >
              Load this version into the editor
            </button>
          </div>
          <p className="note">
            Loading replaces the unsaved editor draft for this record type. Saving creates the next
            immutable version.
          </p>
        </section>
      )}
      {schema && (
        <details className="fold" open={editorOpen || versions.length === 0}>
          <summary>
            {draft.id ? "Revise saved record" : "Create research record"}
            {draft.dirty && <span className="tag warn">unsaved draft</span>}
          </summary>
          <div className="fold-body">
            {kinds.length > 1 && (
              <label className="fld" style={{ width: "100%" }}>
                Record type
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {fieldLabel(k)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ResearchForm schema={schema} value={draft.value} onChange={(v) => draft.set(v)} choices={choices} />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn primary small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const input = versionInput.parse({ kind, content: pruneBlankItems(schema, draft.value) });
                    await sendCommand({
                      type: "version.create",
                      value: input,
                      ...(draft.id ? { id: draft.id } : {}),
                    });
                  })
                }
              >
                Save immutable version
              </button>
              {draft.dirty && (
                <button className="btn small ghost" onClick={draft.clear}>
                  Discard draft
                </button>
              )}
            </div>
            <p className="note">
              Saving records source and lineage. Approval and scientific validation are separate
              actions.
            </p>
          </div>
        </details>
      )}
      {children}
    </div>
  );
}

/** Explicit research commands for a stage, each a validated form. */
export function ActionPanel({ commands, title = "Research actions" }: { commands: string[]; title?: string }) {
  const scope = useResearch();
  const { busy, run, sendCommand, notices } = useAction();
  const choices = useChoices();
  const [action, setAction] = useState(commands[0]);
  const schema = (scope.portfolio ? portfolioCommandSchema : strategyCommandSchema).options.find(
    (s: any) => s.shape.type.value === action,
  );
  const draft = useRecordDraft(`${scope.stage}:action:${action}`, schema);
  if (!commands.length) return null;
  return (
    <details className="fold">
      <summary>{title}</summary>
      <div className="fold-body">
        {notices}
        <select
          aria-label="Research action"
          value={action}
          style={{ width: "100%" }}
          onChange={(e) => setAction(e.target.value)}
        >
          {commands.map((c) => (
            <option key={c} value={c}>
              {commandLabels[c]}
            </option>
          ))}
        </select>
        {schema && (
          <>
            <ResearchForm schema={schema} value={draft.value} onChange={(v) => draft.setRaw(v)} choices={choices} />
            <button
              className="btn primary small"
              disabled={busy}
              onClick={() => void run(() => sendCommand(pruneBlankItems(schema, draft.value)))}
            >
              {commandLabels[action]}
            </button>
          </>
        )}
      </div>
    </details>
  );
}

/** Loading / unavailable placeholder shared by panes. */
export function PaneLoading() {
  const { view, loadError } = useResearch();
  if (loadError && !view)
    return (
      <div className="pane-inner">
        <p className="notice error">{loadError}</p>
      </div>
    );
  return (
    <div className="pane-inner">
      <p className="note">Loading research records…</p>
    </div>
  );
}
