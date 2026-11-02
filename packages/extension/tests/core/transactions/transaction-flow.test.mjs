import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const describe = it.describe

const backgroundSource = readFileSync(
  new URL('../../../src/background/index.ts', import.meta.url),
  'utf-8'
)
const monitorSource = readFileSync(
  new URL('../../../src/background/transaction-monitor.ts', import.meta.url),
  'utf-8'
)
const transactionListSource = readFileSync(
  new URL('../../../src/popup/components/transaction/TransactionList.tsx', import.meta.url),
  'utf-8'
)
const resultPageSource = readFileSync(
  new URL('../../../src/popup/pages/transactions/TransactionResultPage.tsx', import.meta.url),
  'utf-8'
)
const transactionDetailSource = readFileSync(
  new URL('../../../src/popup/components/transaction/TransactionDetail.tsx', import.meta.url),
  'utf-8'
)
const zcashMonitorSource = readFileSync(
  new URL('../../../src/background/zcash-tx-monitor.ts', import.meta.url),
  'utf-8'
)
const lendingStoreSource = readFileSync(
  new URL('../../../src/store/lending-store.ts', import.meta.url),
  'utf-8'
)
const txSyncSource = readFileSync(
  new URL('../../../src/background/tx-sync.ts', import.meta.url),
  'utf-8'
)
const resultStoreSource = readFileSync(
  new URL('../../../src/store/transaction-result-store.ts', import.meta.url),
  'utf-8'
)
const swapSource = readFileSync(
  new URL('../../../src/popup/pages/swap/Swap.tsx', import.meta.url),
  'utf-8'
)
const swapReviewSource = readFileSync(
  new URL('../../../src/popup/components/swap/SwapReviewView.tsx', import.meta.url),
  'utf-8'
)
const dappHandlerSource = readFileSync(
  new URL('../../../src/background/dapp-handler.ts', import.meta.url),
  'utf-8'
)

