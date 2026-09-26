# Pi Research workflow and architecture implementation plan

Product design and engineering delivery plan

26 September 2026 · Version 1.0

## 1 Purpose and recommended direction

Pi Research should provide one continuous workspace for a research direction, from the first question through experiments, release validation, and operational feedback. The researcher and AI should work against the same explicit project state. A validated candidate must identify the implementation that actually ran, together with its data, environment, configuration, and evidence.

The immediate priority is to correct task scoping and preservation of research dependencies. The next priority is to connect real workspace execution to recorded experiments and release candidates. Navigation, conversation continuity, and screen composition should then be redesigned around the decisions researchers make. Adding more stages or specialised forms before those foundations are coherent would increase the burden on the user.

This document defines the proposed product behaviour, domain objects, execution interfaces, AI interaction, user interface, migration, engineering work packages, tests, and rollout. It is intended for the product owner and engineers implementing the next version. Recommendations are planning decisions for the proposed system; they do not describe capabilities already delivered.

The plan preserves the existing investment in sources, annotations, scientific evidence, immutable records, research workspaces, data collection, and runtime adapters. Existing research and historical results must remain readable throughout the transition. The old reference engine remains an explicitly labelled execution option for its supported cases; it must not be represented as validation of arbitrary authored code.

### 1 1 Outcomes

- A researcher can investigate an idea, test its practical constraints, run the real implementation, compare evidence, and create a release candidate without re-entering the project in another record system.
- An AI task remains bound to its intended idea and candidate even when the user navigates elsewhere or closes a window.
- Every reported result identifies what executed and whether its inputs, runtime, and artifacts are retained and verifiable.
- Important feasibility risks are tested early and reassessed when their dependencies change.
- The primary screen presents the artifact, evidence, AI activity, and next decision relevant to the current task.
- Local and remote execution share a stable contract, while each backend reports its actual capabilities and limitations.

### 1 2 Scope and boundaries

The initial implementation remains a desktop research product with local execution. It adds the interfaces needed for remote execution and storage, but it does not need a cloud provisioning console, a new hosted collaboration platform, or a universal model-development framework. The first remote implementation should use an existing execution environment chosen by the user.

The product should integrate with repositories, CI, experiment trackers, artifact storage, and deployment systems through adapters. It should not require a specific model provider, agent runtime, cloud vendor, Python framework, or experiment tracker. A professional workflow needs reviewable releases and operational evidence; full multi-user administration can be delivered later without pretending the local application already supplies it.

Automated execution of research code is within scope. Unattended production trading or other consequential external actions are outside the initial release. The application must expose the execution target and authority of each task; a workspace boundary is not an operating-system sandbox.

## 2 Current state and evidence

The source baseline is repository HEAD ae7cadd with substantial working-tree changes present during the September 2026 review. HEAD alone does not identify the inspected implementation. Before engineering begins, capture a source inventory or an agreed snapshot that includes those changes. The findings below identify symbols and files so they remain traceable when line numbers move.

Evidence levels are deliberately distinct. Confirmed means the relevant code path was inspected. Observed means behaviour or composition was seen in the running application. Reported means a supplied review described it and the complete scenario still needs reproduction. Proposed means a target behaviour introduced by this plan.

### 2 1 Findings that determine the architecture

F01 Confirmed. Research Development operates on real per-idea Git workspaces and scripts. Formal run submission uses reference-close-v1, captures authored code references, and marks authoredCodeExecuted as false. The result is a discontinuity between the implementation explored and the implementation formally tested. Sources: server/workbench/rd.ts; server/platform.ts, run.queue; server/reference-engine.ts.

F02 Confirmed. The formal specification and contract encode daily close-price assumptions and restricted rules; the code record supports TypeScript, JavaScript, and text. These contracts are insufficient as a general representation of the Python, tick-data, and ML work already possible in Research Development. Source: src/platform.ts, specSchema, contractSchema, codeSchema, and runConfigSchema.

F03 Confirmed. The production handoff stores an idea version, checkpoint, and snapshot hashes, but the formal run configuration does not reference that handoff. This leaves two separate provenance paths. Sources: src/production-contract.ts; server/workbench/tools.ts, commitProduction; src/platform.ts, runConfigSchema.

F04 Confirmed. ScriptWorker launches scheduled commands in a mutable Research-Workspaces directory. Recording a checkpoint does not make those executions use that checkpoint. Source: server/feeds/workers.ts, ScriptWorker.run.

F05 Confirmed. Snapshot deletion checks for an active writer but does not enforce retention by a candidate or historical experiment. Read-only file permissions do not prevent the owner from unlinking the files. Source: server/workbench/data.ts, DataFeeds.delete; registry data_delete handler.

F06 Confirmed code risk with scenario reproduction required. MCP receives an idea identifier for session instructions but does not propagate it into Workbench.call. Several operations default to the window's developing idea. A background session can therefore resolve an omitted target using a later UI selection. Sources: server/workbench/mcp.ts, mcpHandle; server/workbench/tools.ts, developIdea and rdWorkspace.

F07 Confirmed divergence. The Idea pane sends some scientific commands directly, while agent handlers apply registry-level checks. Some checks also exist in the UI, so each claimed behavioural bypass requires a specific regression case. The intended invariant is one authoritative validation path. Sources: src/workbench/panes/IdeaBoard.tsx; server/workbench/tools.ts, saveIdea and decideIdea.

F08 Confirmed code risk with scenario reproduction required. Historical dataset projections and exploratory snapshot manifests share Data/snapshots JSON paths. The snapshot reader accepts arbitrary JSON and sorts by createdAt, which projection wrappers do not provide. Sources: server/projections.ts, strategyPlan; server/workbench/data.ts, snapshots.

### 2 2 Findings that determine interaction and scale work

F09 Confirmed and observed. Research Development places six related views in one tab group; Data places four. Design and Code reserves a graph pane. Stage-based conversations and separate selections make comparisons and context transfer more difficult. Sources: src/workbench/layouts.ts; src/workbench/Workbench.tsx; running app inspection.

F10 Confirmed. Registry coverage is much stronger for ideas, sources, snapshots, and feeds than for formal specifications, runs, conclusions, and release operations. The later stages have minimal guidance. This is a missing product-operation interface, not proof that Pi has no general tools. Source: server/workbench/tools.ts.

F11 Confirmed. View context covers ideas and papers but does not consistently identify selected files, diffs, runs, features, or feeds. Presentation events have similarly limited coverage. Source: server/workbench/view-channel.ts.

F12 Confirmed mechanism with performance measurement required. Multiple panes poll, Files and Documents can request the same resource, and the companion persistence path traverses all strategies. Supplied request-rate estimates have not been treated as measured performance. Sources: src/workbench/research.tsx; src/workbench/panes/ResearchDev.tsx; src/workbench/panes/Feeds.tsx; server/companion-storage.ts.

