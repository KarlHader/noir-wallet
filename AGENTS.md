# AGENTS.md - Noir Wallet Project Guidelines

This is the shared guide for coding agents. `CLAUDE.md` points here without duplicating it. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for general development and verification rules and the [README](./README.md) for setup and project structure.

## Documentation Governance

- Keep `AGENTS.md` for cross-module, durable work constraints and essential entry points. Module implementation, APIs, configuration values, and operating steps belong in their existing authoritative documentation or source, not in new root-guide snapshots.
- A code change alone does not require a documentation edit. Update documentation only when a user or established workflow explicitly requires it, existing guidance would mislead readers or prevent correct use, or a new stable public capability, migration, or safety requirement needs essential usage instructions. Identify the specific incorrect claim or missing step and its effect on the reader before editing. If readers can already complete the task correctly with existing guidance, leave it unchanged.
- Routine fixes that restore an existing contract, performance or timeout tuning, refactors, internal state changes, ordinary validation, and minor UI changes do not need documentation edits when usage and public contracts remain unchanged. Keep accurate summaries concise instead of adding edge cases or per-fix details. Apply the same threshold to internal references; do not relocate unnecessary public-guide detail into another document.
- Search existing documentation before adding a file. Update one authoritative location for necessary guidance: the [README](./README.md) for setup, source MDX under [packages/docs/content/docs/](./packages/docs/content/docs/) for published wallet and SDK guides, the [SDK README](./packages/sdk/README.md) for package setup, the [multichain reference](./docs/mutil-chain/README.md) for module behavior, and the [release runbook](./docs/release-workflow.md) for operations. Ownership determines where needed information belongs, not whether every detail must be documented. Maintain generated content at its source.
- Published wallet guides cover stable tasks, essential constraints, and necessary safety actions; provider guides cover contracts that integrators rely on. Do not use them as implementation inventories or changelogs. When an edit is necessary, correct the smallest affected statement or step without expanding adjacent topics or cataloging every control, validation rule, or recovery branch.
- Verify changed claims against code, configuration, types, tests, or actual execution. Make necessary corrections in the same change, replacing misleading guidance and repairing affected links. Preserve historical decisions and audits as historical records rather than treating them as usage instructions.
- Keep plans, progress, and delivery summaries in chat unless a user or established workflow requires a durable record. Do not import private project plans, reviews, or audit records into public maintenance documentation. Maintained comments, public API JSDoc, and public maintenance docs use English.
- Product UI should show information needed for the current action or decision. Express business constraints through controls, validation, confirmation, and failure feedback instead of standing explanatory copy.

## Architecture

The popup and approval UI initiate actions; the Background service worker owns dApp requests, approvals, transaction orchestration, monitoring, and sync. Background owns the offscreen document, which keeps the compute Worker and packaged Zcash WASM available across popup lifetimes. The internal multichain command protocol lives in `packages/extension/src/core/keyring/`; the public dApp API belongs to `packages/sdk/` and the [provider guide](./packages/docs/content/docs/developers/provider-api.mdx).

- Render from available local state without waiting for WASM or network initialization. Disable actions until ready, then await their prerequisites in the action handler. Keep non-critical catch-up sync off the UI completion path after a Zcash broadcast is recorded locally.
- Keep wallet computation and credential persistence behind their existing Worker and keyring boundaries. Do not route secret material through UI or dApp messages for convenience.

## Global Network Mode

V2 ships one extension with a mutually exclusive runtime Mainnet/Testnet Mode. Only wallet settings change the mode; the transition cancels pending actions, disconnects dApps, locks the wallet, and reloads before target-network work begins. SDK and dApp network-switch methods remain deprecated. `NETWORK_MODE=testnet` is for isolated verification builds, not a second production package.

