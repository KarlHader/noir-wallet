# Confidential DeFi Development and Troubleshooting

This guide covers local setup, data sources, recovery, and diagnosis for mnemonic and imported EVM private-key accounts using a Global PEA, Confidential balances, internal transfers, Confidential Send/Swap, and dApp Confidential asset transfers. Hardware accounts and private keys imported for other chain families do not support Confidential execution. The shared account capability is defined in `packages/extension/src/core/chains/evm/execution-capability.ts`; funding boundaries are enforced in `packages/extension/src/core/services/confidential-funding/` and the routes named below.

## 1. Account and Balance Model

| Concept                                 | Meaning                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main                                    | Public EVM account. It funds source-chain deposits and signs Confidential login and Intents requests.                                            |
| Confidential                            | NEAR Intents abstract balance associated with the Main signer. It is not an on-chain address and cannot directly sign an EVM transaction.        |
| Global PEA                              | EVM execution address controlled by an independent WASM child key. It holds on-chain assets and Gas and executes dApp and protocol transactions. |
| Displayed Confidential balance          | Product aggregate of the Global PEA on-chain balance and the Confidential abstract balance.                                                      |
| Directly spendable Confidential balance | Only the Global PEA's `privateOnchainRaw`.                                                                                                       |

The UI uses `Confidential`. Internal names such as `private`, `PrivateExecution`, and `privateOnchainRaw` do not make abstract balances spendable from the PEA.

The current flow does not depend on a Private Indexer. It does not request `privateindexer.refburrow.top`, read its balances, Activity, orders, or finality, or silently fall back to it when 1Click or RHEA fails. If such a request appears in the browser Network panel, inspect the loaded extension version for an outdated build or reintroduced dependency.

## 2. Funds Flows

### Add to Confidential

```text
Main
  -> 1Click deposit address
  -> Confidential abstract balance
  -> 2-5 frozen Withdraw Intents
  -> Global PEA
```

The entry point is the asset-detail Transfer dialog or PEA Gas top-up. Confirmation starts the background plan directly, without another Add to Private confirmation page. Implementation entry points are `src/background/confidential-funding-{api,coordinator,signer,store}.ts`, `src/core/services/confidential-funding/`, `src/popup/services/confidential-funding-client.ts`, and the Swap and transaction-result pages.

### Move to Main

```text
Global PEA
  -> Near Intents route with confidentiality=basic
  -> Main address or an external destination
```

The reverse Transfer from asset details fills the current Main address and uses this route. It spends only PEA on-chain assets, never balances that exist solely in the Confidential abstract account. The relevant code is `src/popup/pages/transactions/evm-send-validation.ts`, `src/core/services/rhea-swap/rhea-private-transfer.ts`, and `src/background/rhea-swap.ts`.

### Wallet EVM Same-chain Send

Send always retains the selected source address. Public sends use direct on-chain native or ERC-20 transfers. A Confidential source uses `confidentiality: basic` when the asset declares Near Intents support. If a complete catalog explicitly excludes the asset or its Confidential capability, or RHEA does not support the network, Send prepares a direct on-chain transfer from the PEA with `executionMode: private`. Fees, Gas, and Max use that source's chain balance; Confidential abstract balances are not spendable.

Send prefetches selectable EVM catalogs with at most two requests in flight, sharing the existing ten-minute cache and request deduplication. In SDK 2.0.6, same-chain source and destination assets use the `from` catalog. The source-catalog adapter detects rows the SDK would silently discard and avoids retaining empty or capability-incomplete results, so Retry can reach the service. Match the network and native identity or contract, then require `nearintents` or `preswap-nearintents` in the matching asset's sources. A failed, partial, empty, or capability-incomplete result leaves support unknown: Continue waits and offers Retry. A failed supported-asset quote or Max estimate never falls back to a direct transfer.

