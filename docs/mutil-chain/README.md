# Multichain Maintenance Reference

The extension separates UI, Background orchestration, chain adapters, and wallet computation. See [project architecture](../../AGENTS.md#architecture), [network mode](../../AGENTS.md#global-network-mode), and [state and security](../../AGENTS.md#state-persistence-and-security) for the maintained boundaries.

Chain availability comes from the product registry, enabled feature flags, and runtime capabilities. A chain identifier or adapter alone does not establish that every wallet type supports every operation. Global Mainnet/Testnet Mode applies to all enabled chains; accounts, transactions, caches, RPC settings, and explorer selections remain partitioned by network.

## Reference Guides

- [Transaction lifecycle and Activity](architecture/transaction-lifecycle.md): local transaction ownership, lifecycle transitions, remote history, cache fallback, and reconstruction.
- [Confidential DeFi development](operations/private-defi-development.md): Main, private execution, abstract balances, configuration, and recovery.
- [UI design conventions](design/ui-design-system.md): production tokens, components, viewport sizes, and design-to-code review.
- [Test-wallet registry](operations/test-wallet-registry.md): public unfunded vectors, private fixture formats, and local verification boundaries.
- [Release runbook](../release-workflow.md): local versus release inputs, History proxy deployment, and artifact verification.

## Implementation Sources

- `packages/extension/src/core/chains/`: chain identifiers, product definitions, asset registry, and capability policy.
- `packages/extension/src/core/zcash/`: Zcash transaction rules and shared private-broadcast contracts and validation.
- `packages/extension/src/core/keyring/`: internal command protocol and wallet computation ports.
- `packages/extension/src/infrastructure/keyring/`: command clients and credential persistence.
- `packages/extension/src/core/transactions/`: scoped transaction graphs and lifecycle rules.
- `packages/extension/src/core/activity/` and `src/infrastructure/activity/`: Activity projections, aggregation, and supplemental history.
- `packages/extension/src/config/`: bundled values, configuration parsing, and simple accessors. Runtime contracts belong to their domain modules; persisted settings and cache keys belong to their persistence modules. Managed RPC pools belong to the remote registry.

The Background account-network catalog keeps Storage V2's Zcash identity unchanged and projects the current shielded receive selection from retained wallet metadata for the same wallet, account, and network. Rotation and selection of a historical address use that same selection; the Addresses page refreshes when it changes.

Zcash settings reads the registered account derivation path for software and hardware accounts. The transparent address path is shown only when WASM has supplied the child index for that same network's primary transparent receiver; shielded address rotation does not change this index. Unknown indexes are not assumed to be zero.

The public dApp API belongs to the independent [SDK](../../packages/sdk/README.md) and [published provider guide](../../packages/docs/content/docs/developers/provider-api.mdx). Internal plans and historical review records are kept outside this public reference.

## Ledger Hardware

The V2 Ledger implementation registers EVM, Bitcoin BIP-84, Solana, NEAR, and Zcash exports in a version-3 hardware credential. Each export retains its actual device path and public key; Bitcoin also retains its xpub and master fingerprint, and Zcash retains its UFVK. A logical wallet account index does not imply a device derivation path. Existing version-2 Ledger Zcash credentials remain readable and are upgraded when extending the same wallet.

The connect tab permits only chains enabled in the current build and marks deferred choices as **Coming soon**. See the [release runbook](../release-workflow.md#verification-and-build) for the default build scope. It can create a wallet without Zcash, or add chain exports and accounts to an existing KeyDomain. After device selection, the wallet requests the required App automatically and shows device interaction prompts without an extra browser confirmation step. In explicitly enabled verification builds, EVM, Bitcoin, Solana, and NEAR candidates are read in pages of five within one device session per page; only selected accounts are then confirmed and registered. EVM offers Ledger Live, standard BIP44, and legacy paths; Solana offers standard, legacy, and Ledger-root paths; NEAR offers final-index paths and the existing Noir path layout. Advanced controls select the first device index. Changing presets does not change previously registered paths.

Bitcoin imports a BIP84 account root, not separate wallets for each address under one xpub. Discovery, receive/change derivation, and PSBT signing use the registered root even when its device index differs from the Noir account index. Candidate activity checks examine the first receive address and do not claim an xpub account balance. After import, the existing gap-limit scanner discovers both receive and change branches; Ledger balances and input selection include those scanned children, and change uses a reserved address under the same root. Existing address-only Ledger checkpoints continue scanning without discarding their observations. EVM balance previews use the active EVM network, and unavailable RPC reads do not hide candidates or prevent import.

The retained Zcash runtime still permits one Zcash account per Ledger wallet; additional EVM, Bitcoin, Solana, and NEAR accounts are independent of that limit. Extending a wallet requires a fresh export of a registered public anchor from the connected device. Names and legacy zero-valued fingerprints do not establish device identity. Provisioning uses the credential transaction journal and Storage V2 generation pointer; retained Zcash data continues to use the same wallet and account identifiers.

Device interaction runs in a full extension tab. Background code retains the reviewed payload, checks account and authorization bindings, verifies returned signatures, and broadcasts transactions. Locking, account or network changes, disconnecting a dApp, expiry, and closing the signing tab cancel outstanding device requests. Wallet transfer records can be continued by the user after a service-worker restart while their original approval remains valid; interrupted dApp calls must be initiated and approved again. An unsigned RHEA swap also requires a fresh quote and preparation after a restart. Solana blockhash expiry requires a new preparation and approval.

Zcash signing preserves a retained V1 USB/Bluetooth preference. A later successful device signature saves the selected transport in wallet-scoped settings, which take precedence over that retained preference. Bluetooth is offered only for a compatible recorded device model; other models use USB.

Shared device-signing contracts and boundary validation live in `src/core/keyring/protocol/ledger-signing.ts`; transport and vendor SDK adapters live in `src/lib/ledger/`. Credential provisioning and persistence belong to `src/infrastructure/keyring/`, with background orchestration in `src/background/hardware-wallet-provisioning.ts`. Popup pages delegate device and runtime interactions to `src/popup/services/`; the shared provisioning client is `hardware-provisioning-client.ts`.

EVM adapters implement transaction, personal-message, and EIP-712 signing. Bitcoin adapters implement own-input PSBT signing and BIP-322 simple with the existing `smp` response format; BIP-322 requires Bitcoin App 2.1.3 or newer and displays a zero-value device transaction. Mainnet uses the `Bitcoin` device App and Testnet uses `Bitcoin Test`; the adapter requests and verifies the network-specific App before exporting or signing, then disables the Bitcoin SDK's automatic App switching to preserve that choice. Solana implements legacy/v0 transaction signing and preserves other signatures; Ledger accounts do not advertise ordinary `signMessage`. NEAR implements transaction and NEP-413 signing.

Main-mode Swap uses the same Ledger transaction adapters and supports EVM ERC-20 approvals and Mainnet RHEA EIP-712 orders. An ERC-20 approval is recorded as a separate transaction; return to Swap for a fresh quote after it confirms. Persisted signed EVM orders can retry submission after a restart without signing again, including after quote expiry. Confidential DeFi and Lending remain outside this hardware scope.

These implementation paths require physical-device acceptance before being described as delivered hardware support. USB/Bluetooth exports, four-chain Testnet transactions and dApp signatures, refusal/disconnection, and the Zcash PCZT regression have not been verified on a physical Ledger.
