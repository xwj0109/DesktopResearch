# Workbench interface (2026-09-23 rebuild)

The renderer UI in `src/workbench/` was rebuilt from scratch in the visual idiom of [Omarchy](https://github.com/basecamp/omarchy): a tiled, keyboard-first, monospace desktop. Backend, IPC, persistence and scientific contracts are unchanged. The only contract addition is an optional `theme` field in the saved view state.

## Composition

- **Bar (26px, 34px on macOS):** The macOS traffic lights sit in the same themed background as the tile gutters. The strip is draggable, with no dividing line between it and the workspace. Other platforms keep their normal window frame. `π` opens the command palette. When the workspace rail is hidden, stages appear as numbered workspaces `1–7`; otherwise the rail provides that navigation. The bar also shows the active scope title, a centered clock, save status and theme. Pi's status stays in the conversation pane, where it is actionable.
- **Tiles:** rail, conversation and context pane are Hyprland-style windows. They sit 8px apart with 2px square borders; the focused tile gets the accent border and the others the inactive grey. The tile titles sit on the border, btop-style. The gap between conversation and pane is the resize handle, operated by pointer or by ←/→/Home/End.
- **Conversation pane = the real Pi CLI.** Strategy and portfolio windows run the installed `pi` in a PTY, in the strategy's folder, on Pi's own sessions (one per stage). It is themed like the app and carries the research tools through `-e`. A bar above it shows the session, model and status. It offers a reading view (maths and tables), a Pi commands menu, Attach, Open in Terminal (a handoff on the same session) and Restart. See [Pi in the conversation pane](PI-PARITY.md). The graphical conversation below is a fallback for bridges without terminal support.
- **Conversation (graphical fallback):** styled after Pi's own TUI theme tokens.
  - User turns show as panel blocks marked `❯`.
  - Assistant Markdown is rendered without HTML injection.
  - Thinking is collapsed.
  - Tool calls appear as tinted pending/success/error blocks joined to their `toolResult`, with a `⎿` output line. They collapse on success; failures stay open.
  - While Pi is running you see a braille spinner and elapsed time.
  - Pending Pi dialogs dock above the composer as a numbered list (keys 1–9, Esc to cancel).
  - The composer sends with `Enter`; `Shift+Enter` inserts a new line. `⌘⏎` remains an alternative. While a run is active, Send becomes Cancel work.
  - **Inline `/` commands** (`src/workbench/ChatComposer.tsx`, `composer-hints.ts`) replace the separate command box.
    - Typing `/` lists the commands, CLI-style: app commands first (`/model`, `/thinking`, `/attach`, `/cancel`, `/reload`, `/connect`, `/stop`, `/clear`), then the runtime's installed commands (extensions, prompt templates, skills), each tagged `app` or `runtime`.
    - ↑↓ choose, Tab or ⏎ completes, and Esc dismisses. `/model ` and `/thinking ` then suggest their values.
    - `Enter` runs the command after completion, and the Send button reads **Run**. App commands map to the conversation's generic operations (set model, set thinking, cancel, reload, connect, stop), so they work with any runtime. Runtime commands are sent as a command operation. Unknown commands are explained, not sent.
    - A hint line under the input shows the keys, the command's usage and description, or a warning.
  - **Attachments.** Use 📎 or `/attach`, drag and drop onto the composer, ⌘V paste, or `@` to pick a library source. Everything is portable (`src/chat-attachment.ts`):
    - library sources are attached by reference, and the runtime is told to read them with `paper_read` / `paper_find`;
    - text files are inlined, within the message budget;
    - PDFs are imported into the strategy library, deduplicated by hash, and attached by reference;
    - images (at most 4, about 4 MB of base64 in total, large ones downscaled) travel as the prompt's `images` field, which the Pi adapter maps to Pi image input.

    Sources and files show as chips, images as thumbnails, both in the composer and in sent messages. Images aren't kept in the saved draft. Attachments stay in the composer when you run a command.
- **Context pane:** tabs styled like Hyprland's groupbar, a path bar, content blocks and a status line. The PDF viewer puts its zoom and find toolbar under the page.
- **Palette:** a walker-style card with a scrim, grouped rows and ↑↓/Ctrl-N/P navigation.
- **Themes:** twelve Omarchy palettes: Tokyo Night (default), Catppuccin, Gruvbox, Everforest, Kanagawa, Nord, Matte Black, Osaka Jade, Ristretto, Rosé Pine Dawn, Catppuccin Latte and Flexoki Light. There is **one theme for the whole app**. The main process stores it in `<desktop>/preferences.json` (atomic write), and it is read before first paint through `pi-research:read-theme`. Choosing a theme from any window (palette or `⌘⇧T`) goes through `pi-research:save-theme`: the id is checked against the known palettes, persisted, then broadcast on `pi-research:theme-changed` to every open window, including the launcher. New windows open with the theme's background colour. On first run, a theme saved in an older per-window view seeds the app-wide value once. This is desktop presentation only and never changes Pi's terminal theme.

Action notifications disappear after 6 seconds (12 seconds for errors). Click a notification or its × button to dismiss it immediately; hovering or keyboard focus pauses expiry. The Review prepared panel dismisses after 12 seconds, with its actions also available in Previous reviews.

Keyboard: `⌘K` palette · `⌘1–7` stages · `⌘B` rail · `⌘\` context pane · `⌘⇧T` theme · `Enter` send · `Shift+Enter` new line.

## Stage pane layouts (per the panes/windows handover)

Each stage has a fixed tiling. It is not arbitrary docking: `a` is upper left, `b` lower left (optional), `c` the right column. Panes in `c` can have several tabs.

| Stage | a | b | c |
| --- | --- | --- | --- |
| Ideas | Pi | — | Sources · Idea |
| Literature | Pi | — | Sources · Bibliography |
| Research Development | Pi | Sources | Research spec |
| Data | Pi | — | Data (contracts, handoffs, feasibility, bounded samples) |
| **Design & Code** | **Pi** | **Graph** | **Code** |
| Backtests | Pi | — | Experiments (queue, runs, exact inputs, log) |
| Results | Pi | — | Results · Conclusion |
| Portfolio | Pi | — | Evidence (frozen imports, analyses, feedback) |

**Behaviour:**
- Splits are dragged, moved with the arrow keys, or reset by double-click.
- Hidden and zoomed-away panes stay mounted, so drafts and reading position survive.
- Split ratios, active tabs, hidden panes and zoom are saved per stage in the view state (`layouts`).
- Open, pinned and active sources are window-wide (`companion`), so reading context follows you across stages. Each document's page is kept in its research draft.

**Panes:**
- **Sources:** several documents open in tabs, pin/unpin, a library, and a review tray. Closing the paper you're reading returns to the library; any other open papers stay as tabs. The Review tab prepares a research question with selected evidence. It supports text search, paper groups, per-paper selection, a selected-only filter, page links and an expandable exact preview. Preparation saves an immutable snapshot and offers an immediate **Add to conversation** action that adds a collapsed review attachment to the existing draft and focuses the composer. The card shows the question and evidence counts, expands to show exact passages, and can be removed before sending. Sent messages retain the collapsed card. The complete question and evidence travel in a portable text envelope, so every runtime receives the content without needing an upload service. Attachments persist with the draft, survive failed sends, and clear only on acknowledgement of the unchanged draft. Repeated additions of the same snapshot are deduplicated; oversize messages are refused without replacing the draft. The original JSON remains under Snapshot details. Sending stays explicit. Previous reviews are titled by their question, with verified delivery status and provenance in Details. **Delete review…** asks for inline confirmation, then removes the saved snapshot while retaining source notes and conversation attachments. Backend validation refuses stale revisions/hashes, active or uncertain deliveries, and reviews referenced by scientific records or idea drafts. **Duplicate as new review** reuses the original saved evidence even after live annotations change. **Create idea from response**, available in history and on assistant messages, creates an editable conjecture citing the exact review and source documents. Users explicitly select the review associated with a conversation response; the UI does not infer delivery or response linkage from composer insertion.
- **Idea pane (Ideas → Idea):** one vertical list grouped into collapsible status sections, top to bottom: **Brainstorm** (unsaved drafts), **To decide** (saved, no decision on its latest version), **Pursue** and **Revise**. Section headers stay pinned while you scroll. Each idea is one compact row: status dot (hollow for drafts), title, one line of rationale (or the last decision's reason), and version or draft age on the right. On hover the right side switches to actions: ⇢ decide, π, ⧉, ×. The top bar holds **+ New idea**, a filter, and toggles for **rejected** (adds a Rejected section) and **archived** (switches to the archive list); `?` explains the flow. Clicking a row opens the editor in the pane; ← or Esc returns.
  - **+ New idea** opens a blank idea in the editor: title, then rationale, universe, horizon and falsification as auto-growing text with prompts. Below that, "how established is it?" is a single choice (assumed · conjectured · derived · cited · tested), then evidence rows (kind, a paper or saved record, what it shows). **+ From my highlights** turns a PDF highlight into a cited evidence row, e.g. `p. 6: “quote” — comment`.
  - Drafts autosave in the window view (`researchDrafts["ideas:board"]`, at most 100) and can be duplicated, or deleted with **Undo**. The old single-form draft becomes a Brainstorm entry on first open.
  - **Save as v1** / **Save vN** (⌘S) creates the next immutable `idea` version. Missing fields are flagged inline, and evidence rows left completely blank are dropped. Editing a saved idea keeps a pending next version (tag **edited**) until you save or discard it. **History** lists every version, and **Load** copies an old version's text into the editor.
  - **Decisions:** ⇢ on a row (pursue/revise/reject), the buttons in the editor, or dragging a row into another section, record `idea.decide` on the exact latest version, with a reason. Dropping a draft on a status saves it first. A new version returns the idea to **To decide**.
  - **×** on a saved idea archives it (a view-local hide, with Undo and **Restore**). From **Archived**, **Delete…** asks for inline confirmation, then sends `idea.delete`. The server removes every version of the idea and the decisions and approvals on it, journals the deletion, and then erases the idea's content blobs, unless an identical blob still backs another record. It refuses (`cited`, validated through the desktop protocol) while any other version or state row references the idea. Old journal snapshots keep only version metadata and decision reasons, never the idea text.
  - **π** appends the idea as text to the Pi composer and never sends.
- **Graph:** dragging a node or using the arrow keys changes only its on-screen position, saved in view state. Labels, stages, interfaces, assumptions, edges, linked code and the spec reference are semantic. They are diffed against the base version before *Save graph version*. The pane flags nodes whose linked code has moved on, and warns when a newer spec has been approved since the graph's spec.
- **Adding papers (Sources → library):**
  - **Add papers** takes one or more arXiv IDs, arXiv links or https PDF links (up to 10 at once), e.g. `2609.22612 1206.2305`.
  - **arXiv suggestions:** typing title or author words (e.g. `kardaras numeraire`, `au:platen ti:benchmark`) shows matching arXiv papers under the box: title, authors, year, category, id, and an **in library** tag. ↑↓ and ⏎ or a click picks one. Picking downloads it through the same checked path, or opens it if it's already in the library. Every plain word must match a title or an author; `au:`/`ti:` restrict a word to one field.
    - Runs through `pi-research:search-papers` in main (strategy windows only). Only the typed words go to `export.arxiv.org`: they're reduced to `[a-z0-9]` words, at most 8, so no query syntax passes through. The renderer waits 450 ms after typing stops. Main sends one request at a time, at least 3 s apart as arXiv asks, and backs off 10 s after a 429/503. A newer query from the same window drops a waiting one before it's sent, and results are cached (last 100 queries).
    - IDs and links aren't searched; they go straight to **Add papers**.
  - **Import files** accepts several files, and files can be dropped anywhere on the Sources pane.
  - Downloads happen in the main process, only when you press the button, through `pi-research:fetch-paper` (strategy windows only, one download at a time). The renderer itself still has no network access.
  - Checks: every hop, including redirects, must be https to a public address (loopback, private, link-local and cloud-metadata ranges are refused). There's a 30 s timeout and a 20 MiB cap, and the body must be a real PDF.
  - arXiv papers are named "Author et al. Year - Title (arXiv id).pdf" from the arXiv API.
  - The bytes go through the ordinary immutable-artifact import. Identical files already in the library are opened instead of duplicated.
  - Nothing is sent to Pi. DNS is checked before each request, not pinned per connection, so DNS rebinding isn't fully excluded.
- **Library keyboard (Finder-style):** the source list is a single focusable list.
  - ↑/↓ (Home/End) move the selection, and a single click selects a row. The keys work as soon as the Sources pane is the active tile: after clicking anywhere in it, or moving there with the tiling keys (the list is the pane's preferred focus). They don't need a click into the list, and are left alone while you type in a field or a button has focus.
  - **Space** opens a Quick Look preview. It uses the real PDF viewer in read-only mode (zoom, find, select and copy, but no note menus); text files show as text and images as images.
  - While the preview is open, ↑/↓ switch it to the neighbouring source (the header shows `2 / 5`). Space or Esc closes it.
  - **Enter**, a double-click or **Open** opens the source for work in the reader.
  - **⌘⌫** deletes the selected source straight away, like Finder's Move to Trash. There is no confirmation step because the notice offers **Undo** and Recently deleted keeps the source. The selection moves to the next source. A source in a frozen review batch is refused with the reason. The plain Delete key does nothing.
- **Back to the library from a paper:** the paper header has **‹ Sources**, and **Esc** does the same when the Sources pane is the active tile. Find, note editors, menus and dialogs handle Esc first; Esc in a field does not leave the paper. The paper stays open as a tab, and focus returns to the library list.
- **Library sections:** sources are grouped into **Primary**, **Secondary** and **Other sources**, in that order.
  - Papers you add from the arXiv bar (a picked suggestion or **Add papers**) start in **Primary**. Files imported from disk or by drop start in Other, and a paper already in the library keeps its section. Placing is a separate step after the import: if it fails, the paper stays imported in Other and the import summary says so. Agent imports (`paper_import`) are not placed. While everything is in Other, the library stays a single plain list.
  - To move the selected source, press **1** (Primary), **2** (Secondary) or **3** (Other; **0** also works). Each row also has a section menu, and rows can be dragged onto a section. While dragging, empty sections appear as drop targets.
  - A moved source stays selected in its new section. ↑/↓ and the Quick Look count follow the sections' order.
  - Clicking a section header collapses it; its rows then leave keyboard navigation. Collapsing is per window and isn't saved.
  - Sections are stored per strategy beside the immutable artifacts (`importance` in the store, holding only primary and secondary), never inside them. Moving a source changes no fingerprint or frozen history. It is library organisation, not a research record, so it needs no revision.
  - A deleted source keeps its section in case it is restored. The section is dropped once the source leaves Recently deleted.
  - The window and agents use the same registry operation, `source_importance`, through `POST /native/source-importance`. `sources_list` reports each source's section.
- **Deleting and restoring sources:** the × on a library row asks for inline confirmation, stating how many annotations go with it.
  - The source and its annotations move to the strategy's **Recently deleted** list (newest first, last 20), and its bytes are kept. Tab references and the saved page are cleared.
  - The notice after a deletion has **Undo**. The Recently deleted list has **Restore**, and still works after a restart.
  - A restore brings back the original id, fingerprint, annotations and timestamps, after checking the stored bytes.
  - An entry that falls off the list is removed for good, and its bytes go too unless another live or deleted source shares them.
  - Deletion is refused when the source is part of a frozen review batch, or when it or any of its annotations is cited by a scientific record. The citation check runs inside the same store transaction.
  - The desktop protocol still hides backend error text, but these refusals cross the boundary as strictly validated data (`frozen-batch` with a 10-hex batch prefix, or `cited` with record labels shaped `kind vN (8-hex)`). The pane turns them into messages such as "cited by idea v1 (1a2b3c4d)".
- **PDF reader:**
  - Pages scroll continuously and are drawn at the display's pixel density (2× on Retina), capped at 16 MP per page. Only pages near the viewport are rendered; far ones are released.
  - pdf.js's `TextLayerBuilder` makes text selectable and copyable. Keep its `endOfContent` selection handling and matching CSS: the low-level `TextLayer` alone lets browser selection jump when dragging across line gaps, especially upward.
  - Selecting text offers **Highlight**, **Comment…**, **Ask Pi** (appends a quoted, page-referenced passage to the stage composer; it never sends) and **Copy**. Highlights and comments are ordinary annotations anchored to the immutable source.
  - Saved notes are drawn back onto the page by re-finding their quote in the text layer. Matching ignores whitespace, case, hyphens and diacritics and splits ligatures, so a PDF's `num´eraire` or "ﬁ" still match. It falls back to the stored rectangle.
  - Clicking a note's page link jumps to and flashes its highlight. Clicking a highlight opens a **note card** on the page with the quote, the comment, **Edit**/**Add comment**, **Remove highlight**, **Ask Pi** and **Copy quote**.
  - **Removing highlights:** use Remove highlight on the note card, or select text that overlaps highlights (the selection menu then leads with **Remove highlight(s)**), or use **Remove** in the notes list. After a removal the list shows an **Undo** notice, which re-creates the note with the same anchor, comment and status (under a new id).
  - **Notes list:** filter by all / highlights / comments / open / addressed. **Copy all as Markdown** copies the page-referenced quotes and comments. Each note has inline **Edit** (clearing the comment turns it back into a plain highlight), **Remove**, **Ask Pi**, **Copy**, **Addressed**/**Reopen**, and **Review**, which adds it to or drops it from the review tray selection.
  - A note cited by a scientific record can't be edited or removed; save a new note instead. The refusal crosses the desktop boundary as a validated `cited` refusal, like source deletion.
  - Toolbar (no pager, since the whole paper scrolls continuously and the reading position is saved): zoom (`+`/`−`, `0` for fit width, since ⌘± zoom the whole window), fit width, inverted pages for dark themes, and find with a hit count: ⏎ scrolls to the next match itself, not just its page, and ⇧⏎ to the previous one. A match already comfortably in view doesn't move the page. Esc clears.
  - **⌘F** jumps to the find box of the reader you're working in, selecting any existing text. This works from anywhere in the window, including the chat box. **⌘G** and **⇧⌘G** step to the next and previous match. Esc clears the search, and Esc on an empty box returns focus to the paper. When several readers are mounted, only a visible one responds: the Quick Look preview when it's open, otherwise the focused reader.
- **Code:** an editor over the code record draft with a line gutter, Tab indentation and ⌘S to save a version. A line diff against the base version is available. Nothing executes.
- **Results:** explicit disclosure; equity and drawdown with a drag or slider interval selection. *Ask Pi about this interval* appends an exact run/input/dataset/interval reference to the composer and sends nothing. Shows lineage of the exact historical inputs.
- **Awareness:** a read-only poller shows pending Pi dialogs and running work in other stages, as a `!` on the rail and in the bar. It never connects or starts Pi.

### Tiling navigation (Omarchy/Hyprland bindings)

The bindings mirror Omarchy's `default/hypr/bindings/tiling.lua`, with **SUPER = ⌘⌥** (Ctrl+Alt off macOS). ⌘ alone is left to macOS text editing and window keys. Keys are matched on physical key codes because ⌥ changes the typed characters.

| Omarchy | Pi Research | Effect |
| --- | --- | --- |
| SUPER + arrows | ⌘⌥ + arrows | Focus the pane on that side (geometric, includes the rail) |
| SUPER+SHIFT + arrows | ⌘⌥⇧ + arrows | Swap the focused pane with its neighbour; focus follows it |
| ALT + TAB | ⌃Tab / ⌃⇧Tab | Cycle focus through visible panes |
| SUPER + J | ⌘⌥J | Toggle the split containing the focused pane (side by side ↔ stacked) |
| SUPER + F | ⌘⌥F (also ⌘⇧F) | Full-screen (zoom) the focused pane |
| SUPER + W | ⌘⌥W | Hide the focused pane (Pi is never hidden) |
| SUPER + −/= | ⌘⌥−/= (⇧ for height) | Resize the focused pane by moving the split that bounds it |
| SUPER + 1–9 | ⌘⌥1–7 (also ⌘1–7) | Switch stage (Omarchy workspace) |
| SUPER + TAB / SUPER+CTRL+TAB | ⌘⌥] ⌘⌥[ / ⌘⌥` | Next/previous stage / former stage |
| SUPER+CTRL + ←/→ | ⌘⌥⌃ + ←/→ (also ⌘[ ⌘]) | Previous/next tab in the focused pane (group) |
| SUPER + Home | ⌘⌥Home | Reset the stage layout |
| SUPER + mouse drag | drag a pane's border title | Drop on another pane to swap |
| SUPER + K | ⌘⌥K | Searchable key bindings; choosing one runs it |

**How it's implemented:**
- Focus movement uses the same logical geometry the stage renders (`tileRects` / `neighbor` in `layouts.ts`), so it follows swaps, flipped splits, hidden panes and zoom.
- Returning to a pane restores the element you last focused there. Otherwise focus goes to its preferred input: the composer or the code editor.
- Swaps (`slots`) and split directions (`outer`, `inner`) are saved per stage. A saved arrangement that isn't a permutation of the stage's panes is ignored, so a stage can never lose a pane.

Other keys: `⌘\` companion · `⌘⇧\` lower pane · `⌘B` rail · `⌘K` palette.

**Not done:** tear-off/pop-out panes, artifact-bound side conversations, CSV/Parquet/HTML viewers, and graph↔code round-tripping. Divergence is flagged, not reconciled automatically.

## Agents operating the panes (workbench tools)

The chat, and optionally external agents, operate the Ideas and Sources panes through **one tool registry owned by the backend** (`server/workbench/tools.ts`). No agent runtime has its own copy of the tools. This is the app's agnosticity principle; see [principles](PRINCIPLES.md).

- **Strategy management.** The workspace launcher offers Rename and Delete beside each strategy. Rename preserves its ID, research and conversations. Delete requires confirmation, removes the strategy from the catalog, and revokes access; research files and conversations remain on disk, and portfolio imports remain intact. There is no launcher restore action. Connected sessions, unresolved ownership, active experiments and pending review delivery block deletion. An open desktop window prepares its drafts before deletion and resumes editing if deletion is refused. The backend registry exposes `strategy_rename` and `strategy_delete` with an expected-name check.

- **Registry.** There are 27 small tools, each with a precise zod input schema that is exported as JSON Schema:
  - ideas: `ideas_list`, `idea_get`, `idea_create`, `idea_update`, `idea_save`, `idea_decide`, `idea_open`;
  - reviews: `reviews_list`, `review_get`, `review_prepare`, `review_duplicate`, `review_create_idea`, `review_delete`;
  - sources: `sources_list`, `source_notes`, `paper_search`, `paper_import`, `source_view`, `paper_read`, `paper_find`, `note_create`, `note_update`, `note_delete`, `source_delete`, `source_restore`, `source_importance`.

  `Workbench.call(strategy, name, input)` is the single entry point. It validates the input, runs the handler against current state and returns the backend's own result or a readable refusal. Tools re-read state on every call. Review preparation additionally requires the inspected workspace revision, and review reuse requires the exact snapshot hash, to reject stale inputs.
- **Research runs in the backend, not the window.**
  - Idea drafts, pending edits of saved ideas, and the archive live in the strategy store (`ideas`, see `src/idea-board-contract.ts`).
  - PDF text is extracted in the backend with pdf.js (`server/workbench/pdf-text.ts`, cached by content hash).
  - Highlights must quote text that appears on the given page.
  - Saving and deciding go through the scientific journal, with the same checks as the UI.

  Tools work whether or not a window is open.
- **Windows only display.**
  - Agents publish presentation events: open, close or pin a paper; jump to a page or find match; open an idea; refresh. Each strategy window receives them by long-polling `GET …/native/view-events?after=` (`WorkbenchEvents.tsx`). There is no fixed-interval polling.
  - Windows report what they show (open paper, page, open idea) with an unjournaled `GET …/native/view-context`. Tools use that to resolve "this paper" or "the open idea".
  - If the current stage has no pane for a change (e.g. an idea created while on Literature), the window shows a notice with **Show** instead of switching stage, since every stage has its own Pi conversation.
- **The Idea pane** reads the backend board with an optimistic local overlay. It sends board operations (`POST …/native/ideas`): typing is debounced (about 1.2 s idle, and when leaving a field) and sends only the changed fields. A board kept in window drafts by older builds is adopted once.
- **Pi adapter.** The backend passes the manifest into the Pi host config. `server/pi-host-tools.mjs` turns each entry into a Pi custom tool whose parameters are the plain JSON Schema, which Pi validates without TypeBox. The shared guidance is added once, and each call relays `workbench_tool_request` to `relayWorkbenchTool()` in `server/pi.ts`.
- **MCP adapter (external agents: Claude Code, Codex, Cursor, …).** `POST /mcp/<strategy>` speaks JSON-RPC 2.0 (MCP Streamable HTTP, JSON responses): `initialize`, `tools/list`, `tools/call` and `ping`. Tool failures come back as `isError` results.
  - Access is off by default. It is turned on per strategy from the palette under **External agents (MCP)…**, which issues a random token written with the backend origin to `.runtime/mcp/<strategy>.json` (0600). The file is re-issued with the new origin after a restart. Turning access off deletes it, and the token stops working at once.
  - Clients run the stdio bridge (`scripts/pi-research-mcp.mjs`, shipped in the app) with `--strategy <id>`. It re-reads the access file for every message. The dialog shows the `claude mcp add …` command and a JSON config to copy.
- **Not yet done:** see the known gaps in [principles](PRINCIPLES.md#where-the-app-is-not-yet-agnostic).

## References (pinned, inspected, not copied)

| Source | Pin | Used for |
| --- | --- | --- |
| Omarchy | `d3cfd53b997f8bdcf776b8db68bf0d735e7a065d` (MIT) | Palette values from `themes/*/colors.toml`; gap/border/rounding values from `default/hypr/looknfeel.lua`; control-fill alphas and type scale from `default/themed/shell.toml.tpl`; surface mixes from `pi.json.tpl`/`t3code.json.tpl`. No Omarchy logo, artwork or branding is used. |
| T3 Code | `aff9318bf46beaf05cc7155b428d3f0b8711efd2` | Workspace/thread rail, ⌘1–9 jump, working timer, approval dock above composer, Stop replacing Send, right panel becoming a sheet at ≤980px. |
| Qwen Code | `1b26d38b5c4707c1bd60e2857fded881f55527fe` | Tool summary rows with auto-collapse, collapsed thinking, braille status line, numbered approval options. |
| ZCode | `872ad960de7ec172591f7e1952f7849229f94521` | PDF viewport with bottom page/zoom toolbar, breadcrumb path header, status wording paired with colour. |

## Verification

`npm run check` passes: boundaries, TypeScript, 229/229 tests and the production build. The tests keep `native-live-ui.test.tsx` and `workbench-interactions.test.tsx` unchanged. `native-workbench.test.tsx` now selects elements by role, data attribute or text instead of old CSS class names. `workbench-model.test.ts` encodes the tiled width budget and keeps the ≥420px conversation guarantee.

Screenshots were taken with Electron at 1440×900, 1280×800 and 960×700 for:
- the design preview: stages, code, map, palette and portfolio views, in dark and light themes;
- a temporary fake-bridge harness, deleted afterwards: the connected conversation with tools and a pending dialog, research records, and the launcher.

That harness is not native runtime acceptance. The packaged app was not rebuilt or re-inspected for this change.

The embedded Pi CLI starts with the active conversation when a strategy or portfolio workspace opens, and each stage starts its own Pi terminal when visited. The launcher has no connection preference. In the graphical fallback, strategy conversations connect once on first visit; an explicit Stop or failed attempt still prevents automatic retries until the user reconnects. Connection never sends a prompt or clears a draft.

The graphical conversation uses the installed Pi keybindings for submission, prompt history, models, thinking, interruption, queue controls and editor actions. Enter steers during a running turn; Alt+Enter queues a follow-up; Alt+Up restores queued input. Double-Escape honors Pi’s configured tree/fork/none action. Ctrl+C preserves selected-text copying. Ctrl+G opens the configured external editor in a PTY surface and returns the saved draft. Runtime commands and completions delegate to the installed SDK. See [PI-PARITY.md](PI-PARITY.md) for implemented behavior, desktop adaptations, verification and remaining gaps; exact CLI parity is not yet claimed.
