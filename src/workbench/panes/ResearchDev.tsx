import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { chooseIdea, chosenIdea } from "../../workbench-contract";
import { PdfViewer } from "../PdfViewer";
import { Prose } from "../Prose";
import { useResearch } from "../research";
import { PaneVisible, usePoll } from "../usePoll";
import { setBadge } from "../badges";
import type { IdeaCoverage } from "../../idea-coverage";
import { formatTime } from "../transcript";
import { CodeView } from "./CodePane";
import { SendToProduction } from "./Production";

/** Research Development (docs/RESEARCH-FLOW.md): one workspace per pursued idea,
 * a git repository its own Pi conversation works in. These panes only read it
 * (files, changes since the last checkpoint, documents) and record checkpoints,
 * through the same registry operations agents use (rd_*). Nothing executes. */

export interface DevIdea {
  target: string;
  title: string;
  version: number;
  pursuedOnVersion: number | null;
  reason: string;
  pendingEdits: boolean;
  coverage?: IdeaCoverage;
}
/** Window drafts per idea: the document shown in Documents, and the newest one the user has seen. */
const docKey = (idea: string) => `research:doc:${idea}`;
const seenKey = (idea: string) => `research:seen:${idea}`;
const newestDocs = (files?: RdFile[]) => (files ?? []).filter((f) => f.document && f.path !== "README.md").sort((a, b) => b.modified.localeCompare(a.modified));
interface RdFile {
  path: string;
  bytes: number;
  modified: string;
  kind: "text" | "pdf" | "image" | "binary";
  document: boolean;
}

/** The idea being developed: the window's current idea, else the first pursued idea. */
export function developingIdea(view: any, drafts: Record<string, string>): DevIdea | null {
  const pursued: DevIdea[] = view?.pursued ?? [];
  return chosenIdea(pursued, drafts) ?? pursued[0] ?? null;
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

/** Which idea Research Development is working on, stated clearly for the whole stage. */
export function ResearchIdeaBar() {
  const scope = useResearch();
  const [sending, setSending] = useState(false);
  if (!scope.view || scope.portfolio) return null;
  const pursued: DevIdea[] = scope.view.pursued ?? [];
  const dev = developingIdea(scope.view, scope.drafts);
  const inProduction = scope.view.production?.current;
  return (
    <>
    <div className="rd-bar" role="region" aria-label="Idea in development">
      <span className="lbl">developing</span>
      {pursued.length ? (
        <div className="lit-tabs" role="tablist" aria-label="Idea to develop">
          {pursued.map((p) => (
            <button
              key={p.target}
              role="tab"
              aria-selected={dev?.target === p.target}
              className={dev?.target === p.target ? "on" : ""}
              title={`${p.title || "Untitled idea"} · v${p.version}. Each idea has its own workspace and Pi conversation.`}
              onClick={() => chooseIdea(scope.setDraft, p.target)}
            >
              {p.title || "Untitled idea"}
            </button>
          ))}
        </div>
      ) : (
        <span className="rd-none">No pursued ideas yet. Mark an idea Pursue in Ideas to develop it here.</span>
      )}
      {dev && (
        <span className="meta" title={dev.reason}>
          v{dev.version}
          {dev.pursuedOnVersion && dev.pursuedOnVersion !== dev.version ? ` · pursued since v${dev.pursuedOnVersion}` : ""}
          {dev.pendingEdits ? " · unsaved edits in Ideas" : ""}
        </span>
      )}
      {dev && <IdeaStatus dev={dev} />}
      {dev && inProduction?.idea === dev.target && (
        <span className="tag ok" title={`Checkpoint ${inProduction.checkpoint.slice(0, 8)} · ${inProduction.checkpointMessage}`}>
          candidate · v{inProduction.version}
        </span>
      )}
      {dev && (
        <button className={`btn small ${sending ? "primary" : "ghost"}`} onClick={() => setSending((s) => !s)}>
          Create release candidate…
        </button>
      )}
    </div>
    {sending && dev && <SendToProduction idea={dev.target} onClose={() => setSending(false)} />}
    </>
  );
}

/** Where the idea stands, each item a link: its literature, uncheckpointed
 * changes, and the newest document (marked new until seen). */
function IdeaStatus({ dev }: { dev: DevIdea }) {
  const scope = useResearch();
  const files = usePoll<{ files: RdFile[] }>(`/native/rd/files?idea=${dev.target}`, 3000);
  const changes = usePoll<{ files: unknown[] }>(`/native/rd/changes?idea=${dev.target}`, 4000);
  const newest = newestDocs(files.data?.files)[0];
  const fresh = !!newest && newest.modified > (scope.drafts[seenKey(dev.target)] ?? "");
  const pending = changes.data?.files.length;
  useEffect(() => {
    setBadge("changes", pending ? String(pending) : undefined);
    setBadge("documents", fresh ? "new" : undefined);
  }, [pending, fresh]);
  useEffect(() => () => (setBadge("changes"), setBadge("documents")), []);
  const c = dev.coverage;
  const papers = c ? c.papers.primary + c.papers.secondary : 0;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <span className="idea-status" role="group" aria-label="Where this idea stands">
      {c && (
        <button className="is-item" title={c.next ? `Literature · next: ${c.next}` : "Literature"} onClick={() => scope.goToStage?.("literature", "sources")}>
          {plural(papers, "paper")} · {plural(c.notes.total, "note")}
          {c.notes.contradicts ? ` (${c.notes.contradicts} contra)` : ""}
        </button>
      )}
      {pending !== undefined && (
        <button className={`is-item ${pending ? "warn" : ""}`} title={pending ? "Changes since the last checkpoint: not yet checkpointed" : "Everything is checkpointed"} onClick={() => scope.goToStage?.("research", "changes")}>
          {pending ? plural(pending, "change") : "checkpointed"}
        </button>
      )}
      {newest && (
        <button
          className={`is-item ${fresh ? "new" : ""}`}
          title={`Newest document: ${newest.path}`}
          onClick={() => {
            scope.setDraft(docKey(dev.target), newest.path);
            scope.setDraft(seenKey(dev.target), newest.modified);
            scope.goToStage?.("research", "documents");
          }}
        >
          {newest.path.split("/").pop()}
          {fresh ? " • new" : ""}
        </button>
      )}
    </span>
  );
}

