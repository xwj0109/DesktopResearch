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
| Ideas | Pi | — | Idea · Sources |
| Literature | Pi | — | Sources · Bibliography |
| Research Development | Pi (the developing idea's own) | — | Files · Changes · Documents · Data · Research spec · Sources |
| Data | Pi | — | Feeds · Explorer · Quality · Contract |
| **Design & Code** | **Pi** | **Graph** | **Code** |
| Backtests | Pi | — | Experiments (queue, runs, exact inputs, log) |
| Results | Pi | — | Results · Conclusion |
| Portfolio | Pi | — | Evidence (frozen imports, analyses, feedback) |

**Behaviour:**
- Splits are dragged, moved with the arrow keys, or reset by double-click.
- **⊟** in a tile's tab bar shows a second of its panes below the current one (e.g. Changes below Documents); the choice below is saved per stage (`below`). Hidden tabs stop polling; panes reading the same route share one request (`src/workbench/usePoll.ts`).
- Up to 1440px wide the rail keeps to stage numbers, with names on hover, so the work and Pi get the width.
- "Ask Pi" (papers, notes, ideas, and Research Development files, documents and diffs) puts a reference into Pi's input; nothing is sent. If Pi's terminal isn't ready, the text waits in the Pi bar (**Paste now** / **Discard**) rather than in a hidden draft.
- Hidden and zoomed-away panes stay mounted, so drafts and reading position survive.
- Split ratios, active tabs, hidden panes and zoom are saved per stage in the view state (`layouts`).
- Open, pinned and active sources are window-wide (`companion`), so reading context follows you across stages. Each document's page is kept in its research draft.

**Panes:**
- **Sources:** several documents open in tabs, pin/unpin, a library, and a review tray. Closing the paper you're reading returns to the library; any other open papers stay as tabs. The Review tab prepares a research question with selected evidence. It supports text search, paper groups, per-paper selection, a selected-only filter, page links and an expandable exact preview. Preparation saves an immutable snapshot and offers an immediate **Add to conversation** action that adds a collapsed review attachment to the existing draft and focuses the composer. The card shows the question and evidence counts, expands to show exact passages, and can be removed before sending. Sent messages retain the collapsed card. The complete question and evidence travel in a portable text envelope, so every runtime receives the content without needing an upload service. Attachments persist with the draft, survive failed sends, and clear only on acknowledgement of the unchanged draft. Repeated additions of the same snapshot are deduplicated; oversize messages are refused without replacing the draft. The original JSON remains under Snapshot details. Sending stays explicit. Previous reviews are titled by their question, with verified delivery status and provenance in Details. **Delete review…** asks for inline confirmation, then removes the saved snapshot while retaining source notes and conversation attachments. Backend validation refuses stale revisions/hashes, active or uncertain deliveries, and reviews referenced by scientific records or idea drafts. **Duplicate as new review** reuses the original saved evidence even after live annotations change. **Create idea from response**, available in history and on assistant messages, creates an editable conjecture citing the exact review and source documents. Users explicitly select the review associated with a conversation response; the UI does not infer delivery or response linkage from composer insertion.
- **Idea pane (Ideas → Idea):** one vertical list grouped into collapsible status sections, top to bottom: **Brainstorm** (unsaved drafts), **To decide** (saved, no decision on its latest version), **Pursue** and **Revise**. Section headers stay pinned while you scroll. Each idea is one compact row: status dot (hollow for drafts), title, one line of rationale (or the last decision's reason), and version or draft age on the right. On hover the right side switches to actions: ⇢ decide, π, ⧉, ×. The top bar holds **+ New idea**, a filter, and toggles for **rejected** (adds a Rejected section) and **archived** (switches to the archive list); `?` explains the flow. Clicking a row opens the editor in the pane; ← or Esc returns.
  - **+ New idea** opens a blank idea in the editor: title, then rationale, universe, horizon and falsification as auto-growing text with prompts. Below that, "how established is it?" is a single choice (assumed · conjectured · derived · cited · tested), then evidence rows (kind, a paper or saved record, what it shows). **+ From my highlights** turns a PDF highlight into a cited evidence row, e.g. `p. 6: “quote” — comment`.
  - Drafts autosave in the window view (`researchDrafts["ideas:board"]`, at most 100) and can be duplicated, or deleted with **Undo**. The old single-form draft becomes a Brainstorm entry on first open.
  - **Save as v1** / **Save vN** (⌘S) creates the next immutable `idea` version. Missing fields are flagged inline, and evidence rows left completely blank are dropped. Editing a saved idea keeps a pending next version (tag **edited**) until you save or discard it. **History** lists every version, and **Load** copies an old version's text into the editor.
  - **Decisions:** ⇢ on a row (pursue/revise/reject), the buttons in the editor, or dragging a row into another section, record `idea.decide` on the exact latest version, with a reason. Dropping a draft on a status saves it first. Pursue stays with the idea through new versions (the editor says "Pursued since v1"). Revise and reject are answered by the next version, which returns the idea to **To decide** (see [research flow](RESEARCH-FLOW.md)).
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
- **Literature focus (Literature stage only):** idea tabs sit at the top of the Sources pane: **All ideas**, then one tab per pursued idea. They appear in a compact form above the page while reading. See [research flow](RESEARCH-FLOW.md).
  - **All ideas** (the default) lists each pursued idea as one quiet row: title and version, a thin evidence bar coloured by stance, a summary such as "8 papers · 3 notes: 2 supports, 1 contradicts" (zero stances are left out), and the next step on the right. Clicking a row focuses it. The library below keeps its library-wide sections.
  - **A focused idea** shows its version, the pursue reason, the evidence bar with its summary, and **Next:** one suggested action. Next comes from `coverage.next`, computed in the backend from the most fundamental gap, in this order: papers, evidence, contradicting evidence, unread primary papers, notes without a stance, stale judgements. `ideas_pursued` returns the same text, so the Literature agent suggests the same step. The full list of gaps is kept for agents.
  - **Focused on an idea:** Primary, Secondary and Other are that idea's ranks. Papers the idea cites count as Primary for it until ranked otherwise, and an explicit Other is kept. Keys 1 2 3, the row menu, drag and new arXiv papers rank for that idea; library-wide sections are untouched. A paper can have a different rank for each idea.
  - The focus is the window's **current idea** (draft `idea:current`, shared with Research Development and set by opening a pursued idea in the Idea pane); **All ideas** sets `literature:overview`. It is reported with the view context (`focus=`). Agents read it from `ideas_pursued.focus` (and `sources_list.literatureFocus`), set it with `literature_focus` (pursued ideas only; the window follows), and rank per idea with `source_importance` plus `idea`. A focus that stops being pursued falls back to the overview.
  - Per-idea ranks are stored in `ideaImportance` in the strategy store, beside the library-wide `importance`. `/native/research` includes `pursued` (as `ideas_pursued`, without full content) for the window.
- **Research Development (one workspace per pursued idea):** see [research flow](RESEARCH-FLOW.md).
  - **Developing bar:** across the whole stage, with tabs for the pursued ideas and the idea's version. The developing idea is the window's current idea (draft `idea:current`, the same choice as Literature's focus), else the first pursued idea. Windows saved by older versions keep their choice (`research:idea`, else `literature:focus`).
  - **Where the idea stands** (in the bar, each item a link): papers and notes (with contradicting ones) → Literature; changes not yet checkpointed → Changes; the newest document, marked **new** until seen → opens it in Documents. The Changes and Documents tabs carry the same count and mark as badges. The window reports it as `develop=` in the view context, and agents change it with `rd_develop` (pursued ideas only).
  - **Pi:** the Pi pane runs that idea's own conversation (`research:<idea id>`, a stable session id per idea) in its workspace, labelled "‹strategy› · RD · ‹idea›". Its tools connection carries `?stage=research&idea=r:<id>`, so its instructions name the idea and say to work in the folder and offer checkpoints. Switching ideas switches conversations; each keeps running. With no pursued idea, the pane explains how to get one.
  - **Workspace:** `<strategy>/Research-Workspaces/<idea id>/`, created on first use with a README and a `.gitignore` (virtualenvs, caches, node_modules), then `git init` and a "Workspace created" checkpoint. Identity is repository-local. Git runs with fixed arguments, no shell, pager, prompts or system config (`server/workbench/rd.ts`). Operations on one workspace are serialised, so panes, the Pi pane and agents never race git. Paths are confined to the workspace: `..`, `.git` and symlinks that lead out are refused.
  - **Files:** a folder tree (folders first; caches skipped) and a viewer, refreshed every 3 s.
  - **Changes:** a **Showing** selector at the top: *Current changes · N*, or any past checkpoint. Next to it, a summary such as "16 files · +104,289 −0 since ‹last checkpoint›". With current changes selected, **Checkpoint** takes a message and commits, and is refused when nothing changed.
    - **File list** (left): grouped by folder, folders first and foldable, with a status letter (A new, M modified, D deleted) and line counts, or "bin" for binary files.
    - **Diff** (right): the selected file only, fetched on its own and capped at 512 KiB, with a note when cut off. Images show as pictures.
    - **Why per file:** the backend never builds the whole diff. `rd_changes` (git status plus numstat) returns files, counts and totals, `rd_diff` returns one file's diff for current changes or a checkpoint, and `rd_history` with `sha` returns that checkpoint's files. A multi-megabyte generated output therefore no longer blanks the view with "diff too large"; each file stays readable.
  - **Documents:** reports, figures, tables, PDFs and notebooks, newest first.
  - **Viewer:** Markdown renders with KaTeX maths and tables (with a **Source** toggle). CSV and TSV show as tables. Notebooks show their markdown, code and text or PNG outputs. PDFs use the read-only PDF viewer. Images show inline. Code is highlighted. Text is capped at 1 MiB and PDFs and images at 12 MiB.
  - **Routes:** reads are unjournaled GETs (`/native/rd/files|file|changes|history?idea=r:<id>`). Checkpoints are `POST /native/rd/checkpoint`. The desktop creates and locates a workspace for Pi with `POST /native/rd/workspace`. All of these go through the registry.
- **Data tab (Research Development):** frozen data snapshots shared by every idea of the strategy (`server/workbench/data.ts`). See [research flow](RESEARCH-FLOW.md).
  - **Storage format:** all fetched snapshots are **Parquet** (`server/workbench/parquet.ts`, via hyparquet-writer). Compression is zstd (Node's built-in; snappy where Node lacks it). Columns are typed int64, float64, bool or string. Timestamps are `TIMESTAMP(MICROS, UTC)` from millisecond, microsecond or text times, which polars reads as `Datetime[μs, UTC]`. Row groups are 1 M rows, written as they fill.
  - **Binance archive (the default source; tick level):** market, dataset, symbol, dates (`server/workbench/binance-archive.ts`).
    - **Markets and datasets:**
      - Spot: trades, aggTrades, klines (1s–1d).
      - USDⓈ-M and COIN-M: trades, aggTrades, bookTicker, bookDepth, metrics, fundingRate (monthly files), klines, and mark/index/premium price klines. COIN-M also has liquidationSnapshot.
      - Options: BVOLIndex and EOHSummary, which Binance no longer updates.
    - **Listing:** files come from the bucket's S3 listing, starting at the first wanted date. The form shows an estimate as you type: files, date span, download size, days not in the archive, and free disk. Pi gets the same from `data_estimate`.
    - **Checks and conversion:** each zip is downloaded, verified against its `.CHECKSUM` SHA-256 (a mismatch discards the whole fetch), unzipped by streaming the single entry, and parsed. Spot files are headerless and use known column names, while futures files carry a header. The result is one Parquet file per day in `<name>/`.
    - **Manifest:** lists each day's rows, bytes, Parquet SHA-256 and the archive's SHA-256, plus the days the archive lacks. A fetch is capped at 500 GiB of download and needs 1.5× that in free disk.
  - **Ticker suggestions:** the Symbol field is a combobox (`server/workbench/symbols.ts`, tool `data_symbols`). It opens on focus with the majors, then ranks as you type, handled with ↑/↓, Enter and Esc. The ranking is: exact; then the typed coin with a quote or separator (SOL → SOLUSDT, SOLUSDC; ETH → ETH-USD, ETH-GBP), preferring USDT, USD, USDC and similar; then other prefixes; then contains; then title matches; inactive products last.
    - **Lists:**
      - Binance archive: the symbols the archive holds for the chosen market and dataset (bucket listing with delimiter, paged, delisted included).
      - Binance bars: the archive's spot bar symbols.
      - Coinbase: its public product list, with status.
      - FRED: a curated list of about 40 common series with titles, since FRED's search needs an API key. Any id can still be typed.
    - Lists load on first use and are kept for 12 hours, and a concurrent first use shares one load.
  - **Fetch data (other sources):** source (Binance or Coinbase bars, FRED), symbol, interval (1s…1w; Coinbase 1m, 5m, 15m, 1h, 6h, 1d) and a UTC date range. The result is one Parquet file. Fetches run in the background with progress and **Cancel**, and a cancelled or failed fetch keeps nothing.
    - **Binance** uses the public market-data mirror `data-api.binance.vision`, 1,000 bars per request.
    - **Coinbase** uses `api.exchange.coinbase.com`, 300 candles per request.
    - **FRED** uses the keyless `fredgraph.csv` download.
    - Requests are paced and back off on 429 or 5xx. They go only to those three https hosts, only to public addresses, and refuse redirects. The cap is 20 M rows per fetch.
  - **Register a file:** freezes a CSV, CSV.GZ, TSV, Parquet or JSON file from the developing idea's workspace (up to 20 GiB; CSV and Parquet get a preview) as a snapshot, with a title and a note on where it came from. This is how data from Bloomberg or another paid feed, pulled by the user's own code, arrives with provenance. The app never holds credentials.
  - **Storage:** a snapshot is `<strategy>/Data/snapshots/<name>.<ext>` (read-only Parquet: one file, or a folder of daily files for archive data) plus `<name>.json`. The JSON holds the source, query, fetch time, rows, first and last timestamps, columns, bytes, SHA-256 and a preview: the first and last 20 rows and the close or value column thinned to about 2,000 points, computed once when written. A refresh is a new snapshot, never an overwrite.
  - **Deleting a snapshot:** **Delete…** in the snapshot's header, or ⌘⌫ in the list, always opens an inline confirmation first. It shows the space freed and the code in the strategy's idea workspaces that mentions the snapshot's file: text files up to 1 MiB, outside `data/`, `.git` and caches, listed with the idea's name. **Delete for good** removes the file or daily folder (its read-only files included) and the manifest; there is no trash, since snapshots can be gigabytes. The data can be fetched again as a new snapshot. The workspaces' own files are never touched. `data_preview` reports the same references, and `data_delete` (destructive; only on an explicit request) returns them. A snapshot a release candidate used (current or earlier) cannot be deleted: `data_preview.retainedBy` names the candidates, and the confirmation says so instead of offering **Delete for good**.
  - **In the workspace:** each idea workspace links `data/` to the snapshots, and git ignores it. The Files pane lists the workspace only. Pi is told to read `data/`, never to modify it, and how to fetch or register data.
  - **View:** a list with rows or size per snapshot, and a detail view with rows, range, columns, file, SHA-256, fetch time and source note. The column types, a copyable polars snippet (`pl.scan_parquet("data/<name>/*.parquet")` for daily folders, otherwise `pl.read_parquet`), a chart on the time column, a line chart of the close or value (crosshair and tooltip; intraday ranges label the ends with times), and the first and last rows as a table.
  - **Routes:** reads are unjournaled GETs (`/native/data/snapshots|jobs|preview?name=`). Fetch, cancel and register are POSTs. All go through the registry.
- **Data stage (production live data):**
  - **Production bar:** every production stage shows the idea in production: its title, version, checkpoint, snapshot count and when it was sent. With nothing in production, the bar links back to Research Development.
  - **Feeds:**
    - **Collection switch:** turns the background service on or off (`feeds_service_set`). The pane states whether it is collecting, how many feeds it serves and its last heartbeat.
      - On macOS it is a user LaunchAgent, `~/Library/LaunchAgents/com.piresearch.feeds.<hash of data root>.plist` (RunAtLoad, KeepAlive). It runs `backend/feeds-daemon.mjs --root <data root>` and logs to `<root>/.runtime/feeds/daemon.log`, so collection continues while the app is closed. Switching off unloads and removes it.
      - With `PI_RESEARCH_FEEDS_MODE=child` (development, tests) the same service runs as a child of the backend and nothing is installed.
    - **From your research:** the snapshots sent to production, each with the live feed that continues it. For example, archive 1m bars become a live 1m bar stream that first fills the days since the snapshot ended from the archive. One click, **Collect live**, creates it (`seededFrom` records the snapshot).
    - **New feed:**
      - **Live stream:** Binance spot, USDⓈ-M or COIN-M (trades, aggTrades, bars, bookTicker, depth10, markPrice, liquidations) or Coinbase (trades, ticker). The stream can optionally backfill complete past days from the archive.
      - **Scheduled pull:** Binance archive datasets, Binance or Coinbase bars, or FRED, every 15m, 1h, 6h or 1d.
      - **Your script:** a command run on a schedule with the user's login shell. For the idea that is the release candidate, it runs in a clean copy of the candidate's checkpoint (`Data/production/<id>/source/`, with `data/` linked as in the workspace), so later edits to the workspace change nothing that runs; the checkpoint is tagged `candidate/<n>` in the workspace so it stays reachable. A script for another idea runs in its live workspace. It writes CSV or Parquet to `$PI_RESEARCH_OUT` with rows after `$PI_RESEARCH_SINCE`, and its time column keys the partitions. The app never holds credentials, and changed columns are refused.
      - Symbols have suggestions.
    - **Feed rows:** each shows its state (live, catching up, scheduled, paused, error, not collecting) as a labelled tag, its source, lag, rows today and in total, frozen partitions and the latest error. Rows have **Pause/Resume** and **Explore**. **Delete** (or ⌘⌫) opens an inline confirmation, with the option to keep the data.
  - **Live collection is built not to lose data** (server/feeds/workers.ts `StreamWorker`):
    - **Two connections per stream, always on.** Each message is kept once, by the exchange's sequence number: trade id, aggregated-trade id, book update id, bar open time, mark-price event time, or Coinbase trade id or sequence. Liquidations have no sequence number, so they are deduplicated by content within a minute. One connection dropping, stalling or being rotated leaves no gap.
      - Rotation happens before Binance's 24-hour cutoff, at 20 h, staggered between the two connections, and only while the other one is live.
    - **Liveness:** Binance connections must answer a `LIST_SUBSCRIPTIONS` request (sent on open and every 30 s, 10 s to answer); Coinbase connections subscribe to heartbeats (every second). A silent or half-open connection is replaced. Reconnects back off from 1 s to 30 s.
    - **Exact gap fills:** trades (spot `api.binance.com/api/v3/historicalTrades`), aggregated trades (spot, USDⓈ-M and COIN-M `aggTrades?fromId=`) and Coinbase trades (paged by id) have gap-free ids. A skipped id, a restart (from the last row on disk) or a Coinbase heartbeat naming a newer trade id triggers a fetch of exactly the missing ids before any newer row is written.
      - Bars fill skipped bar times the same way.
      - At most 500,000 rows are fetched per gap; the rest stays missing, for the archive to repair.
      - The resume point only moves forward, so live rows that arrive during a fill are written once.
    - **Outages:** `outages.jsonl` records every stretch the connections did not cover by themselves: from, to, cause, rows known missing, refetched and still missing, or a hole for data without history (books, mark price, liquidations).
      - A crash is recovered on restart: the newest open hour stays open until its gap is filled.
      - Quality lists outages, and flags those that left data missing. Feed rows show "2 of 2 connections" and the rows refetched today.
    - **Freezing:** periods freeze 10 s after they end. The timer never freezes a period while a feed is catching up, whether from a backfill, a fill, or a pull or script run. Writes and freezes run one at a time.
  - **Explorer:** the chosen feed's status, latest row and lag, its columns, a copyable `pl.scan_parquet("Data/production/<id>/data/**/*.parquet")`, a chart of its main value, and the latest rows. It refreshes every 3 s.
  - **Quality:** the feed's frozen partitions, newest first. Each lists rows, largest gap, duplicates (by trade/update id), out-of-order rows, missing bars (bar feeds), late rows, size and SHA-256. Partitions with issues are flagged with ▲.
  - **Contract:** data contracts, handoffs and feasibility, as before.
  - **Storage, per strategy:**
    - Definitions: `Data/production/feeds/<id>.json`, written by the app.
    - Per feed, `Data/production/<id>/` holds:
      - `open/<period>.ndjson`: the open hour (streams) or day, flushed every second;
      - `data/YYYY/MM/DD/HH.parquet` or `data/YYYY/MM/DD.parquet`: closed periods (zstd, UTC microsecond timestamps, read-only, 0400);
      - `partitions.jsonl`: rows, SHA-256 and quality per period;
      - `status.json` and `state.json`.
    - The service rescans definitions every 5 s, so create, pause, resume and delete need no signal.
    - Late rows are counted, never written into a frozen period. A restarted service resumes the current period and closes older ones.
  - **Registry:** `feeds_list`, `feed_create`, `feed_update`, `feed_delete` (destructive), `feed_partitions`, `feed_rows`, `feeds_service`, `feeds_service_set` (only when the user asks), `production_commit`, `production_preview`, `production_status`. Reads are unjournaled GETs (`/native/feeds`, `/native/feeds/rows?id=`, `/native/feeds/partitions?id=`); changes are POSTs.
- **Moving between Ideas and Literature:**
  - **Revise idea:** a note's actions in Literature, with a focus set, include **Revise idea**. It adds the note to the focus idea's evidence as an unsaved revision: page, quote, comment and stance, cited to the source. Then it switches to Ideas with that idea open in the editor. Nothing is saved as a version, and saving it keeps the idea pursued. The same note is never added twice. The window uses the registry operation `idea_add_note` (`POST /native/idea-note`, `show: false`) and moves itself. Agents use the same tool, which opens the idea in the Idea pane by default.
  - **Work on in Literature:** a pursued idea's row (↗) and its editor header (**Work on in Literature ↗**) set it as the Literature focus and switch to Literature with the Sources pane forward. Agents can set the focus with `literature_focus`.
  - Panes hand work to another stage through `goToStage(stage, pane)` on the research scope. It switches stage and brings that pane forward in the stage's layout.
  - While reading a paper in Literature, a compact focus selector sits above the page, so the focus idea stays visible.
- **Coverage per idea (Literature):** each pursued idea in the overview, and the focused idea under the selector, shows its papers (primary + secondary), notes by stance (supports, contradicts, refines, unjudged) and its gaps:
  - no primary or secondary papers yet;
  - no evidence noted yet;
  - supporting evidence only, nothing contradicts it yet;
  - notes without a stance;
  - notes judged on an earlier version;
  - primary papers without notes.

  Coverage is computed once in the backend (`ideaCoverage` in `src/idea-coverage.ts`, from the idea's ranks and linked notes on live sources) and returned by `ideas_pursued`, so the window and agents see the same numbers. The Literature agent is told to use the gaps to suggest what to read next, especially evidence that could contradict an idea.
- **Notes linked to ideas (Literature):** see [research flow](RESEARCH-FLOW.md).
  - **Stance buttons:** with a focus idea set, every note in the reader shows the idea's name and **supports / contradicts / refines**. Clicking a stance links the note with that stance. Clicking the active stance clears it but keeps the link, and × unlinks.
  - **New notes:** a highlight or comment made during a focus is linked to the focus idea straight away, with its stance still to be judged. The notice says so.
  - **Other ideas:** links to other ideas show as chips ("contradicts · Vol-managed crypto").
  - **Versions:** a link records the idea version it was judged on. When the idea has moved on, the note shows "v1→v3".
  - **Filter:** the notes list gains a **this idea** filter.
  - **Storage:** links sit beside the notes (`noteLinks` in the strategy store, by note and idea), so notes cited by scientific records stay unchanged. Links of notes in Recently deleted are kept for restore.
  - **Agents:** `note_link` sets a stance ("unclassified" links without one, "none" removes the link) and records the idea's current version. `note_create` accepts `idea` and `stance`, and the idea is checked before the note is created. `idea_notes` lists an idea's linked notes with counts by stance. `source_notes` shows each note's links. Wherever idea is omitted, the Literature focus is used. `/native/research` includes `noteLinks` and `ideaTitles` for the window.
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

- **Registry.** There are 61 small tools (including the two strategy-management tools above), each with a precise zod input schema that is exported as JSON Schema:
  - ideas: `ideas_list`, `ideas_pursued`, `literature_focus`, `idea_get`, `idea_create`, `idea_update`, `idea_save`, `idea_decide` (with `expectedHash`), `idea_delete`, `idea_open`. The Idea pane saves, decides and deletes through these same operations (`/native/idea-save|idea-decide|idea-delete`).
  - **A conversation bound to one idea** (the Research Development Pi, whose tool connection carries `idea=`) stays on it: tools that take an idea default to that one, whatever the window shows, and changes to another idea are refused; reads of other ideas stay allowed.
  - reviews: `reviews_list`, `review_get`, `review_prepare`, `review_duplicate`, `review_create_idea`, `review_delete`;
  - Research Development: `rd_develop`, `rd_files`, `rd_read`, `rd_changes`, `rd_diff`, `rd_checkpoint`, `rd_history`;
  - data snapshots: `data_snapshots`, `data_preview`, `data_symbols`, `data_estimate`, `data_fetch`, `data_jobs`, `data_cancel`, `data_register`, `data_delete`;
  - sources: `sources_list`, `source_notes`, `note_link`, `idea_notes`, `idea_add_note`, `paper_search`, `paper_import`, `source_view`, `paper_read`, `paper_find`, `note_create`, `note_update`, `note_delete`, `source_delete`, `source_restore`, `source_importance`.

  `ideas_pursued` is how the later stages (Literature onwards) read the ideas you decided to pursue. It returns each idea at its latest saved version (id, version, hash), with the decision reason, all fields, and its evidence with the cited sources named. Unsaved edits are never included; `pendingEdits` says whether there are any. Pursue stays with an idea as it is revised, so the list gives the latest saved version with `pursuedOnVersion`. Revise or reject on a later version removes it. Archived ideas are left out.

  **Stage guidance.** Each research stage's conversation is told what the stage is for (`STAGE_GUIDANCE` in `server/workbench/tools.ts`). The desktop's Pi pane connects to the tools with `?stage=<stage>`, and the MCP `initialize` instructions then append that stage's text, which Pi receives as prompt guidelines. Literature is told to start from `ideas_pursued`, to find, read and annotate papers for those ideas, and to say which idea each finding bears on. External MCP clients connect without a stage and get only the shared guidance.

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
