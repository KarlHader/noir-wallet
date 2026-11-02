import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import {
  normalizeTxHash,
  localTxHashSet,
  isDuplicateWasmRow
} from '../../../src/lib/tx-history-dedup.ts'
import { decideMonitorSignal } from '../../../src/background/tx-monitor-policy.ts'
import {
  getCrossChainCompletionStatus,
  isIntentsSettledTransaction,
  needsRelayStatusRecovery
} from '../../../src/lib/cross-chain-transaction.ts'
import { WALLET_CONFIG } from '../../../src/config/wallet.ts'
import {
  getRequiredConfirmations,
  mergeTransactionUpdate,
  resolveMinedTransactionStatus
} from '../../../src/lib/transaction-status.ts'
import {
  formatConfirmingStatus,
  getTransactionStatusCopy
} from '../../../src/lib/transaction-status-copy.ts'
import { isWalletSettlementComplete } from '../../../src/lib/wallet-settlement.ts'

function tx(overrides) {
  return {
    id: 'tx_1',
    txHash: 'abc123',
    status: 'pending',
    type: 'send',
    amount: '1',
    to: 't1',
    from: 't1',
    fromType: 'shielded',
    fee: '0',
    timestamp: 0,
    network: 'mainnet',
    ...overrides
  }
}

test.describe('ZIP-315 confirmation lifecycle', () => {
  test('MIN_CONFIRMATIONS is 3 for outbound finality', () => {
    expect(WALLET_CONFIG.MIN_CONFIRMATIONS).toBe(3)
  })

  test('SPENDABILITY_CONFIRMATIONS preserves incoming Activity finality at 10', () => {
    expect(WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS).toBe(10)
  })

  test('Received in first block is still confirming (1/10)', () => {
    const signal = decideMonitorSignal({
      lookup: { status: 'confirmed', confirmations: 1 },
      minConfirmations: 10,
      expired: false,
      elapsedMs: 1000,
      timeoutMs: 30 * 60 * 1000,
      hasNode: true,
      confirmedInDb: false
    })
    expect(signal).toBe('wait')
  })

  test('confirming transactions use the neutral tone', () => {
    expect(
      getTransactionStatusCopy(
        tx({ status: 'confirming', confirmations: 2, requiredConfirmations: 3 })
      )
    ).toMatchObject({ label: 'Confirming (2/3)', tone: 'neutral' })
  })

  test('9 incoming confirmations still wait for Activity finality', () => {
    const signal = decideMonitorSignal({
      lookup: { status: 'confirmed', confirmations: 9 },
      minConfirmations: 10,
      expired: false,
      elapsedMs: 1000,
      timeoutMs: 30 * 60 * 1000,
      hasNode: true,
      confirmedInDb: false
    })
    expect(signal).toBe('wait')
  })

  test('10 confirmations reaches confirmed', () => {
    const signal = decideMonitorSignal({
      lookup: { status: 'confirmed', confirmations: 10 },
      minConfirmations: 10,
      expired: false,
      elapsedMs: 1000,
      timeoutMs: 30 * 60 * 1000,
      hasNode: true,
      confirmedInDb: false
    })
    expect(signal).toBe('confirm')
  })

  test('external receives require 10 confirmations while sends require 3', () => {
    expect(getRequiredConfirmations('receive')).toBe(10)
    expect(getRequiredConfirmations('receive', 'trusted')).toBe(3)
    expect(getRequiredConfirmations('withdraw')).toBe(10)
    expect(getRequiredConfirmations('send')).toBe(3)
    expect(resolveMinedTransactionStatus('mined', 100, 102, 'send').status).toBe('success')
    expect(resolveMinedTransactionStatus('mined', 100, 102, 'receive', 'trusted')).toEqual({
      status: 'success',
      confirmations: 3,
      requiredConfirmations: 3
    })
    expect(resolveMinedTransactionStatus('mined', 100, 102, 'receive')).toEqual({
      status: 'confirming',
      confirmations: 3,
      requiredConfirmations: 10
    })
  })

  test('confirmation progress uses the same label for incoming and outgoing transactions', () => {
    expect(formatConfirmingStatus('receive', 6, 10)).toBe('Confirming (6/10)')
    expect(formatConfirmingStatus('send', 2, 3)).toBe('Confirming (2/3)')
  })

  test('mined but under 10 confirmations is not timed out even past timeout', () => {
    const signal = decideMonitorSignal({
      lookup: { status: 'confirmed', confirmations: 5 },
      minConfirmations: 10,
      expired: false,
      elapsedMs: 60 * 60 * 1000,
      timeoutMs: 30 * 60 * 1000,
      hasNode: true,
      confirmedInDb: false
    })
    // Past timeout, but tx is mined — policy returns 'wait' because it's
    // confirmed but immature (not 'notfound').
    expect(signal).toBe('wait')
  })
})