F13 Reported observations to reproduce. Narrow terminal wrapping, graph fit, long-lived notices, missing activity signals, and the complete multi-stage navigation count should be assessed with recorded task journeys at 1280 by 800 and 1440 by 900. The supplied review reports these conditions, but its timings and screenshots are not acceptance baselines.

### 2 3 Baseline work before implementation

Create a disposable research root and isolated Pi configuration for QA. Record the application build, viewport, fixture version, and any running background service. Build fixtures for three ideas, two simultaneous agent sessions, several snapshots, one historical reference run, one script feed, and one candidate. Include corrupt or legacy manifest examples in separate failure fixtures.

Measure API requests, bytes, CPU, memory, read latency, write latency, startup, and event delivery for idle and active workspaces. Exercise small and large metadata stores separately from large data files. Retain baseline logs and screen recordings. Do not infer a performance regression from source length or request count alone.

## 3 Product model and operating principles

### 3 1 The primary object

Keep Strategy as the existing top-level scope for compatibility. Within it, introduce a Research Direction with a stable identity; current saved ideas become the first Research Directions. A direction contains evolving hypotheses, evidence, implementation branches, experiments, constraints, and candidates. Multiple directions may coexist without sharing an implicit current task.

The UI may continue to call a direction an idea where that language is natural. Code and storage must distinguish the stable direction identifier from a particular hypothesis revision. A candidate references both the direction and the exact hypothesis revision used to explain it.

Do not force two model variants into separate strategies merely to compare them. Variants and candidates can be compared within one direction or strategy. Separate strategies remain useful when ownership, data scope, or operational purpose differs. Existing portfolios keep their independent scope and frozen imports.

### 3 2 Five invariants

I01 Task identity is independent of view selection. Every mutating task has explicit scope bound by the backend. Navigation cannot change it.

I02 Evidence identifies an execution. A run records the code and runtime actually used; a document or saved source file never becomes executed evidence merely by existing.

I03 Retained records retain their dependencies. Deleting or collecting an artifact must respect every retained run, candidate, deployment, and export that depends on it.

I04 Estimates and measurements remain distinguishable. Evidence records its method, conditions, scope, and validity. Unverified declarations cannot satisfy measured release criteria.

I05 All clients use the same business rules. UI, Pi, MCP, importers, and background jobs call shared services with consistent authorization, validation, version checks, and receipts.

### 3 3 Navigation and lifecycle

Use Explore, Develop, and Release as the proposed top-level activity groups. Explore contains framing, literature, and initial feasibility. Develop contains implementation, data and features, experiments, comparisons, and profiling. Release contains candidate validation, packaging, deployment status, and operational evidence.

These are views, not locks. Users can read literature while validating a candidate or inspect live data during exploration. The app may suggest relevant views but should preserve focus and user-pinned content.

Keep lifecycle state separate from navigation. A direction may be exploring, active, blocked, paused, or archived. A candidate may be created, validating, validation failed, ready for review, approved, superseded, or withdrawn. A deployment has its own pending, deploying, healthy, degraded, failed, rolled back, or retired state. No single status word should stand for all three objects.

## 4 Research workflow and decision rules

### 4 1 Frame the question

Capture the intended outcome, baseline, success metric, falsification condition, operating horizon, initial data assumptions, execution target, and important resource limits. The AI drafts the brief from the conversation; the researcher can edit it in place. Only the question and intended outcome are required to start. Unknown information remains visible as unknown rather than being filled with plausible prose.

An initial feasibility review identifies the assumptions whose failure would invalidate the direction. The output is a short ordered list of uncertainties and the cheapest useful tests. Do not require an exhaustive infrastructure specification before exploratory work.

### 4 2 Establish practical feasibility

Run a small representative path from input acquisition through transformation and output. Check historical coverage and whether required fields can exist at the intended decision time. Measure an initial resource profile. Establish a simple baseline before escalating model complexity or compute.

A feasibility probe is an ordinary experiment with a particular question. It may inspect a provider response, calculate sample memory usage, test one training batch, compare offline and live feature values, or validate access to a target machine. The application records both successful and failed probes.

Proceed when the remaining uncertainty is acceptable for the next proposed action. A small local test does not need the same evidence as a costly sweep or release. Blocking criteria should match the commitment being made.

### 4 3 Develop and evaluate

Write and run the actual implementation in a workspace. Each experiment declares inputs and captures a code snapshot before execution. The researcher can iterate rapidly without manually approving every save. Runs are comparable when their evaluation protocol, data partitions, and relevant conditions match; otherwise the UI identifies the difference.

The AI should propose the next experiment by explaining which uncertainty it resolves and its expected resource use. Results include quality and resource measures alongside the baseline. Hypotheses, conclusions, and limitations link to exact runs or cited evidence.

### 4 4 Create and validate a candidate

Create a candidate from an explicit implementation snapshot. Candidate creation confirms identity and retained inputs; it does not assert production readiness. The candidate records its intended target, required tests, data and feature contract versions, environment, artifacts, and unresolved limitations.

Validation executes that candidate in a sufficiently representative target environment. Separate scientific evaluation, operational performance, contract compliance, and deployment compatibility. A candidate can pass one dimension and fail another. Review must expose these dimensions rather than collapsing them into a percentage.

Approval applies to an exact candidate digest and a specified target or target class. Material changes create a new candidate or a new validation context and invalidate the relevant approval. The deployed version remains unchanged until a separate deployment action succeeds.

### 4 5 Operate and return evidence to research

The first release adapter may accept deployment records from an external CI or operations system. The app stores the external identity, candidate digest, environment, time, health observations, and rollback relationship. It must not label an uploaded package as deployed without evidence from the deployment system.

Operational failures, feature skew, freshness violations, drift signals, and resource overruns can open new investigations linked to the deployment. A monitoring alert does not automatically prove model failure or authorise a new release. A researcher can inspect evidence, create a revised candidate, and compare it with the deployed one.

### 4 6 Handling an infeasible direction

If a required feature arrives too late, link the finding to the feature contract and affected runs or candidates. Preserve historical results under their original conditions. Mark conclusions whose production applicability changed as needing review. Offer a revision, alternative source, different operating frequency, reduced model, or stop decision with the cost and evidence consequences visible.

The system should identify downstream dependencies, not automatically discard every result. Re-run only the checks whose assumptions or inputs changed, with a conservative option when dependency information is incomplete. Record the reason for stopping a direction so later researchers do not unknowingly repeat the same work.

## 5 Feasibility and evidence model

### 5 1 Constraint records

Each constraint has an ID, direction ID, category, statement, importance, threshold where applicable, unit, scope, source, owner role, proposed test, and current assessment. Categories include data availability, data rights, feature timing, compute, memory, training duration, latency, throughput, storage, cost, and operational availability. Domain-specific fields are optional extensions rather than requirements for every project.

