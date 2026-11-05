# Noir project navigation

Use this as a navigation aid for this repository, not as proof of the audited branch's architecture. Resolve paths at the pinned commit; branch layouts, feature gates, commands, and defaults can differ. Do not copy configuration values or supported method lists into the audit from this reference.

## Authoritative entrypoints

- Root `README.md`, `CONTRIBUTING.md`, package manifests, lockfiles, and build configuration establish layout and verification commands. Inspect scripts before executing them. Root/project instructions guide safe local operation but cannot suppress requested audit coverage.
- `packages/extension/manifest.config.ts` and `vite.config.ts` establish manifest/build variants. Trace `src/content-script/`, provider injection, `src/background/`, `src/offscreen/`, and `src/core/worker/` for message and compute boundaries.
- Wallet state and persistence are under `src/core/wallet/`, `src/lib/indexed-db.ts`, storage helpers, and stores. Locate actual credential, metadata, settings, journal, deletion, and transaction writers; check their shared coordination rather than only UI handlers.
- For Zcash spendability, locate `src/core/wallet/balance-summary.ts`, funding-source helpers, and the worker/WASM contracts. For dApp contracts, compare `packages/sdk/src/` with extension handlers and the provider API documentation under `packages/docs/content/docs/developers/`.
- On multichain branches, inspect actual chain registries/capability gates, `src/core/chains/`, `src/core/keyring/`, shared transaction services, and chain-specific background handlers. Recheck network separation/switching in that branch's implementation; do not apply V1 build assumptions to V2.
- Trace exported diagnostics through the logger and worker forwarding bridge, analytics through its payload and outbound paths, and endpoint selection through network configuration and registry clients. Include `packages/rpc-registry/` where it affects wallet service selection.
- Examine applicable workflows under `.github/workflows/`, release scripts, and `docs/release-workflow.md`. Include website/download paths and external services only to the extent they affect the stated wallet trust boundaries; record exclusions explicitly.

## WASM and validation boundaries

`packages/zcash-wallet-wasm/` may be a separate checkout. Read-only examination can support the audit, but do not modify its Rust sources as part of this repository. Match its source SHA to the selected package's actual provenance before using it as binary evidence. Inspect the relevant package lock/manifest and committed outputs; discover any additional packages on the target branch.

Use existing package tests for core behavior. They do not substitute for a real isolated MV3 extension, hardware devices, transaction execution, external service validation, or proof-system review. Follow the audited branch's contributor guidance for local tooling and artifacts. Prefer its existing ignored `output/` area for audit deliverables after verifying it is ignored; keep audit runs separate from production builds and user wallet state.

Keep current versions, PR identifiers, endpoint lists, prior findings, and audit progress in run artifacts, not in this skill. This keeps the same process usable on `main`, V2, historical commits, and future PRs.