test.describe('Transaction status monotonicity', () => {
  test('stale relay updates cannot downgrade a successful transaction', () => {
    const successful = tx({ status: 'success', notified: true })
    expect(
      mergeTransactionUpdate(successful, {
        status: 'relay_confirmed',
        notified: false,
        failureReason: 'timeout',
        memo: 'Refunded',
        destinationTxHash: 'destination'
      })
    ).toEqual({
      ...successful,
      destinationTxHash: 'destination'
    })
  })

  test('non-terminal transactions still advance to confirming', () => {
    const pending = tx({ status: 'pending' })
    expect(
      mergeTransactionUpdate(pending, {
        status: 'confirming',
        confirmations: 2,
        requiredConfirmations: 10
      }).status
    ).toBe('confirming')
  })
})

test.describe('Confirmed transaction wallet settlement', () => {
  test('keeps monitoring until catch-up succeeds and reaches the confirming node height', () => {
    expect(isWalletSettlementComplete(false, 100, 100)).toBe(false)
    expect(isWalletSettlementComplete(true, 99, 100)).toBe(false)
    expect(isWalletSettlementComplete(true, 100, 100)).toBe(true)
    expect(isWalletSettlementComplete(true, 100)).toBe(true)
  })
})

test.describe('Withdraw and Received merge via destinationTxHash', () => {
  test('localTxHashSet includes destinationTxHash from withdraw records', () => {
    const withdrawTx = tx({
      id: 'tx_withdraw_1',
      txHash: 'origin_hash',
      type: 'withdraw',
      destinationTxHash: 'dest_zcash_hash'
    })
    const hashes = localTxHashSet([withdrawTx])
    expect(hashes.has(normalizeTxHash('origin_hash'))).toBe(true)
    expect(hashes.has(normalizeTxHash('dest_zcash_hash'))).toBe(true)
  })

  test('WASM receive matching withdraw destinationTxHash is deduplicated', () => {
    const withdrawTx = tx({
      id: 'tx_withdraw_1',
      txHash: 'near_hash',
      type: 'withdraw',
      destinationTxHash: 'DEST_ZCASH_HASH'
    })
    const wasmReceive = tx({
      id: 'wasm_dest_zcash_hash',
      txHash: 'dest_zcash_hash',
      type: 'receive',
      fromType: 'shielded'
    })
    const hashes = localTxHashSet([withdrawTx])
    expect(isDuplicateWasmRow(wasmReceive, hashes)).toBe(true)
  })

  test('unrelated WASM receive with same amount is NOT deduplicated (no fuzzy match)', () => {
    const withdrawTx = tx({
      id: 'tx_withdraw_1',
      txHash: 'near_hash',
      type: 'withdraw',
      amount: '1.5',
      destinationTxHash: 'dest_hash_a'
    })
    const unrelatedReceive = tx({
      id: 'wasm_unrelated',
      txHash: 'different_hash',
      type: 'receive',
      amount: '1.5',
      fromType: 'shielded'
    })
    const hashes = localTxHashSet([withdrawTx])
    expect(isDuplicateWasmRow(unrelatedReceive, hashes)).toBe(false)
  })

  test('withdraw without destinationTxHash does not suppress any receive', () => {
    const withdrawTx = tx({
      id: 'tx_withdraw_1',
      txHash: 'near_hash',
      type: 'withdraw'
    })
    const wasmReceive = tx({
      id: 'wasm_some_hash',
      txHash: 'some_hash',
      type: 'receive',
      fromType: 'shielded'
    })
    const hashes = localTxHashSet([withdrawTx])
    expect(isDuplicateWasmRow(wasmReceive, hashes)).toBe(false)
  })
})

