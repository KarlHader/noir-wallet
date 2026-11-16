# Changelog

All notable user-facing changes to Noir Wallet are documented in this file.

## [2.0.0-beta.2] - 2026-11-10

### Added

- Added Shield Funds for NEAR Confidential balances and native Zcash shielded balances, with Send, Receive, Move, and supported Swap routes.
- Added external Shield deposits with receiving addresses, editable refund addresses, and deposit tracking.
- Added Directly and Cluster options for Public/Private transfers, with route fees and estimated arrival times before confirmation.
- Added an optional private route for supported dApp transfers from Private accounts, with quotes for the amount the recipient should receive.

### Changed

- Redesigned Home, asset details, account management, Send, Receive, Move, Swap, and Settings for the V2 interface, including side-panel layouts.
- Separated Total, Public, Shield, and Private asset views on Home and asset details, with matching balances and activity filters.
- Updated Shield Move to select a funding source and asset first, support direction switching, and offer supported EVM destination networks for the same token.
- Updated wallet import with network selection and address previews, while retaining Zcash recovery and synchronization controls.
- Added all-EVM and single-network contacts, compact address previews, and a warning before copying Private addresses.
- Updated the default Swap token list to use RHEA's curated catalog while retaining held assets and token search.
- Simplified connected dApp account and network selection, and removed the built-in Lending views and valuations.

### Fixed

- Fixed wallet switching getting stuck behind Zcash synchronization requests.
- Fixed backup reminders appearing for newly imported wallets or referring to a different wallet.
- Fixed Shield balance loading, asset classification, and action routing; stopped repeated checks for expired, unfunded deposit requests.
- Fixed Send, Move, and Swap Max controls and stale fee estimates, and made quote failures and retries clearer.
- Fixed Zcash Swap funding selection in Private mode and preserved the selected recipient and funding source through confirmation.
- Fixed transaction progress and activity recovery after reopening the wallet, including interrupted hardware-wallet Swap approvals.
- Fixed Swap asset selection and address lists when custom EVM networks are configured.
- Fixed network labels and duplicate Zcash account counts in connected dApp permissions.
- Fixed stale recovery-date requests and import errors appearing after changing Zcash history options.
- Fixed Public-to-Confidential Max transfers opening confirmation before the current route's gas estimate was ready.
- Fixed wallet snapshot recovery after locking and unlocking when the Zcash Worker had restarted.
- Fixed Swap rates displaying both equality and approximation symbols at the same time.

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

## [1.0.40] - 2026-10-25

### Fixed

- Show the full quoted recipient before confirming a swap and keep Confirm visible when long addresses wrap.
- Keep recovery words out of readable page content and the accessibility tree until the backup phrase is revealed.
- Respect transaction pauses before queued synchronization starts and between synchronization stages, without starting follow-up balance or history requests after a paused scan.
- Clear wallet snapshots, transactions, balance caches, voting data, and sessions according to the reset or deletion scope. Stop background writes from restoring deleted data, allow cleanup failures to retry, and preserve other accounts' records.
- Preserve explicit dApp disconnection across restarts, including first-party sites, and require user approval to reconnect.
- Keep approval display, fee estimation, transaction execution, and current-account message signing bound to the requested account when switching accounts or refreshing the approval window.
- Apply network deadlines to complete response-body reads, limit response sizes, and release cancelled or failed requests so they can be retried.

## [1.0.39] - 2026-10-16

### Added

- Add a default-enabled ZeroIndexer toggle under Security & Privacy. Transactions containing Orchard try the configured ZeroIndexer broadcast endpoints in order and fall back to the ordinary wallet RPC if every attempt fails, across software and hardware signing flows.
- Add a separate ZeroIndexer node manager with automatic official-node selection, fixed node selection, custom nodes, and read-only network and reachability checks. Keep node choices per network and preserve them when broadcasting is disabled.

### Changed

