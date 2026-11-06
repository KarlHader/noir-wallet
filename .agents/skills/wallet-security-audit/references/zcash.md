# Zcash investigation

Determine actual pools, key types, address families, network modes, signing paths, and wallet-library features from the pinned source and packaged component. Do not infer pool support, viewing capability, or privacy from an address label alone.

## Standards and component boundary

Use the [Zcash protocol specification](https://zips.z.cash/protocol/protocol.pdf), [ZIP index](https://zips.z.cash/), and the actual library's source/contracts as primary starting points. Relevant topics may include ZIP 32 derivation, ZIP 316 Unified Addresses/keys, ZIP 321 payment URIs, fee rules, and the target network's active upgrades. Retrieve the applicable revision/status and activation conditions during the audit; do not freeze “current” protocol requirements in this skill.

Record the Rust/SDK/WASM source revision, forks/patches, enabled features, generated bindings, and shipped binary hashes. A lock-file source claim plus matching file hashes establishes neither reproducible provenance nor a full audit of the underlying proof system. Inspect matching source where available; isolate any unavailable source or correspondence proof as a coverage limitation.

## Keys, addresses, and payment requests

- Verify mnemonic/seed handling and the actual transparent and shielded derivation schemes, account isolation, viewing/spending capability separation, and recovery compatibility. Inspect entropy across JS/WASM boundaries and error propagation.
- Check Transparent, Sapling, Orchard, and historical paths only where supported. Trace Unified Address decoding, checksum/network validation, receiver selection, unsupported receivers, and any fallback. Determine when the chosen funding pool or receiver changes privacy.
- If payment URIs, QR codes, or deep links exist, trace ZIP 321 amounts, indexed recipients, memo encoding, required/unknown and duplicate parameters, malformed percent encoding, and total payment limits through review and signing. Do not mark absent multi-recipient support as a protocol defect without checking required handling.

## Scanning and consensus-facing state

- Trace compact block/transaction retrieval, trial decryption, notes, nullifiers, commitments, witness/anchor selection, and tree checkpoint persistence. Identify data actually checked locally versus assertions trusted from lightwalletd/indexers.
- Check birthdays, interrupted scans, rescans, account discovery, inconsistent height/hash/tree responses, reorg rollback, expiry, and confirmation policy. Investigate missing or duplicated funds and stale spendability across restart or database recovery.
- Confirm network, consensus branch/transaction version, upgrade activation, and parameter selection along construction, fee estimation, hardware signing, and broadcast. Verify behavior near supported activation boundaries with matching implementation evidence.

## Spending and privacy

- Trace note/UTXO selection and reservation, change receivers, fees, shielding/unshielding, cross-pool migration, Max, and unavailable anchors. Confirm total or shielded balance is not substituted for route-specific spendability.
- Analyze dust, consolidation, amount/timing linkage, transparent change, address reuse/rotation, and transaction structure. Separate inherent public-chain observations from avoidable implementation leakage.
- Map transparent address queries, viewing-key exports, scan heights/birthdays, transaction/memo fetches, broadcast, failover, and any compact-block CDN or private-broadcast service. Establish which parties can join requests by IP, timing, identifiers, or shared infrastructure.
- Validate privacy settings across normal, retry, fallback, and error paths. TLS protects transport; shielded transactions protect specific on-chain fields. Neither establishes anonymity from the wallet's service providers.

Review the extension/library integration even when using mature cryptographic libraries. Clearly bound any review of custom cryptography or proof-system internals; do not claim formal verification from integration tests.
