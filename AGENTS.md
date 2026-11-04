# AGENTS.md - Noir Wallet Project Guidelines

This is the shared guide for coding agents and contributors. `CLAUDE.md` points here. Use the [README](./README.md) for setup and commands, [CONTRIBUTING](./CONTRIBUTING.md) for tests and review, the [release runbook](./docs/release-workflow.md) for operations, and the [SDK package guide](./packages/sdk/README.md) and [documentation source](./packages/docs/content/docs/) for public APIs. Code, configuration, and public types are the implementation sources of truth.

## Documentation Governance

- Keep this root guide to cross-module, durable work constraints and necessary entry points. Put module implementation, interfaces, configuration values, and operational steps in their authoritative source or existing documentation, rather than appending them here.
- A code change alone does not require a documentation edit. Update documentation only when a user or established workflow explicitly requires it, existing guidance would mislead readers or prevent correct use, or a new stable public capability, migration, or safety requirement needs essential usage instructions. Identify the specific incorrect claim or missing step and its effect on the reader before editing. If readers can already complete the task correctly with existing guidance, leave it unchanged.
- Routine fixes that restore an existing contract, performance or timeout tuning, refactors, internal state changes, ordinary validation, and minor UI changes do not need documentation edits when usage and public contracts remain unchanged. Keep accurate summaries concise instead of adding edge cases or per-fix details. Apply the same threshold to internal references; do not relocate unnecessary public-guide detail into another document.
- Search existing documentation before adding a page. Keep necessary guidance in its authoritative place: README for project setup, CONTRIBUTING for contribution and verification, existing topic documents under `docs/` for operations and module-specific guidance, source MDX for wallet and SDK guides, and `CHANGELOG.md` and `packages/web/public/changelog.json` for their distinct release-note audiences. Ownership determines where needed information belongs, not whether every detail must be documented. Update generated content at its source.
- Published wallet guides cover stable tasks, essential constraints, and necessary safety actions; provider guides cover contracts that integrators rely on. Do not use them as implementation inventories or changelogs. When an edit is necessary, correct the smallest affected statement or step without expanding adjacent topics or cataloging every control, validation rule, or recovery branch.
- Make necessary corrections with the code change, replacing misleading current-state text and fixing affected links. Preserve decisions, retrospectives, and audit records as history rather than treating their age as grounds for deletion.
- Write only verified current behavior. State limitations and unverified claims plainly. Follow the document's language and format; keep existing bilingual counterparts consistent when their meaning changes.
- Keep plans, progress, test logs, and delivery summaries in chat or ignored temporary output unless the user or established workflow requires a durable record. Add a document only when its audience and ownership cannot fit an existing location.

## Architecture

The extension uses popup, approval, and full-tab UI; a background service worker for dApp requests, transaction lifecycle, and sync; an offscreen document to keep a compute worker available; and packaged Zcash WASM in that worker. See the [README project structure](./README.md#project-structure) and the implementation under `packages/extension/src/` for current boundaries.

- Render from available local state without waiting for WASM or network initialization. Disable actions until ready and wait for account or worker readiness inside the action handler.
- After broadcast and local recording, notify the UI before non-critical catch-up sync. Keep monitoring and long-running sync in the background.
- Mainnet and testnet are separate builds, with separate extension identities and storage. There is no runtime network switch. Keep endpoints and chain IDs in `packages/extension/src/config/networks.ts`, not duplicated in business logic.

## Security and Persistence

- Never print recovery phrases, private keys, passwords, session credentials, or decrypted wallet data through `logger` or `console`. Store session credentials in `chrome.storage.session`, never persistent local storage.
- Authenticate the sender and origin of dApp messages. Recheck origin authorization, the approved wallet/account binding, and current lock/deletion state before every sensitive operation, including execution after an approval window or hardware interaction. See `packages/extension/src/background/dapp-handler.ts` and `packages/extension/src/core/dapp/dapp-manager.ts`.
- Wallet metadata updates and deletions must use the shared Web Lock in `packages/extension/src/lib/wallet-metadata-storage.ts`. Commit the deletion marker and updated metadata before clearing credentials so stale contexts cannot restore a deleted wallet. Coordinate settings writes through `packages/extension/src/lib/wallet-settings-storage.ts`.
- Treat `zcash-wallet-db` schema changes as migrations that preserve credentials and transaction records. Hardware signing limits and funding-source restrictions live in `packages/extension/src/lib/hardware-capabilities.ts`.

### Exported Diagnostics

Every `logger.log`, `logger.info`, `logger.warn`, and `logger.error` call is persisted on-device and can be shared with support, including in production. Use the single pipeline in `packages/extension/src/lib/logger.ts` and the existing Worker forwarding bridge; do not add another log store or message path.

- Log durable technical stages and outcomes, not request or wallet payloads. Never include secrets, signatures, memos, addresses, balances, amounts, dApp origins, full transaction hashes, or raw request/response objects. Sanitization is a fallback, not permission to log them.
- Pass wallet and account IDs through the logger's optional arguments for fingerprinting, never interpolate them into messages. Pass an exception as the fourth argument to preserve useful safe error codes, causes, and recovery context without copying payloads. Worker and offscreen errors use the same diagnostic projection.
- `console.log` may serve temporary local debugging and is removed from production builds, but `console.*` must never print secrets. Avoid exported logs in rendering, polling, timers, and other high-frequency paths unless a state transition or terminal failure occurs.

## Async and Transaction Lifecycle

- Use `packages/extension/src/lib/async-utils.ts` for readiness and in-flight deduplication. Scope shared operations by wallet/account, make preconditions idempotent, clean up listeners, timers, worker requests, and abort controllers, and wait for actual readiness rather than fixed sleeps.
- Local transactions are scoped by network, wallet, and account. Broadcast completion means built, broadcast, and locally recorded; UI completion must not wait for catch-up sync. Recovery must be idempotent and must not downgrade terminal status after stale polling. Use `packages/extension/src/lib/cross-chain-transaction.ts` for cross-chain completion semantics and persist quote binding with the transaction record.
- Lending data and refreshes are account-scoped. Share concurrent refreshes and surface cached state while background work proceeds. Distinguish external RPC/Intents latency from wallet initialization when diagnosing failures.

## WASM Package Boundary

`packages/zcash-wallet-wasm` is a separate Git repository. Do not edit or commit its Rust source as part of this repository. Follow the [WASM package update procedure](./docs/release-workflow.md#wasm-package-updates); ordinary extension builds use the committed package. Commit `wasm-package.lock.json` with the complete `packages/extension/src/lib/wasm-pkg/` output. An importer-recorded source commit and file hashes do not by themselves prove source-to-binary correspondence.

## Project-Specific Review

- Read relevant code, tests, configuration, and Git status before editing. Preserve unrelated worktree changes and fix root causes using existing patterns rather than superficial fallbacks.
- Check SDK contracts against `packages/sdk/src/chains/zcash/types.ts` and the extension provider, not a copied RPC list. The [provider API guide](./packages/docs/content/docs/developers/provider-api.mdx) owns external method descriptions.
- For balance or Max behavior, inspect `packages/extension/src/core/wallet/balance-summary.ts` and `packages/extension/src/lib/funding-source.ts`. Do not treat total or shielded balance as destination-specific spendable value.
- Verify browser-specific changes in the real isolated MV3 extension. Core tests or a mock page do not establish popup, storage, or service-worker behavior. Follow [contributor verification](./CONTRIBUTING.md#development-and-verification) for test scope and local artifacts.
