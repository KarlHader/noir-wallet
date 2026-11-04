# Confidential DeFi Development and Troubleshooting

This guide covers local setup, data sources, recovery, and diagnosis for mnemonic and imported EVM private-key accounts using a Global PEA, Confidential balances, internal transfers, Confidential Send/Swap, and dApp Confidential asset transfers. Hardware accounts and private keys imported for other chain families do not support Confidential execution. The shared account capability is defined in `packages/extension/src/core/chains/evm/execution-capability.ts`; funding boundaries are enforced in `packages/extension/src/core/services/confidential-funding/` and the routes named below.

## 1. Account and Balance Model

| Concept                                 | Meaning                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main                                    | Public EVM account. It signs Confidential login and Intents requests. Deposits can be funded by Main or Global PEA.                              |
| Confidential                            | NEAR Intents abstract balance associated with the Main signer. It is not an on-chain address and cannot directly sign an EVM transaction.        |
| Global PEA                              | EVM execution address controlled by an independent WASM child key. It holds on-chain assets and Gas and executes dApp and protocol transactions. |
| Displayed Private and Shield balances   | Private shows Global PEA on-chain assets; Shield shows the Confidential abstract balance separately.                                             |
| Directly spendable Confidential balance | Only the Global PEA's `privateOnchainRaw`.                                                                                                       |

The UI separates Public / Private usage modes from Public / Shield / Private asset categories. Internal names such as `private`, `PrivateExecution`, and `privateOnchainRaw` do not make abstract balances spendable from the PEA.

Directly and Shield balances use the RHEA/1Click services below. Cluster additionally uses the configured RHEA `/v3/private` service to schedule signed withdrawals and reconcile orders. Its history queries require a separate wallet JWT obtained through a strictly validated read-only sign-in challenge; a scheduler acknowledgement does not establish destination settlement.

## 2. Funds Flows

### Shield Deposit and Withdraw

```text
Public or Private -> 1Click deposit address -> Shield balance
Shield balance -> one Withdraw Intent -> Public or Private
```

Use the NEAR Confidential Shield view or Transfer page. Connect Shield to authenticate its balance, then review and confirm Deposit or Withdraw. Both ends belong to the same Wallet Account. A deposit stays in Shield; a withdrawal spends the selected portion of its existing balance. Private deposits refund to the originating PEA. Cluster signs multiple withdrawals to one selected destination and submits them as one scheduled batch. If submission has an ambiguous result, recovery queries order history without resubmitting the batch. Existing batch plans retain their original recovery behavior.

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
| Login and session refresh                          | RHEA 1Click proxy        | `/auth/authenticate`, `/auth/refresh`                                             |
| Confidential abstract balance                      | 1Click direct API        | `/account/balances`                                                               |
| Deposit/Withdraw quote                             | RHEA 1Click proxy        | `/quote` with `confidentiality: basic`                                            |
| Withdraw Intent                                    | RHEA 1Click proxy        | `/generate-intent`, `/submit-intent`                                              |
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
CONFIDENTIAL_ONE_CLICK_API_URL=https://api.rhea.finance/proxy/1click/v0 \
RHEA_SWAP_ACCESS_TOKEN=replace-with-development-token \
pnpm dev:extension
```

`CONFIDENTIAL_ONE_CLICK_API_URL` must be an HTTPS URL without credentials, query, or fragment. Without an override, authentication and quotes use the RHEA 1Click proxy; abstract balances use the official 1Click direct API. The direct official endpoint requires partner authentication for Confidential quotes. Do not commit the access token. For local files, use a Git-ignored `*.local` environment file and check `git status` before committing.

Confidential Funding creates a coordinator only on Mainnet; Testnet returns unavailable. Release builds require `RHEA_SWAP_ACCESS_TOKEN`. EVM History uses the bundled proxy by default; `EVM_HISTORY_API_ORIGIN` only overrides it. Its [release configuration](../../release-workflow.md#verification-and-build) is separate from Confidential order status.

## 5. State, Storage, and Recovery

Legacy batch plans in `src/core/services/confidential-funding/confidential-funding-model.ts` follow these stages. Independent deposits finish after deposit confirmation; independent withdrawals skip the deposit stages:

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

Pending Shield withdrawals reserve their source amount within the Wallet Account; expired preparations stop reserving funds. A `prepared` plan can be canceled; deleting a signed or broadcast plan is not recovery. A 401/403 response clears the session and moves the plan to `needs-auth`; authorization resumes its prior stage. Direct withdrawals query status before retrying the exact frozen payload. Once a Cluster submission has been attempted, recovery only queries order history and never resubmits the batch; an empty history does not release its reservation. Do not requote or sign again to recover an uncertain submission. Service Worker startup and alarms resume nonterminal plans.

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