Represent evidence strength and constraint satisfaction separately. Evidence may be assumed, cited, estimated, or measured. Satisfaction may be unknown, passes, fails, or waived for a named scope. Freshness may be current or stale. A measured failure is strong evidence of a failed condition; it must not receive the same visual meaning as a confident pass.

Use labels and accessible icons as well as colour. A waiver includes the reason, approver, permitted action, expiry or invalidation condition, and affected candidate. It cannot silently turn a failed requirement into a passing measurement.

### 5 2 Measurements and estimates

An estimate stores its method, sample size, extrapolation assumptions, uncertainty range where available, and price or capacity reference date. A measurement stores the run, hardware, environment, data volume, configuration, duration, and raw artifact references. Distinguish warm-up from steady state and preprocessing from model execution when profiling latency.

Use repeatability appropriate to the claim. A memory-fit check can be informative after one representative run; a tail-latency claim needs an adequate sample and declared conditions. The app records the method rather than prescribing one universal statistical protocol.

### 5 3 Invalidation rules

Changing the source schema invalidates dependent feature compatibility checks. Changing feature logic invalidates relevant training-to-serving parity evidence. Changing code or dependencies invalidates execution evidence for the candidate. Changing target hardware invalidates target-specific resource claims unless a declared compatibility rule applies. Changing dataset partitions invalidates comparisons that require those partitions.

Implement invalidation as new assessments and events; preserve the original evidence. A dependency graph tracks stable IDs and version references. Manual overrides must remain explicit and auditable. Avoid invalidating unrelated literature notes merely because an execution parameter changed.

## 6 Domain records and provenance

### 6 1 Core objects

| Object | Identity and essential content | Primary relationships |
| --- | --- | --- |
| Research Direction | Stable ID, title, objective, status | Hypothesis revisions, constraints, workspaces |
| Task | Scope, objective, authority, budget, lifecycle | Direction, optional candidate, conversation |
| Workspace Snapshot | Commit or captured source digest, file inventory | Repository, direction, environment declaration |
| Dataset Version | Immutable manifest, object hashes, schema, time semantics | Provider or feed, partitions, retention roots |
| Feature Definition | Versioned transformation, inputs, timing, output schema | Dataset contracts, code symbols, parity checks |
| Experiment Plan | Question, protocol, baseline, configurations, budget | Tasks and planned run inputs |
| Run | Immutable inputs and receipts, append only execution events | Snapshot, data, target, metrics, artifacts |
| Candidate | Immutable manifest and digest | Hypothesis, code, model, contracts, evidence |
| Deployment | External or local deployment identity and lifecycle | Candidate, environment, health, rollback |
| Decision | Actor, exact target, choice, reason, time | Evidence and superseded decisions |

### 6 2 Candidate contents

A candidate manifest includes schema version, candidate ID, direction ID, hypothesis reference, workspace snapshot reference, entry points, environment lock references, model or other binary artifacts, configuration digest, dataset and feature contract references, intended execution target requirements, validation policy version, evidence references, limitations, creator, and creation time.

The manifest is immutable. Validation results and approvals are separate records that refer to its digest. The current candidate pointer is mutable presentation or workflow state; historical candidates remain accessible. An earlier production handoff becomes an imported candidate only with clearly identified missing fields and unverified readiness.

### 6 3 Run contents

A run includes a unique ID, parent experiment, task scope, exact source snapshot, declared and resolved inputs, command or entry point, working directory policy, environment identity, execution target, configuration, seed policy, resource request, budget, and submission receipt. Capture resolved hardware and library information from the executor rather than relying only on declarations.

Record lifecycle events, logs, process exit, scheduler status, metrics, artifact hashes, and validation outcomes. A successful process is distinct from a scientifically acceptable result. Missing outputs, partial outputs, cancelled runs, and failures remain in the registry. Imported external runs retain their external IDs and an authenticity or verification status.

### 6 4 Workspace manifest

Introduce a small versioned research.toml or equivalent manifest for executable declarations. The final filename is a proposed default, not an external standard. It declares entry points, environment preparation, required inputs, expected outputs, resource requests, and supported evaluation modes. Feature and dataset definitions may be referenced from separate files.

Validate the manifest against a shared schema. The agent can edit it as ordinary source, while the application displays structured errors and a readable projection. The manifest must not duplicate the complete journal or become the authority for approvals, measured metrics, deployment state, or historical results.

Support custom metadata in an explicitly namespaced extension field with size limits. Unknown extensions can be retained without claiming support. Execution must reject unknown required capabilities with an actionable explanation.

### 6 5 Retention and reproducibility

Build a dependency index from retained runs, candidates, deployments, exports, and manual pins to their immutable assets. Deletion checks must occur in the same transaction that changes references or schedules collection. Protect all retained historical consumers, not only the current candidate.

Keep a durable Git reference or source archive for each retained snapshot and verify that it is materialisable. Run candidates in a separate checkout or immutable package, with outputs written to a separate run directory. A tag is a retention aid; it is not the execution mechanism or a security boundary.

Data snapshots must use explicit manifests rather than only source-text searches for paths. Runtime-created paths, generated configurations, and indirect dependencies make text matching incomplete. Automatic discovery can suggest dependencies, but the resolved run input manifest records what was actually supplied. For live feeds, freeze a partition list, content identities, and time boundary for every reproducible evaluation.

Record external dependencies that cannot be retained, including access requirements and licences. Such a run may be traceable but not fully reproducible. Display that distinction. Reproducible input identity also does not guarantee identical numeric output across hardware or nondeterministic libraries; capture tolerances and determinism limitations.

## 7 Execution and infrastructure

### 7 1 Executor interface

Define an executor with capabilities, preflight, submit, status, streamEvents, cancel, collectArtifacts, and reconcile operations. Inputs use shared schemas. Capabilities describe supported operating systems, accelerators, isolation, storage access, maximum resources, cancellation semantics, and telemetry. Unsupported requests fail before submission.

Preflight validates the source snapshot, environment, input availability, output destinations, resource limits, and policy. It returns a resolved execution plan and estimates with limitations. Submission uses an idempotency key. Store the intent before issuing the external action and reconcile an uncertain response before attempting another submission.

Use queued, preparing, running, succeeded, failed, cancellation requested, cancelled, and unknown as execution states, with explicit transition rules. A disconnected UI does not turn running into failed. Unknown requires reconciliation with the executor. Cancellation is a request until the underlying process or scheduler confirms it.

### 7 2 First local executor

The first executor materialises a source snapshot into a run directory, resolves input manifests, prepares or verifies the configured environment, launches a declared entry point, records telemetry, and collects outputs. It supports Python first without encoding ML-specific assumptions into the core run object. Additional languages can use the same command contract.

Use an environment lock or a container image digest where available. Record the actual resolved environment. If exact reconstruction is unavailable, mark it explicitly and restrict release validation accordingly. Secrets are supplied through runtime credential providers or scoped environment references; they must not be copied into manifests, logs, or exported bundles.

