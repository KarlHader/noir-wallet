# Transaction Lifecycle

The V2 transaction model represents a product action as one `TransactionRoot` with ordered `TransactionSegment` records. The domain model and parsers live in `packages/extension/src/core/transactions/domain/`; the repository contract and production IndexedDB implementation live in `src/ports/repositories/` and `src/infrastructure/persistence/repositories/`, respectively. Zcash V1 transactions remain authoritative for Zcash; the shared Activity read model combines them with V2 graphs and supplemental history.

## 1. Root and Segment

```text
TransactionRoot
├── scope: KeyDomainId + AccountId
├── kind and lifecycle status
├── optional immutable intent snapshot
├── ordered segmentIds
└── optional retry/replacement relation

TransactionSegment
├── role: origin | relay | destination | refund
├── target: onchain | relay | protocol
├── requiredForFinality
├── dependsOn and lifecycle status
└── evidence: hash/reference/block/confirmations
```

A Root is one complete intent, such as Transfer, Swap, Supply, or Withdraw. Before `prepared`, a new transaction persists a `TransactionIntentSnapshot v1` with direction, source and counter-asset amounts, fee ceiling, and available sender and recipient. Amounts use CAIP-19 `AssetId` and base-unit integers; later RPC responses must not be used to reconstruct the original intent. RHEA Swap counter amounts retain quoted token display metadata for assets absent from the current wallet catalog; older bindings without it remain valid. The snapshot remains attached to its Root. RPC observations update Segment evidence and lifecycle only. An older V2 graph without a snapshot is marked `partial` in Activity; missing fields are not invented.

A Segment is an independently submitted and recoverable on-chain transaction, relay, or protocol-position outcome. A `protocol` target applies only when the protocol itself supplies a final outcome without a separate destination-chain transaction, such as a RHEA Supply position in an existing MCA. Swap and Withdraw must still wait for the applicable destination hash and finality. Each on-chain Segment binds its own `ChainId`; a cross-chain Root has no single chain ID. Segment dependencies point only to earlier entries in stable `segmentIds` order. `requiredForFinality = false` is reserved for supplementary segments such as refunds and diagnostics.

## 2. Lifecycle States

| State        | Meaning                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `created`    | Intent exists, but the final signable payload does not.                                                         |
| `prepared`   | Final payload, summary, and fingerprint exist.                                                                  |
| `approved`   | The user or an authorized policy approved that same summary and payload.                                        |
| `signed`     | A signature exists, without proof of successful broadcast.                                                      |
| `broadcast`  | A chain node or relay accepted submission and supplied a transaction hash or external reference.                |
| `confirming` | Mempool, block, or protocol progress was observed, but adapter-defined finality has not been met.               |
| `final`      | The Segment met adapter-defined finality; the Root is final only when every required Segment is final.          |
| `failed`     | Definitive failure evidence exists. A transient network error, Worker timeout, or failed query is insufficient. |

The usual progression is `created → prepared → approved → signed → broadcast → confirming → final`. Import or recovery may skip locally missing observations, such as `created → confirming`; that does not imply the intervening business actions did not happen.

- `final` and `failed` never reopen. Same-state updates may add evidence but cannot change the transaction hash, external reference, or required confirmation count.
- Ordinary progress cannot change an included block hash or height or reduce confirmations. An explicit `reorg` event may move a nonterminal `confirming` Segment back to `broadcast` and replace or clear its inclusion evidence.
- Late reorg or poller results cannot downgrade a terminal record. An anomaly after finality requires a separate reconciliation or incident process.
- `failed` requires a structured failure code and time. Timeout is not a failure code because it does not prove transaction failure. `unknown` is reserved for migration of V1 failures without a recorded reason.
- EVM finality is checked against the RPC `finalized` block, including reverted receipts. A reverted but unfinalized receipt remains `confirming`. One null `eth_getTransactionReceipt` response is not proof of a reorg; the same RPC must also show the original hash as pending through `eth_getTransactionByHash` before old inclusion evidence is cleared. Unknown or still-included results leave the current state unchanged.