The direct-send review identifies the send method and requires **Send anyway** for a PEA source or a Public source whose recipient is Confidential or unknown. Only the local account directory on the selected network establishes a Public or PEA role; external addresses and address-book labels do not. Source, recipient, asset, amount, and method changes invalidate the review. Entry points are `src/popup/pages/transactions/EvmSendForm.tsx`, `src/popup/services/evm-send-{catalog,routing}.ts`, `src/core/services/rhea-swap/rhea-confidential-support.ts`, and `src/core/accounts/evm-address-role.ts`.

These rules apply only to wallet same-chain Send. Swap, cross-chain Send, account-to-account Transfer, and dApp routing retain their existing behavior.

### dApp Confidential Asset Transfer

In Private/Confidential mode, native-asset sends, ERC-20 `transfer`, and supported PEA `transferFrom` calls use the RHEA/Intents Confidential route. An unknown token cannot fall back to a direct PEA transfer. An ordinary contract call may execute directly from the PEA, but its approval must identify it as a direct contract interaction. Routing lives in `src/background/evm-dapp-private-transfer.ts`, `evm-transfer-router.ts`, and `evm-dapp-handler.ts`; approval is rendered in `src/popup/pages/dapp/ApprovalPage.tsx`.

## 3. Services and Authoritative State

| Purpose                                            | Service                  | Request                                                                           |
| -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| ERC-191 login nonce                                | Configured NEAR RPC      | `intents.near/current_salt`                                                       |
| Login and session refresh                          | Official 1Click          | `/auth/authenticate`, `/auth/refresh`                                             |
| Confidential abstract balance                      | Official 1Click          | `/account/balances`                                                               |
| Deposit/Withdraw quote                             | Official 1Click          | `/quote` with `confidentiality: basic`                                            |
| Withdraw Intent                                    | Official 1Click          | `/generate-intent`, `/submit-intent`                                              |
| Deposit and Withdraw order status                  | RHEA Cross-chain DEX     | `/api/swap/order-status?orderId=<depositAddress>&router=nearintents&chainId=<id>` |
| Main/PEA on-chain balance, nonce, and confirmation | Current EVM RPC registry | Standard EVM JSON-RPC                                                             |
| PEA Swap and dApp Confidential transfer            | RHEA Cross-chain SDK/API | Quote, prepare, submit, and order status                                          |

The order ID for this route is the quote's deposit address. 1Click `/status?depositAddress=...` is not its order-status API; a request to that endpoint usually indicates an outdated extension build.

## 4. Local Setup

From the repository root:

```bash
pnpm install
RHEA_SWAP_ACCESS_TOKEN=replace-with-development-token pnpm dev:extension
```

Load `packages/extension/dist-dev/` as the unpacked extension in Chrome. The production `dist/` directory does not receive the development server's HMR updates.

An optional 1Click override:

```bash
CONFIDENTIAL_ONE_CLICK_API_URL=https://1click.chaindefuser.com/v0 \
RHEA_SWAP_ACCESS_TOKEN=replace-with-development-token \
pnpm dev:extension
```

`CONFIDENTIAL_ONE_CLICK_API_URL` must be an HTTPS URL without credentials, query, or fragment. Without an override, the official 1Click URL is used. Do not commit the access token. For local files, use a Git-ignored `*.local` environment file and check `git status` before committing.

