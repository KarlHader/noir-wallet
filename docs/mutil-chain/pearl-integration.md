# Pearl Integration Status and Completion Plan

Status: implementation in progress. This records the current source inspection and local verification; it is not a release announcement or a claim of mainnet readiness. Pearl host changes in the worktree remain uncommitted, including newly added files under `infrastructure/chains/pearl/`, `background/pearl-*`, the Pearl send UI, the Pearl dApp provider, and the SDK Pearl entry point. Recheck this status after those changes land. Default-build enablement and the public BIP-322 dApp contract were added after the last real-extension run, so their MV3 evidence is still outstanding. The [multichain reference](README.md) defines the architectural boundaries, and the [release runbook](../release-workflow.md) governs build and release decisions.

## Intended scope and current integration

The product definition in `packages/extension/src/core/chains/registry/product-chain-definitions.ts` declares Pearl Mainnet/Testnet with PRL as the native asset, P2TR addresses, BIP-86 or imported keys, PSBT-v0 and BIP-322 signing formats, and **native transfer only**. Declared capabilities describe intended software support, not validated user-facing availability. `packages/extension/src/config/multichain-feature-flags.ts` now enables `chain.pearl` in `DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS` alongside Zcash and EVM, so Pearl is a selectable family rather than a deferred **Coming soon** entry. Hardware transfers and quote-deposit sources remain unavailable in controls and policy. The software dApp surface now includes native sends, PSBT signing, and broadcast helpers alongside BIP-322.

The table below lists **source that exists in the tree**. The product registry now constructs, but that does **not** mean a Pearl-enabled MV3 flow has been proven.

| Area                         | Code present (not runtime-proven)                                                                                                                                        | Source of truth                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain identity and endpoints | Pearl chain IDs, network/explorer configuration, managed and bundled Blockbook endpoints                                                                                 | `packages/extension/src/core/chains/registry/chain-ids.ts`, `packages/extension/src/config/networks.ts`, `packages/rpc-registry/src/registry.ts`                                                        |
| Software keys and signing    | BIP-86 derivation, private-key import, PSBT and BIP-322 Worker/WASM command paths; packaged manifest lists the operations                                                | `packages/extension/src/infrastructure/keyring/multichain/pearl-derivation-client.ts`, `pearl-signing-client.ts`, `packages/extension/src/infrastructure/generated/wasm/multichain/wasm-integrity.json` |
| Network and transfer         | Blockbook identity and reads, address discovery, UTXO selection, PSBT build/finalization, input reservations, broadcast, monitoring and recovery paths                   | `packages/extension/src/infrastructure/chains/pearl/`, `packages/extension/src/background/pearl-transfer.ts`, `pearl-transfer-controller.ts`, `pearl-transaction-monitor.ts`                            |
| Wallet UI and activity       | Send form/result, receive and account presentation, activity history, explorer and endpoint settings branches                                                            | `packages/extension/src/popup/pages/transactions/PearlSendForm.tsx`, `MultichainSend.tsx`, `packages/extension/src/infrastructure/activity/configured-history-sources.ts`                               |
| dApp provider and SDK        | Inpage `window.noirwallet.pearl`, request parsing, origin/account authorization, reviewed BIP-322/PSBT/`sendPearl` approval, push helpers, and the typed SDK entry point | `packages/extension/src/core/dapp/pearl-provider.ts`, `background/pearl-dapp-handler.ts`, `content-script/inject-provider.ts`, `packages/sdk/src/chains/pearl/`                                         |

## Completed locally and remaining boundaries