Resource enforcement must report its limits. Some local platforms cannot guarantee a hard monetary or GPU-memory bound. Use wall-time limits, concurrency controls, preflight checks, disk reserves, and measured usage where possible. Do not present a soft estimate as a hard budget. If isolation is required by policy and unavailable, refuse that execution rather than silently weakening it.

### 7 3 Remote executor and storage

Implement one remote adapter after the local lifecycle is stable. Choose the initial target based on the actual deployment environment; do not build several cloud providers speculatively. Remote execution uses the same manifests and run IDs, with adapter-specific scheduler and storage metadata stored separately.

Inputs are referenced by content identity and location. A storage resolver can stage local data, use a shared filesystem, or resolve object storage versions. Validate access, transfer requirements, available space, and data locality before launching large work. Cache by content identity and verify bytes after transfer where practical.

Remote jobs must survive desktop closure. On reconnection, reconcile by external job identity and idempotency key. Support partial artifact retrieval, retryable transport failures, expired credentials, cancelled jobs, and worker loss. A retry creates a new attempt linked to the original run and preserves earlier logs.

### 7 4 Cost and sweep control

A task budget includes maximum runs, concurrency, wall time, resource allocation, storage growth, and optional monetary budget. Reserve estimated capacity before submission and account for actual usage as it arrives. Monetary enforcement must consider provider reporting delay and minimum billing increments; use a conservative stop threshold and disclose possible overshoot.

For parameter sweeps, persist the configuration matrix, pending runs, completed runs, stopping criteria, and budget ledger. Restarting the app must not duplicate completed or uncertain submissions. The AI may analyse intermediate results and propose changes, but changing the authorised search space or increasing the budget requires a recorded scope update.

### 7 5 Feeds and deployment boundaries

Classify a script feed as exploratory or operational. Exploratory feeds may deliberately follow a workspace and must be labelled accordingly. Operational feeds reference a retained candidate or script snapshot with a fixed environment and configuration. Editing the research workspace must not change the operational command's code.

Existing exchange feeds remain services with their own identities, independent of a direction's lifecycle. Link a direction's requirements to the feeds that satisfy them. Display collection health separately from schema compliance and suitability for a model. Do not imply that a green connection means complete or suitable data.

## 8 Machine learning capabilities

### 8 1 Features and timing

A feature definition includes its name, description, transformation reference, input fields, lookback, units, data type, event time, availability time, freshness target, missing-value behaviour, and version. Track whether it is available in training, validation, and serving. Treat importance as an observation from a particular model and dataset, not an intrinsic constant of the feature.

Expose feature samples and lineage beside definitions. Provide checks for unexpected future information, joins that ignore availability time, schema mismatch, and transformation differences. Domain-specific validation such as purging or embargo can be configured for appropriate time-series protocols rather than applied to every ML task.

### 8 2 Evaluation and comparisons

An evaluation protocol declares splits, target construction, baseline, metrics, acceptance rules, repeat or seed policy, and permitted selection use. Log evaluation attempts so repeated access to a held-out set is visible. A local application with ordinary filesystem access must not claim to enforce secret holdout data.

Compare runs using metric definitions and units, dataset and protocol identities, model or feature differences, and resource conditions. Warn when comparisons are not like for like. Keep failed trials visible; selectively displaying only successful runs can distort the research history.

Support tracker integration through an adapter for run identity, parameters, metrics, artifacts, and external links. Select a tracker only after confirming the project's existing tooling. Preserve one canonical run identity and an explicit mapping to external runs so imported and locally executed records are not duplicated.

### 8 3 Profiling and model artifacts

Collect training duration, data loading, preprocessing, throughput, peak host memory, accelerator utilisation and memory where supported, inference latency, and artifact size. Report distributions and sample counts where needed. Show the end-to-end path alongside isolated model timing.

Model artifacts record framework and format, digest, expected input and output schemas, preprocessing dependencies, and loader entry point. Loading a model is code execution in some formats; use the same execution authority and environment controls as other authored code.

### 8 4 Useful representations

Provide Features, Data, Runs, Resources, and Pipeline views over the same records. Keep mathematical explanations and semantic graphs available for work that benefits from them. The default view should follow the current task, and the graph should not occupy a permanent pane when a table, code diff, or resource profile is more useful.

## 9 AI collaboration and operation contracts

### 9 1 Bind tasks to scope

Create a TaskContext with strategy ID, direction ID, optional candidate ID, objective, allowed operations, execution target, budget, and expected revisions where relevant. Bind it to the agent session or task credential on the backend. Every mutation validates this context. An explicit cross-direction action must declare both scopes and meet the operation's policy.

The view context helps resolve phrases such as this chart, but it cannot supply a missing mutation target for a background task. For interactive tasks, the UI can offer the selected object as an explicit attachment. Show the resolved scope before a consequential action.

All adapters should carry the same logical context, even if their transport differs. Read-only strategy discovery can remain available, while mutations to an unexpected direction fail with a structured mismatch response. Add a deliberate retarget operation rather than silently changing a session's identity.

### 9 2 Shared research state

Build a compact context bundle from the current objective, hypothesis revision, constraints, accepted decisions, recent relevant runs, unresolved questions, and selected artifacts. Each item has a source reference and revision. The user can inspect what the agent is using and refresh stale context.

Conversation transcripts are supporting history. Accepted decisions and measured results are stored separately and cannot be overwritten by a conversational summary. Keep optional focused threads for a paper, experiment, critique, or bug. They can propose changes to shared research state through the same operations as the main conversation.

Use retrieval and bounded summaries to control context size. Include the task's relevant evidence rather than every artifact in the strategy. Treat imported papers, logs, notebooks, and repository text as data unless they are deliberately designated project instructions under the user's chosen policy.

### 9 3 Operation coverage

Extend the registry with shared operations for constraints, feature and data contracts, experiment plans, run submission and cancellation, comparison, candidate creation and validation, decisions, and deployment records. Define schemas in domain modules, keep registry definitions thin, and have UI routes call the same underlying services.

Every mutation returns the affected IDs, revisions, receipt, and whether further work is pending. Validation failures include a machine-readable code and a useful next action. Long-running work returns a job ID rather than pretending completion. Reads expose compact summaries with paginated detail and explicit freshness.

Test parity by running the same valid and invalid commands through UI routes and MCP. A different transport must not create a different scientific or operational rule. Permissions and capability discovery should be explicit; a tool's presence is not permission to use it for every task.

### 9 4 Rich context and artifact actions

Add stable attachments for a file revision and line range, diff, notebook cell, result interval, feature, dataset sample, feed partition, run, and candidate. Ask AI attaches the reference and selected text where appropriate. It never silently loses the context if the terminal is not ready; retain a visible draft or attachment with a clear retry path.

Extend view context with active view, selected object IDs and versions, selection ranges, and user-pinned panes. Add presentation events to open artifacts, show a comparison, reveal changes, and inspect runs or feeds. Events request a view change; they should not steal focus during typing or close a user's pinned artifact.