EVM preparation adds a 20% gas-limit margin, rounded up, to ERC-20 transfers, contract calls, and native transfers with estimates above 21,000. Plain 21,000-gas native transfers keep that estimate. The padded limit is used consistently for the funding check, signed payload, and maximum fee shown in review. Gas estimation and this reserve cannot guarantee success after arbitrary contract-state changes. Native EVM Max additionally leaves 25% of the prepared maximum network fee in the source account as balance headroom; this does not increase the signed fee or the fee shown in review. RHEA routes keep their amount and calldata bound to a fresh quote. A smaller fee probe may first calculate Max, after which re-quotes only reduce it when needed. An insufficient-funds result during preparation can trigger a bounded lower-amount re-quote before review; repeated failures surface to the user.

## 3. Events and Concurrent Updates

Roots and Segments carry a `revision`, `updatedAt`, and `lastEventId`. Event IDs are opaque product IDs, not RPC request IDs. An observation older than the recorded `observedAt` cannot replace newer state. A Segment hash or reference binds its identity; later pollers cannot substitute another transaction. A block change, vanished receipt, or lower confirmation count needs an explicit reorg source.

Each repository mutation checks both Root and target Segment revisions and reconciles the Root in the same write. It also retains the full processed event ID/fingerprint history: an identical replay returns duplicate, while a reused ID with different content returns conflict. Domain idempotency alone does not provide persistence-level concurrency control.

Only required Segments contribute to Root status. Any required failure fails the Root; all required final Segments finalize it. A final Segment contributes `confirming` progress while another required Segment is pending. Otherwise the highest nonterminal required progress applies. A planned, unstarted Segment cannot regress the Root's own pre-broadcast progress. A nonterminal reorg downgrade needs explicit caller permission; terminal Roots never downgrade.

## 4. Cross-Chain Graphs

A single-chain Transfer or Shield has one required on-chain origin Segment. Broadcast does not mean confirmed; adapter-defined finality moves the Segment and Root to `final`.

A wallet-owned EVM or Bitcoin source Supply or Swap uses a required origin, Intents relay, and destination, plus an optional origin-chain refund. Before source preparation and review, persist the exact Intents quote binding in the V2 graph: source asset and base-unit amount, deposit and refund addresses, destination asset and recipient, minimum receive, and deadline. Those values cannot change during confirmation. The source-chain monitor advances the origin; the Near Intents monitor advances relay, destination, and refund.

For Supply, protocol `SUCCESS` proves arrival in the target MCA; a persisted deposit reference can finalize a protocol destination even without a separate destination transaction hash. Swap needs a destination hash before its destination reaches finality. Zcash destinations also wait for existing spendability confirmations. Existing Zcash-source Supply and Swap continue through their V1 transaction and monitoring path.

Withdraw, Claim, and Zcash-destination Swap use required origin, relay, and Zcash destination Segments. Relay `SUCCESS` finalizes only the relay; the Root remains `confirming` until the destination has sufficient confirmations. The V2 graph does not use a combined `relay_confirmed` state.

A refund is an optional Segment on the original failed Root. It can keep progressing without changing that failed intent to success. Present the original failure and refund progress separately.

## 5. Retry, Replacement, and V1 Records

A terminal Root is never reopened. A retry creates a new Root with a `retry-of` relation; a wallet-initiated Speed Up, EVM replacement, or Cancel creates a new Root with `replacement-of`. A refund is an optional Segment of the original Root, not a retry.

Standard EVM JSON-RPC can query known hashes but cannot prove that a null result was replaced by another sender/nonce transaction or dropped. Wallet-initiated replacements can record their relation when created. Detecting an external replacement requires a privacy-reviewed indexer or txpool source that proves sender and nonce identity. Until then, monitors must not guess replacement or failure from a missing receipt.

