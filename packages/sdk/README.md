# Noir Wallet SDK

Typed TypeScript SDK for connecting web apps to the Noir Wallet browser extension.

- [Integration guide](https://docs.zknoir.com/developers)
- [Provider API reference](https://docs.zknoir.com/developers/provider-api)
- [Example dApp](https://github.com/NoirWallet/noir-wallet/tree/v2/packages/sdk/example)
- [Install Noir Wallet](https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn)
- [V2 Beta download instructions](https://github.com/NoirWallet/noir-wallet/blob/v2/docs/release-workflow.md#routine-previews)
- [Legacy V1 releases](https://github.com/NoirWallet/noir-wallet-sdk/releases)
- [Questions and bug reports](https://github.com/NoirWallet/noir-wallet/issues)
- [Private security reports](https://github.com/NoirWallet/noir-wallet/blob/v2/SECURITY.md)

## What the SDK does

`@noir-wallet/sdk` wraps the provider injected at `window.noirwallet` and gives your app a typed Zcash API. Use it to:

- request access to one or more wallet accounts;
- read addresses, balances, and transaction history;
- estimate the exact maximum transfer and send ZEC;
- shield transparent funds;
- sign and verify messages;
- react to account changes.

The SDK is browser-only. It does not create or custody wallets, and Noir Wallet must be installed for provider calls to work.

## Install an extension build

V2 uses one extension with a global Mainnet/Testnet Mode. Select the mode in the wallet's Developer Settings; dApps cannot change it.

Get a V2 beta from [Beta versions](https://zknoir.com/beta/versions). The currently published wallet is also available from the [Chrome Web Store](https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn). To load a V2 beta ZIP locally:

1. Download and unzip the extension ZIP from the beta versions page.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted extension directory.
4. In the wallet's Developer Settings, select Mainnet or Testnet Mode.

The wallet locks and reloads when its network mode changes. Older V1 downloads, including their separate Testnet builds, remain available in the [legacy SDK releases](https://github.com/NoirWallet/noir-wallet-sdk/releases).

## Install the SDK

```bash
pnpm add @noir-wallet/sdk@beta --save-exact
npm install @noir-wallet/sdk@beta --save-exact
```

## Quick start

There are two different connection calls:

- `getAccounts()` checks an existing authorization silently and returns `null` when the current site is not connected.
- `connect()` opens Noir Wallet so the user can approve access. Call it from an intentional user action such as a button click.

```ts
import { getNoirWallet } from '@noir-wallet/sdk'

const wallet = getNoirWallet()

if (!wallet) {
  throw new Error('Install Noir Wallet to continue')
}

const { zcash } = wallet

// Safe to call during page initialization: this never requests approval.
const existingConnection = await zcash.getAccounts()
if (existingConnection) {
  console.log('Already connected:', existingConnection.accounts)
}

// Call this from your Connect button.
async function connectWallet() {
  const connection = await zcash.connect()

  console.log('Primary shielded address:', connection.shielded)
  console.log('Authorized accounts:', connection.accounts)

  const balance = await zcash.getBalance()
  console.log('Total ZEC:', balance.total)
  console.log('Spendable estimate:', balance.available)
}
```

`getNoirWallet()` returns `null` during server-side rendering and when the extension is unavailable. Resolve it in browser code, not at module initialization in an SSR application.

The examples below use the `zcash` instance created in the quick start.

## Core concepts

### Primary and authorized accounts

`connect()` and `getAccounts()` return the primary account at the top level for simple integrations:

```ts
const connection = await zcash.connect()

console.log(connection.transparent)
console.log(connection.shielded)
```

They also return every account the user authorized:

```ts
for (const account of connection.accounts) {
  console.log(account.id, account.label)
  console.log(account.addresses.transparent)
  console.log(account.addresses.shielded)
}
```

Use an account `id` when you need a specific authorized account's balance:

```ts
const allBalances = await zcash.getBalance()

for (const account of allBalances.accounts) {
  console.log(account.id, account.balance.total, account.synced)
}

const selected = connection.accounts[1]
if (selected) {
  const selectedBalance = await zcash.getBalance(selected.id)
  console.log(selectedBalance.total)
}
```

`synced: false` means the value is cached or unavailable because that account is locked or has not finished syncing.

### Amounts and available balance

Amounts are decimal ZEC strings. Keep them as strings instead of converting them to JavaScript floating-point numbers.

`getBalance().available` is a destination-agnostic estimate. It cannot account for the final recipient, memo, fee tier, or transaction action count. Use `getMaxTransfer()` when you need an exact Max value.

## Send ZEC

Use `to`, not `address` or `recipient`, for the destination.

```ts
const txid = await zcash.sendTransaction({
  to: 'u1...',
  amount: '0.25',
  memo: 'Invoice 1042',
  fundingSource: 'shielded'
})

console.log('Broadcast transaction:', txid)
```

The wallet opens an approval screen before sending. A memo is supported only for shielded recipients and is limited to 512 UTF-8 bytes.

### Send the exact maximum

The estimate and transaction must use the same destination, memo, and funding source:

```ts
import type { MaxTransferParams } from '@noir-wallet/sdk'

const transfer = {
  to: 'u1...',
  memo: 'Withdraw remaining balance',
  feeTier: 'standard',
  fundingSource: 'shielded'
} satisfies MaxTransferParams

const estimate = await zcash.getMaxTransfer(transfer)

console.log('Maximum payment:', estimate.maxAmount)
console.log('Transaction fee:', estimate.fee)

const txid = await zcash.sendTransaction({
  to: transfer.to,
  amount: estimate.maxAmount,
  memo: transfer.memo,
  fundingSource: transfer.fundingSource
})
```

The approval screen controls the final transaction fee. If the user chooses a fee tier different from the estimate, recalculate Max before sending.

Transparent funding can reveal and link selected UTXOs. It is not supported by Keystone accounts.

## Sign and verify a message

`derived` mode creates a privacy-preserving identity key that is unlinkable to the main transparent address. It is the recommended mode for off-chain identity binding.

```ts
import { verifyMessageSignature } from '@noir-wallet/sdk'

const message = 'Sign in to Example'
const signed = await zcash.signMessage(message, {
  signingMode: 'derived'
})

const verification = verifyMessageSignature({
  message,
  signature: signed.signature,
  pubkey: signed.pubkey,
  address: signed.address,
  network: 'mainnet'
})

if (!verification.valid) {
  throw new Error(verification.error ?? 'Invalid signature')
}
```

Available signing modes are `current`, `derived`, and `legacy_index0`. See the [Provider API reference](https://docs.zknoir.com/developers/provider-api) before choosing a compatibility mode.

## Listen for account changes

Refresh account-scoped state after `accountsChanged`. Remove the listener when your component or integration is disposed.

```ts
async function refreshWalletState() {
  const connection = await zcash.getAccounts()

  if (!connection) {
    // The site is disconnected or the selected account is unavailable.
    return
  }

  const balance = await zcash.getBalance()
  console.log(connection.accounts, balance.accounts)
}

function handleAccountsChanged() {
  void refreshWalletState()
}

zcash.on('accountsChanged', handleAccountsChanged)

// During cleanup:
zcash.removeListener('accountsChanged', handleAccountsChanged)
```

## API overview

All wallet methods are available on `getNoirWallet().zcash`.

| Method                           | Approval | Purpose                                                 |
| -------------------------------- | -------: | ------------------------------------------------------- |
| `connect()`                      |      Yes | Request access to one or more accounts                  |
| `getAccounts()`                  |       No | Read the current authorization, or `null`               |
| `disconnect()`                   |       No | Remove this site's wallet authorization                 |
| `getAddresses()`                 |       No | Read the primary transparent and shielded addresses     |
| `getBalance(accountId?)`         |       No | Read primary, selected, and authorized-account balances |
| `getMaxTransfer(params)`         |       No | Calculate the exact Max amount and fee                  |
| `sendTransaction(params)`        |      Yes | Approve and broadcast a Zcash transaction               |
| `shieldFunds()`                  |      Yes | Move transparent funds into the shielded balance        |
| `getTransactionHistory()`        |       No | Read on-chain and locally pending transactions          |
| `getPublicKey(options?)`         |       No | Read the public identity key for a signing mode         |
| `signMessage(message, options?)` |      Yes | Approve and sign a message                              |
| `checkLendingMcaAccount()`       |       No | Read lending MCA and signing-mode status                |
| `on(event, handler)`             |       No | Subscribe to provider events                            |
| `removeListener(event, handler)` |       No | Unsubscribe from provider events                        |

`switchNetwork()` is deprecated and always throws. Select the wallet's global network mode in Developer Settings.

The package also exports lower-level helpers such as `detectProvider()`, `getZcashProvider()`, `publicKeyToAddress()`, and `verifyMessageSignature()`. Most applications should start with `getNoirWallet()`.

## Handle errors

Provider calls can fail when the user rejects a request, the wallet is locked, the account is no longer authorized, a parameter is invalid, or a transaction cannot be built.

```ts
try {
  await zcash.sendTransaction({
    to: 'u1...',
    amount: '0.25'
  })
} catch (error) {
  const message = error instanceof Error ? error.message : 'Wallet request failed'
  console.error(message)
}
```

Do not treat `getAccounts() === null` as an exception; it is the normal result for a site without an active authorization.

## Extension compatibility

The optional `fundingSource` parameter in `getMaxTransfer()` and `sendTransaction()` requires Noir Wallet 1.0.27 or later. When omitted, it defaults to shielded funds.

The SDK normalizes older single-account responses into the current `accounts` array shape, so one integration path works with both response formats.

## Run the example locally

Run these commands from the wallet repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @noir-wallet/sdk build
pnpm --filter @noir-wallet/example build
pnpm --filter @noir-wallet/example dev
```

## Example

The example app lives in `example/` and uses the workspace SDK package. It exposes the same
Zcash, EVM, and Bitcoin provider flows that a dApp uses, including connection, balance queries,
transactions, message signing, EIP-712, BIP-322, and PSBT signing.

The example dApp requires Noir Wallet to be installed in the same browser.

## Complete documentation

For parameter definitions, return types, privacy considerations, and provider RPC details, read:

- [SDK integration guide](https://docs.zknoir.com/developers)
- [Provider API reference](https://docs.zknoir.com/developers/provider-api)
- [Accounts and events](https://docs.zknoir.com/developers/accounts-and-events)
- [Integration security](https://docs.zknoir.com/developers/security)

## License

The SDK and its example are licensed under [MIT](./LICENSE). The wallet application is licensed separately under [Business Source License 1.1](https://github.com/NoirWallet/noir-wallet/blob/v2/LICENSE).
