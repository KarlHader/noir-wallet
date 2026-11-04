# Changelog

All notable user-facing changes to Noir Wallet are documented in this file.

## [2.0.0-beta.1] - 2026-11-02

### Added

- Added one multichain Wallet experience for Zcash, Ethereum, and released EVM networks, with unified Assets, Addresses, Send, Receive, and Activity views.
- Added 12-word and 24-word recovery phrase creation and import, with all supported account identities derived from either phrase length.
- Added invite-code activation for V2 Beta, with binding retries and code replacement that retain the existing wallet.
- Added EVM native and token balances, transfers, message and transaction signing, dApp permissions, discovered-token management, and network-aware activity.
- Added encrypted EVM private-key Wallet import and export, including Confidential mode, without exposing secrets to the popup after provisioning.
- Added Ledger account provisioning for Zcash and EVM, with accounts retained when adding another chain.
- Added a global Mainnet/Testnet Mode that keeps account caches, activity, RPC settings, approvals, and Zcash databases isolated between modes.
- Added custom EVM networks with verified RPC chain identity, configurable block explorers, and settings isolated between Mainnet and Testnet.
- Added a default EVM wallet preference so Noir Wallet can coexist with other installed wallets.
- Added grouped wallets and accounts with inline renaming and consistent ordering across restarts.

### Changed

- Updated Swap and Lending to select from supported multichain assets, restore cached data immediately, and refresh markets in the background.
- Redesigned Portfolio, asset details, transaction details, account management, recipient selection, and loading states for the V2 multichain interface.
- Expanded the dApp SDK and example with EVM providers, network helpers, account switching, and smart-contract testing flows.
- Deferred Bitcoin, Solana, and NEAR wallet operations; chain selectors mark them as Coming soon.
- Kept cached balances available across navigation and network filters, and refreshed newly discovered token prices in the background.
- Updated EVM transaction activity to use receipts and token transfers, preserve wallet-authored amounts, and omit untracked token history.
- Added inline Retry for recoverable Send and Swap preparation failures, including expired quotes, unavailable routes, and provider timeouts.

### Fixed

- Fixed dApp network switching after approval when the destination chain's public RPC is temporarily unavailable.
- Fixed repeated EVM activity reloads, empty-result retries, token/icon mismatches, value ordering, and stale price or protocol displays.
- Kept Send, Swap, and dApp approvals bound to the selected account, funding source, recipient, reviewed amount, and current fee estimate.
- Recalculated Max for the current recipient and route, reserved EVM transaction gas, and prevented submission of expired or non-executable quotes.
- Resumed interrupted Swap and Ledger approval flows, retained destination asset details, and refreshed Zcash balances after settlement without switching accounts.
- Fixed Confidential Swap offering destination assets unsupported by its route.
- Fixed SDK example authorization requesting chains unavailable in the installed wallet.
- Fixed Ledger unlocking after adding Zcash and retained-account provisioning when other chains are disabled.
- Prevented removed wallets and accounts from reappearing, preserved other accounts during cleanup, and allowed removed private-key wallets to be imported again.
- Fixed Zcash recovery setup, retained wallet recovery dates, rejected blank passwords, and allowed failed account, hardware, and settings initialization to retry.
- Kept recovery words hidden until revealed, preserved site disconnections across restarts, and cancelled stale synchronization work when locking the wallet.
- Removed sensitive identifiers and Zcash pool balances from exported diagnostics while retaining actionable failure details.
- Preserved V1 1.0.40 encrypted credentials, passwords, Zcash data, account metadata, and transaction state during V2 migration, including late Zcash broadcast results.

## [1.0.35] - 2026-09-07

### Fixed

- Fixed spent TEX temporary outputs reappearing as transparent balance after transaction expiry and blocking Shield Funds.

## [1.0.34] - 2026-09-07

### Added

- Added a Cloudflare-hosted, versioned RPC registry and a Singapore DeltaRPC endpoint.

### Changed

- New installations select the fastest healthy mainnet RPC, while existing user preferences remain first priority.
- RPC monitoring now reads every configured endpoint from the shared multi-chain registry.

### Fixed

- Automatically selects the fastest remaining endpoint when a preferred RPC is removed from the registry.
- Uses functional gRPC-Web health checks for endpoint selection and recovery instead of HTTP reachability alone.

## [1.0.33] - 2026-09-07

### Added

- Added TEX sends from transparent or shielded funds through the unified transfer flow, including Standard and Fast fees and multi-transaction tracking.
- Added direct Lending access through the first-party zkNoir app, with automatic wallet account connection for its exact trusted origin.

### Changed

- Improved Supply, Swap, Withdraw, and Claim progress while Zcash, relay, and destination settlement complete.
- Scoped the analytics setting to Google Analytics while keeping encrypted Noir Wallet service metrics active for aggregate volume reporting.
- Made the selected mainnet RPC the preferred first choice and added automatic fallback across three DeltaRPC Web endpoints and ChainSafe while preserving sync progress.

### Fixed

