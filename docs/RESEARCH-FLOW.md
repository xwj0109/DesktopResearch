# Research flow: ideas through the stages

Decided with the user on 2026-09-25. Research is iterative: you move back and forth between Ideas, Literature and Research Development until you are convinced. Only then does an idea go on to the production stages.

```
Ideas ⇄ Literature ⇄ Research Development      exploratory, several ideas at once
                           │  send on (commit to one idea)
                           ▼
Data → Design & Code → Backtests → Results      production code, backtests, outputs
```

## Exploratory stages: Ideas, Literature, Research Development

- **Several ideas travel together.** Any number of ideas can be pursued at once. The **idea is the thread** through these stages: its versions, the papers and notes about it, and later its research drafts.
- **Pursue belongs to the idea, not to one version.** Revising a pursued idea keeps it pursued ("pursued since v1"), so iterating never drops it from Literature. Revise and reject are answered by the next version, which returns the idea to "to decide". The idea's most recent decision counts. There is one rule, `ideaStatus` in `src/idea-board-contract.ts`, used by the backend, every agent and the Idea pane.
- **Literature works on one focus idea at a time**, chosen at the top of the stage, or on "All pursued" as an overview. The focus decides which papers the Sources pane ranks and shows first. The Literature agent is told the focus, so "find papers" means for that idea. A paper can matter to several ideas, with a different rank for each.
- **Research Development** is where you test scripts and code with the agent and define the research precisely. It stays flexible, and you can go back to Ideas and Literature as often as needed.
  - **One workspace per pursued idea:** a folder `<strategy>/Research-Workspaces/<idea id>/` that is a local git repository the app manages (no remote), plus the idea's own Pi conversation, which runs in that folder.
  - **Which idea:** a **developing** bar across the stage states the idea being worked on. It is the window's **current idea**, the same choice as Literature's focus, else the first pursued idea. That idea's conversation stays on it: its tools default to it and cannot change another idea. Switching the idea switches the Pi conversation and every pane. Each idea's conversation keeps running.
  - **Real data: data snapshots.** Data fetched once and frozen: a file plus a manifest (source, query, fetch time, rows, SHA-256, preview). A refresh is a new snapshot, so results stay reproducible on the exact bytes. Snapshots are shared by every idea of the strategy (`<strategy>/Data/snapshots/`, read-only files) and appear in each workspace as `data/` (a link git ignores). Everything fetched is **Parquet** (zstd, typed columns, UTC-microsecond timestamps), read with polars.
    - **Tick level and derivatives:** Binance's public archive. It covers spot, USDⓈ-M and COIN-M futures, and options (historical only). Datasets are tick trades, aggregated trades, 1s–1d bars, best bid/ask, order-book depth snapshots, open interest and long/short metrics, funding, mark, index and premium price bars, liquidations, BVOL and option summaries. Each archive file is checked against its published SHA-256 and becomes one Parquet file per day in a snapshot folder, scanned lazily with `pl.scan_parquet("data/<name>/*.parquet")`.
    - **Bars and series:** from the Binance and Coinbase APIs, and FRED.
    - Fetches run in the background, with an estimate first: files, download size, gaps and free disk. Paid feeds such as Bloomberg come in as files the user's own code writes in the workspace, registered with a note on their source; the app never holds credentials. The formal Data stage (contract, handoff, strict ingest) stays the gate to production, and the snapshots an idea used are its starting point.
  - **Checkpoints:** the right-hand panes show the workspace's **Files**, the **Changes** since the last checkpoint (a commit), **Documents** produced, the **Research spec** and **Sources**. Pi writes and runs code with its own tools; the app only reads the workspace and records checkpoints.
- **Agents read pursued ideas with `ideas_pursued`**: each idea at its latest saved version, with the version and reason of the pursue decision and its cited sources named. Each stage's agent is told its stage's role (`STAGE_GUIDANCE`).

## Runs: the workspace's code, executed and recorded

Decided 2026-09-26 (docs/WORKFLOW-REDESIGN-PLAN.md, phase 2). Results that will be compared or reported come from **runs**, not from scripts run by hand:

