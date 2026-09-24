import { useEffect, useRef, useState } from "react";
import { versionInput } from "../../platform";
import { highlight } from "../Materials";
import { DecisionTag, PaneLoading, latestDecision, useAction, useResearch } from "../research";

/** Line diff via LCS; bounded so a huge file cannot freeze the renderer. */
export function lineDiff(a: string, b: string) {
  const x = a.split("\n"),
    y = b.split("\n");
  if (x.length * y.length > 4_000_000) return null;
  const m = x.length,
    n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: " " | "+" | "-"; text: string }[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n)
    if (x[i] === y[j]) out.push({ op: " ", text: x[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  while (i < m) out.push({ op: "-", text: x[i++] });
  while (j < n) out.push({ op: "+", text: y[j++] });
  return out;
}

/** Read-only highlighted source with a line gutter. */
export function CodeView({ source }: { source: string }) {
  return (
    <pre className="code">
      {source.split("\n").map((line, i) => (
        <span className={`ln ${/^\s*(#|\/\/)/.test(line) ? "comment" : ""}`} key={i}>
          {/^\s*(#|\/\/)/.test(line) ? line : highlight(line)}
          {line ? "" : " "}
        </span>
      ))}
    </pre>
  );
}

const emptyFile = () => ({
  filename: "strategy.ts",
  language: "typescript",
  source: "",
  symbols: [],
  evidence: [],
});

/** Design & Code right pane (§5.5): editor over the code record draft, with
 * explicit save as a new immutable version. Nothing here executes code. */
export function CodePane() {
  const scope = useResearch();
  const { busy, run, sendCommand, notices } = useAction();
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [base, setBase] = useState<any>();
  const [shown, setShown] = useState<any>();
  const gutter = useRef<HTMLPreElement>(null);
  const science = scope.view?.science?.state;
  const all: any[] = (science?.versions ?? []).filter((v: any) => v.kind === "code");
  const files = [...new Map(all.map((v) => [v.id, v])).values()]; // latest per record
  const [fileId, setFileId] = useState<string>();
  const draftKey = "code:code";
  let raw: any;
  try {
    raw = scope.drafts[draftKey] ? JSON.parse(scope.drafts[draftKey]) : undefined;
  } catch {}
  const editing = raw?.nativeDraft === 1 ? raw : undefined;
  const current = files.find((f) => f.id === (editing?.id ?? fileId)) ?? files.at(-1);
  const baseRef = editing?.base as { id: string; hash: string } | undefined;

  useEffect(() => {
    if (!current || editing) return setShown(undefined);
    let alive = true;
    void scope.client
      .read(`/science/versions/${current.id}/${current.hash}`)
      .then((d: any) => alive && setShown(d.value.content), () => {});
    return () => {
      alive = false;
    };
  }, [current?.hash, !!editing]);
  useEffect(() => {
    if (!baseRef) return setBase(undefined);
    let alive = true;
    void scope.client
      .read(`/science/versions/${baseRef.id}/${baseRef.hash}`)
      .then((d: any) => alive && setBase(d.value.content), () => {});
    return () => {
      alive = false;
    };
  }, [baseRef?.hash]);

  if (!scope.view) return <PaneLoading />;
  const content = editing?.content;
  const write = (next: any, id = editing?.id, b = editing?.base) =>
    scope.setDraft(draftKey, JSON.stringify({ nativeDraft: 1, content: next, id, base: b }));
  const diff = content && base ? lineDiff(base.source, content.source) : null;
  const added = diff?.filter((d) => d.op === "+").length ?? 0,
    removed = diff?.filter((d) => d.op === "-").length ?? 0;
  const save = () =>
    void run(async () => {
      const input = versionInput.parse({ kind: "code", content });
      await sendCommand({ type: "version.create", value: input, ...(editing?.id ? { id: editing.id } : {}) });
      scope.setDraft(draftKey, "");
    }, "Code version saved. It has not been executed; approval is a separate action.");
  const lineCount = (content?.source ?? "").split("\n").length;

  return (
    <div className="pane-col">
      <div className="pane-toolbar">
        <select
          aria-label="Code file"
          value={current?.id ?? ""}
          disabled={!!editing}
          title={editing ? "Save or discard the current edit to switch files" : undefined}
          onChange={(e) => setFileId(e.target.value)}
        >
          {!files.length && <option value="">no saved files</option>}
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id === current?.id && (editing?.content.filename || shown?.filename)
                ? editing?.content.filename || shown?.filename
                : `file ${f.id.slice(0, 6)}`}{" "}
              · v{f.version}
            </option>
          ))}
        </select>
        {current && !editing && <DecisionTag decision={latestDecision(science, current)} />}
        {editing && (
          <span className={`tag ${added + removed ? "warn" : ""}`}>
            {base ? `+${added} −${removed}` : editing.id ? "loading base…" : "new file"}
          </span>
        )}
        <span className="spacer" />
        {!editing && (
          <>
            <button className="btn small" onClick={() => write(emptyFile(), undefined, undefined)}>
              + file
            </button>
            <button
              className="btn small primary"
              disabled={!shown}
              onClick={() => write(shown, current.id, { id: current.id, hash: current.hash })}
            >
              Edit
            </button>
          </>
        )}
        {editing && (
          <>
            <div className="seg" role="tablist" aria-label="Editor mode">
              <button role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>
                edit
              </button>
              <button role="tab" aria-selected={mode === "diff"} disabled={!base} onClick={() => setMode("diff")}>
                diff
              </button>
            </div>
            <button className="btn small ghost" onClick={() => scope.setDraft(draftKey, "")}>
              Discard
            </button>
            <button className="btn small primary" disabled={busy} onClick={save}>
              Save version
            </button>
          </>
        )}
      </div>
      {notices && <div style={{ padding: "0 12px" }}>{notices}</div>}
      {!editing && (
        <div className="pane-body">
          {shown ? (
            <CodeView source={shown.source} />
          ) : (
            <div className="empty">
              <h2>{files.length ? "Loading…" : "No code yet"}</h2>
              <p>
                Start a file or ask Pi for a patch. Saved code is inspected, never executed;
                reference experiments run the declared engine.
              </p>
            </div>
          )}
        </div>
      )}
      {editing && mode === "edit" && (
        <div className="editor">
          <pre ref={gutter} className="lines" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </pre>
          <textarea
            aria-label="Code editor"
            data-autofocus
            spellCheck={false}
            wrap="off"
            value={content.source}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onSelect={(e) => {
              const t = e.currentTarget;
              const before = t.value.slice(0, t.selectionStart).split("\n");
              setCursor({ line: before.length, col: before.at(-1)!.length + 1 });
            }}
            onKeyDown={(e) => {
              const t = e.currentTarget;
              if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                const { selectionStart: s, selectionEnd: end, value } = t;
                write({ ...content, source: value.slice(0, s) + "  " + value.slice(end) });
                requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
              } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                save();
              }
            }}
            onChange={(e) => write({ ...content, source: e.target.value })}
          />
        </div>
      )}
      {editing && mode === "diff" && (
        <div className="pane-body">
          {diff ? (
            <pre className="code diff">
              {diff.map((d, i) => (
                <span key={i} className={`dl ${d.op === "+" ? "add" : d.op === "-" ? "del" : ""}`}>
                  {d.op} {d.text || " "}
                </span>
              ))}
            </pre>
          ) : (
            <p className="note" style={{ padding: 12 }}>
              File too large for an inline diff.
            </p>
          )}
        </div>
      )}
      {editing && (
        <div className="pane-status editor-status">
          <input
            aria-label="Filename"
            value={content.filename}
            onChange={(e) => write({ ...content, filename: e.target.value })}
          />
          <select
            aria-label="Language"
            value={content.language}
            onChange={(e) => write({ ...content, language: e.target.value })}
          >
            <option>typescript</option>
            <option>javascript</option>
            <option>text</option>
          </select>
          <input
            aria-label="Symbols"
            placeholder="exported symbols, comma separated"
            defaultValue={content.symbols.join(", ")}
            onBlur={(e) =>
              write({
                ...content,
                symbols: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
              })
            }
            style={{ flex: 1 }}
          />
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
        </div>
      )}
    </div>
  );
}