1. **Product registry runtime blocker resolved.** `registry/chain-registry.ts` now accepts `family: 'pearl'` at runtime, matching `registry/capabilities.ts`. The existing product-definition test asserts Pearl Mainnet/Testnet IDs, its flag, capabilities and bundled PRL asset. The default flag now includes Pearl, and the offline availability expectations were updated with that release decision.
2. **Existing Pearl-related regressions reconciled.** The signing-summary schema and review tests now include Pearl; Pearl review retains its own schema and chain presentation instead of displaying Bitcoin's schema or title. Compressed WIF shared by Bitcoin and Pearl is tested as ambiguous, requiring an explicit chain-family choice.
3. **Packaged WASM build check passes; upstream correspondence remains unproven.** The committed Multichain manifest, runtime pin, sync script and build verifier all name `cb993e08778fe6b0aafdf015a7a03a8741cdfe66` (`wallet-engine-cb993e0-v11`). `pnpm build:extension` passes structural and artifact-hash verification against that pin. This verifies the _packaged files against their manifest_, not that the binary was independently rebuilt from the claimed upstream source commit; an upstream rebuild requires the [WASM update procedure](../release-workflow.md#wasm-package-updates).
4. **Hardware transfers are explicitly unsupported.** `pearl-transfer-controller.ts` rejects hardware preparation and external signing; `HARDWARE_CHAIN_CAPABILITIES` has no Pearl entry. Do not advertise hardware support from the software PSBT path.
5. **Quote-deposit/Swap source transfers are explicitly unsupported.** Both Pearl branches in `quote-deposit-transfer-client.ts` reject the operation. The product definition does not declare Pearl token transfers.
6. **Public Pearl spend contract added for software accounts.** `packages/sdk/src/chains/pearl/` exposes `getPearlProvider()` / `detectPearlProvider()` with accounts, network/chain, public key, balance, `sendPearl`, `signMessage('bip322-simple')`, `signPsbt` / `signPsbts`, and `pushPsbt` / `pushTx`. Background validates origin, chain authorization, active account and the prepared signing or transfer summary again before Worker confirmation or broadcast. Hardware Pearl dApp signing remains closed.
7. **Acceptance evidence is incomplete.** Pearl-specific offline suites under `packages/extension/tests/core/chains/pearl/` cover Blockbook identity/reads, coin selection, malformed finalization rejection and safe runtime-error mapping. The `pearl-testnet` Playwright project and `tests/extension/pearl-dapp-provider-testnet.spec.ts` now exist but have not been executed; they cover released-family presentation, injected provider identity, connect approval, unfunded balance, BIP-322 approval/rejection and disconnect against a stubbed Blockbook, with malformed/`signPsbt` rejection paths for the expanded public surface. Successful funded signing and broadcast, funded restart recovery and hardware behavior remain unproven.

## Completion plan

### P0 — Completed: make the chain registry executable

- Pearl was added to runtime family validation; owning product-definition, selection, signing-review and WIF-import regression expectations were reconciled.
- Exit gate: product registry constructs for both networks; `pnpm test` and extension type-check pass. The default flag decision landed later, in the dApp-provider change.

### P1 — Completed: software transfer lifecycle hardening

- Signing claims, per-transfer serialization, reconciliation of interrupted signing, idempotent broadcast recovery, conflict detection and removal of the dead `previousTransactions` path are implemented and covered by `tests/core/chains/pearl/pearl-pending-transfer-lifecycle.test.mjs` and the extended Blockbook client test.
- Residual risk: reconciliation compares an unknown signing outcome with on-chain evidence only after the grace period; a signature produced and never returned is unrecoverable, which is why the claim is retained instead of releasing inputs.
- Exit gate: deterministic tests cover the races and failure windows; recovery is idempotent; the default build stays green.

### P2 — In progress: verify the real extension before release consideration

- The isolated `pearl-testnet` project (`testnet-pearl` profile, `chain.pearl`) and `tests/extension/pearl-dapp-provider-testnet.spec.ts` now exist. The spec covers released-family presentation, provider identity, connect approval, unfunded balance, BIP-322 approval and rejection, and disconnect against a stubbed Blockbook.
- Still required: actually running that project, then extending the evidence to wallet creation/import, unlock, receive and discovery, exact and Max sends, activity/confirmations, RPC error handling, account/network switching and service-worker restart recovery. Funded sends need an explicitly authorized registered test wallet; do not include credentials in logs or Git.
- Exit gate: extension, storage, Worker and transaction lifecycle evidence is recorded locally; blocked live or hardware checks are reported rather than marked passed.

### P3 — Decide optional product expansions separately

- For a software-wallet PRL send/receive milestone, keep hardware and quote-deposit unavailable in controls and capability policy. The released public contract covers account reads, balances, BIP-322 message signatures, software `sendPearl`, PSBT signing, and push helpers.
- **Hardware:** before reusing Bitcoin's PSBT device path (`src/lib/ledger/bitcoin.ts` or Keystone's PSBT UR path), confirm the vendor app supports Pearl network, BIP-86 paths and taproot signing. Then add a Pearl hardware credential/capability, bind exported account identity and device path, implement device confirmation UI and external signed-PSBT verification. Complete refusal, disconnect, restart and physical-device acceptance before enabling it.
- **Swap quote-deposit:** first establish that the quote provider accepts native PRL with a supported destination and refund contract. Then extend `quote-deposit-transfer-client.ts` source resolution, Pearl-specific draft/Max cleanup and exact-transfer preparation; bind quote, recipient, refund, expiry and fee to the reviewed intent in Background, with recovery after restart. Removing the two explicit rejections alone is unsafe.
- **Hardware after dApp spend:** software `sendPearl` / PSBT / push paths are wired. Hardware still needs vendor app support, Pearl capability binding, device UI, and physical-device acceptance before any dApp hardware path.