/** Put a reference to what is on screen into Pi's input (nothing is sent). */
function AskPi({ text }: { text: string }) {
  const scope = useResearch();
  return (
    <button className="btn small ghost" title="Add a reference to Pi’s input. Nothing is sent until you send it there." onClick={() => scope.appendComposer(text)}>
      Ask Pi
    </button>
  );
}

function NoIdea() {
  return <p className="rd-empty">Choose a pursued idea to develop in the bar above. Each idea has its own workspace folder and Pi conversation.</p>;
}

/* ── viewers ──────────────────────────────────────────────────────────── */

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function csvRows(text: string, sep: string) {
  // Small CSV reader: quoted fields, escaped quotes; enough for a preview.
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length && rows.length < 201; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(field), (field = "");
    else if (c === "\n") row.push(field.replace(/\r$/, "")), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}
function Notebook({ text }: { text: string }) {
  let nb: any;
  try {
    nb = JSON.parse(text);
  } catch {
    return <CodeView source={text} />;
  }
  const src = (s: any) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
  return (
    <div className="rd-notebook">
      {(nb.cells ?? []).map((c: any, i: number) =>
        c.cell_type === "markdown" ? (
          <Prose key={i} text={src(c.source)} />
        ) : (
          <div key={i} className="nb-cell">
            <CodeView source={src(c.source)} />
            {(c.outputs ?? []).map((o: any, j: number) =>
              o.data?.["image/png"] ? (
                <img key={j} alt="cell output" src={`data:image/png;base64,${src(o.data["image/png"]).replace(/\s/g, "")}`} />
              ) : o.text || o.data?.["text/plain"] ? (
                <pre key={j} className="nb-out">{src(o.text ?? o.data["text/plain"])}</pre>
              ) : null,
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** One workspace file, shown the way it reads best (refetched when it changes). */
export function RdViewer({ idea, file }: { idea: string; file: RdFile }) {
  const scope = useResearch();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    setError("");
    scope.client
      .read(`/native/rd/file?idea=${idea}&path=${encodeURIComponent(file.path)}`)
      .then((d) => live && setData(d), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [idea, file.path, file.modified]);
  const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
  const bytes = useMemo(() => (data?.base64 ? fromBase64(data.base64) : null), [data]);
  const rendered = ["md", "markdown", "ipynb", "csv", "tsv"].includes(ext);
  let body: React.ReactNode = <p className="rd-empty">loading…</p>;
  if (error) body = <p className="notice error">{error}</p>;
  else if (data?.path === file.path) {
    if (data.tooLarge) body = <p className="rd-empty">Too large to preview ({size(data.bytes)}).</p>;
    else if (data.kind === "pdf" && bytes) body = <PdfViewer key={`${file.path}:${file.modified}`} bytes={bytes} marks={[]} readOnly onAnnotate={async () => {}} />;
    else if (data.kind === "image" && data.base64) body = <img className="rd-image" alt={file.path} src={`data:${data.mime};base64,${data.base64}`} />;
    else if (data.kind === "binary") body = <p className="rd-empty">Binary file ({size(data.bytes)}); no preview.</p>;
    else if (typeof data.text === "string") {
      const t = data.text as string;
      body =
        rendered && !source ? (
          ext === "ipynb" ? (
            <Notebook text={t} />
          ) : ext === "csv" || ext === "tsv" ? (
            <div className="table-wrap rd-table">
              <table>
                <tbody>
                  {csvRows(t, ext === "tsv" ? "\t" : ",").map((r, i) => (
                    <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Prose text={t} />
          )
        ) : (
          <CodeView source={t} />
        );
      if (data.truncated) body = <>{body}<p className="rd-empty">Showing the first 1 MiB.</p></>;
    }
  }
  return (
    <div className="rd-viewer">
      <div className="rd-viewer-head">
        <span className="path" title={file.path}>{file.path}</span>
        <span className="dim">
          {size(file.bytes)} · {formatTime(file.modified)?.full ?? file.modified}
        </span>
        {rendered && (
          <button className="btn small ghost" onClick={() => setSource((s) => !s)}>
            {source ? "Rendered" : "Source"}
          </button>
        )}
        <AskPi text={`About \`${file.path}\` in this workspace: `} />
      </div>
      <div className="rd-viewer-body">{body}</div>
    </div>
  );
}

/* ── Files ────────────────────────────────────────────────────────────── */

const glyph = (f: RdFile) => (f.kind === "pdf" ? "▤" : f.kind === "image" ? "▧" : f.document ? "≡" : "λ");
/** The idea's workspace: a folder tree and a viewer. */
export function FilesPane() {
  const scope = useResearch();
  const dev = developingIdea(scope.view, scope.drafts);
  const { data, error } = usePoll<{ files: RdFile[] }>(dev ? `/native/rd/files?idea=${dev.target}` : null, 3000);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!dev) return <NoIdea />;
  const files = data?.files ?? [];
  const selected = files.find((f) => f.path === chosen[dev.target]) ?? files.find((f) => f.path === "README.md") ?? null;
  // Folders first, then files, indented by depth; collapsed folders hide their contents.
  const rows: ({ folder: string; depth: number } | { file: RdFile; depth: number })[] = [];
  const seen = new Set<string>();
  for (const f of [...files].sort((a, b) => {
    const da = a.path.includes("/"), db = b.path.includes("/");
    return da === db ? a.path.localeCompare(b.path) : da ? -1 : 1;
  })) {
    const parts = f.path.split("/");
    let hidden = false;
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!seen.has(folder) && !hidden) {
        seen.add(folder);
        rows.push({ folder, depth: i - 1 });
      }
      if (closed.has(folder)) hidden = true;
    }
    if (!hidden) rows.push({ file: f, depth: parts.length - 1 });
  }
  return (
    <div className="rd-split">
      <nav className="rd-tree" aria-label="Workspace files">
        {error && <p className="notice error">{error}</p>}
        {rows.map((r) =>
          "folder" in r ? (
            <button
              key={`d:${r.folder}`}
              className="rd-folder"
              style={{ paddingLeft: 6 + r.depth * 12 }}
              aria-expanded={!closed.has(r.folder)}
              onClick={() => setClosed((c) => (c.has(r.folder) ? new Set([...c].filter((x) => x !== r.folder)) : new Set([...c, r.folder])))}
            >
              {closed.has(r.folder) ? "▸" : "▾"} {r.folder.split("/").pop()}/
            </button>
          ) : (
            <button
              key={r.file.path}
              className={`rd-file ${selected?.path === r.file.path ? "on" : ""}`}
              style={{ paddingLeft: 6 + r.depth * 12 }}
              title={r.file.path}
              onClick={() => setChosen((c) => ({ ...c, [dev.target]: r.file.path }))}
            >
              <span className="g">{glyph(r.file)}</span> {r.file.path.split("/").pop()}
            </button>
          ),
        )}
        {data && !files.length && <p className="rd-empty">The workspace is empty.</p>}
      </nav>
      {selected ? <RdViewer idea={dev.target} file={selected} /> : <p className="rd-empty">Select a file to view it.</p>}
    </div>
  );
}

/* ── Documents ───────────────────────────────────────────────────────── */

/** Documents the work produced (reports, figures, tables, PDFs, notebooks), newest first. */
export function DocumentsPane() {
  const scope = useResearch();
  const dev = developingIdea(scope.view, scope.drafts);
  const { data, error } = usePoll<{ files: RdFile[] }>(dev ? `/native/rd/files?idea=${dev.target}` : null, 3000);
  const visible = useContext(PaneVisible);
  const docs = newestDocs(data?.files);
  const selected = (dev && docs.find((f) => f.path === scope.drafts[docKey(dev.target)])) || docs[0] || null;
  // The newest document counts as seen once it is on screen here.
  const seen = dev ? scope.drafts[seenKey(dev.target)] ?? "" : "";
  useEffect(() => {
    if (dev && visible && selected && selected === docs[0] && selected.modified > seen) scope.setDraft(seenKey(dev.target), selected.modified);
  }, [dev?.target, visible, selected?.path, selected?.modified, seen]);
  if (!dev) return <NoIdea />;
  return (
    <div className="rd-split">
      <nav className="rd-tree" aria-label="Documents">
        {error && <p className="notice error">{error}</p>}
        {docs.map((f) => (
          <button key={f.path} className={`rd-doc ${selected?.path === f.path ? "on" : ""}`} title={f.path} onClick={() => scope.setDraft(docKey(dev.target), f.path)}>
            <span className="t">
              <span className="g">{glyph(f)}</span> {f.path.split("/").pop()}
            </span>
            <span className="m">
              {f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))} · ` : ""}
              {formatTime(f.modified)?.short ?? ""}
            </span>
          </button>
        ))}
        {data && !docs.length && <p className="rd-empty">No documents yet. Reports, figures, tables, PDFs and notebooks Pi produces in this workspace appear here.</p>}
      </nav>
      {selected ? <RdViewer idea={dev.target} file={selected} /> : <p className="rd-empty">Nothing to show yet.</p>}
    </div>
  );
}

/* ── Changes ─────────────────────────────────────────────────────────── */

interface DiffFile {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}
/** Split `git diff` output into files with their lines. */
export function parseDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!head) continue;
    const lines = chunk.split("\n");
    const body = lines.slice(lines.findIndex((l) => l.startsWith("@@") || l.startsWith("Binary")));
    out.push({
      path: head[2],
      lines: body[0] === undefined ? [] : body.filter((l, i) => l || i < body.length - 1),
      added: body.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      removed: body.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
    });
  }
  return out;
}
interface ChangedFile {
  path: string;
  status: string; // A new · M modified · D deleted
  added: number;
  removed: number;
  binary: boolean;
}
const STATUS_TITLE: Record<string, string> = { A: "new", M: "modified", D: "deleted", R: "renamed", T: "type changed" };
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/** One file's diff, fetched on its own (capped per file) so big outputs never hide the rest. */
function FileDiff({ idea, file, sha }: { idea: string; file: ChangedFile; sha?: string }) {
  const scope = useResearch();
  const [data, setData] = useState<{ path: string; diff: string; truncated: boolean; binary: boolean } | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    setImage(null);
    scope.client
      .read(`/native/rd/diff?idea=${idea}&path=${encodeURIComponent(file.path)}${sha ? `&sha=${sha}` : ""}`)
      .then((d: any) => live && setData(d), (e) => live && setError(errorText(e)));
    // Images: show the picture (the current file; a checkpoint's old image is not kept here).
    if (file.binary && IMAGE.test(file.path) && !sha && file.status !== "D")
      scope.client.read(`/native/rd/file?idea=${idea}&path=${encodeURIComponent(file.path)}`).then((d: any) => live && d?.base64 && setImage(`data:${d.mime};base64,${d.base64}`), () => {});
    return () => {
      live = false;
    };
  }, [idea, file.path, file.added, file.removed, sha]);
  const lines = data?.path === file.path ? (parseDiff(data.diff)[0]?.lines ?? []) : null;
  return (
    <div className="rd-viewer chg-diff">
      <div className="rd-viewer-head">
        <span className={`st st-${file.status}`} title={STATUS_TITLE[file.status] ?? file.status}>
          {file.status}
        </span>
        <span className="path" title={file.path}>
          {file.path}
        </span>
        <span className="dim">{file.binary ? "binary" : <><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></>}</span>
        <AskPi text={sha ? `About the changes to \`${file.path}\` in checkpoint ${sha.slice(0, 8)}: ` : `About my changes to \`${file.path}\` since the last checkpoint: `} />
      </div>
      <div className="rd-viewer-body">
        {error ? (
          <p className="notice error">{error}</p>
        ) : image ? (
          <img className="rd-image" alt={file.path} src={image} />
        ) : file.binary ? (
          <p className="rd-empty">Binary file{file.status === "D" ? " (deleted)" : ""}; no text diff.</p>
        ) : lines === null ? (
          <p className="rd-empty">loading…</p>
        ) : !lines.length ? (
          <p className="rd-empty">No line changes (mode or empty file).</p>
        ) : (
          <pre className="chg-lines">
            {lines.map((l, i) => (
              <span key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
                {l || " "}
              </span>
            ))}
          </pre>
        )}
        {data?.truncated && <p className="rd-empty">Showing the first 512 KiB of this file's diff.</p>}
      </div>
    </div>
  );
}

/** Files grouped by folder (folders first, top-level files last), as the list shows them. */
function changedGroups(files: ChangedFile[]) {
  const groups = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  return [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}
/** Changed files grouped by folder, with status letters and line counts. */
function ChangedFiles({ files, selected, onSelect }: { files: ChangedFile[]; selected: string | null; onSelect: (p: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const ordered = changedGroups(files);
  const row = (f: ChangedFile, nested: boolean) => (
    <button key={f.path} className={`chg-file ${selected === f.path ? "on" : ""} ${nested ? "nested" : ""}`} title={f.path} onClick={() => onSelect(f.path)}>
      <span className={`st st-${f.status}`} title={STATUS_TITLE[f.status] ?? f.status}>
        {f.status}
      </span>
      <span className="n">{f.path.split("/").pop()}</span>
      <span className="c">
        {f.binary ? "bin" : (
          <>
            {f.added ? <span className="add">+{f.added}</span> : null}
            {f.removed ? <span className="del"> −{f.removed}</span> : null}
          </>
        )}
      </span>
    </button>
  );
  return (
    <nav className="rd-tree chg-list" aria-label="Changed files">
      {ordered.map(([dir, list]) =>
        dir === "" ? (
          list.map((f) => row(f, false))
        ) : (
          <div key={dir} className="chg-group">
            <button className="rd-folder" aria-expanded={!closed.has(dir)} onClick={() => setClosed((c) => (c.has(dir) ? new Set([...c].filter((x) => x !== dir)) : new Set([...c, dir])))}>
              {closed.has(dir) ? "▸" : "▾"} {dir}/ <span className="count">{list.length}</span>
            </button>
            {!closed.has(dir) && list.map((f) => row(f, true))}
          </div>
        ),
      )}
    </nav>
  );
}

/** What changed since the last checkpoint (or within a past one), recording checkpoints. */
export function ChangesPane() {
  const scope = useResearch();
  const dev = developingIdea(scope.view, scope.drafts);
  const idea = dev?.target;
  const [showing, setShowing] = useState<string>("current");
  const current = showing === "current";
  const changes = usePoll<{ files: ChangedFile[]; added: number; removed: number }>(idea && current ? `/native/rd/changes?idea=${idea}` : null, 4000);
  const history = usePoll<{ checkpoints: { sha: string; at: string; message: string; stat: string }[] }>(idea ? `/native/rd/history?idea=${idea}` : null, 10000);
  const [commit, setCommit] = useState<{ sha: string; files: ChangedFile[]; added: number; removed: number } | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setShowing("current"), [idea]);
  useEffect(() => {
    setCommit(null);
    if (current || !idea) return;
    let live = true;
    scope.client.read(`/native/rd/history?idea=${idea}&sha=${showing}`).then((d: any) => live && setCommit(d), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [showing, idea]);
  if (!dev || !idea) return <NoIdea />;
  const checkpoints = history.data?.checkpoints ?? [];
  const last = checkpoints[0];
  const data = current ? changes.data : commit;
  const files = data?.files ?? [];
  // The default is the first file as listed (folders first).
  const pick = files.find((f) => f.path === selected[showing]) ?? changedGroups(files)[0]?.[1][0] ?? null;
  const checkpoint = async () => {
    setBusy(true);
    setError("");
    try {
      await scope.client.write("/native/rd/checkpoint", { idea, message: message.trim() });
      setMessage("");
      changes.reload();
      history.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rd-changes">
      <header className="rd-changes-head">
        <div className="chg-top">
          <label className="chg-showing">
            <span className="sr-only">Showing</span>
            <select aria-label="Showing" value={showing} onChange={(e) => setShowing(e.target.value)}>
              <option value="current">Current changes{changes.data ? ` · ${changes.data.files.length}` : ""}</option>
              {checkpoints.map((c) => (
                <option key={c.sha} value={c.sha}>
                  Checkpoint: {c.message} · {formatTime(c.at)?.short ?? ""}
                </option>
              ))}
            </select>
          </label>
          <p className="summary">
            {data
              ? files.length
                ? `${plural(files.length, "file")} · +${data.added.toLocaleString("en-US")} −${data.removed.toLocaleString("en-US")}${current && last ? ` since “${last.message}” · ${formatTime(last.at)?.short ?? ""}` : ""}`
                : current
                  ? `No changes${last ? ` since “${last.message}”` : ""}`
                  : "This checkpoint changed no files"
              : "loading…"}
          </p>
        </div>
        {current && (
          <form
            className="rd-checkpoint"
            onSubmit={(e) => {
              e.preventDefault();
              if (message.trim() && files.length && !busy) void checkpoint();
            }}
          >
            <input
              aria-label="Checkpoint message"
              placeholder={files.length ? "What changed? e.g. Fit Kelly fraction under volatility decay" : "Nothing to checkpoint yet"}
              value={message}
              maxLength={500}
              disabled={!files.length || busy}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="btn small primary" type="submit" disabled={!files.length || !message.trim() || busy}>
              {busy ? "Saving…" : "Checkpoint"}
            </button>
          </form>
        )}
        {error && <p className="notice error">{error}</p>}
        {changes.error && <p className="notice error">{changes.error}</p>}
      </header>
      {files.length > 0 ? (
        <div className="rd-split chg-split">
          <ChangedFiles files={files} selected={pick?.path ?? null} onSelect={(p) => setSelected((m) => ({ ...m, [showing]: p }))} />
          {pick ? <FileDiff key={`${showing}:${pick.path}`} idea={idea} file={pick} sha={current ? undefined : showing} /> : null}
        </div>
      ) : null}
    </div>
  );
}