| V1 state          | V2 interpretation                                                                     |
| ----------------- | ------------------------------------------------------------------------------------- |
| No record         | V2 persists `created`, `prepared`, `approved`, and `signed` for new transactions.     |
| `pending`         | `broadcast` with broadcast evidence; `confirming` with chain or relay observation.    |
| `confirming`      | The on-chain Segment is `confirming`.                                                 |
| `relay_confirmed` | The relay Segment is `final`; the Root is usually still `confirming`.                 |
| `success`         | Root `final` only with final evidence for all required Segments.                      |
| `failed`          | Map the recorded reason; historical records without one use migration-only `unknown`. |

A V1 status string alone cannot construct a complete graph. Migration also needs its type, hashes, deposit address, and quote binding. Keep unproven data in V1 rather than fabricating V2 evidence. The Zcash adapter maps V1 records into Activity without writing them back to V2 or changing their original status handling.

## 6. Local-First Activity Merge

`ActivityCoordinator` obtains the sole `KeyDomainId + AccountId` partition from the active Storage V2 pointer and merges these sources in Background:

1. Zcash uses V1 IndexedDB records and retains its existing behavior and detail entry point.
2. Non-Zcash transactions initiated by the wallet use Transaction V2 graphs. The immutable snapshot determines assets, amounts, and participants; RPC evidence determines hash, block, confirmations, and finality.
3. RPC and indexer records supplement external history absent locally. Deduplicate by `chainId + transactionHash`; EVM RPC item and Segment IDs include chainId so identical hashes on different chains remain distinct.
4. Source priority is `zcash-v1 > wallet-v2 > rpc`. A Zcash shadow graph cannot displace its V1 display, and incomplete RPC data cannot overwrite an authoritative local wallet record.
5. Hexadecimal hash deduplication is case-insensitive for EVM and BIP122. Other namespaces retain native case semantics.
6. Chains whose standard RPC lacks complete address history require an explicitly integrated trusted indexer. Wallet-originated records must not be described as complete on-chain history.

Zcash history refresh publishes local records before looking up missing send recipients. Recovery accepts only one external transparent destination whose aggregate output value equals the recorded send amount, excluding the wallet's known transparent addresses. Known recipients survive later WASM refreshes; ambiguous or shielded destinations remain unavailable. Confirmed transaction bodies are reused, and concurrent receive-history and recipient-recovery writes merge atomically in the network/Wallet/Account cache. Lock, account removal, wallet purge, and network changes cancel recovery and prevent late recipient writes.

Unmined WASM records without a timestamp keep their first locally observed time across refreshes. Expired local Zcash sends retain their funding pool and offer Speed Up from Activity; replacement hashes, recorded fees, and available memos remain attached to the original record. Software send and shield construction reserve expiry blocks relative to the current node tip, within the bound in `src/core/zcash/transaction-expiry.ts`; a wallet further behind must sync before constructing a transaction.

Wallet snapshots reject empty serialization before writing and atomically replace their manifest and chunks. Reads inspect quarantine, manifest, and chunk bytes in one committed transaction; confirmed corruption remains available for explicit recovery. Spendability recovery reloads a persisted snapshot and requests catch-up without deleting wallet data. Confirmed-transaction catch-up shares the wallet's sync scheduler. Passive sync may use a persisted watch-only snapshot while locked or with no UI open, without restoring signing credentials; polling uses backoff, jitter, and a bounded scan budget from `src/config/wallet.ts`.

The shared `zcash-wallet-db` schema is version 9 and upgrades V1 version 8 in place, retaining wallet data and write fences. Deletion persists tombstones before removing credentials and prevents stale contexts from restoring account data. Removing one account discards the shared WASM snapshots and sync journals on both networks after stopping the worker; retained accounts keep their credentials, addresses, birthdays, and account-scoped history and rebuild their scanned state from those inputs. Startup also resumes V1 `wallet_cleanup_pending_ids`: committed deletions finish cleanup, while a pending operation with intact wallet metadata and no deletion tombstone is rolled back. Missing or inconsistent recovery metadata leaves the pending marker intact and fails initialization rather than guessing which credentials to remove.

The Popup reads only the current account through trusted `GET_ACTIVITY`. Content scripts cannot specify Account scope or enumerate partitions. `createConfiguredActivityHistorySources` selects adapters; Background uses one aggregation and local fallback path, while each adapter still contacts its configured source:

