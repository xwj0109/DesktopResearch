import { useEffect, useState } from "react";
import { useResearch } from "./research";
import { copyText } from "./PdfViewer";

/** Opt-in access for external agents (Claude Code, Codex, Cursor, …) to this
 * strategy's workbench tools over MCP. Off by default; the token lives in a
 * private file the stdio bridge reads, and turning access off revokes it. */
export function ExternalAgents({ onClose }: { onClose: () => void }) {
  const scope = useResearch();
  const [state, setState] = useState<{ enabled: boolean; bridge: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const sid = "id" in scope.client.context.scope ? scope.client.context.scope.id : "";
  useEffect(() => {
    scope.client.read("/native/mcp-access").then(setState, (e) => setError(String(e?.message ?? e)));
  }, [scope.client]);
  const toggle = async () => {
    setError("");
    try {
      setState(await scope.client.write("/native/mcp-access", { enabled: !state?.enabled }));
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const claude = state ? `claude mcp add pi-research -- node "${state.bridge}" --strategy ${sid}` : "";
  const json = state
    ? JSON.stringify({ mcpServers: { "pi-research": { command: "node", args: [state.bridge, "--strategy", sid] } } }, null, 2)
    : "";
  const copy = (what: string, text: string) => {
    copyText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1400);
  };
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className="agents-card"
        role="dialog"
        aria-label="External agents"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header>
          <h2>External agents (MCP)</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="note">
          Let other agents such as Claude Code, Codex or Cursor use the same workbench tools as Pi on this strategy: ideas, papers,
          highlights and comments. Research actions keep the same checks, and saving, deciding and deleting still need an explicit request.
        </p>
        {error && <p className="notice error">{error}</p>}
        {state && (
          <>
            <div className="agents-toggle">
              <span className={`tag ${state.enabled ? "ok" : ""}`}>{state.enabled ? "access on" : "access off"}</span>
              <button className={`btn small ${state.enabled ? "danger" : "primary"}`} onClick={() => void toggle()}>
                {state.enabled ? "Turn off and revoke" : "Turn on for this strategy"}
              </button>
            </div>
            {state.enabled && (
              <>
                <h3 className="section-title">Claude Code</h3>
                <pre className="agents-snippet">{claude}</pre>
                <button className="btn small ghost" onClick={() => copy("claude", claude)}>
                  {copied === "claude" ? "Copied" : "Copy command"}
                </button>
                <h3 className="section-title">Any MCP client (JSON config)</h3>
                <pre className="agents-snippet">{json}</pre>
                <button className="btn small ghost" onClick={() => copy("json", json)}>
                  {copied === "json" ? "Copied" : "Copy config"}
                </button>
                <p className="note">
                  The bridge reaches this app while it is open. Access is stored in a private file (only your user can read it) and
                  survives restarts until you turn it off here.
                </p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
