# V1 to V2 Decision Policy

Use this policy during analysis and before any authorized execution. Record evidence by file, behavior, or test; commit subjects alone are not enough to justify a port.

## V2 architecture

- Treat the extension as a layered MV3 system: popup and approval UI, background service worker, offscreen document, worker, and packaged Zcash WASM. Put orchestration in the owning layer and wallet computation in worker/WASM boundaries.
- Keep React components focused on rendering, ephemeral state, lifecycle wiring, and event delegation. Put reusable parsing, validation, mapping, and request derivation in a non-React module.
- Follow existing shared chain, asset, account, transaction, and error models. Do not fork a V1 abstraction into V2 when a V2 registry or service already owns that responsibility.
- Preserve optimistic rendering and background sync behavior. A confirmed local broadcast should reach the UI before noncritical catch-up work.

## Behavior comparison

For each source unit, identify the user-visible or security-relevant behavior, then trace its current V2 equivalent across UI, background, worker/WASM, storage, SDK, and tests as applicable. Classify each behavior slice as `adopt` (same behavior can be moved directly), `adapt` (V2-specific implementation), `equivalent` (already present), or `reject` (outside V2 scope or incompatible), and cite concrete evidence. Use `defer` only while evidence or verification is unresolved. Port the behavior, not source structure or implementation details. Retain V2 conventions and current contracts unless the task explicitly requests a contract change.

Use exact-path overlap from the inventory as a navigation hint only. A file touched in both histories may implement unrelated behavior, and a feature may cross files. Check surrounding history and current code before deciding.

## Release metadata isolation

Keep inventory and analysis read-only. Do not change version numbers, changelogs, release notes, tags, workflows, or release metadata while porting a behavior unless the user explicitly includes release preparation in scope. A code change does not imply permission to prepare or publish a release.

## Atomic WASM packaging

Treat `packages/zcash-wallet-wasm` as a nested repository. Do not modify its Rust source as part of a top-level port. When a matching WASM change is already built in the nested repository, use the repository's documented `sync-wasm-pkg` workflow and keep generated bindings, loader, and `.wasm` binary in sync. Never ship TypeScript bindings without their matching JavaScript loader and binary. Review generated package changes as one atomic unit.

## Security and migration

- Never expose or log seed phrases, passwords, private keys, session key material, or decrypted wallet data.
- Preserve credential encryption and session-only secret lifetimes. Recheck dApp origin, chain, account, and payload binding at sensitive request boundaries.
- Treat storage schema, wallet identity, account derivation, credential handling, active pointers, and WASM persistence changes as migration-sensitive. Trace existing migration behavior and compatibility fixtures before changing them.
- Keep network data partitioned by the authoritative global network mode. Do not introduce mixed Mainnet/Testnet state or let a dApp change the global mode.
- Preserve a manually selected Zcash RPC as a fixed endpoint. Optional block delivery accelerators may run only when they cannot bypass that selection, and Testnet requires its own attested dataset.
- Require explicit user authorization for mutations before starting them. Make the approved scope concrete, preserve unrelated worktree changes, and stop if implementation evidence shows the change would cross that scope.