- **Entries.** A workspace declares what can be run in `research.toml` (`[run.<name>] command = "uv run python train.py"`, optional `inputs`; `[env] lock = "uv.lock"`). A command can also be given directly.
- **Exact by construction.** Starting a run checkpoints any uncheckpointed changes, then runs a clean copy of that checkpoint (data/ linked). Editing the workspace afterwards changes nothing that runs.
- **What is recorded.** The command, environment files and lock hash, hardware, the snapshots used, exit, wall time, peak memory, the log, `outputs/metrics.json` and every output file with its hash. Runs live in `<strategy>/Runs/<id>/`.
- **Detached.** Runs keep going when the app quits; the next start reconciles them (finished, or lost if the process vanished). At most two run at once.
- **Agents run within a limit** (default 5 runs and 60 run minutes per hour); only the user changes it.
- **Release candidates are validated by a run** of their entry on exactly their checkpoint.

## Risks and one thread per idea

Decided 2026-09-26 (plan, phase 3).

- **Risks on every saved idea.** Each risk is a sentence on what could make the idea unusable in practice, with a status (unknown, estimated, measured ok, failed, waived). The agent drafts the first 3–5. Cheap runs test the most fundamental first and become their evidence.
- **Failing a risk halfway is an ordinary outcome.** The strip shows it, old results stay as they were, and you revise, work around it or stop. A release candidate with a failed risk needs a stated reason.
- **One conversation per idea** runs through Explore, Develop and Release. It reads `idea_context` for where the idea stands, and you see the same summary as **What the AI sees**.
- **Bounded searches** use run batches. The app writes their summary into the workspace when the last run ends.

## Sending an idea on

When you are convinced, one idea is sent from Research Development to the production stages. From then on, Data, Design & Code, Backtests and Results work towards production code, backtests and outputs, all traceable to that idea's exact version. Other pursued ideas stay in the exploratory stages. Two ideas that are both worth building become two strategies, which a portfolio can compare or combine.

- **Create release candidate** (decided 2026-09-25; renamed from "Send to production" on 2026-09-26) is explicit: **Create release candidate…** in the Research Development bar, or `production_commit`. The checkpoint is tagged `candidate/<n>`, production script feeds run from it, and the snapshots it froze cannot be deleted while the candidate is kept. See docs/WORKFLOW-REDESIGN-PLAN.md for where this is heading.
  - It freezes the idea's exact saved version, the workspace's last checkpoint (refused while there are changes not yet checkpointed) and the data snapshots its research used. By default these are the snapshots whose files its code references.
  - Sending again replaces what is in production and keeps the earlier commits as history.
  - The production stages show what is in production in their bar.
- **The Data stage works with production live data**, not exploratory snapshots:
  - Feeds are collected by a background service that the user switches on and off. On macOS it is a login item, so feeds keep collecting while the app is closed.
  - There are three kinds of feed: live exchange streams (Binance spot, USDⓈ-M and COIN-M; Coinbase), scheduled pulls (Binance archive, Binance/Coinbase bars, FRED), and the user's own scripts (e.g. Bloomberg).
  - Every closed hour or day is frozen: Parquet, read-only, SHA-256, with quality counts.
  - The snapshots sent to production are offered as **Collect live**, so production code sees the same data the research saw. See docs/INTERFACE.md, "Data stage".

## Planned, in order

1. Pursue across versions. *(done)*
2. Literature focus idea, for the pane and the agent, with per-idea paper ranks. *(done)*
3. Notes linked to ideas, with a stance: supports, contradicts or refines. The link is to the idea, and the note records the version it was made against. *(done)*
4. Coverage per idea: papers, notes, and supporting vs contradicting counts. *(done)*
5. Back-and-forth steps: "Revise idea from this note", and jumping from an idea to Literature focused on it. *(done)*
6. Research Development workspaces per idea (folder + git + Pi, with Files, Changes and Documents panes). *(done)*
7. Data snapshots for Research Development (public fetchers, registered files, Data tab). *(done)*
7b. Tick-level and derivatives data from the Binance archive, all snapshots in Parquet for polars. *(done)*
8. Send to production. *(done)*
9. The Data stage on production live data: the background feed service, streams, pulls and scripts, frozen partitions with quality counts. *(done)*
10. The research spec per idea; data contracts for production feeds (schema, latency and gap targets, approval).
