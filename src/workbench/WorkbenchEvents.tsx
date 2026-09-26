import { useEffect, useRef, useState } from "react";
import { useResearch } from "./research";
import { CURRENT_IDEA, LITERATURE_OVERVIEW, SOURCE_NAVIGATION, chooseIdea, literatureFocus, type ViewEvent } from "../workbench-contract";
import { developingIdea } from "./panes/ResearchDev";

export const ACTIVE_IDEA = "ideas:active";
/** Applies agent presentation events to this window and reports what it shows.
 *
 * Agents change research through the backend's workbench tools; this only
 * displays the result: open or pin a paper, jump to a page or match, select an
 * idea, refresh. It long-polls (one request held open at a time) instead of
 * polling on an interval, and reports the visible context with an unjournaled
 * GET so tools can resolve "this paper" or "the open idea". */
export function WorkbenchEvents({
  onReveal,
  onShow,
}: {
  /** Bring a pane forward in this stage; false when the stage lacks it. */
  onReveal: (pane: "sources" | "idea") => boolean;
  /** Go to a stage that shows the pane. */
  onShow: (pane: "sources" | "idea") => void;
}) {
  const scope = useResearch();
  const [notice, setNotice] = useState<"sources" | "idea" | null>(null);
  const current = useRef({ scope, onReveal });
  current.current = { scope, onReveal };

  useEffect(() => {
    if (scope.portfolio) return;
    let stopped = false;
    let after = -1;
    const apply = (e: ViewEvent) => {
      const { scope: s, onReveal: bringForward } = current.current;
      const reveal = (pane: "sources" | "idea") => setNotice(bringForward(pane) ? null : pane);
      const companion = s.companion;
      const openWith = (id: string) => {
        let open = companion.open.includes(id) ? [...companion.open] : [...companion.open, id];
        while (open.length > 12) {
          const victim = open.find((x) => !companion.pinned.includes(x) && x !== id);
          if (!victim) break;
          open = open.filter((x) => x !== victim);
        }
        s.setCompanion({ ...companion, open, active: id });
      };
      switch (e.type) {
        case "open-source":
        case "find":
          openWith(e.artifactId);
          s.setDraft(
            SOURCE_NAVIGATION,
            JSON.stringify(
              e.type === "find"
                ? { id: `v${e.seq}`, artifactId: e.artifactId, query: e.query, occurrence: e.occurrence, page: e.page }
                : { id: `v${e.seq}`, artifactId: e.artifactId, ...(e.page ? { page: e.page } : {}) },
            ),
          );
          reveal("sources");
          break;
        case "close-source": {
          const open = companion.open.filter((x) => x !== e.artifactId);
          s.setCompanion({
            open,
            pinned: companion.pinned.filter((x) => x !== e.artifactId),
            active: companion.active === e.artifactId ? (open.at(-1) ?? null) : companion.active,
          });
          break;
        }
        case "pin-source":
          if (!companion.open.includes(e.artifactId)) openWith(e.artifactId);
          s.setCompanion({ ...current.current.scope.companion, pinned: [...new Set([...companion.pinned, e.artifactId])] });
          break;
        case "unpin-source":
          s.setCompanion({ ...companion, pinned: companion.pinned.filter((x) => x !== e.artifactId) });
          break;
        case "open-idea":
          s.setDraft(ACTIVE_IDEA, e.target);
          reveal("idea");
          break;
        // Literature's focus and Research Development's idea are one choice: the current idea.
        case "focus-idea":
          if (e.target) chooseIdea(s.setDraft, e.target);
          else s.setDraft(LITERATURE_OVERVIEW, "1");
          break;
        case "develop-idea":
          if (e.target) chooseIdea(s.setDraft, e.target);
          else s.setDraft(CURRENT_IDEA, "");
          break;
      }
    };
    void (async () => {
      while (!stopped) {
        try {
          const r = await current.current.scope.client.read<{ seq: number; events: ViewEvent[] }>(`/native/view-events?after=${after}`);
          if (stopped) return;
          after = r.seq;
          if (r.events.length) {
            for (const e of r.events) apply(e);
            await current.current.scope.refresh().catch(() => {});
          }
        } catch {
          // Backend busy or restarting: back off briefly, never replay events.
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [scope.client, scope.portfolio]);

  // Report what this window shows (debounced; ephemeral, not journaled).
  const active = scope.companion.active;
  const open = scope.companion.open.join(",");
  let page = 0;
  try {
    page = active ? (JSON.parse(scope.drafts[`artifact:${active}`] ?? "{}").page ?? 0) : 0;
  } catch {}
  const idea = scope.drafts[ACTIVE_IDEA] ?? "";
  const focus = literatureFocus(scope.view?.pursued ?? [], scope.drafts)?.target ?? "";
  const develop = developingIdea(scope.view, scope.drafts)?.target ?? "";
  useEffect(() => {
    if (scope.portfolio) return;
    const timer = setTimeout(() => {
      void scope.client
        .read(`/native/view-context?active=${active ?? ""}&page=${page || ""}&idea=${idea}&open=${open}&focus=${focus}&develop=${develop}`)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [active, open, page, idea, focus, develop, scope.client, scope.portfolio]);
  if (!notice) return null;
  return (
    <div className="agent-toast" role="status">
      <span>{notice === "idea" ? "An agent updated the Idea board." : "An agent opened a paper in Sources."}</span>
      <button
        className="btn small"
        onClick={() => {
          onShow(notice);
          setNotice(null);
        }}
      >
        Show
      </button>
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
        ×
      </button>
    </div>
  );
}