| Chain / network            | History source                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| EVM supported by Ankr      | History Worker → Ankr Advanced API                                                             |
| Arbitrum Sepolia           | Configured Blockscout directly                                                                 |
| Bitcoin Mainnet / Testnet3 | Configured Esplora directly, with custom RPC, network checks, and managed endpoint failover    |
| Solana Mainnet / Devnet    | Configured Solana RPC directly, with custom RPC, network checks, and managed endpoint failover |
| NEAR Mainnet               | FastNear transfers indexer directly                                                            |

EVM chains without an approved source and NEAR Testnet use cache and local records. Adapters provide bounded recent history, not complete account history. Bitcoin, Solana, NEAR, and Blockscout do not consume the History Worker's Ankr quota or rate limiter. For deployment and build configuration, see the [History proxy release procedure](../../release-workflow.md#history-proxy-deployment).

When supplemental refresh fails, return the account's persisted RPC cache and readable authoritative local transactions. A locked software wallet or failed derivation can recover one unique Private address from the current account's public Main address and persisted signers of EVM origin transactions. Exclude other accounts, non-EVM records, inbound senders, and conflicting candidates. Main-to-Private transactions remain assigned to Main; cancellation still verifies account ownership through the signer. Account partition, local-storage, and address-type filtering failures must surface as errors rather than empty history. The Popup shows local data and cache before refreshing remotely and keeps them visible if refresh fails.

EVM history and sync cursors are partitioned by `KeyDomainId + AccountId + chainId + address` in `noir-wallet-evm-history-cache`. Background combines those address records with Storage V2's public Main address without needing Private address derivation for cache reads. Bitcoin, Solana, and NEAR use `noir-wallet-activity-history-cache`, partitioned by network, Account scope, and current Bitcoin address type. The supplemental merge window holds at most 10,000 entries, while each EVM address cache retains up to 2,000. Activity merges supplemental history with up to 200 local graphs and the current Zcash V1 records and returns at most 2,000 items, with an optional `hasMore` flag for truncated or remotely paginated results. The Popup displays 50 rows initially and reveals retained history with Load more; display limits do not delete authoritative transactions. The caches retain independent refresh and fallback behavior.

Zero-value ERC-20 Transfer events do not create asset-movement rows in supplemental EVM history. This filtering applies to fresh indexer results and persisted RPC cache reads. Nonzero transfers, approvals, contract calls, native-asset transfers, and authoritative local wallet records remain eligible for Activity.

Supported EVM chains query the History Worker's root path with POST JSON-RPC. Each address refresh calls `ankr_getTransactionsByAddress` with a string address and `ankr_getTokenTransfers` with an address array; both pass an explicit `blockchain` array. Split results by chain before caching. If a truncated shared first page contains no records for one chain, make a bounded single-chain follow-up. An explicit Load more request may increase `historyPageCount` from 1 through 10. Deeper requests fetch the selected chain and address from the first page, following independent native-transaction and token-transfer cursors up to that depth. Regular incremental refreshes and failures retain previously loaded older rows. Incomplete pagination, partial failures, and outages cannot clear the current address cache. Full history links remain available for a selected chain. Unsupported chains use their configured indexer.

Old beta RPC History caches are cleared and fetched again, including `activity_history_cache_v2:*` Chrome local keys, obsolete IndexedDB schema or mode partitions, mixed-EVM projections, and EVM items without Account scope or chainId in their IDs. Wallet credentials, Zcash WASM data, and authoritative local transactions remain. Account deletion and Wallet Reset clear both supplemental caches and legacy Chrome keys.

## 7. Persistence and Recovery

Zcash software sends and shielding pass the original transaction ID to Offscreen. A complete Worker result updates that existing account-scoped record before snapshot persistence, including results arriving after the RPC timeout. Background reuses the existing monitors; this does not add submission phases, restart replay, or matching of legacy empty-hash records.

