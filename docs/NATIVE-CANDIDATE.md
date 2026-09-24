# Native integration — validation and handoff

## Build and startup

- App: `desktop-release/Pi Research-darwin-arm64/Pi Research.app`.
- Executable: `Contents/MacOS/Pi Research` inside the app.
- QA argument: `--lab-root` followed by a new disposable absolute directory. Production defaults to the Finder-visible `~/Pi Research Data` folder.
- Installed runtime overrides: `LAB_PI_NODE=/opt/homebrew/bin/node`, `LAB_PI_EXECUTABLE=/opt/homebrew/bin/pi`. Invalid explicit runtime paths fail rather than falling back.
- Opening a strategy starts its embedded Pi CLI conversation. The old launcher connection preference has been removed. The graphical fallback attempts one connection per visited strategy conversation; Stop and failed attempts are respected across tab changes. Sending a prompt remains a separate action.
- Cmd+Q, last-window close and SIGTERM to the app's owned PID use the graceful shutdown barrier. Failed preparation allows cancellation or explicit close anyway; blocked backend shutdown stays visible until the owned process exits.
- Private bounded diagnostics: `~/Library/Application Support/Pi Research/diagnostics/startup.jsonl`. Records contain fixed event codes, not roots, capabilities, environment or child output.

Electron owns the asset-only UI and main-process capabilities. An owned system-Node backend loads the installed Pi. JSON lifecycle IPC avoids the observed V8 advanced-serialization incompatibility between Electron 44 and system Node 25. Packaged helpers resolve within the app payload; no development tsx or external repository import is needed.

## Conversation and input contracts

Native snapshots expose actual models, commands, UI state and canonical conversation. Connected history comes from the active SessionManager branch; disconnected history is explicitly labeled as an offline append log. History pagination is fenced by generation and context, including a UI epoch when dialogs/terminal surfaces change.

Client-known action IDs are persisted before dispatch. Scoped durable receipts distinguish pending, acknowledged, uncertain and sealed outcomes. Duplicate IDs cannot execute another payload; retained receipts are not silently pruned. Sealing a missing receipt prevents a delayed action with that ID from executing. The UI offers explicit inspection/recovery and never automatically resends uncertain work.

The ordinary composer and expanded extension editor remain separate. Expanded editor text and revision/input watermarks are atomically checkpointed under product storage before raw input and after acknowledgement, and across stop/reconnect. Ordered terminal input drains before graceful close/reload. A failed critical input remains a preparation barrier until explicit successful refresh/acknowledgement. Refresh refuses while input is queued. Pending raw keys are never replayed. Terminal paste is split into ordered bounded frames; failed frames retain the input failure barrier.

Extension surfaces now use xterm for ANSI state, cursor movement and terminal input. The configured external editor uses a separate owned PTY. Terminal graphics protocols and every custom extension rendering convention are not certified. Tool/message output can be expanded without replacing the graphical composer. See [PI-PARITY.md](PI-PARITY.md) for the current compatibility audit.

## Scientific materials and authority

All seven stages expose actual immutable scientific records, human-labeled schema forms, version inspection and explicit approvals. Loading a saved version into an editor is explicit and preserves version lineage. Data handoffs and CSV ingestion feed bounded reference experiments; authored source code is inspected, not executed as arbitrary code.

PDF/text/image preview, source hashes, persisted annotation drafts, saved annotations, immutable prompt batches, code, semantic graphs and result plots share the context pane. Using a frozen annotation prompt only copies it into the composer; sending remains explicit. Portfolios maintain independent imported evidence, analyses and proposals. Conversation/tool text does not become scientific authority automatically.

Native mutations carry client request IDs. Main persists a scoped request journal before dispatch and refuses repeated IDs. Exact route/method/body allowlists and positive native DTOs keep filesystem paths and capabilities out of the renderer. Native export exposes only a bounded text/filename save-dialog operation, not a generic filesystem API. Navigation, unsolicited downloads, popups, permissions and external network requests remain denied.

## Persistence

Root/scope identities select separate Chromium profiles, stable view IDs and deduplicated windows. Main saves composer drafts, scientific/annotation drafts and selected layout using private temporary files, fsync and atomic rename. View preparation freezes editing, drains tracked mutations and saves the final synchronous snapshot before shutdown.

Corrupt or oversized saved view state fails visibly. Explicitly closed windows leave the restoration set but retain drafts; app quit preserves the open layout. These are acknowledged ordinary-save/graceful-close guarantees. Forced-crash losslessness, concurrent unmanaged writers and a user choosing Close anyway after preparation fails remain outside that guarantee.

## Verified on 2026-09-23

- `npm run check`: **229/229 tests**, TypeScript, repository boundary checks and Vite production build passed.
- Native integration regressions cover scoped receipts/deduplication/sealing, active/offline history, scientific approvals/scopes, expanded-editor restoration and a bootstrap dialog answerable while Connect is pending.
- Four React regressions cover Connect polling, ordered queued keys with refused Refresh, close-time critical-input failure and stale history-page isolation. An independent read-only reviewer reproduced the input-ordering issue, then cleared the focused repairs and these four tests.
- Actual dev and packaged Electron GUI: created separate strategy/portfolio records; verified window focus/deduplication, distinct composer drafts, pane state and quit/relaunch restoration; saved an immutable idea; rendered an authored PDF and saved a source-bound annotation; inspected source code and a three-node semantic graph.
- Packaged GUI using an authored fake Pi installation: explicit Connect, model display, canonical response, three tool events and custom renderer output. No real inference. Quit with the fixture connected exited successfully.
- The available display constrained native windows to **1200×850**. Automated geometry tests cover 1280×800 and 1440×900; native screenshots at those two sizes were not obtained.
- Final rebuild: renderer/workbench-ready diagnostics and graceful SIGTERM shutdown with exit 0 passed. Repeat visual inspection was unavailable because the Mac had locked; the preceding packaged GUI checks above are the visual evidence.
- Final macOS arm64 package: allowlisted payload, verified local ad-hoc signature and relocated backend ready/create/list/exit-0/reopen-persistence/exit-0 smoke. This does not imply notarization or distribution signing.

The installed-harness probe (`scripts/installed-pi-smoke.ts`, explicitly invoked only) used real installed Pi **0.84.1** with no prompts, network denied and all external writes denied by a temporary inherited macOS proof sandbox. It stopped during configured extension initialization with `Pi resources failed to load: Failed to load extension: unable to open database file`. The configured memory extension requires database access incompatible with that protected-write proof. Full shared-harness compatibility is therefore **not verified**. The probe did not disable extensions, copy authentication or alter global configuration; hashes of settings.json, auth.json, models.json, models-store.json, sandbox.json and path-approvals.json were unchanged. This instrumentation is not production sandbox policy.

## Evidence and remaining limits

The source summary is `evidence/native-check.json`; final packaged bytes are recorded in `evidence/native-payload.json`. Detailed logs and disposable QA records are private under `.local-evidence/` and the recorded temporary QA root. GUI screenshots were inspected through native computer-use tooling; they are not claimed as saved screenshot files. Foundation provenance remains in `evidence/native-pattern-import.json`.

Source integration and local packaged QA are complete within the stated scope. Configured installed-harness acceptance, unsupported extension terminal behavior, native target-size inspection, notarization and distribution signing remain open. No taskboard advancement, staging, commit, publishing, legacy migration or paid inference was performed.
