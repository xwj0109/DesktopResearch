# Pi Research workflow redesign plan

26 September 2026 · Version 2.0

Version 2 replaces the first draft (kept as [WORKFLOW-REDESIGN-PLAN.v1.md](WORKFLOW-REDESIGN-PLAN.v1.md)). It keeps that draft's direction and cuts it down to what one researcher, or a small team, working with AI agents on a desktop app needs now. Section 10 lists what was removed and when to bring it back.

## 1 Goal

One researcher should be able to take an idea from the first question to a validated release candidate in one continuous place, with the AI working on the same state. Along the way, practical risks (data, timing, compute, cost) should be tested early, and nothing already learned should need to be re-entered or re-explained.

Every feature in this plan must make one of the journeys in section 8 shorter or safer. If it does neither, it waits.

What it should feel like:

- **I pick an idea once.** Its papers, code, data, runs, risks and conversation follow it, whatever I'm doing.
- **I see the thing I'm working on**, not a form about it. Records are captured as a side effect of the work.
- **The latest result, the biggest risk and anything waiting for me are always one glance away.**
- **The AI works on the same idea as me** and never touches another one by accident.

## 2 What changed from version 1

| | Version 1 | Version 2 |
| --- | --- | --- |
| Direction | Continuous workspace, real execution, early feasibility, artifact-first layout | Same |
| Correctness fixes | After a baseline phase | First, each with its regression test as the reproduction |
| UX | Phase E, after the domain work | Quick wins in phase 1; navigation change in phase 2 |
| New concepts | 10 domain objects, plus tasks, grants, waivers, budgets | 3 new records: Run, Risk, Candidate |
| Evidence model | Strength × satisfaction × freshness, dependency-graph invalidation | One status per risk, plus a simple stale rule |
| Delivery | 6 phases, 16 work packages, 7 decision owners | 3 phases, plus a "when needed" list |
| Remote, deployment, budgets, migration machinery | Planned now | Deferred until there is a real need (section 10) |

## 3 Principles

### 3.1 User experience

1. **The idea is the thread.** Everything opens in the context of one idea, and choosing an idea is one action for the whole window.
2. **Show the artifact.** The main surface shows the paper, code, diff, run or data. Saving versions, checkpoints and records happens around the work, not in separate stages.
3. **Two actions to anything that matters:** the latest result, the most important risk, a pending approval, a new document.
4. **Few words to learn.** The words users see: *Idea, Paper, Note, Snapshot, Run, Risk, Candidate, Feed.* No other domain term appears in the interface.
5. **Ask only when it matters.** Routine, reversible work needs no approval. Saving a version, creating a candidate, deleting, switching feeds on and large runs do.
6. **Don't rearrange my screen.** The AI can offer to show something. It never steals focus or closes what I pinned.

### 3.2 Invariants (unchanged from version 1, condensed)

- **An agent's write lands only on the idea its session belongs to.** Navigating the window never changes that.
- **A run records what actually executed:** commit, command, data, environment, hardware.
- **Nothing a release candidate used can be deleted** while the candidate is kept; exploratory runs keep the names and hashes of the data they used.
- **The window and the agent go through the same operations,** with the same checks (docs/PRINCIPLES.md).

## 4 Problems this plan fixes

"Confirmed" means seen in the code or the running app. "Reported" means a review described it and it still needs reproducing.

| # | Problem | Evidence | Phase |
| --- | --- | --- | --- |
| P1 | Formal backtests run `reference-close-v1` on daily closes and never execute the workspace code; spec, contract and code schemas can't describe Python, tick data or ML | Confirmed: `src/platform.ts` schemas, `server/platform.ts` `run.queue` (`authoredCodeExecuted: false`) | 2 |
| P2 | The production commit isn't used by anything downstream; feed scripts run in the live working folder, not the commit | Confirmed: `production-contract.ts`, `feeds/workers.ts` `ScriptWorker.run` | 1 |
| P3 | Snapshots used by the production commit can be deleted | Confirmed: `data.ts` delete | 1 |
| P4 | Agent tools fall back to the window's selected idea, so a background session can act on another idea | Confirmed path, scenario to reproduce: `mcp.ts`, `tools.ts` `developIdea` | 1 |
| P5 | The Idea pane sends save, decide and delete as raw commands, not through the registry services | Confirmed: `IdeaBoard.tsx` | 1 |
| P6 | Old dataset projections and snapshot manifests share `Data/snapshots/`, and the listing sorts by a field projections lack | Confirmed path, scenario to reproduce: `projections.ts`, `data.ts` `snapshots` | 1 |
| P7 | The agent has no operations for runs, candidates or risks; the later stages get one-line guidance | Confirmed: 60 registry tools, none for these | 2–3 |
| P8 | Seven stage conversations and three separate "current idea" selections; the user carries context between them | Confirmed: `WorkbenchEvents.tsx`, `ResearchDev.tsx`, `SourcesPane.tsx` | 1, 3 |
| P9 | One visible pane per column: 6 tabs in Research Development, 4 in Data, no badges; the Ideas stage opens on the library | Confirmed and observed in screenshots | 1 |
| P10 | "Ask Pi" pastes into the terminal, can land in an invisible draft, says "press Send", and is missing on files, diffs, documents, runs and feeds | Confirmed: `Workbench.tsx` `appendComposer`, `PiTerminal.tsx` | 1 |
| P11 | Hidden tabs keep polling; the same resources are fetched by several loops | Confirmed mechanism; request rate estimated, not measured | 1 |
| P12 | Feasibility is only recorded after the handoff | Confirmed: `feasibility.record` needs a handoff | 3 |