If the terminal remains the conversation surface, use wording and controls that match its actual behaviour. Rich artifacts should have app-native previews alongside it. Terminal support and a richer conversation UI can coexist behind a runtime adapter; do not make an immediate terminal replacement a dependency of fixing the research model.

### 9 5 Decisions and autonomous work

The decision inbox groups requests by task and candidate. A request includes the exact target, proposed change, supporting evidence, cost or authority implications, expiry or revision fence, and approve or reject action. Stale requests must be refreshed before action. Batch approval is allowed only when each item remains explicit and no dependency makes the batch ambiguous.

Routine edits, checkpoints, and bounded experiments follow the task's existing authorisation. Significant scope changes, additional spending, release decisions, and expanded access remain explicit. Record the grant and its limits so an overnight task can proceed without repeated prompts while staying within its assigned scope.

Show running, waiting for input, blocked, failed, and complete tasks using actual task or executor events. Do not derive terminal-agent status exclusively from a retired graphical conversation endpoint. Completion reports state the question, work performed, results, limitations, retained artifacts, and recommended next decision.

## 10 Interface and information architecture

### 10 1 Window composition

Use a compact navigation rail for strategies and directions, a narrow context strip, a primary artifact surface, an AI pane, and an optional inspector or activity drawer. The context strip shows the direction, current candidate when relevant, execution target, running task count, and the most important blocker or pending decision. Detailed provenance expands on demand.

The primary surface receives most of the width during code review, experiment comparison, and profiling. AI remains available and resizable. During discussion or reading, the user can enlarge the conversation. Remember layouts by activity and window class without forcing automatic changes whenever the agent emits an event.

Allow two relevant artifacts side by side or stacked. Panes should be selected from the same object model rather than from a fixed stage-specific list. Preserve tabs, selection, scroll, unsent messages, and file state when changing views. Support a single-view layout at narrow sizes.

### 10 2 Default activity views

| Activity | Main surface | Supporting information |
| --- | --- | --- |
| Frame an idea | Hypothesis and constraints | Baseline, next feasibility probe, AI |
| Read evidence | Paper or report | Notes, linked direction, AI |
| Develop features | Feature definitions and sample data | Timing, source lineage, checks |
| Implement or debug | Code and relevant diff or failure | Inputs, logs, AI |
| Compare experiments | Run comparison and plots | Configuration differences, cost, limitations |
| Validate a candidate | Readiness evidence and changes | Target, blockers, requested decision |
| Inspect operations | Deployment or feed health | Violations, affected candidate, recent events |

### 10 3 Progressive detail

Keep the everyday view focused. Do not display a permanent dossier, constraint matrix, decision inbox, task log, and resource dashboard all at once. Use the context strip for the next material issue and provide one-step access to the full record. Badges communicate meaningful counts such as changed files, new artifacts, failed checks, and pending decisions.

The Ideas view opens on ideas. Selecting a new report opens that report without losing the active direction or conversation. A run's failure opens its logs and inputs together. The graph supports fit, pan, zoom, keyboard selection, and a readable detail inspector, but stays optional.

### 10 4 Responsive and accessible behaviour

Validate at 1440 by 900, 1280 by 800, and a narrow fallback around 960 by 700. Use content and minimum usable widths to choose collapse behaviour; do not enforce an untested universal breakpoint. Preserve a labelled navigation option so icon-only controls do not become guesswork.

Support keyboard navigation, visible focus, accessible names, screen-reader statuses, and non-colour indicators. Use appropriate text wrapping and clear truncation affordances. The terminal requires a usable column budget or an explicit expanded mode. Avoid rendering tables and comparisons solely inside a narrow terminal.

### 10 5 Acceptance journeys

J01 From an idea, open its latest experiment, compare it with the baseline, and return to the hypothesis without changing the task's identity or re-explaining context.

J02 Ask AI about a selected diff, receive a response linked to the exact revision, and inspect the resulting change beside the relevant test output.

J03 Switch to idea B while idea A runs a task. See A's progress, return to its result, and verify that every write and run belongs to A.

J04 Discover that a required live feature is unavailable, inspect the affected candidate, create a variant, and compare its evidence without losing the original result.

J05 Review an ML candidate with quality, feature parity, latency, memory, and target-environment evidence visible through one coherent review surface.

J06 Close and reopen the desktop during a run or feed collection. Reconcile actual execution, recover drafts, and show any pending decision without duplicate work.

## 11 Backend structure and performance

### 11 1 Service boundaries

Separate domain schemas and services from HTTP routes, UI components, runtime adapters, and desktop process integration. Proposed services include Directions, Tasks, Constraints, Artifacts, Runs, Candidates, Decisions, and Deployments. Executors and storage resolvers are ports used by services. Registry tools and HTTP routes adapt inputs into those services.

Move portable contracts out of desktop-specific modules when changing the affected path. Keep operating-system services in desktop or host adapters. Refactor large files along these boundaries incrementally; line count alone is not a reason for a rewrite. Remove the old fallback path only after usage, compatibility requirements, and replacement coverage are understood.

### 11 2 Events and query caching

Create a shared query cache keyed by scope, resource, parameters, and version. Deduplicate simultaneous requests. Subscribe to backend events with sequence cursors and invalidate affected queries. On missed events or reconnect, perform a bounded resynchronisation. Use low-frequency fallback polling where events cannot provide reliable freshness.

Only active views should run expensive presentation queries. Background task and service status must remain available through compact summaries even when their detailed panes are hidden. Unmounting a pane never cancels execution. Coalesce high-volume metrics and logs while preserving complete records on disk or in the executor.

### 11 3 Persistence and limits

Avoid reserialising every strategy for each changed field. Introduce transactional per-scope updates or dirty-object persistence behind existing store interfaces. Select an embedded transactional store, such as SQLite, through a focused architecture decision after measuring current behaviour and migration needs. Preserve atomic publication, integrity checks, and durable receipts.

Separate scientific history from transient presentation state and request-delivery bookkeeping. Add bounded retention, compaction, and pagination with explicit policies. A retained scientific result must not disappear merely to satisfy a request-log limit. Approaching capacity should produce advance notice and a supported maintenance action rather than an unexplained refusal.

Metrics should identify endpoint latency, query volume, payload size, event lag, disk growth, and background CPU without storing credentials or unnecessary research content. Instrumentation remains local by default unless the user explicitly configures external telemetry.

## 12 Correctness and verification strategy

### 12 1 Required regression cases

T01 Bind a session to direction A, switch the UI to B, and issue an omitted-target checkpoint or candidate request from A. It must affect A or return a scope error; B remains unchanged. Test an explicit mismatch as well.

T02 Create a candidate from commit C, edit the research folder to C plus changes, and run an operational script feed or validation. The recorded and executed source must still be C.

T03 Attempt to delete data retained by a historical run or superseded candidate. Deletion is refused with its consumers listed. After an explicit permitted release of every retention root, collection becomes possible.

