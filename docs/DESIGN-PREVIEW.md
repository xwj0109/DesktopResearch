> Integration note (2026-09-23): the following records the original private design handoff. In this repository browser fixtures now require `?design-preview=1`. Native windows do not load these fixtures; they use empty/disconnected actual scopes and native-owned local drafts. Native draft persistence does not change the browser preview’s reload-clears-drafts behavior. See `NATIVE-CANDIDATE.md`; historical private-preview test counts below are not current native acceptance.

# Imported design handoff

This is the historical private design implementation note. Its new frontend candidate is now copied into this independent repository under `src/workbench/`, with its own dependency install. It remains a synthetic/disconnected design preview until real runtime/scientific integration is verified. No legacy renderer was copied. Parent visual evidence is separate from the original author report.

---

# Pi Research — desktop workbench design preview

A new, original frontend seed, not a React port of the legacy HTTP dashboard. This project is intentionally transport-free. **Every conversation, activity, note, code sketch, graph and evidence record is synthetic. Nothing has been executed, approved, imported or scientifically validated.**

## Run and build

Requires the supplied Node 25 / dependency environment (native TypeScript config loading). No installation was performed.

```sh
npm run dev -- --port 5173
# or, after the existing production build:
npm run preview -- --port 4173
npm run build
npm test
```

Both servers bind to `127.0.0.1`. Neither was started by the implementation worker. Vite uses `--configLoader native` and a project-local `.vite-cache` so running these commands does not create caches/config bundles in the read-only node_modules symlink. Build output is `dist/index.html` and `dist/assets/` in this private directory. Do not run commands in the legacy repository.

**Tooling incident:** two earlier builds used Vite's default bundled config loader before this behavior was noticed. That loader writes then unlinks temporary config modules under `node_modules/.vite-temp`, whose symlink resolves to the legacy dependency directory. This was an unintended transient write outside the private project, not an application/source/settings change. No cleanup or mutation of that shared directory was attempted. The final commands avoid that path; the final build and tests passed afterward.

## Composition, not dashboard navigation

- A persistent 238px workspace rail holds isolated strategies and their seven research-stage sessions. Portfolio is a separate review context, not an eighth strategy stage. There are no seven full-page form screens.
- A conversation-led center has a session heading, restrained transcript, native expandable activity details, inline material reference and a session-scoped composer. Send is visibly disabled and labelled unavailable. Drafts are memory-only, separate for each strategy/stage and portfolio, and clear on reload.
- A genuinely adjustable material pane keeps the note, code, concept map and provenance next to the discussion. Default width is 440px. Drag the divider, use left/right arrows in 20px increments, or Home/End for bounds. Collapse from either header; reopen from the conversation toolbar. Bounds preserve at least 420px of center at 1280/1440 widths. Narrow screens overlay the materials; the desktop is the primary layout.
- Typography and thin separators establish hierarchy. Warm neutrals and a restrained sage accent distinguish contexts without dashboard cards, a marketing hero, vendor assets, or fake OS chrome.
- The note is a real rendered, locally authored CC0 text artifact, **not a PDF**. Text zoom works. Code is a viewer, not an editor. Map nodes are selectable conceptual dependencies, not an execution DAG or editable scientific schema.

## Bounded reference inspection

The existing source-evaluation report supplied exact pins. This implementation additionally retrieved the following pinned files, inspected bounded relevant excerpts and removed the downloaded inspection copies. No upstream source, branding or artwork is incorporated. These are verified structural influences, **not claims of pixel fidelity or copied components**:

| Reference | Exact inspected URL | Pattern translated here |
| --- | --- | --- |
| T3 Code README | https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/README.md | Agent control-surface framing rather than a workflow form dashboard. |
| T3 Code Sidebar | https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/Sidebar.tsx | Scoped project/thread navigation and compact selected-thread hierarchy → workspace rail and stage session in `Workbench.tsx`. Inspected imports and project/thread title rendering/search excerpts, not the entire 4,950-line implementation. |
| Qwen WebShellTranscript | https://github.com/QwenLM/qwen-code/blob/1b26d38b5c4707c1bd60e2857fded881f55527fe/packages/web-shell/client/components/WebShellTranscript.tsx | Transcript data/rendering customization and source-open boundary → data-fed conversation with an inline artifact opening the adjacent pane. Inspected imports and exported transcript props. No Qwen providers or daemon imported. |
| ZCode PDF viewer | https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/ui/src/components/ui/pdf-viewer.tsx | Focused document viewport with restrained navigation/zoom controls → `Materials.tsx` reading surface and bottom text-size controls. Inspected source interface and viewer-control excerpts. PDF rendering/annotation code was not reused. |

The upstream root licenses are MIT for T3 Code, Apache-2.0 for Qwen and ZCode per the supplied pinned evaluation. No copied-source notices are needed for this original implementation; this is not a license clearance for future upstream reuse.

## Components and integration boundary

- `src/main.tsx`: preview harness only; injects `previewData`.
- `src/fixtures.ts`: all synthetic scenario content; authored note text is dedicated to CC0 1.0. The code sketch is illustrative and not validated.
- `src/model.ts`: typed `WorkbenchData`, `Workspace`, `Thread`, `Material` props and pure draft/geometry helpers.
- `src/Workbench.tsx`: desktop shell, workspace/stage selection, thread, per-session drafts and panel state. No fixture import, transport, persistent store or SDK. Deliberately preview-only runtime status; a future connected mode must not reuse synthetic transcript activity as execution events.
- `src/Materials.tsx`: prop-driven note/code/map/evidence viewers. File-system access is absent.
- `src/CommandPalette.tsx`: reusable command list; Cmd/Ctrl+K, arrows, Enter, Escape, focus trap and focus restoration.
- `src/icons.tsx`, `src/styles.css`: original SVG primitives and desktop composition.

For the **new repository**, replace the preview harness with a validated data adapter rather than grafting this onto legacy dashboard routing. Thread keys currently demonstrate workspace/stage isolation, not durable session identity. Introduce canonical workspace/session IDs, persistence and Pi execution through an explicit adapter only after the visual gate. Keep canonical evidence distinct from transcript state. Do not enable Send merely by changing its disabled attribute: real lifecycle, approval, cancellation, error, permission and connection states need a genuine adapter contract.

Portfolio renders a bundled frozen-source example. It cannot mutate a strategy because this project contains no source-write API. That is **not** a promise of OS-level Pi read-only enforcement, real import provenance, or backend immutability. Production enforcement remains with the retained backend.

## Validation and handoff

- `npm run build`: passed; TypeScript and Vite 7.3.6, 34 modules. Final artifacts: `dist/index.html` (0.42 kB), CSS (21.00 kB), JS (223.41 kB / 70.49 kB gzip).
- `npm test`: 6 passed (4 model/fixture contracts, 2 rendered interaction tests). Tests cover isolated drafts, seven-stage navigation, workspace switching, portfolio separation, pane hide/show, keyboard resizing, palette filtering and tab selection. React 19 emits its expected react-test-renderer deprecation warning.
- No real browser, native desktop host, PDF reader, backend, inference or execution was run. Tests do not establish visual fidelity, DOM focus behavior or pointer hit-testing.
- This private directory is not a Git repository; there is no staging area and nothing was staged. `.gitignore` excludes dependencies, builds, local caches and runner artifacts.
- **Files frozen for parent visual QA.** Required next gate: inspect 1440×900 and 1280×800 with the native browser tool, check overflow, legibility, scroll/composer geometry, pointer resizing and keyboard focus. Independent review remains pending.

Suggested QA path: Momentum/Literature → expand a sample activity → open inline note → Code/Map/Evidence tabs → select a map node → type a draft → switch Reversal and return → switch research stages → Portfolio → resize/collapse/reopen materials → Cmd/Ctrl+K and search “Open map”. Reload clears drafts by design. Nothing should make a network inference request.