- Fixed cross-chain recovery so terminal results are not downgraded and pending destination Zcash settlement resumes after restart.
- Changed all in-progress transaction statuses to yellow, while completed transactions remain green and failures remain red.
- Fixed account history becoming incomplete after a shielded receiving address rotation.
- Fixed spent TEX temporary outputs reappearing as transparent balance after transaction expiry.
- Removed stale browsing-history and clipboard permissions retained by older extension installations.

## [1.0.32] - 2026-09-05

### Added

- Added DeltaRPC Web as a third mainnet RPC endpoint after the existing ChainSafe fallback.

### Changed

- Removed unnecessary browsing history and clipboard-reading permissions while retaining wallet notifications and native copy and paste controls.
- Paused passive balance polling while the wallet is closed unless a transaction still needs monitoring.
- Updated the support contact shown in the wallet terms and privacy documentation.

## [1.0.31] - 2026-08-14

### Added

- Added a Settings toggle for opening Noir Wallet in Chrome's side panel, with the Settings shortcut moved to Home.

### Changed

- Update reminders now follow release milestones in the product changelog, without a second notification after installation.

### Fixed

- Fixed Lending data refreshes hiding NEAR RPC failures, allowing configured endpoint failover and clearer recovery.
- Fixed shielded transaction creation after reopening or restoring a synced wallet by refreshing commitment tree state before building the transaction.
- Fixed dApp balances remaining stale until the wallet popup was opened by adding periodic background sync while unlocked.

## [1.0.30] - 2026-08-03

### Changed

- Updated `@rhea-finance/cross-chain-sdk` to 0.1.20 so lending price queries use the Pyth oracle account from RHEA configuration.
- Added automatic Zcash RPC failover with session-only fallback state and recovery to the preferred endpoint.
- Replaced the automatic installed-update dialog and persistent home banner with an actionable update toast.

## [1.0.29] - 2026-07-31

### Changed

- Clarified the anonymous analytics disclosure to explicitly identify wallet and transaction data that analytics never collects.

### Fixed

- Fixed switch thumb alignment and standardized existing toggle visuals on a shared component.

## [1.0.28] - 2026-07-30

### Added

- Added Security & Privacy settings with a default-on anonymous analytics control that stops reporting when disabled.

### Changed

- Removed wallet addresses, transaction hashes, exact amounts, dApp origins, and raw errors from analytics reports.

### Fixed

- Fixed same-transaction Sent and Received activity entries showing different confirmation progress.
- Hidden Shield Funds actions when an account has no confirmed transparent funds available to shield.
- Fixed dApp requests receiving empty or mismatched background responses by validating and correlating replies before returning them to the page.

## [1.0.27] - 2026-07-28

### Added

- Added transparent ZEC balances as optional funding sources for supported dApp transactions, including exact Max transfers.
- Added in-wallet update notices and release notes after extension upgrades.
- Added a one-time network privacy notice for wallets with legacy Orchard funds, with guidance for using NymVPN or Tor before migration.

### Changed

- Incoming ZEC now shows confirmation and spendability progress based on ZIP-315: wallet-created internal transfers finalize after 3 confirmations, while external receives become spendable after 10.
- Account search now matches account names, wallet names, transparent addresses, and shielded addresses.
- Improved recovery phrase validation with clearer feedback for unknown words, invalid checksums, and obsolete import attempts.

### Fixed

- Fixed Shield history amounts to match the transparent inputs actually selected by the broadcast transaction.
- Fixed shielded-to-transparent sends becoming stuck at `Confirming (2/3)` when a wallet history refresh overlapped the confirmation monitor.
- Fixed interrupted Lending withdrawals and claims remaining pending after the extension restarted.
- Fixed Supply and Swap completion states so Intents settlement remains the source of truth after the Zcash deposit confirms.
- Fixed transaction history leaking between accounts or missing incoming records after balance updates.
- Fixed Lending Max withdrawal calculations, including relayer fees and conditional token-registration storage.

## [1.0.26] - 2026-07-19

### Added

- Added separate mainnet and testnet extension packages with isolated storage and wallet data.
- Added Zcash Name Service support for resolving bare names plus `.zec` and `.zcash` aliases in Send and saving them with contacts.
- Added shielded transaction memos for software and Keystone signing flows.
- Added dApp methods for shielding funds and reading transaction history.
- Added transaction history and confirmation checks for testnet through a dedicated JSON-RPC endpoint.

### Changed

- Supply and Swap now move to pending immediately after the Zcash transaction is broadcast and report cross-chain completion states more accurately.
- Lending opens faster by removing an unconditional startup delay and sharing concurrent account refreshes.
- Restored wallets can recover transaction memos and recomputed fees from mined transactions.
- Mainnet and testnet unified Zcash addresses are accepted by dApp transaction validation.
- Production builds emit concise lifecycle logs, while beta and development builds retain detailed diagnostics.

### Fixed

- Fixed transactions remaining stuck after a background timeout or missed status update.
- Fixed Activity not refreshing after background transaction completion or failure.
- Fixed shielded memos being stored locally without being forwarded to transaction construction.
- Fixed pre-activation mainnet sync compatibility while retaining support for Ironwood balance data after activation.
- Fixed Speed Up remaining available on an expired transaction after its replacement was broadcast.
- Fixed overflow and unnecessary scrolling in Swap, Supply status, and long-memo transaction details.