T04 Ingest a legacy dataset and list exploratory snapshots. The listing validates formats and remains usable. Corrupt or unrelated JSON produces a bounded diagnostic rather than crashing the entire list.

T05 Submit equivalent idea operations through UI and MCP, including pending edits, archived targets, stale revisions, and deletion of cited objects. Results and refusals match.

T06 Interrupt submission after the executor accepts a job but before the app stores the response. Reconcile the external identity and prove that retry does not create a duplicate job.

T07 Close the desktop during execution and reopen it. Restore task status from durable records and executor evidence; do not replay uncertain inputs.

T08 Mutate a feature definition or target environment after validation. The appropriate readiness evidence becomes stale; unaffected historical results remain unchanged.

T09 Exhaust a sweep's run or resource budget. Stop further submissions, preserve completed work, account for in-flight jobs, and report the stopping reason.

T10 Compare two runs with different split or metric definitions. The UI identifies the mismatch and avoids presenting an unqualified improvement claim.

T11 Migrate a workspace containing historical reference runs, drafts, annotations, feeds, and production handoffs. Verify identities, hashes, counts, references, and readable history; perform rollback on a disposable copy.

T12 Attach context while the terminal is unavailable. Preserve the user's selected reference and draft, expose the delivery state, and prevent accidental duplicate submission.

### 12 2 Test layers

Use schema and service tests for scope, state transitions, retention, and invalidation. Use adapter contract tests for UI and MCP parity and for executor capability reporting. Use disposable integration tests for filesystem snapshots, process lifecycle, migration, feed execution, and failure injection. Use native UI journeys for navigation, accessibility, restoration, and visual composition.

Extend relevant existing suites instead of introducing a parallel test harness for every module. Starting points include tests/research-dev.test.ts, tests/production-feeds.test.ts, tests/workbench-tools.test.ts, tests/idea-board.test.tsx, tests/platform-jobs.test.ts, tests/platform-durability.test.ts, tests/native-lifecycle.test.ts, and tests/workbench-interactions.test.tsx.

Run repository boundary checks, type checking, relevant tests, and production build checks at each milestone. Native packaging and end-to-end QA are required for releases that change lifecycle or terminal integration. Passing unit tests does not substitute for an executed candidate or rendered interface review.

### 12 3 Proposed acceptance targets

| Measure | Initial target | Verification method |
| --- | --- | --- |
| Wrong-direction writes | Zero across scope regression suite | Two-session and navigation tests |
| Duplicate submissions | Zero in retry and crash scenarios | Executor receipts and failure injection |
| Candidate dependency retention | Every retained reference resolves or has an explicit external limitation | Integrity scan and deletion tests |
| Common context lookup | Latest result or blocker reachable within two deliberate navigation actions | Recorded J01 and J04 journeys |
| Manual context reconstruction | None required for J01 through J05 | User walkthrough and attachment inspection |
| Duplicate active queries | No simultaneous identical resource requests | Network instrumentation |
| Local event visibility | Initial target below one second at the 95th percentile | Timestamped events on the baseline fixture |
| View responsiveness | Initial target below 300 ms at the 95th percentile for cached navigation | Instrumented native app journeys |

Performance figures are proposed budgets, not measured claims. Confirm them against representative hardware and fixture sizes in the baseline phase; change a budget only with the reason and evidence recorded. Test load definitions must accompany every published metric.

## 13 Migration and compatibility

### 13 1 Additive introduction

Introduce schema versions and new records alongside existing data. Keep old readers for historical scientific records and reference-engine results. Add explicit adapters that label legacy semantics; do not rewrite old results to imply that authored Python was executed.

Map saved ideas to direction identities without changing their existing IDs or citations. Link per-idea workspaces to those directions. Import old production handoffs as candidates with incomplete runtime or validation information; retain their original records and show the missing evidence.

### 13 2 Storage migration

Move generated dataset projections into a distinct namespace using an explicit migration plan. Identify files by validated schema rather than only filename. Preserve unrelated files. Migration records contain source and destination inventories, hashes, schema version, and completion state. A dry run reports every intended change before any production migration.

Before migration, quiesce relevant writers, capture a recoverable backup or snapshot, and check free space. Copy and verify immutable content before switching catalog references. Use an atomic authority switch or equivalent transactional boundary. If verification fails, continue using the old catalog and preserve diagnostic evidence.

### 13 3 Conversation and UI migration

Preserve all existing stage transcripts. Expose them as historical or focused threads attached to the strategy or inferred direction, with ambiguous mappings left for review. Do not concatenate transcripts and claim a single coherent memory. Build shared research state from accepted records first; AI-derived summaries remain proposals until accepted where they change project truth.

Map existing open tabs, drafts, and selected artifacts into the new shell where possible. Preserve unmapped drafts in a recovery view. Provide a temporary legacy navigation option during pilot rollout. Returning to the old shell must not lose new-domain records; it may show them read-only when editing is unsupported.

### 13 4 Feature flags and rollback

Use separate flags for task scoping, candidate execution, new domain views, and the new navigation shell. Correctness fixes should not depend on enabling the complete redesign. Pilot against disposable fixtures, then a copied real workspace, then the active workspace after migration acceptance.

Application rollback must respect schema compatibility. Older binaries must refuse unsupported writes rather than corrupt newer state. Restore a tested backup when downgrading across an incompatible storage version. Do not run two writers against the same root during rollback or migration.

## 14 Delivery phases and release gates

### 14 1 Phase A Establish a reliable baseline

Deliver the source snapshot, fixture pack, reproduction cases for scope and folder collision, performance measurements, and current native journey recordings. Classify findings as reproduced, statically supported, or unresolved. Resolve the smallest necessary product decisions about identifiers and candidate meaning.

Exit gate: the team can reproduce the major risks on disposable data and has an agreed baseline. No claimed speedup or usability improvement is assessed without a comparable before-and-after case.

### 14 2 Phase B Repair correctness and preservation

Deliver backend-bound task scope, shared idea-operation validation, schema-aware snapshot discovery, distinct projection paths, dependency retention checks, and explicit script-feed execution mode. Add the regression cases before or alongside the fixes. Label the old handoff as candidate preparation in user-facing text where it currently implies deployment.

Exit gate: T01 through T05 pass, existing data remains readable, and an operational script executes retained source. This phase can ship independently and should precede broad interface work.

### 14 3 Phase C Connect real execution and candidates

Deliver core run and candidate records, source materialisation, environment capture, a local executor, artifact collection, task receipts, and the minimal registry tools. Execute one real Python research workflow from source through recorded result and candidate validation. Preserve reference-engine access with accurate labels.

Exit gate: a candidate rerun identifies and executes the intended source and inputs; T06 and T07 pass; cancellation, failure, and partial outputs remain inspectable. The implementation must not require recreating Python code in the legacy code record.

### 14 4 Phase D Add feasibility and continuous AI context