### Completed locally

1. **Approval/rejection race.** Pending records gained a durable `signing` phase claimed through `pending-store.ts`/`pending-transfer-lifecycle.ts` before `signer.confirm`, and every mutating operation on one transfer is serialized by a per-transaction queue in the orchestrator. `reject`, expiry sweeps and programmatic cancellation now refuse or skip records whose signature may already exist.
2. **Lost signature response.** A non-descript signing failure keeps the `signing` claim instead of releasing reservations. `recoverPendingTransfers()` reconciles stale claims against the chain: an existing transaction keeps its reservations and is recorded as broadcast, otherwise the signature never left the wallet and the reservation is released.
3. **Broadcast/commit gap.** Reservation commit failure no longer deletes the signed record; the recovery sweep re-broadcasts idempotently and completes the commit, running from the Pearl monitor alarm and runtime startup.
4. **Conflict detection.** `pearl-blockbook-client.ts` reads Blockbook `vin[].txid/vout` through `getAddressSpends`, `pearl-conflict-detection.ts` selects a confirmed conflicting spend deterministically, and recovery now retires committed inputs when another transaction mined the same outpoint. The previous no-op is gone.
5. **Dead `previousTransactions` branch removed.** Pearl taproot inputs rely on `witnessUtxo` from `pearl-psbt-builder.ts`; the unused wiring, the unused client dependency and the unused `PearlPreviousTransaction` type were deleted.
6. **Signer identity.** `assertPearlDiscoverySigner` is a tested guard requiring the discovered signer to equal the selected ChainAccount identity.
7. **Packaged WASM build check.** The verifier pin matches the manifest, runtime pin and sync script; the default build verifies packaged structure and hashes. This does not prove source-to-binary correspondence (see P1).

### Remaining work

"Fixable locally" means code, configuration and deterministic offline tests can settle it. Items 1-7 above are closed; the list below is what is left.

1. **Pearl-enabled MV3 evidence must be produced.** `pnpm test e2e pearl-testnet` builds the isolated `testnet-pearl` profile and runs `tests/extension/pearl-dapp-provider-testnet.spec.ts`. It has not been executed locally yet, and it deliberately stops at an unfunded account: funded signing, broadcast, funded restart recovery and hardware remain out of scope. Widening it to receive/discovery and funded sends needs authorized test coins.
2. **Funded broadcast acceptance.** Requires funded Pearl Testnet coins and explicit authorization. Both Blockbook endpoints are publicly reachable and in sync (Mainnet `Pearl`, Testnet `Pearl Testnet`), so connectivity is not the blocker.
3. **Upstream source-to-binary correspondence.** Proving the committed binary matches `cb993e08778fe6b0aafdf015a7a03a8741cdfe66` needs the separate Rust/WASM checkout and the pinned rebuild in the [WASM update procedure](../release-workflow.md#wasm-package-updates).

### Needs an external prerequisite

4. **Hardware transfers.** Requires a vendor app supporting the Pearl network, BIP-86 paths and taproot signing, plus physical devices for refusal/disconnect/restart acceptance.
5. **Swap quote-deposit.** Depends on the quote provider accepting native PRL with a destination and refund contract; removing the two rejections without that contract would be unsafe.
6. **Hardware dApp spend.** Needs vendor Pearl support plus the wallet hardware transfer milestone before any dApp hardware path.

## Verification snapshot

- `createInitialProductChainRegistry('mainnet'|'testnet')`: product-definition regression constructs both networks and passes after the runtime-family fix.
- `pnpm test`: 2,546 passed, 0 failed after the dApp-provider and default-enable changes.
- `pnpm --filter @noir-wallet/extension run type-check`, `pnpm --filter @noir-wallet/sdk run type-check`, `pnpm --filter @noir-wallet/example run type-check`, `pnpm build:extension`, `pnpm --filter @noir-wallet/sdk run build` and `pnpm exec eslint` on the changed extension sources: passed.
- `pnpm knip --workspace @noir-wallet/extension --include files`: no unused files after deleting the unused Esplora-shaped `pearl-blockbook-history-model.ts` and unused `AddressSelector.tsx`.
- Pearl-enabled isolated MV3 (`pnpm test e2e pearl-testnet`), physical hardware and funded on-chain transactions: not run. The spec exists but no funded test wallet or explicit transaction authorization was supplied.
- Blockbook status reads for both networks returned `coin: Pearl` (Mainnet) and `coin: Pearl Testnet` (Testnet, `backend.chain: testnet`) with `inSync: true`; address history includes `vin[].txid`/`vout`. These are connectivity/shape checks, not transaction acceptance.
