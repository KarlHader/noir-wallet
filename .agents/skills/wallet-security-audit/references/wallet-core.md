# Wallet core

Apply these questions to the discovered implementation. Establish the invariant, attacker entrypoint, downstream guard, and observed result for each important path; do not merely inventory API names.

## Keys and authentication

- Locate actual entropy sources, mnemonic/seed generation, derivation libraries and paths, import formats, and account identifiers. Verify entropy errors fail closed and derivation agrees with supported recovery tools or published vectors. Identify custom cryptographic code and library modifications.
- Distinguish spending, viewing, session, device, and watch-only capabilities. Trace where secret material is generated, copied, decrypted, retained, passed to workers/hardware, exported, and discarded. UI hiding or biometric success is not evidence of cryptographic access control.
- Inspect encryption and authentication together: KDF parameters and migration, random salt/nonce generation and uniqueness, authenticated context, corruption handling, password change, and backup compatibility. Assess offline attack cost under an explicit storage-theft assumption. Do not invent universal KDF thresholds detached from platform and password assumptions.
- Check all secret access paths during lock, timeout, restart, wallet/account deletion, backup, password changes, and hardware disconnect. Trace session credentials and stale contexts, including pending approvals and work already queued. State memory-erasure limits of managed runtimes separately from actionable leaks.
- Check recovery against persistent state: mnemonic/passphrase and derivation, account indices, network, birthday/scan bounds, imported private keys, hardware paths, and migration versions. A successful new-wallet flow does not demonstrate existing-wallet recovery.

## Authorization and signing

- Model permissions as the implemented combination of origin/sender, wallet, account, chain/network, method, and session. Check both approval creation and sensitive execution after every relevant asynchronous boundary. A previous permission check does not cover later lock, revocation, account switching, or deletion.
- Trace user-visible review to the final bytes or digest signed. Check recipient resolution, amount/unit, asset identifier, fees, change, memo/calldata, network, signature domain, and any server-provided transaction. Determine whether mutation or substitution is possible after confirmation.
- Inspect generic message, typed-data, raw-transaction, batch, and hardware signing separately when present. Determine replay scope and whether a seemingly harmless signature can authorize a spend or account change.
- For hardware/offline signing, verify device/account/path identity, transaction decoding, display limitations, returned signature validation, request correlation, QR/UR parsing bounds, cancellation, and stale responses. Host-side tests do not establish device display or firmware behavior; record hardware model/app/firmware for actual checks.

## Money and transaction lifecycle

- Trace amounts across UI parsing, unit conversion, serialization, APIs, and persisted records. Check integer precision, decimals, negative/NaN/infinite values, overflow, rounding, and Max calculations using destination- and funding-source-specific spendability.
- Identify ownership of nonce/UTXO/note reservation and concurrent operation coordination. Analyze double submission across windows, dApps, workers, accounts, and retries. Validate idempotency under delayed responses and ambiguous broadcast outcomes.
- Trace build → approve → sign → broadcast → local record → monitor → confirm/expire/replace/reorg. Check crash windows and whether recovery can duplicate a payment, lose its record, downgrade a terminal state, or show a failed transfer as settled.
- Distinguish total, pending, confirmed, spendable, reserved, locked, and watch-only balances. Check stale cache invalidation and whether failures look like a genuine zero balance. Track network/wallet/account scope throughout cache and persistence.

## Persistence and adversarial data

- Examine atomicity, Web Locks or equivalents, journal replay, schema migration, corruption recovery, deletion tombstones, and stale writers. Verify interrupted upgrades preserve credentials and transaction records; ensure sync recovery cannot resurrect deleted wallets.
- Follow malformed or oversized import files, URIs, QR payloads, names, metadata, memos, and database records. Check parsing limits, duplicate/unknown parameters, encoding, network binding, and downstream behavior. Test boundaries with bounded synthetic inputs.
- Treat remote nodes, fee/price/quote services, registries, and indexers according to what the wallet actually validates. Check missing, stale, reordered, conflicting, duplicated, and oversized responses; TLS/origin rules; HTTP downgrade; timeout/retry/failover behavior; cancellation; and CPU/memory/disk budgets.
- Separate an expected server-trust limitation from an implementation defect, such as bypassing a validation the wallet promises or already attempts. Describe the same trust limitation once and link its affected flows.
