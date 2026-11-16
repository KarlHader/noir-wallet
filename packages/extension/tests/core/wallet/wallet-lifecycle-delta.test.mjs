import { test } from 'node:test'
import { expect } from '@playwright/test'
import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'
import {
  associateIncomingIntentsTransactions,
  mergeTransactionsWithTransparentReceives
} from '../../../src/core/wallet/transparent-history.ts'
import { resolveZcashResultView } from '../../../src/lib/transaction-result-model.ts'
import { isValidAddTransactionResponse } from '../../../src/lib/transaction-record-response.ts'
import { isSyncOccupyingWallet } from '../../../src/background/sync-status-policy.ts'
import { getZcashDestinationCatchUpThreshold } from '../../../src/lib/intents-progress.ts'
import { deliverTerminalNotificationAndRemoveTask } from '../../../src/background/tx-monitor-finalization.ts'
import { shouldRestoreZcashOriginMonitor } from '../../../src/background/tx-monitor-policy.ts'

function transaction(overrides = {}) {
  return {
    id: 'tx_receive',
    txHash: 'destination-hash',
    status: 'pending',
    type: 'receive',
    amount: '0.1',
    to: 't1wallet',
    from: '',
    fromType: 'transparent',
    fee: '0',
    timestamp: 1_700_000_000_000,
    network: 'mainnet',
    ...overrides
  }
}

test('uses the WASM shieldable amount when confirmed transparent funds include locked UTXOs', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    unshielded_balance: 20_000_000,
    unshielded_shieldable_balance: 8_000_000,
    unshielded_total_balance: 20_000_000
  })
  expect(balance.transparent).toBe('0.2')
  expect(balance.shieldable).toBe('0.08')
})

test('retains incoming swap ownership after transparent receive history is refreshed', () => {
  const swap = transaction({
    id: 'tx_swap',
    txHash: 'origin-hash',
    type: 'swap',
    fromType: 'shielded',
    depositAddress: 'deposit-address',
    destinationTxHash: 'DESTINATION-HASH'
  })
  const receive = transaction({ depositAddress: 'deposit-address' })
  const refreshed = transaction({ id: 'rpc_treceive_destination-hash', status: 'success' })
  const merged = mergeTransactionsWithTransparentReceives([swap, receive], [refreshed])
  expect(merged.find(tx => tx.type === 'receive')?.depositAddress).toBe('deposit-address')

  const associated = associateIncomingIntentsTransactions([swap, refreshed])
  expect(associated.find(tx => tx.type === 'receive')?.depositAddress).toBe('deposit-address')
})

test('recovers an out-of-order send result from its durable transaction record', () => {
  const result = { step: 'pending', timestamp: 1_700_000_000_000 }
  expect(resolveZcashResultView(result, transaction({ txHash: 'broadcast-hash' }))).toMatchObject({
    step: 'submitted',
    txHash: 'broadcast-hash'
  })
  expect(resolveZcashResultView(result, transaction({ status: 'success' })).step).toBe('success')
  expect(
    resolveZcashResultView({ step: 'submitted' }, transaction({ status: 'failed' })).step
  ).toBe('failed')
})

test('rejects malformed transaction creation responses before dispatching a send', () => {
  expect(isValidAddTransactionResponse({ success: true, transaction: { id: 'tx_1' } })).toBe(false)
  expect(isValidAddTransactionResponse({ success: true, transaction: transaction() })).toBe(true)
})

test('a visible sync preflight does not block a transaction, but an active scan does', () => {
  expect(isSyncOccupyingWallet(false, true, true)).toBe(false)
  expect(isSyncOccupyingWallet(true, true, true)).toBe(true)
  expect(isSyncOccupyingWallet(false, true, false)).toBe(true)
})

test('destination catch-up advances at first, wallet-selection, and spendability depth', () => {
  expect([0, 1, 2, 3, 9, 10].map(getZcashDestinationCatchUpThreshold)).toEqual([0, 1, 1, 3, 3, 10])
})

test('recovers broadcast unshield monitoring without treating builds or scanned receives as sends', () => {
  const unshield = transaction({ type: 'unshield', txHash: 'unshield-broadcast' })
  expect(shouldRestoreZcashOriginMonitor(unshield)).toBe(true)
  expect(shouldRestoreZcashOriginMonitor({ ...unshield, status: 'confirming' })).toBe(true)
  expect(shouldRestoreZcashOriginMonitor({ ...unshield, txHash: '' })).toBe(false)
  expect(shouldRestoreZcashOriginMonitor({ ...unshield, status: 'success' })).toBe(false)
  expect(shouldRestoreZcashOriginMonitor({ ...unshield, type: 'receive' })).toBe(false)
  expect(shouldRestoreZcashOriginMonitor({ ...unshield, id: 'wasm_scanned' })).toBe(false)
})

test('terminal notification survives a failed monitor task cleanup without repeating on retry', async () => {
  const delivered = []
  let cleanupAttempts = 0
  const removeTask = async () => {
    cleanupAttempts++
    if (cleanupAttempts === 1) throw new Error('storage write failed')
  }
  const notify = () => delivered.push('popup', 'system')

  await expect(deliverTerminalNotificationAndRemoveTask(true, notify, removeTask)).rejects.toThrow(
    'storage write failed'
  )
  expect(delivered).toEqual(['popup', 'system'])
  await deliverTerminalNotificationAndRemoveTask(false, notify, removeTask)
  expect(delivered).toEqual(['popup', 'system'])
  expect(cleanupAttempts).toBe(2)
})
