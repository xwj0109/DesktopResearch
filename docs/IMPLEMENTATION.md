# Execution gates

## Scope

Build the desktop-first product described in `PRODUCT-DESIGN.md`, in this repository only. The legacy lab is read-only. No data migration, live-server shutdown, lock deletion or in-place upgrade is part of this work.

## 1. Independent foundation (task t-14.1)

- Initialise local Git without staging/commits/push.
- Import a narrow, hash-recorded app-owned research/Pi foundation from frozen verified source, not the live moving legacy tree.
- Give this repository its own dependency manifest/lock/install. Reject cross-repo runtime imports/symlinks and bundled Pi packages.
- Re-run imported backend regressions here; historical results do not certify a new repository.
- Document excluded UI/data and remaining risks.

## 2. Desktop workbench and shell (t-15.1)

- Implement new reusable workbench components with preview fixtures separated from production data.
- Visually verify workspace/session rail, conversation center, resizable context pane, contextual research navigation and keyboard flows.
- Integrate a secure Electron shell with isolated root/scope windows/profiles and stable view identity before renderer module initialisation.
- Use one owned system-Node service, main-only capabilities, narrow sender/main-frame/scope-validated IPC, asset-only secure scheme and strict navigation/permission/download policy.
- Verify actual startup and full quit/reopen. Do not block Electron ESM module evaluation on `app.whenReady()`.
- Treat preview success, native shell success and live Pi integration as distinct gates.

## 3. Real Pi and research integration (t-16.1)

- Dynamically load the exact installed Pi and shared harness, not a private/copy SDK.
- Use canonical session history with generation plus canonical/context fencing, truthful active-branch projection and explicit offline append-log state.
- Persist client-known intent IDs before dispatch; exact receipts/deduplication/sealing/retention prevent uncertain automatic replay. `not_found` is not proof that delayed input cannot arrive.
- Preserve expanded custom-editor state with durable revision/input watermarks and close/reload/handoff/idle-eviction barriers. Do not claim forced-crash losslessness or replay uncertain raw keys.
- Render native conversations, actual tool activity, native standard dialogs, dynamic models/resources/commands and targeted TUI factories.
- Integrate all seven scientific stages, artifact annotations/immutable batches, semantic graphs/code, experiments/results and separate evidence portfolios as workbench surfaces.
- Preserve explicit approval, provenance, exact receipts, request fencing and draft recovery. Do not copy conversational content into another authority database.

## 4. Independent hardening (t-17.1)

Read-only reviewers audit frozen current source and concrete evidence: desktop fidelity, IPC/scope/credentials, process/session ownership, recovery and last acknowledged drafts, scientific/durability/numerical invariants and cross-repo independence. The sole writer repairs reproduced blockers; rerun checks and review. No superficial test-count clearance.

## 5. Packaged delivery (t-18.1)

Verify the actual macOS app, valid local signature, isolated strategy/portfolio windows, PDF/code/graph context and full quit/relaunch. Perform separately controlled installed-harness compatibility tests without paid inference; temporary network/protected-write test instrumentation is not production sandbox policy. Confirm process cleanup and named protected baselines.

Production owns new product storage; test roots are explicitly disposable. Do not migrate/cut over the legacy lab unless separately requested. Report unsupported extension/terminal behaviour, packaging/notarisation limits and unverified scenarios honestly.

## Work discipline

One writer per cwd. Any private design worker stays in its own directory until a frozen handoff. Preserve unrelated edits; no writes/builds in the legacy repo. Do not complete a task from a plan, backend check, fixture-only screenshot or directory existence alone.

## Native integration checkpoint (2026-09-23)

The native workbench is integrated with installed-Pi transport and scientific materials. Canonical branch/history fences, durable action receipts, ordered terminal input, expanded-editor checkpoints, versioned scientific forms, PDF/annotations/code/graphs/results and separate portfolios are implemented. Ordinary native quit/relaunch and fixture conversations have been exercised in the actual packaged app.

All 229 tests, TypeScript, boundaries and production build pass. Focused independent read-only review cleared the repaired input-ordering, bootstrap-dialog, close-barrier and stale-history cases. The macOS arm64 package has a verified local ad-hoc signature and relocated backend persistence/exit smoke. See `NATIVE-CANDIDATE.md` and `evidence/native-check.json` for precise evidence.

This does not close every acceptance gate: the configured installed-Pi 0.84.1 probe stopped at an extension database open under temporary external-write protection. It sent no prompts and left all six protected baselines unchanged. Full configured-harness compatibility remains unverified. Native GUI inspection used the available 1200×850 display; target 1280×800 and 1440×900 geometry is automated only. Terminal fidelity is text/basic keys, experiments use the reference engine, and the app is not notarized/distribution-signed. No taskboard state was changed.