Confidential Funding creates a coordinator only on Mainnet; Testnet returns unavailable. Release builds require `RHEA_SWAP_ACCESS_TOKEN`. EVM History uses the bundled proxy by default; `EVM_HISTORY_API_ORIGIN` only overrides it. Its [release configuration](../../release-workflow.md#verification-and-build) is separate from Confidential order status.

## 5. State, Storage, and Recovery

The plan stages in `src/core/services/confidential-funding/confidential-funding-model.ts` are:

```text
prepared -> authorized -> deposit-signed -> deposit-confirming
  -> signing-withdraws -> submitting -> processing
  -> ready | partial | refunded | failed | expired | cancelled

recoverable stage requiring renewed login -> needs-auth -> original resumePhase
```

| Key prefix                      | Storage                  | Content                                                             |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `confidential_funding_plan:`    | `chrome.storage.local`   | Frozen plan, batches, signed payloads, state, and recovery evidence |
| `confidential_funding_session:` | `chrome.storage.session` | 1Click access/refresh tokens and expiration                         |
| `confidential_funding_balance:` | `chrome.storage.local`   | Confidential balance snapshot with a five-minute TTL                |
| `rhea_swap_quote:`              | `chrome.storage.local`   | Frozen quote session for PEA Swap or Confidential transfer          |

Only one nonterminal Confidential Funding plan may use a given source asset. A `prepared` plan can be canceled; deleting a signed or broadcast plan is not recovery. A 401/403 response clears the session and moves the plan to `needs-auth`; authorization resumes its prior stage. Timeout and 5xx responses have uncertain outcomes: query status first, then replay the exact frozen payload. Do not requote or sign again. Service Worker startup and alarms resume nonterminal plans.

RHEA transfer and swap results include origin and destination transaction links from persisted graph evidence. The result page recovers these hashes from Activity when a status notification is missed, retains them across partial updates, and does not regress a terminal result on a late processing update.

## 6. Troubleshooting

Open the Noir Wallet Service Worker inspector from `chrome://extensions`. Relevant log prefixes are `[Confidential Funding]` for batch plans, recovery, status, and balance merging; `[RHEA Swap]` for PEA Swap and Confidential transfers; `[EVM Transfer]` for EVM preparation, signing, and broadcast; and `[EVM Transaction Monitor]` for receipts and Activity finality.

| Symptom                                                       | Check                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Another Private transfer is already using this source asset` | Inspect the source asset's nonterminal `confidential_funding_plan:`; do not delete a signed plan.                                   |
| 1Click `/status` returns 404                                  | Check for an old `dist/` build, stale Service Worker, or cached extension package.                                                  |
| On-chain deposit succeeded but the page reports failure       | Compare the EVM receipt, RHEA `order-status`, and 1Click `/account/balances`. Do not fill gaps with Private Indexer data.           |
| Plan remains in `needs-auth`                                  | Check 1Click 401/403, session-key clearing, and whether the wallet is unlocked.                                                     |
| Confidential abstract balance disappeared                     | Check `/account/balances` and the five-minute cache. Do not infer the abstract balance from PEA on-chain assets.                    |
| Activity remains Confirming                                   | Check the EVM receipt and local Transaction V2 graph, then the RHEA status of each Confidential batch.                              |
| `Invalid EVM transaction input`                               | ERC-20 calldata, addresses, and raw transactions must be canonical hexadecimal. Lowercase checksum addresses only for ABI encoding. |

Logs must not include access or refresh tokens, complete signed payloads, mnemonics, passwords, or private keys.

## 7. Verification

Run the offline behavior tests:

```bash
pnpm test
```

The protocol test uses deterministic responses in a real MV3 extension and does not broadcast Mainnet funds:

```bash
pnpm test e2e protocol-mainnet
```

Run extension type checking and the build for affected extension code:

```bash
pnpm --filter @noir-wallet/extension type-check
pnpm test
pnpm --filter @noir-wallet/extension build
```

A funded Mainnet test is outside routine regression. Before broadcasting, register its wallet under the [test-wallet rules](test-wallet-registry.md), verify asset and amount, and obtain explicit authorization. Keep transaction evidence outside the repository.

When changing this flow, verify Main/abstract/PEA balances remain distinct, Confidential routes retain `confidentiality: basic`, wallet Send handles unknown support without a fallback, quote and signer data stay bound through approval and recovery, a restart or lost response cannot double-spend, and stale polling cannot downgrade a terminal Activity state. Check the affected UI at 375×600 or 375×632 and run focused logic and MV3 checks according to the changed boundary.