Deliver constraints, evidence assessments, dependency invalidation, scoped context bundles, stable artifact attachments, and meaningful decision requests. Support one bounded multi-run task with a persisted budget and completion report.

Exit gate: J03 and J04 pass, T08 through T10 pass, and an agent can plan, submit, inspect, compare, and report a real experiment using the shared registry without manual form transfer.

### 14 5 Phase E Simplify navigation and comparisons

Deliver the direction-based shell, activity views, two-artifact comparisons, context strip, relevant badges, graph fit, and draft-safe Ask AI behaviour. Replace duplicated presentation polling with a shared cache and event invalidation as the views are migrated.

Exit gate: J01 through J06 pass at supported viewports; keyboard and accessibility checks pass; T12 passes; measured navigation and context-transfer burden improve against Phase A. Keep layouts reversible during pilot use.

### 14 6 Phase F Extend professional and remote operation

Deliver one remote executor and storage resolver, repository or CI linkage, external experiment import where needed, deployment receipts, health observations, and rollback references. Add schema-compatible backup and migration tooling before broad release.

Exit gate: a remote job survives desktop closure, an uncertain submission reconciles without duplication, a candidate can be linked to deployment evidence, and T11 plus remote failure scenarios pass. Multi-user governance is a separate milestone unless required by the first deployment environment.

### 14 7 Estimation and sequencing

Do not assign calendar dates from the supplied reviews' short estimates. Size each work package after the baseline and interface decisions. Use small, medium, and large as relative planning categories only. Assign named owners and dates when engineering capacity and the first remote target are known.

The critical dependency path is baseline, correctness, real runs and candidates, feasibility and task context, then integrated UI acceptance. UI prototypes can begin after the domain model is agreed. Remote adapter research can begin early, but production integration should depend on a proven local executor contract. Performance work can proceed wherever measurements reveal a user-visible bottleneck.

## 15 Engineering work packages

### 15 1 WP01 Reproduction fixtures and instrumentation

Owner role: engineering lead with QA. Relative size: medium. Dependencies: none. Create disposable fixtures, capture the baseline source inventory, add request and lifecycle instrumentation, and reproduce F06 and F08. Include interruption and restart controls. Acceptance: Phase A evidence is repeatable, stored locally, and independent of the user's live research. Relevant paths: tests, scripts, server/app.ts, and desktop lifecycle code.

### 15 2 WP02 Task scope binding

Owner role: backend engineer. Relative size: medium. Dependencies: WP01 and agreed IDs. Add TaskContext to registry dispatch and transport adapters. Bind idea sessions to direction scope, require explicit mutation targets or server-bound defaults, and reject mismatches. Keep view context read-only for target discovery. Acceptance: T01 passes through Pi-compatible and MCP paths. Relevant paths: server/workbench/mcp.ts, tools.ts, server/pi-research-extension.mjs, desktop terminal setup.

### 15 3 WP03 Snapshot format and namespace repair

Owner role: backend engineer. Relative size: small to medium. Dependencies: WP01. Introduce a discriminated snapshot manifest schema, tolerant listing with diagnostics, and a separate projection namespace. Implement dry-run migration and legacy reads. Acceptance: T04 passes for valid, legacy, unrelated, and malformed JSON. Relevant paths: server/workbench/data.ts, server/projections.ts, snapshot tests.

### 15 4 WP04 Shared business validation

Owner role: backend engineer with frontend engineer. Relative size: medium. Dependencies: WP02. Route idea save, decision, archive, restore, and delete through shared services. Preserve UI responsiveness and revision conflict handling. Acceptance: T05 parity matrix passes and no duplicate request receipts are introduced. Relevant paths: IdeaBoard.tsx, research.tsx, tools.ts, native routes, platform commands.

### 15 5 WP05 Dependency retention and materialisation

Owner role: backend engineer. Relative size: large. Dependencies: WP03 and candidate identity decision. Implement retention roots, reference queries, source snapshots, verification, and deletion refusal. Capture referenced and generated artifacts without relying solely on path searches. Acceptance: T02 and T03 pass, with source and data integrity reports. Relevant paths: rd.ts, data.ts, production contract, store, new artifact service.

### 15 6 WP06 Operational script isolation

Owner role: execution engineer. Relative size: medium. Dependencies: WP05. Add exploratory and operational feed modes; materialise operational source and environment separately from research. Preserve output partition behaviour and surface execution provenance. Acceptance: editing the research folder cannot alter the next operational run. Relevant paths: feed contract, feeds/catalog.ts, workers.ts, feed UI and tests.

### 15 7 WP07 Domain records and migration adapters

Owner role: backend engineer. Relative size: large. Dependencies: WP02 and WP05. Define direction, run, candidate, decision, and deployment schemas with explicit versions. Add adapters for legacy handoffs and reference runs. Acceptance: old and new records coexist and no old result acquires an unsupported execution claim. Relevant paths: src/platform.ts, production contract, platform schemas, persistence services.

### 15 8 WP08 Local executor and receipts

Owner role: execution engineer. Relative size: large. Dependencies: WP05 and WP07. Implement preflight, source materialisation, environment capture, submission, logs, cancellation, artifacts, and reconciliation. Acceptance: a real Python fixture passes T06 and T07, and failure cases preserve evidence. Relevant paths: new executor modules, server lifecycle, run services, job tests.

### 15 9 WP09 Experiment and candidate tools

Owner role: backend engineer. Relative size: medium. Dependencies: WP07 and WP08. Expose experiment planning, run submission, status, cancellation, comparison, candidate creation, validation, and decisions in the shared registry and UI routes. Acceptance: one complete research-to-candidate journey is performed through tools and yields the same records as the UI. Relevant paths: registry, MCP, native routes, adapter tests.

### 15 10 WP10 Feasibility and feature contracts

Owner role: research engineer with backend engineer. Relative size: large. Dependencies: WP07. Add constraints, evidence strength, satisfaction, staleness, feature timing, data contracts, and invalidation. Start with a small supported set and extensible schema. Acceptance: T08 passes and a failed live-feature assumption identifies affected candidates. Relevant paths: new domain modules, DataSnapshots, Feeds, research views.

### 15 11 WP11 Shared AI context and attachments

Owner role: agent integration engineer. Relative size: medium to large. Dependencies: WP02, WP09, and WP10. Build bounded context bundles and stable attachments; extend view context and presentation events. Ensure terminal-unavailable drafts survive. Acceptance: J02, J03, and T12 pass without manual context copying. Relevant paths: WorkbenchEvents, view-channel, Workbench, PiTerminal, attachment contracts.

### 15 12 WP12 Task budgets and decision inbox

Owner role: backend engineer with frontend engineer. Relative size: large. Dependencies: WP08 and WP11. Add budget ledger, sweep state, authority grants, pending decisions, stale-request checks, and completion reports. Acceptance: T09 passes under restart and cancellation, and the inbox contains only decisions requiring user attention. Relevant paths: task services, executor adapters, activity UI.