## 5 Target experience

### 5.1 Navigation: ideas and three modes instead of seven stages

The rail lists the strategy's **ideas** (with a status dot) instead of stages. Within an idea there are three modes, switched with ⌘1–3:

| Mode | What you do there | Replaces |
| --- | --- | --- |
| **Explore** | Frame the idea, read papers, take notes, draft the risks | Ideas (editor), Literature |
| **Develop** | Code, data snapshots, runs, comparisons, documents | Research Development, Design & Code, Backtests, Results |
| **Release** | Release candidate, its validation run, the feeds it needs | "Send to production", the production parts of Data |

The **Ideas board** is the strategy's home: all ideas, their status, and **+ New idea**. It opens on the board, not on the library. **Feeds** stay a strategy-level view, because a feed is a service that several ideas can use. The Release mode shows the feeds its candidate depends on, with their health. Portfolio windows are unchanged.

Legacy spec, contract, graph, code and reference runs stay readable under **Legacy records**. The reference engine remains available as a labelled **reference baseline (daily close)** in Runs.

### 5.2 Window

```
┌ Perp funding carry · v3 · pursued │ 8 papers (2 contra) │ ⚠ 1 risk failed │ 5 changes │ run #12 ✓ │ 1 waiting ┐
├────┬─────────────────────────────────────────────┬───────────────────────────────┤
│ ◉  │ main surface: document, diff, run or paper  │ AI (idea's conversation)      │
│ ○  │                                             │                               │
│ ○  ├─────────────────────────────────────────────┤  resizable; ⌘J collapses to   │
│ +  │ optional second artifact (e.g. Changes ·5)  │  a slim bar with its status   │
└────┴─────────────────────────────────────────────┴───────────────────────────────┘
```

- **The idea strip** is the one place for "where does this idea stand". Each item links to what it names. Expanding it shows **What the AI sees** (section 7.3).
- **The main surface** gets most of the width when reviewing code, comparing runs or reading. The AI pane widens on demand for discussion.
- **Two artifacts can be shown together,** side by side or stacked. Tabs carry badges (Changes ·5, Documents • new, a feed marked ⚠).
- **The rail collapses to icons** at 1440px wide or less, with labels on hover.

### 5.3 Default views

| Mode | Main surface | Beside it |
| --- | --- | --- |
| Explore | The idea, or the paper you're reading | Notes and their stance, risks, AI |
| Develop | Newest document or run | Changes, or a second run to compare; AI |
| Release | Candidate checklist | Validation run, feeds and their health; AI |

A new document or run opens with **Show** in a notice. It only opens by itself if you asked for it.

### 5.4 An idea's journey

1. **Frame.** You describe the idea. The AI drafts the brief (question, baseline, falsification, where it must run) and the **3–5 risks that could kill it**, each marked *unknown*. Only the title and question are required.
2. **Probe the cheapest risk first.** Each probe is an ordinary run: fetch a sample and check coverage, time one training batch, measure feature latency. The run marks its risk *measured-ok* or *failed*.
3. **Develop.** Write code in the workspace, run it, compare two runs side by side. The app warns when two runs used different data or splits.
4. **Create release candidate.** One button, which checks four things: no uncheckpointed changes, snapshots pinned, environment lock present, and risk status shown (failed risks need an explicit "continue anyway" with a reason).
5. **Validate.** Run the candidate's entry point from a clean checkout of its commit, on the held-out period.
6. **Release.** Feeds the candidate needs run from its commit. Deployment elsewhere is recorded as a link (section 10).

