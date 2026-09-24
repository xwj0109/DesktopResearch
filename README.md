# Pi Research

A desktop-first AI research workbench using the user's installed Pi harness. This independent repository owns its dependencies, native interface and new product data. The legacy `herdr-lab` application is not a build or runtime dependency; its UI and live data are not imported.

## Implemented

The Electron app now connects the conversation-led workbench to the installed-Pi adapter and scientific evidence engine:

- Independent strategy and portfolio windows, seven research stages, persistent drafts, resizable context panes and graceful quit/relaunch.
- Canonical active-branch conversation history, streaming responses, inline tool activity, installed models/commands, standard dialogs and a targeted text terminal for extension/editor interaction.
- Durable scoped action receipts, generation/context fences, explicit recovery and sealing, ordered terminal input and expanded-editor checkpoints. Uncertain actions are never automatically replayed.
- Versioned scientific records, explicit approvals, data handoffs/CSV ingestion, reference experiments/results and independent evidence portfolios.
- PDF/text/image previews, source-bound annotations and immutable annotation batches, code inspection, semantic graphs and native file export.
- Main-owned capabilities, exact scoped IPC routes, an asset-only secure scheme and an owned system-Node backend. Opening a strategy starts its active Pi CLI conversation. Opening the launcher never connects Pi, and connecting never sends a prompt.

`src/workbench/` contains the native surfaces; `desktop/` owns Electron security/storage/lifecycle; `server/` contains the research engine and installed-Pi host. Synthetic browser fixtures remain explicitly opt-in at `/?design-preview=1`.

## Run and build

```sh
npm ci
npm run check
npm run dev                         # browser visual preview: /?design-preview=1
npm run desktop:package             # local macOS arm64 app, ad-hoc signed
```

App: `desktop-release/Pi Research-darwin-arm64/Pi Research.app`.

Production defaults to the Finder-visible `~/Pi Research Data` folder. To move it, quit the app first and move the whole folder (don't copy it). On the next Connect, each stage's Pi conversation is re-linked to the new location only when the evidence shows a move; an audit record is written to `.runtime/relocations/`, and copies or live writers are refused. Finder `.DS_Store` files inside the data folder are ignored. Drafts and layouts are keyed to the folder's path, so they start fresh after a move unless carried over. QA uses an explicit disposable absolute `--lab-root`. Installed system Node >=22.19 and Pi are validated; `LAB_PI_NODE` and `LAB_PI_EXECUTABLE` override discovery and invalid configured paths fail visibly.

## Validation and remaining acceptance boundary

The recorded native validation checkpoint passed **229 tests**, TypeScript, repository boundaries and the production build. Run `npm run check` for the current source. Actual native QA exercised strategy/portfolio creation and restoration, drafts/layout, immutable records, PDF rendering, annotations, code, graphs, and fixture-backed conversation/tool rendering. The package has a verified local ad-hoc signature and passes relocated backend quit/reopen smoke. See [native validation and handoff](docs/NATIVE-CANDIDATE.md) and [machine-readable evidence](docs/evidence/native-check.json).

**Compatibility with the fully configured installed harness remains unverified.** A no-inference probe of installed Pi 0.84.1 reached extension initialization, where its database open failed under the probe's external-write protection. No prompts were sent; the six protected configuration/authentication baselines remained unchanged. Authored-fixture tests do not certify that shared harness. The app is not notarized or distribution-signed. The extension terminal supports text/basic keys, not full terminal-emulator fidelity; experiment execution uses the bounded reference engine, not arbitrary authored code.

## Boundaries

- Load installed Pi and the shared harness; do not bundle a replacement SDK or copy authentication.
- Keep canonical conversation separate from scientific authority, explicit approvals and immutable provenance.
- Keep strategy/portfolio scopes isolated and capabilities in Electron main.
- Preserve uncertain receipts and editor watermarks without automatic raw-input replay; do not claim forced-crash losslessness.
- No automatic legacy migration, global Pi configuration changes, Projects changes or paid inference.

The interface is a tiled, Omarchy-styled workbench with twelve switchable palettes; see [interface](docs/INTERFACE.md).

**Core principle: agnosticity.** The app is model- and runtime-agnostic. Every agent operation is defined once in the backend workbench registry and reached through thin adapters (Pi, MCP). Read [principles](docs/PRINCIPLES.md) before adding features.

See [product design](docs/PRODUCT-DESIGN.md), [implementation gates](docs/IMPLEMENTATION.md) and [foundation provenance](docs/FOUNDATIONS.md).

Graphical Pi compatibility and remaining differences: [docs/PI-PARITY.md](docs/PI-PARITY.md).

## Repository and user data

This repository contains the desktop application source, tests, build scripts and documentation. Installed dependencies, packaged builds, local agent state and generated QA output are excluded from Git.

Research workspaces and application state live separately in `~/Pi Research Data`; back up that folder privately. The installed Pi configuration and sessions under `~/.pi` are also outside this repository. Neither folder is distributed with the application source.