`TransactionRepository` provides scoped `create()`, `get/list()`, `applySegmentEvent()`, and `deleteByAccountScope()`. Creating the same graph twice is idempotent; reusing a TransactionId for a different graph returns `id-conflict`. Reads require `keyDomainId + accountId`; listing may filter by on-chain ChainId and Root status. No unscoped global read is permitted. Account deletion removes only that partition and its chain/event indexes.

The in-memory repository is for reference tests. The production `IndexedDbTransactionRepository` commits graphs, event fingerprints, and scope/chain/status indexes in one `noir-wallet-transactions-v2-db` transaction. After restart it restores deduplication from the event store, not only `lastEventId`. Graph/event limits, query limits, corrupt records, and inconsistent indexes fail closed.

EVM and Bitcoin monitors resume active-account graphs after Service Worker reconstruction. Concurrent pollers use revision checks so an older observation cannot reopen a Root another poller finalized. EVM `signed` advances to `broadcast` only after `eth_getTransactionByHash` confirms the same hash. Missing receipts, reorgs, finalized blocks, and reverted finality use the domain event/CAS path; unknown queries and transient RPC failures wait for another poll. Near Intents monitoring resumes Swap/Supply graphs by persisted deposit address and checks origin/destination protocol assets. `REFUNDED` completes the optional refund and fails the required relay; `FAILED` fails the relay; `SUCCESS` finalizes the relay and advances the destination only with the evidence described above.

The RHEA Swap monitor also restores pending Zcash V1 swaps from their account-scoped local transaction and persisted quote binding after a Service Worker restart. Restoration requires the prepared quote session; an absent or invalid session cannot be reconstructed from the transaction alone and leaves the local transaction pending for reconciliation. The monitor records the source hash again idempotently, retries protocol reporting from persisted submitted sessions, and updates the original transaction on a definitive order result. When a completed order sends ZEC to an existing Mainnet account, the monitor persists a wallet catch-up request before making the transaction terminal. It starts an immediate scan only for the active account; other accounts catch up when selected. The scan does not delay the completed status, and a failed catch-up remains eligible for the existing sync retry path. Report delivery does not delay local terminal status. Failed reports remain queued across restarts, including after a V2 graph reaches a terminal state; a successfully reported terminal session is discarded. Startup and alarm failures retain a retry alarm, and one chain's signed-order recovery failure does not block the others or monitor polling. Account deletion discards sessions bound to its transaction graphs and pending monitors before removing those graphs, preserving other accounts. Unbound draft quotes expire within 30 seconds and remain until explicitly discarded or reset. Wallet Reset clears the monitor and persisted RHEA quote sessions, including pending reports.

Before a Zcash Swap enters the WASM transfer or PCZT prove-and-send operation, Background checks its deposit address, base-unit amount, and execution ID against the persisted prepared quote. The Worker checks the quote deadline after queued work and prerequisite reads, before entering WASM. Hardware signing does not extend quote validity: an expired unsigned transfer requires a new quote and review. These checks do not interrupt a WASM operation already in progress or reverse a broadcast transaction.

EVM review persists the TransactionId, Account scope, prepared payload, immutable SigningSummary, signing command ID, fingerprint, and deadline as one exact `chrome.storage.session` record. UI receives the graph, summary, fingerprint, and deadline but not the internal command ID. On approval, Background revalidates the active ChainAccount, canonical WASM payload fingerprint, graph, and pending nonce before consuming the one-time signing command. A Service Worker restart after approval can restore and reconfirm the same review without generating a new payload. After signing, persist a recovery record for the same raw transaction and hash before broadcast. An uncertain RPC response permits rebroadcast of that exact raw transaction or a hash lookup, never another signature. The recovery record is removed after node acceptance; the graph keeps the hash and lifecycle. External messages cannot supply ChainAccount, scope, custom calldata, or signing command ID. Asset selection must match the active network. The staging Activity resume action accepts only the original Transaction ID for a complete local single-Segment EVM signed transfer and must rebind the returned graph to its original account, snapshot, target, hash, creation time, and monotonic update time.

Approved Ledger and Keystone EVM/Bitcoin transactions expose their validated account scope and original signing summary through the external-signing request. The pending-review endpoint remains restricted to the approval stage.