### 5.5 When an idea turns out to be infeasible halfway

A run fails a risk, for example "the feature is only available 2s after the decision time". Then:

- The strip shows **⚠ 1 risk failed**. One click shows the risk, the run that failed it, and the candidates and runs that relied on it.
- Old results stay exactly as they were, with their original conditions.
- You choose: **revise the idea** (new version, the risk carries over), **work around it** (drop the feature, change the frequency), or **stop the idea** (with the reason recorded, so nobody repeats it).
- Risks measured before a change of code or data show as *stale* until re-measured.

## 6 What the app stores

### 6.1 Existing records (unchanged)

Ideas (stable id, immutable versions, decisions), papers and notes, data snapshots, feeds, and workspace checkpoints (git).

### 6.2 Three new records

- **Run.** Its fields:
  - id, idea, commit, command or manifest entry, snapshots used (name and SHA-256), and environment (lockfile hash, Python version, resolved packages)
  - hardware facts (CPU, memory, GPU if any)
  - status (queued, running, succeeded, failed, cancelled), exit code, log
  - metrics (read from `outputs/metrics.json`), output files with hashes, wall time and peak memory

  Runs are append-only. Two runs of the same idea can be compared.
- **Risk.** Its fields:
  - idea, one sentence, and a kind (data, timing, compute, latency, cost, other)
  - status: *unknown, estimated, measured-ok, failed, waived*
  - evidence: a run, a note or a short text
  - a *stale* flag, shown when the current code or data differs from what the evidence run used

  A waiver is a reason, not an approval workflow.
- **Candidate.** Its fields:
  - idea version, commit (tagged `candidate/<n>` in the workspace), pinned snapshots, environment lock
  - validation runs, risk statuses at creation, a note, and an optional link to an external deployment

  Its state (validating, passed, failed, superseded) comes from its validation runs. The current "production commit" becomes candidate 1, with its missing fields shown as missing.

### 6.3 The workspace manifest

A small `research.toml` in the workspace, written by the agent like any other file:

```toml
[env]
lock = "uv.lock"

[run.train]
command = "python train.py"
inputs  = ["binance-btcusdt-1h-2026-08-01-2026-09-01"]
outputs = ["outputs/"]

[[feature]]            # optional; drives the Features table
name = "funding_z"
source = "fundingRate"
lookback = "30d"
available_after = "0s"
```

The app reads it to offer **Run ▸ train** buttons, check the inputs exist, and show a Features table. It is never the authority for results or approvals, and unknown keys are kept and ignored.

## 7 Working with the AI

### 7.1 Each session stays on its idea

A Pi session's tool connection carries its idea. Omitted targets resolve to that idea, and writes to another idea are refused with a clear error. What the window is showing is only used to resolve reads such as "this paper".

### 7.2 One conversation per idea

The idea's conversation (Research Development already has one) is shared by Explore, Develop and Release, with a line of mode guidance added. The old stage conversations stay available as history. Separate threads are possible later, but they aren't the default.

### 7.3 What the AI sees

An `idea_context` tool returns a compact summary: brief, risks, last five runs, candidate, open questions and pending approvals. The user can see the same summary by expanding the idea strip. This replaces "the files are in the same folder" as the shared memory.

### 7.4 Operations to add

- `run_submit`, `run_status`, `run_cancel`, `run_logs`, `run_compare`
- `risk_list`, `risk_set`
- `candidate_create`, `candidate_status`

These are about ten tools in the existing registry, through the same services the window uses.

### 7.5 Context in and out

- **Into the AI:** "Ask Pi" works on a file and line range, a diff, a document, a run, a snapshot, a feed row and a risk. If the terminal isn't ready, the item stays as a visible pending chip rather than a silent draft. The copy matches the terminal: no "press Send".
- **Out to the window:** the agent can ask the window to show a document, a run or the changes. The window shows **Show** in a notice if you're typing or have something pinned.

### 7.6 Approvals

- **Without asking,** the agent may run up to 5 runs or 1 hour of wall time per request. The limit is shown and editable in the idea strip.
- **Only with the user's say-so:** saving idea versions, creating candidates, deleting, switching feeds on, and anything over the limit.
- **Where approvals appear:** one "waiting" count in the idea strip that opens the list.

## 8 Journeys that define success