- Keep synchronization, compact-block CDN downloads, history, and confirmation queries on their existing providers. Remove ZeroIndexer from the synchronization RPC list.
- Align Available balance with transaction selection at three confirmations. Activity continues to show external incoming transfers as pending until ten confirmations.
- Build PR previews automatically and separate production candidate construction from publication of the accepted ZIPs. Verify the committed WASM package during builds and require explicit package updates.

### Fixed

- Migrate ZeroIndexer synchronization preferences from the earlier beta back to ordinary automatic RPC selection while preserving other explicitly selected providers and the broadcast preference.
- Refresh spendable balances after wallet reload and catch-up sync, keep Max current when available funds change, and distinguish pending funds, insufficient balance, and fee failures.
- Recover missing transparent recipients from unambiguous matching transaction outputs, preserve known recipients during history refresh, and avoid labeling unknown recipients as shielded.
- Read wallet snapshot manifests and chunks in one IndexedDB transaction to prevent concurrent saves from causing false missing-chunk errors. Abort failed writes and retain the previous snapshot when serialization or persistence fails.
- Retry snapshot integrity checks in a fresh transaction before recommending Resync. Reserve that recovery path for confirmed incomplete or corrupt snapshots rather than transient initialization, balance, or sync failures.
- Include privacy-redacted original error details with formatted failures so support screenshots retain the actionable cause.

## [1.0.38] - 2026-10-05

### Added

- Added recovery phrase backup verification, reminders for existing software wallets, and backup checks before wallet removal.
- Added mainnet compact-block CDN support and an additional Singapore RPC endpoint.

### Changed

- Kept the voting entry hidden for this release.

### Fixed

- Preserved recovery phrases through wallet creation and import, and clarified which wallet is being backed up.
- Fixed deleted wallets reappearing after writes from another extension context, and recovered unlock access when the selected wallet's credentials are missing but another wallet's credentials can be verified.
- Preserved hardware wallet names during import and existing credentials when initialization fails after import.
- Recovered confirmed Zcash Activity records and corrected stale confirmation status handling.
- Fixed wallet sync errors with Zcash RPC servers that return successful empty gRPC-Web streams.

### Known Issues

- A sync stall was reported after switching accounts and using Swap; manual Resync restored synchronization. The cause remains unconfirmed, and this release does not include a fix for that report.

## [1.0.37] - 2026-09-23

### Added

- Added Ledger Zcash account import and hardware transaction signing over USB and Bluetooth.
- Added configurable hardware account indexes, visible derivation paths, and shared signing flows for Ledger and Keystone.
- Added shielded address history, address rotation, QR codes, and cached address loading across Receive and Addresses.
- Added automatic RPC selection, additional EU endpoints, and downloadable privacy-safe diagnostic logs.
- Added exact wallet birthday dates for faster, more precise restore and rescan setup.
- Added a Send warning for exchanges that may not support shielded deposits.

### Changed

- Separated balance-query and transaction-selection confirmation policies so external funds remain Pending until 10 confirmations while eligible manual transfers can use them after 3.
- Improved Send and Swap funding details so Available excludes Pending, Max stays within confirmed funds, and warnings identify the affected funding source.
- Improved cross-chain progress recovery, account switching, token and network verification, and deposit confirmation safeguards.

### Fixed

- Fixed Ledger import waiting on an unused address confirmation and the side panel remaining on Welcome after import.
- Fixed Bluetooth discovery permissions, PCZT Map serialization, and transaction preview visibility during Ledger signing.
- Fixed explicit transparent and shielded sends being treated as Max transfers, including TEX Max availability.
- Fixed transient spendability metadata errors triggering unnecessary full wallet rescans during active sync.
- Fixed Swap progress stopping after account changes and terminal Intents results remaining in a confirming state.
- Fixed stale balances across routes and clarified actionable RPC, network, and upstream service errors.

## [1.0.36] - 2026-09-09

### Added

- Added a promotional banner to the wallet Home screen.
- Added GitHub, X, and Telegram links to wallet Settings and About.

### Changed

- New installations now open Noir Wallet in Chrome's side panel by default.

### Fixed

- Fixed transparent change from dApp transactions becoming stale or unspendable, allowing normal sync to recover it without a full resync.

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