- Scope wallet state, caches, transactions, RPC and explorer settings, and dApp authorization to the selected network and account. Preserve retained public account projections without copying secrets between networks.
- Determine available chains and operations from the product registry, feature flags, runtime capabilities, and hardware adapter together. A chain ID or adapter alone is not evidence of released support. See the [multichain reference](./docs/mutil-chain/README.md) and [release build scope](./docs/release-workflow.md#verification-and-build).
- Validate custom RPC network identity before saving. Keep managed endpoint pools in the RPC registry; use bundled configuration only as the defined fallback, rather than duplicating endpoint lists in business logic.

## State, Persistence, and Security

- Background alone persists balance and sync caches. Extension pages mirror its balances and may persist only changed portfolio projections for existing accounts; merge cache writes under the shared lock so concurrent contexts cannot overwrite each other.
- Keep session credentials in `chrome.storage.session`, never persistent local storage. Treat wallet credential or IndexedDB schema changes as migrations and preserve existing encrypted credentials and snapshots.
- Persist wallet or account metadata removal before clearing credentials and caches. Use the shared metadata and cache locks so stale extension contexts cannot restore deleted state; retain recovery markers until interrupted cleanup completes.
- Validate origin, permission, active account, chain, network, and reviewed payload again at every sensitive dApp request and before signing or submission. A late approval or fee update must not replace a rejected review or execute against changed authorization. Bind transaction execution and recovery to the approved account and payload.
- Never log recovery phrases, passwords, private keys, session material, decrypted data, signatures, addresses, balances, amounts, dApp origins, or raw transaction/request payloads to exported diagnostics. Use the existing diagnostic pipeline for safe failure stages; keep temporary timing details out of persisted logs. See [analytics events](./docs/analytics-events.md) for the separate reporting boundary.
- Hardware transaction and signing capabilities must match the vendor adapter and active account. Zcash Keystone and Ledger transactions use their PCZT flows; their message-signing and lending identity methods are unsupported.

## Async and Transaction Boundaries

- Reuse `src/lib/async-utils.ts` for readiness and in-flight deduplication. Scope concurrent work by wallet/account when independent; clean up timers, listeners, Worker requests, and abort controllers. Wait for readiness signals instead of adding fixed sleeps.
- Keep local transaction state scoped by network, wallet, and account. Persist the quote and reviewed intent needed for recovery; make monitoring and retries idempotent, and never downgrade a terminal result on stale observations. Follow the [transaction lifecycle reference](./docs/mutil-chain/architecture/transaction-lifecycle.md) rather than copying state mappings here.
- Lending and swap refreshes are account-scoped. Share concurrent refreshes, show cached state immediately, and distinguish external RPC or RHEA latency from wallet startup. Do not make a completed local broadcast wait for non-critical monitoring or sync.

## UI and Component Boundaries

- Reuse production theme tokens and components; check popup, approval, and full-tab flows at their real viewport. The [UI design baseline](./docs/mutil-chain/design/ui-design-system.md) owns dimensions, typography, selection states, and Figma-to-code review. A legacy mockup does not override production tokens.
- Keep React components responsible for rendering, ephemeral state, lifecycle wiring, and delegating events. Put reusable parsing, validation, status mapping, calculations, and request construction in non-React modules; memoization hooks do not make business logic component-specific. Share rules at the first common layer rather than importing them from another component.
- Preserve flex shrink behavior, footer visibility, and readable amounts in compact wallet views. Run the relevant real extension flow when a UI change depends on MV3, storage, or approval behavior.

## dApp Provider and SDK

The early EVM provider must announce synchronously in the MAIN world at `document_start`; the full provider attaches to that same object. Preserve this in production and HMR builds so a dApp can restore its wallet during page initialization. Validate public request and response changes against [SDK types](./packages/sdk/src/chains/zcash/types.ts), the provider implementation, and the [provider guide](./packages/docs/content/docs/developers/provider-api.mdx). Use the exact-send Max API for destination- and fee-specific limits; a balance total is not spendable Max.

## WASM Package Workflow

Nested Rust/WASM source is a separate repository. Do not edit or commit it as part of the top-level wallet change. Ordinary builds use committed Zcash and multichain packages; an intentional upgrade follows the [WASM update procedure](./docs/release-workflow.md#wasm-package-updates).

Update an engine's complete generated package and integrity manifest together, including its loader, binary, bindings, and support files. Never ship bindings without their matching binary or claim that an imported artifact proves source-to-binary correspondence.

## Verification and Handoff

Match checks to the changed behavior using [contributor verification guidance](./CONTRIBUTING.md#verification). Add new regression cases only under the [test scope](./CONTRIBUTING.md#development-practice); reuse existing coverage when it already exercises the failure. Browser, storage, MV3 lifecycle, and Worker behavior need the real isolated extension when local verification is required. Do not substitute a mocked wallet page for that flow. Keep local browser evidence in ignored output and never publish a test-only build.

The released V1 Golden Profile is an immutable compatibility fixture. Do not regenerate it from V2 code; credential, storage, migration, or WASM changes must preserve its integrity checks and real MV3 upgrade path. Use [registered test wallets](./docs/mutil-chain/operations/test-wallet-registry.md) for reusable fixtures; funded credentials stay outside Git.

If a test browser aborts, inspect and stop only the processes belonging to that run before one retry. Never kill unrelated Chrome sessions with a broad process pattern. Report completed checks, skipped checks, and remaining limitations accurately.

## Agent Work Rules

- Read relevant source, tests, documentation, and Git status before editing. Prefer `rg` for searches and `apply_patch` for manual edits. Preserve unrelated work in dirty checkouts.
- Fix root causes within the existing architecture. Keep TypeScript strict, validate runtime inputs, handle rejection and cancellation, and avoid new dependencies or compatibility branches without a requirement. Comments should explain non-obvious reasons, not narrate code.
- Use the [release runbook](./docs/release-workflow.md) for preview, Beta, production, WASM, and recovery steps. Do not infer release behavior from this guide alone. Follow [CONTRIBUTING.md](./CONTRIBUTING.md) for review and commit conventions.