| # | Journey | Target |
| --- | --- | --- |
| J1 | From an idea, see its latest result and most important risk | 2 actions or fewer, no conversation switch |
| J2 | Ask the AI about a diff or a run; view the change beside the test output | The answer names the exact commit or run |
| J3 | Switch to idea B while idea A's agent is running | None of A's writes land on B; A's progress shows in the rail |
| J4 | A run fails a risk: see what relied on it, revise, compare, keep the old result | No manual copying |
| J5 | Create a candidate and validate it from a clean checkout; its feed script uses that commit | Editing the workspace afterwards changes nothing that ran |
| J6 | Quit during a run and reopen | Correct status, no duplicate run |

Measure each journey before and after every phase, using the screenshot driver (an isolated copy of the app on disposable data). Count the actions taken and how many times context had to be re-explained to the AI.

## 9 Delivery

### Phase 1: fixes and quick wins (small; ships on its own)

**Correctness.** Write each regression test first, as the reproduction:

- Bind agent sessions to their idea (P4): `mcp.ts`, `tools.ts`, `pi-research-extension.mjs`.
- Tag the sent commit, and run feed scripts from a checkout of it (P2): `rd.ts`, `feeds/workers.ts`.
- Refuse deleting snapshots the production commit uses (P3): `data.ts`.
- Move projections out of `Data/snapshots/`; skip unreadable manifests with a warning (P6): `projections.ts`, `data.ts`.
- Send idea save, decide and delete through the registry services (P5): `IdeaBoard.tsx`, `tools.ts`.

**UX quick wins:**

- The Ideas stage opens on the Idea board.
- One current idea per window, shared by Ideas, Literature and Research Development (P8).
- Idea strip, first version: status, papers and notes, uncheckpointed changes, newest document, candidate state. Each item links to what it names.
- Tab badges, a right column that can split into two panes, and a rail that collapses to icons (P9).
- Ask Pi on Research Development files, diffs and documents; a visible pending chip; wording that matches the terminal (P10).
- A notice when the agent adds a document, with **Show**.
- "Send to production…" becomes **Create release candidate…**, and "in production" becomes **candidate**.
- One shared polling hook: hidden tabs stop polling, and Files and Documents share one request (P11).

**Status, 26 September 2026:** phase 1 is implemented; `npm run check` passes with 389 tests. Two items were delivered differently from the list above:

- **Idea strip:** it lives in the Research Development bar (literature, changes, newest document, candidate). Literature keeps its own focus bar, and the production stages keep the candidate bar.
- **New document:** it shows as a **new** mark in the strip and on the Documents tab, not as a pop-up notice.

What remains:

- Snapshots (DataSnapshots) and the stage-activity poller still poll on their own.
- JSON that older versions projected into `Data/snapshots/` is skipped but left in place.

### Phase 2: real runs and candidates (medium to large)

- **Run record and local executor:**
  - check out the commit into a run folder and link `data/`
  - check the environment lock
  - run the command with a wall-time limit, stream the log, and collect `metrics.json` and outputs
  - record wall time, peak memory and hardware
  - reconcile after an app restart (J6)
- **Runs view in Develop:** list, log, metrics, and compare two side by side, with a warning when they aren't like for like.
- **Create release candidate** builds a Candidate. Its validation is a run of the candidate's entry point.
- **Registry tools** for runs and candidates, plus the Develop guidance (P7).
- **Navigation switch** to ideas and Explore, Develop and Release. The Design & Code, Backtests and Results stages go; legacy records stay readable. This sits behind one setting while it settles.

**Status, 26 September 2026:** phase 2 is implemented and checked end to end in the app: a real run from **Run ▸ train**, then a candidate created, validated and passed. Where it differs from the list above:

- **Rail:** it lists Ideas, Explore, Develop and Release, with the pursued ideas below them. Stage ids and conversations are unchanged, so each mode still has its own conversation until phase 3.
- **Retention:** snapshots are kept for release candidates (current and earlier), not for every exploratory run. A deleted snapshot stays named in the runs that used it.
- **Environment:** the app records the lock and the environment files; it does not build the environment. A run uses whatever the command sets up (e.g. `uv run`).
- **Legacy stages:** Design & Code, Backtests and Results remain behind **Show legacy stages**, which is the one setting.

### Phase 3: risks, one conversation, ML views (medium)

- **Risks on each idea.** The AI drafts the brief and top risks, runs mark their risk, and stale evidence is shown (P12).
- **One conversation per idea** across modes, with `idea_context` and "What the AI sees". Old stage sessions become history.
- **Experiment batches within the run limit,** ending with a short summary document.
- **ML views** from the manifest and run telemetry:
  - a **Features** table: source, lookback, available after
  - **Resources** per run: wall time, peak memory, GPU if present
  - the graph becomes optional, with zoom-to-fit