### 15 13 WP13 Direction based interface

Owner role: product designer and frontend engineer. Relative size: large. Dependencies: agreed domain model; integration depends on WP09 through WP11. Prototype and implement activity navigation, context strip, artifact-first layouts, two-pane comparisons, and optional graph. Acceptance: J01 through J06 at supported widths with restored drafts and accessible navigation. Relevant paths: Workbench.tsx, stages.ts, layouts.ts, StageLayout.tsx, panes, styles.

### 15 14 WP14 Query and persistence efficiency

Owner role: frontend and backend engineers. Relative size: medium to large. Dependencies: baseline measurement; implementation coordinated with WP07 and WP13. Add query deduplication, event invalidation, bounded summaries, per-scope writes, retention policy, and pagination. Acceptance: measured improvement under the same fixtures, no missed state after reconnect, and no history loss. Relevant paths: research.tsx, pane pollers, store.ts, companion-storage.ts, durable.ts.

### 15 15 WP15 Remote execution and storage

Owner role: infrastructure engineer. Relative size: large. Dependencies: WP08 and selected target. Implement one adapter, content resolution, upload and download verification, remote status, cancellation, and reconnect. Acceptance: remote versions of T06 and T07 pass and usage reporting identifies its uncertainty. Relevant paths: executor and storage ports, credentials adapter, task UI.

### 15 16 WP16 Release integration and migration acceptance

Owner role: engineering lead with QA and operations representative. Relative size: large. Dependencies: WP07, WP10, WP13, and deployment integration requirements. Add deployment evidence, repository or CI references, migration dry run, backup verification, compatibility fencing, and rollback rehearsal. Acceptance: T11 and Phase F gates pass on a copied representative workspace before active rollout.

## 16 Decisions and risks to resolve

### 16 1 Proposed defaults and decision owners

D01 Product owner: adopt Research Direction as the stable concept while retaining Strategy as the current scope. Proposed default: ideas map into directions and variants stay within them. Resolve before WP02 and WP07.

D02 Engineering lead: choose the immutable source packaging and retention mechanism. Proposed default: retained Git references plus materialised execution snapshots and content-addressed artifacts, with an exportable source archive for candidates. Resolve before WP05.

D03 Research and engineering leads: choose the minimum candidate validation policy. Proposed default: protocol-specific scientific evidence, input compatibility, resource fit, and target execution, with explicit exceptions. Resolve before WP09 and WP10.

D04 Product owner: choose the first professional execution and deployment environment. Proposed default: local executor first and one existing remote target next. Resolve before WP15; do not block correctness work.

D05 Engineering lead: select persistence evolution after measuring the baseline. Proposed default: transactional per-scope records behind current interfaces, with an embedded database considered where it materially simplifies atomicity and querying. Resolve before broad WP14 migration.

D06 Product owner and designer: decide how much terminal interaction to preserve. Proposed default: preserve runtime compatibility, provide rich artifact views, and evaluate a native conversation surface separately. Resolve through prototypes rather than a premature rewrite.

D07 Research lead: select external experiment-tracker integration based on existing use. Proposed default: support the app's run contract first and import external records through an adapter. Vendor selection is not a dependency of the local executor.

### 16 2 Principal risks

R01 Expanding scope into a full IDE or cloud platform. Mitigation: integrate existing systems and require each new surface to support an acceptance journey. The first release proves one local workflow and one candidate path.

R02 Losing trusted historical evidence during migration. Mitigation: additive schemas, hash and reference verification, dry runs, backups, compatibility fencing, and rollback rehearsal.

R03 Replacing many stages with one overloaded screen. Mitigation: task-based defaults, optional inspectors, persistent focus, and measured journey testing. Fewer navigation labels alone are not success.

R04 Assuming a declared manifest proves reproducibility. Mitigation: capture resolved runtime facts, retain artifacts, verify materialisation, and show external or nondeterministic limitations.

R05 Increasing autonomy before scope and budgets are reliable. Mitigation: deliver task binding and receipts first, test interruption scenarios, and limit unattended work to explicit grants.

R06 Preserving two parallel authorities indefinitely. Mitigation: make legacy records read-compatible and new execution authoritative for new runs; document each migration boundary and remove duplicate writes once parity is proven.

R07 Excessive approval burden. Mitigation: evaluate decision frequency during journeys and distinguish routine work from scientific, financial, operational, or access commitments.

## 17 Release definition of done

The first redesigned release is complete when a researcher can frame a direction, investigate a material feasibility risk, execute the actual implementation, compare it with a baseline, create a retained candidate, and review evidence in the intended target environment. The AI can perform the corresponding product operations through the shared registry, and the user can inspect the same authoritative state in the app.

Wrong-direction operations, duplicate submissions, deletion of retained dependencies, and misleading execution claims are release blockers. The required migration and restart scenarios must pass. Historical records, drafts, sources, and annotations remain accessible. Native journeys must show that context and decisions survive navigation without manual reconstruction.

The release report records the shipped capabilities, unsupported executor features, known reproducibility limits, migration results, test evidence, visual QA, and measured usability and performance changes. Remote deployment or multi-user capability is claimed only for the integrations actually exercised.

## 18 Evidence and implementation references

The current application and supplied reviews motivated this plan. Repository references below are implementation starting points; engineers should use symbols and current source rather than assume line numbers remain stable. Review claims marked reported remain reproduction tasks until tested.

- docs/RESEARCH-FLOW.md describes the current exploration loop and production handoff.
- docs/PRINCIPLES.md defines shared operation rules and runtime agnosticity.
- docs/PRODUCT-DESIGN.md and docs/INTERFACE.md describe the intended workbench and existing composition.
- src/platform.ts defines the restricted legacy specification, contract, code, and run schemas.
- src/production-contract.ts and server/workbench/tools.ts define current handoff identity and registry behaviour.
- server/workbench/mcp.ts and server/pi-research-extension.mjs carry agent requests and session instructions.
- server/workbench/rd.ts manages research repositories and checkpoints.
- server/workbench/data.ts manages snapshots, path-reference discovery, and deletion.
- server/feeds/workers.ts contains scheduled script execution and feed workers.
- server/platform.ts and server/reference-engine.ts implement formal reference runs.
- server/projections.ts writes historical scientific projections.
- src/workbench/Workbench.tsx, layouts.ts, StageLayout.tsx, WorkbenchEvents.tsx, and useStageActivity.ts define the shell, panes, presentation events, and awareness.
- server/companion-storage.ts and server/durable.ts implement persistence, integrity, and bounded journals.

General engineering references used in the preceding review support early pipeline testing, training-to-serving consistency, and continuous validation. They do not establish the app's current capabilities or dictate a vendor choice.

- Google for Developers, Rules of Machine Learning: https://developers.google.com/machine-learning/guides/rules-of-ml
- Google Cloud, MLOps continuous delivery and automation pipelines in machine learning: https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning
