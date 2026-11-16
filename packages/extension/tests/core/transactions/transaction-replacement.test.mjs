import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  applyTransactionBroadcast,
  canSpeedUp,
  getTransactionRecoveryAction,
  resolveSpeedUpAmount
} from '../../../src/lib/transaction-replacement.ts'
import { isTransactionStatusUpdatedMessage } from '../../../src/types/transaction-messages.ts'

function transaction(overrides = {}) {
  return {
    id: 'tx_original',
    txHash: 'expired-hash',
    status: 'failed',
    type: 'send',
    amount: '0.05',
    to: 'tmRecipient',
    from: 'utestSender',
    fromType: 'shielded',
    fee: '0.0001',
    timestamp: 1,
    network: 'testnet',
    notified: true,
    failureReason: 'expired',
    ...overrides
  }
}

test.describe('Speed Up replacement lifecycle', () => {
  test('marks the expired transaction as replaced after the retry broadcasts', () => {
    const original = transaction()
    const replacement = transaction({
      id: 'tx_replacement',
      txHash: '',
      status: 'pending',
      failureReason: undefined,
      replacesTransactionId: original.id
    })

    expect(canSpeedUp(original)).toBe(true)

    const updated = applyTransactionBroadcast(
      [original, replacement],
      replacement.id,
      'replacement-hash',
      3_771_800
    )

    expect(updated.find(tx => tx.id === replacement.id)).toMatchObject({
      txHash: 'replacement-hash',
      status: 'pending',
      notified: false,
      expiryHeight: 3_771_800,
      replacesTransactionId: original.id
    })
    expect(updated.find(tx => tx.id === original.id)).toMatchObject({
      status: 'failed',
      failureReason: 'expired',
      replacedByTransactionId: replacement.id,
      replacedByTxHash: 'replacement-hash'
    })
    expect(canSpeedUp(updated.find(tx => tx.id === original.id))).toBe(false)
  })

  test('keeps Speed Up available when the replacement never broadcasts', () => {
    const original = transaction()
    const replacement = transaction({
      id: 'tx_replacement',
      txHash: '',
      status: 'failed',
      failureReason: undefined,
      replacesTransactionId: original.id
    })

    expect(canSpeedUp(original)).toBe(true)
    expect(canSpeedUp(replacement)).toBe(false)
  })

  test('reduces a Max retry when the higher fee lowers its spendable amount', () => {
    expect(resolveSpeedUpAmount('0.9897', '0.9888')).toBe('0.9888')
    expect(resolveSpeedUpAmount('0.5', '0.9888')).toBe('0.5')
    expect(resolveSpeedUpAmount('0.5', null)).toBe('0.5')
  })

  test('derives one recovery action for every transaction surface', () => {
    expect(getTransactionRecoveryAction(transaction())).toBe('speed_up')
    expect(getTransactionRecoveryAction(transaction({ failureReason: 'timeout' }))).toBe('retry')
    expect(getTransactionRecoveryAction(transaction({ status: 'pending' }))).toBe('none')
  })

  test('validates transaction status update messages at runtime', () => {
    expect(
      isTransactionStatusUpdatedMessage({
        type: 'TRANSACTION_STATUS_UPDATED',
        accountKey: 'testnet_wallet_account',
        transactionId: 'tx_original',
        status: 'failed',
        failureReason: 'expired'
      })
    ).toBe(true)
    expect(
      isTransactionStatusUpdatedMessage({
        type: 'TRANSACTION_STATUS_UPDATED',
        accountKey: 'testnet_wallet_account',
        transactionId: 'tx_original',
        status: 'failed',
        failureReason: 'unknown'
      })
    ).toBe(false)
    expect(
      isTransactionStatusUpdatedMessage({
        type: 'TRANSACTION_STATUS_UPDATED',
        accountKey: 'testnet_wallet_account',
        transactionId: 'tx_original',
        status: 'success',
        failureReason: 'expired'
      })
    ).toBe(false)
  })
})