**Status, 26 September 2026:** phase 3 is implemented and checked in the app. Where it differs from the list above:

- **The brief is the idea itself.** Its rationale, universe, horizon and "what would change your mind" already are the brief. Risks sit beside it: the Ideas and Develop agents are told to draft 3–5 of them, and **Ask Pi to draft them** in the idea editor does the same.
- **Stale rule:** a measured risk goes stale when its evidence run used other data or another environment than the idea's latest run, or ran on code before the current release candidate. A code change alone doesn't mark it stale; that would mark everything stale at every checkpoint.
- **Conversations:** Develop, Explore (when focused on an idea) and Release (when there is a candidate) share the idea's conversation. The Ideas board, Explore's "All ideas" overview, Release without a candidate and the legacy stages keep their own. Earlier stage conversations stay in Pi's session list.
- **Resources:** wall time and peak memory, next to each run's metrics. GPU use isn't recorded: macOS offers no per-process GPU figure without extra tools.
- **Graph:** it is optional, because it now lives only in the legacy Design & Code stage. Zoom-to-fit wasn't done.
- **Batches:** a batch is up to 20 runs of one checkpoint, checked against the agent limit as a whole. The summary is `reports/batch-….md` in the workspace, marked **new** in Documents.

### When needed (not scheduled; start one when its trigger happens)

| Item | Trigger |
| --- | --- |
| Remote executor for one target you use (SSH or GPU machine); snapshots on object storage | A run no longer fits the laptop |
| Import from MLflow or W&B | You already track runs there |
| Git remote, CI result and deployment link on candidates | Code review or a real deployment starts |
| Per-strategy writes or SQLite; request-log pruning | Measured slowness, or the limits get close |
| Money budgets, leakage checks, held-out access log | Paid compute, or ML candidates reaching release |
| Multiple users and permissions | A second person works in the same data |

## 10 Removed from version 1, and why

- **A "Research Direction" separate from an idea.** Ideas already have a stable id and versions; a second word for the same thing confuses more than it helps.
- **Task objects, authority grants and a decision inbox with batch rules.** Session binding, a visible run limit and one "waiting" list cover the need.
- **Constraint records with 13 fields and waivers with approvers and expiry.** A risk is one sentence, a kind, a status and its evidence.
- **Three-axis evidence and dependency-graph invalidation.** One status plus a stale rule is enough to trust or re-check.
- **Seven-state candidate and deployment lifecycles.** A candidate's state comes from its runs; deployment is a link until it's real.
- **An executor with 8 operations and 8 states, storage resolvers and a monetary budget ledger.** A local process with 5 states comes first; remote work comes when a run doesn't fit.
- **Four feature flags and a formal storage migration with an atomic authority switch.** New records are additive, old ones stay readable, and one setting covers the navigation change.
- **A baseline phase before fixing confirmed bugs.** The regression tests are the reproduction; journeys are measured with the existing screenshot driver.
- **Owner roles, decision owners and 16 work packages.** The plan is for the people actually building it.

Bring them back when one of the triggers in section 9 occurs, or when a journey in section 8 can't be met without them.

## 11 Decisions

Decided with the user on 26 September 2026:

1. **Navigation:** the seven stages are replaced by ideas plus Explore, Develop and Release (phase 2).
2. **AI pane:** the Pi terminal stays the conversation surface for now. Rich previews appear in the main surface.
3. **Environment convention:** `uv.lock`.
4. **Run limit:** the agent may use up to 5 runs or 1 hour of wall time per request without asking. The limit is shown and editable.

## 12 References

- docs/RESEARCH-FLOW.md: the current exploration loop and handoff.
- docs/PRINCIPLES.md: shared operations and runtime agnosticity.
- docs/INTERFACE.md: the current panes and composition.
- src/platform.ts, server/platform.ts, server/reference-engine.ts: legacy records and the reference engine.
- server/workbench/tools.ts, mcp.ts, rd.ts, data.ts; server/feeds/workers.ts; server/projections.ts: the phase 1 fixes.
- src/workbench/Workbench.tsx, layouts.ts, StageLayout.tsx, WorkbenchEvents.tsx, panes/: the interface changes.
- Google, [Rules of Machine Learning](https://developers.google.com/machine-learning/guides/rules-of-ml): an end-to-end pipeline early, and watching for training-to-serving skew.
