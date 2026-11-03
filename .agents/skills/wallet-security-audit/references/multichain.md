# Multichain and cross-chain investigation

Select only implemented/reachable chain and feature sections. Check build gates, exported providers, runtime registration, and production variants; installed dependencies or directories alone do not prove support. For other chains, derive equivalent checks from their official specifications and the wallet's actual library contracts.

## Shared boundaries

- Establish canonical chain/network and asset identities, derivation/key families, and account capabilities. Check ambiguous identifiers, imported-key restrictions, token decimals, custom network/RPC configuration, and cross-chain address confusion.
- Trace chain/account switching through dApp sessions, approval queues, signing, caches, balances, background jobs, and transaction history. Check every operation against its original authorized chain/account, including delayed and retried work.
- Examine shared signer abstractions: whether they preserve chain-specific signature domains, transaction validation, fees, review requirements, and hardware restrictions. Do not copy a generic “signed successfully” assertion across all adapters.
- Map address/account correlation across portfolio, price, history, RPC, analytics, bridge, and swap services. Consider shared device/session identifiers and batching across otherwise separate chains.

## EVM

- Inspect chain ID verification, custom RPC consistency, account/nonce binding, transaction types, fee/gas fields, replacement/cancellation, and pending nonce recovery. Verify actual signing serialization rather than relying solely on simulation output.
- Trace supported personal/raw/typed-data signatures, domain separation, replay boundaries, and permissions. Inspect token approvals, permits or delegated authority when reachable; determine the real spender, asset, amount, deadline, and scope visible in review.
- Decode destination, value, calldata and batch calls for supported paths; inspect swaps and server-provided transactions for substitutions. Check malicious token metadata, decimals, RPC results, and simulation disagreement. Load account-abstraction or delegation-specific requirements only if implemented.

## Bitcoin and other supported UTXO paths

- Verify network/address/script types, derivation, input ownership, prevout amounts/scripts, change detection, fee rate versus absolute fee, dust, coin selection, and UTXO reservation.
- For PSBT or analogous partial signing, inspect unknown fields, supported sighash modes, requested inputs, output mutation, finalization, and device review. Determine whether the wallet can sign unrelated inputs or disguise external outputs as change.
- Trace unconfirmed ancestry, replacement/fee bump, conflicting spends, reorgs, and restoration/discovery gaps. Separate indexer trust from local transaction validation.

## Solana

- Inspect supported legacy/versioned transactions, message decoding, instruction/program interpretation, fee payer and signers, address lookup table resolution, and review-to-message binding.
- Check blockhash expiry, durable nonce if supported, retry semantics, partial signatures, account ownership, token program/asset identification, decimals, and simulated versus signed behavior. Treat RPC-supplied lookup or simulation data according to actual validation.

## NEAR

- Inspect account identity and supported full-access/function-call key capabilities, access-key changes, receiver/actions, method and allowance restrictions, attached deposit, gas, nonce, block hash and signature scope.
- Check action batches, account creation/deletion, key persistence/revocation, message signing, intents, and restart/retry behavior only where implemented. Determine whether review exposes the authority actually granted.

## Swaps, bridges, intents, lending, and private funding

- Follow quote/request creation → approval → signed payload → source-chain spend → relay/solver processing → target-chain settlement/refund. Bind all stages to the intended wallet/account, networks, assets, receiver, amount bounds, fees, slippage, deadline, and quote/order identity.
- Treat API-provided destinations, calldata, instructions, approvals, deposit addresses, and status responses as untrusted. Determine which are independently checked against the user's confirmed intent and whether refreshing a quote can change that intent.
- Test ambiguous broadcast, partial completion, duplicate callbacks, timeout, restart, replacement, refund, and stale polling. Source-chain confirmation alone does not establish delivery to the intended recipient on the target chain.
- Identify custody, admin/upgrade authority, solver/bridge trust, oracle dependence, and unavailable external contracts. Audit the wallet integration and describe external boundaries; do not imply deployed contracts or third-party infrastructure were fully audited without evidence.
- For lending, verify market/asset/recipient binding, approvals, collateral and borrow/repay units, oracle freshness and failure handling, stale positions, and liquidation information relied on by the operation. Record account scoping and concurrent refresh behavior.
- Trace public-chain legs and service metadata in private funding or shielded-to-public flows. Compare observed disclosures and fallback behavior with product claims, including destination account linkage.
