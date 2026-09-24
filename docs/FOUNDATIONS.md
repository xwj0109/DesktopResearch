# Selective foundation reuse

The precise imported-file inventory and SHA-256 hashes are in `evidence/foundation-import.json`.

Source: the immutable `phase10-checked-source.tar.gz` checkpoint (SHA-256 `f9fed11d8d0c2d63e919eabd90b64f384cebb7cd80c2f58d9858090e47d0d0a2`), through the coordinator's private validation copy. No reads of a moving legacy source tree were used to seed these files.

## Included

- App-owned installed-Pi host/UI/resource/session bridge and canonical ownership/recovery helpers.
- Research and portfolio journals, immutable blobs, receipts, numerical reference engine and projections.
- Bounded service lifecycle/IPC contracts and manual CLI handoff helper.
- Four nonvisual shared TypeScript domain/protocol modules.
- Selected backend tests and authored fake runtime fixtures.

The HTTP API implementation is reusable service infrastructure; it is not the new product frontend. Any retained static-route code is compatibility infrastructure, not permission to ship the old browser UI. The future native renderer uses its own workbench and a main-owned scoped transport.

## Excluded

- Legacy `server/index.ts` browser launcher.
- Old `main.tsx`/`renderer.tsx`, dashboard/workbench JSX, forms/reader UI and styles.
- Live `.runtime`, workspaces, session files, capabilities, backups, global settings/auth, installed SDK packages or vendor agent runtimes.
- Legacy UI remains excluded. Selected native lifecycle/security/build files were subsequently adapted from the immutable private reference; exact original hashes are in `evidence/native-pattern-import.json`. They are shell patterns, not acceptance of the old GUI. New startup/diagnostics, draft storage, narrowed t15 DTO transport and launcher/Workbench adapter are independently implemented and tested here.

## Verification status

Legacy checks (including the historical configured-harness no-inference proof) apply only to the source/version and scope recorded at that time. Importing code preserves neither certification nor frontend acceptance. Re-run the selected suite in this repository and record new evidence.

No application inference or real configured extension startup belongs in routine test runs. Tests use disposable roots and explicit fixtures. Normal production Pi extensions keep user-level authority; managed session leases do not control arbitrary unmanaged writers.