describe('Cross-chain transaction lifecycle regressions', () => {
  it('notifies the popup before a lightweight post-broadcast refresh', () => {
    const completionMessage = backgroundSource.indexOf("type: 'ZCASH_TX_COMPLETED'")
    const backgroundRefresh = backgroundSource.indexOf(
      'void refreshAfterOnChainBroadcast',
      completionMessage
    )

    assert.notEqual(completionMessage, -1, 'broadcast completion message must exist')
    assert.notEqual(backgroundRefresh, -1, 'post-broadcast refresh must run asynchronously')
    assert.ok(
      completionMessage < backgroundRefresh,
      'the popup must be notified as soon as broadcast bookkeeping succeeds'
    )
    assert.ok(
      !backgroundSource
        .slice(completionMessage, backgroundRefresh)
        .includes('catchUpAfterOnChainTx'),
      'broadcast must not trigger full settlement before the tx is confirmed'
    )
    assert.match(
      txSyncSource,
      /refreshAfterOnChainBroadcast[\s\S]*?refreshBalances/,
      'the lightweight path must refresh the WASM pending balance'
    )
  })

  it('distinguishes broadcast from an on-chain confirmation', () => {
    assert.match(
      backgroundSource,
      /type:\s*'TRANSACTION_STATUS_UPDATED',[\s\S]*?status:\s*'pending'/,
      'the post-broadcast activity update must remain pending'
    )
    assert.match(
      zcashMonitorSource,
      /notifyFrontend\(tx, status, reason\)/,
      'the confirmation monitor must forward its resolved status'
    )
    assert.match(
      resultPageSource,
      /message\.status === 'success'/,
      'the result page must only show Confirmed for an explicit success status'
    )
  })

  it('reveals a RHEA destination Token on any supported chain after a successful Swap', () => {
    assert.match(
      resultPageSource,
      /data\.status\?\.status !== 'SUCCESS'[\s\S]*?showProtocolAsset\(destinationAsset\)[\s\S]*?getPortfolio\('refresh', \{ chainIds: \[destinationChainId\] \}\)/,
      'a successful Swap must enable its exact Intents destination before refreshing Assets'
    )
    assert.doesNotMatch(
      resultPageSource,
      /forceDiscovery:\s*true/,
      'Swap settlement must not use unrelated received-Token discovery'
    )
    assert.doesNotMatch(
      swapSource,
      /allowedAssetIds/,
      'source selection must not be limited to assets already mapped into the wallet portfolio'
    )
  })

  it('routes non-transaction RHEA builds through chain-specific review and confirmation', () => {
    assert.match(
      swapSource,
      /execution\.kind === 'evm-signature'[\s\S]*?prepareEvmSignature\([\s\S]*?confirmEvmSignature\(/,
      'EVM typed-data orders must use the Background signing coordinator'
    )
    assert.match(
      swapSource,
      /execution\.kind === 'solana-transaction'[\s\S]*?prepareSolanaTransaction\([\s\S]*?confirmSolanaTransaction\(/,
      'Solana serialized transactions must use the Background signing coordinator'
    )
    assert.match(
      swapSource,
      /execution\.kind === 'near-transaction-batch'[\s\S]*?prepareNearTransactionBatch\([\s\S]*?confirmNearTransactionBatch\(/,
      'NEAR transaction batches must use the Background signing coordinator'
    )
    assert.doesNotMatch(swapReviewSource, /Transaction details/)
    assert.doesNotMatch(swapReviewSource, /<span>\{signingActionLabel\}<\/span>/)
    assert.doesNotMatch(swapReviewSource, /signingNetworkFee/)
  })

  it('offers Speed Up directly when the confirmation monitor reports expiry', () => {
    assert.match(
      zcashMonitorSource,
      /const message:\s*TransactionStatusUpdatedMessage[\s\S]*?failureReason/,
      'the monitor must send a typed status event with its failure reason'
    )
    assert.match(
      resultPageSource,
      /isTransactionStatusUpdatedMessage\(message\)/,
      'the result page must validate transaction status events'
    )
    assert.match(
      resultPageSource,
      /getTransactionRecoveryAction\(resultTransaction\)/,
      'the result page must derive its action from the persisted transaction'
    )
    assert.match(
      transactionDetailSource,
      /getTransactionRecoveryAction\(localTx\) === 'speed_up'/,
      'Activity detail must use the same recovery action selector'
    )
  })

  it('labels the two steps of a multi-step Zcash send distinctly', () => {
    assert.match(transactionDetailSource, /showMultiStepZcashLabels = isMultiStepZcashSend/)
    assert.match(transactionDetailSource, /'Funding Hash'/)
    assert.match(transactionDetailSource, /'Payment Hash'/)
  })

  it('treats relay success as final for outbound supply and swap transactions', () => {
    assert.ok(
      monitorSource.includes('getCrossChainCompletionStatus(tx.type, {'),
      'background monitor must resolve finality from the transaction type and route'
    )
    assert.ok(
      transactionListSource.includes('getCrossChainCompletionStatus(tx.type, {'),
      'foreground recovery must use the same transaction route status rule'
    )
  })

  it('recovers outbound records already persisted as relay-confirmed', () => {
    assert.ok(
      transactionListSource.includes("tx.status === 'relay_confirmed'"),
      'Activity reload must normalize previously stuck supply and swap records'
    )
  })

  it('keeps account-scoped history after a receiving address is rotated', () => {
    assert.match(
      transactionListSource,
      /getCurrentTransactions\(\)/,
      'Activity must read the transaction list already scoped to the active account key'
    )
    assert.doesNotMatch(
      transactionListSource,
      /accountAddresses|includes\(tx\.from\)|includes\(tx\.to\)/,
      'Activity must not re-filter account-scoped history using mutable current addresses'
    )
  })

  it('polls an open cross-chain result every five seconds with cancellation', () => {
    assert.match(resultStoreSource, /depositAddress:\s*string/)
    assert.match(swapSource, /type:\s*'swap',[\s\S]*?depositAddress:\s*swap\.depositAddress/)
    assert.match(resultPageSource, /pollingSwapStatus\([\s\S]*?interval:\s*5_000/)
    assert.match(
      resultPageSource,
      /pollingTransactionConfirmations\([\s\S]*?SPENDABILITY_CONFIRMATIONS/
    )
    assert.match(resultPageSource, /controller\.abort\(\)/)
  })

  it('uses Chrome production alarm minimum for background relay checks', () => {
    assert.match(monitorSource, /const POLL_DELAY_MIN = 0\.5/)
  })
})

describe('dApp shield history regressions', () => {
  it('records and monitors an approved shield transaction after broadcast', () => {
    const shieldHandler = dappHandlerSource.slice(
      dappHandlerSource.indexOf('private async shieldFunds'),
      dappHandlerSource.indexOf('private async getTransactionHistory')
    )

    assert.match(shieldHandler, /transactionRecorder\.addTransaction\([\s\S]*?type:\s*'shield'/)
    assert.match(shieldHandler, /zcashTxMonitor\.addTransaction\([\s\S]*?type:\s*'shield'/)
  })
})

describe('Lending loading regressions', () => {
  it('does not add an unconditional three-second startup delay', () => {
    assert.ok(
      !lendingStoreSource.includes('setTimeout(r, 3000)'),
      'lending refresh must begin immediately'
    )
  })

  it('deduplicates concurrent full refreshes', () => {
    assert.ok(
      lendingStoreSource.includes('refreshDedup.run'),
      'Home refreshes must share the same in-flight request'
    )
  })
})