test.describe('Withdraw monitor continuation', () => {
  test('withdraw and claim use relay_confirmed as intermediate status', () => {
    expect(getCrossChainCompletionStatus('withdraw')).toBe('relay_confirmed')
    expect(getCrossChainCompletionStatus('claim')).toBe('relay_confirmed')
  })

  test('supply and swap are final on relay success', () => {
    expect(getCrossChainCompletionStatus('supply')).toBe('success')
    expect(getCrossChainCompletionStatus('swap', { destinationChain: 'near' })).toBe('success')
    expect(getCrossChainCompletionStatus('swap', { destinationChain: 'zec' })).toBe(
      'relay_confirmed'
    )
  })

  test('Intents owns the final status of supply and swap origin transactions', () => {
    expect(isIntentsSettledTransaction('supply')).toBe(true)
    expect(isIntentsSettledTransaction('swap')).toBe(true)
    expect(isIntentsSettledTransaction('send')).toBe(false)
    expect(isIntentsSettledTransaction('withdraw')).toBe(false)
  })

  test('pending withdraw and claim records recover their relay monitor', () => {
    expect(
      needsRelayStatusRecovery(
        tx({ type: 'withdraw', status: 'pending', depositAddress: 'deposit-1' })
      )
    ).toBe(true)
    expect(
      needsRelayStatusRecovery(
        tx({ type: 'claim', status: 'relay_confirmed', depositAddress: 'deposit-2' })
      )
    ).toBe(true)
  })

  test('terminal or destination-bound records do not recover a relay monitor', () => {
    expect(
      needsRelayStatusRecovery(
        tx({ type: 'withdraw', status: 'success', depositAddress: 'deposit-1' })
      )
    ).toBe(false)
    expect(
      needsRelayStatusRecovery(
        tx({
          type: 'withdraw',
          status: 'relay_confirmed',
          depositAddress: 'deposit-1',
          destinationTxHash: 'destination'
        })
      )
    ).toBe(false)
    expect(
      needsRelayStatusRecovery(tx({ type: 'send', status: 'pending', depositAddress: 'deposit-1' }))
    ).toBe(false)
  })
})

test.describe('Source invariants for confirmation lifecycle', () => {
  const monitorSource = readFileSync(
    new URL('../../../src/background/zcash-tx-monitor.ts', import.meta.url),
    'utf-8'
  )
  const transactionMonitorSource = readFileSync(
    new URL('../../../src/background/transaction-monitor.ts', import.meta.url),
    'utf-8'
  )
  const backgroundSource = readFileSync(
    new URL('../../../src/background/index.ts', import.meta.url),
    'utf-8'
  )
  const walletTypes = readFileSync(
    new URL('../../../src/types/wallet.ts', import.meta.url),
    'utf-8'
  )
  const zcashWalletRuntimeSource = readFileSync(
    new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
    'utf-8'
  )

  test('TransactionStatus type includes confirming', () => {
    assert.match(walletTypes, /'confirming'/)
  })

  test('ZcashTxMonitor updates confirming status for mined-but-immature tx', () => {
    assert.match(monitorSource, /updateConfirmingStatus/)
  })

  test('ZcashTxMonitor keeps Intents-origin supply and swap pending', () => {
    assert.match(
      monitorSource,
      /lookup\.confirmations > 0 &&[\s\S]*?!isIntentsSettledTransaction\(tx\.type\)[\s\S]*?updateConfirmingStatus/
    )
  })

  test('ZcashTxMonitor does not timeout a mined tx', () => {
    assert.match(monitorSource, /Tx mined but immature, extending timeout/)
  })

  test('TransactionMonitor only persists destinationTxHash for a Zcash destination', () => {
    assert.match(
      transactionMonitorSource,
      /completionStatus === 'relay_confirmed' && destinationHash[\s\S]*?destinationTxHash: destinationHash/
    )
  })

  test('TransactionMonitor continues polling when Zcash destination SUCCESS has no dest hash', () => {
    assert.match(
      transactionMonitorSource,
      /if \(completionStatus === 'relay_confirmed' && !destinationHash\) \{[\s\S]*?await transactionRecorder\.updateTransaction\(accountKey, transactionId, updates\)[\s\S]*?return\s*\}/
    )
  })

  test('Background restores stuck withdraw monitors on startup', () => {
    assert.match(backgroundSource, /restoreStuckWithdrawMonitors/)
    assert.match(monitorSource, /restoreStuckWithdrawals/)
  })

  test('WASM history resolves confirmation status by transaction type', () => {
    assert.match(zcashWalletRuntimeSource, /resolveMinedTransactionStatus/)
    assert.match(zcashWalletRuntimeSource, /chainTip,[\s\S]*?type/)
  })

  test('Assets shows every unspendable balance without changing activity status', () => {
    const balanceSource = readFileSync(
      new URL('../../../src/popup/components/balance/BalanceWithPending.tsx', import.meta.url),
      'utf-8'
    )
    assert.match(balanceSource, /safeBig\(pending\)\.gt\(0\)/)
    assert.match(balanceSource, /ZEC unspendable/)
    assert.doesNotMatch(balanceSource, /DUST_THRESHOLD/)
    assert.doesNotMatch(balanceSource, /ZEC confirming/)
  })
})
