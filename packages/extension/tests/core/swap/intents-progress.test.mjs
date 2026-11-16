import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  INTENTS_PROGRESS_STALE_MS,
  isIntentsProgressStale,
  normalizeIntentsProgressEntry,
  registerIntentsProgress,
  updateIntentsProgressStatus
} from '../../../src/lib/intents-progress.ts'
import {
  createIntentsDeadline,
  getIntentsQuoteValidityMs
} from '../../../src/lib/intents-timeouts.ts'
import {
  getIntentsStatusCopy,
  getTransactionStatusCopy
} from '../../../src/lib/transaction-status-copy.ts'
import { getSwapResultAction } from '../../../src/popup/components/swap/swap-status-model.ts'

const INPUT = {
  depositAddress: 't1deposit',
  tokenInSymbol: 'ZEC',
  tokenOutSymbol: 'NEAR',
  amountIn: '1',
  amountOut: '2',
  actionName: 'Swap',
  accountKey: 'mainnet_wallet_account',
  originChain: 'zec',
  destinationChain: 'near'
}

test.describe('Intents quote validity', () => {
  test('uses ten minutes normally and thirty minutes for Zcash or Bitcoin routes', () => {
    expect(getIntentsQuoteValidityMs('near', 'eth')).toBe(10 * 60 * 1000)
    expect(getIntentsQuoteValidityMs('zec', 'near')).toBe(30 * 60 * 1000)
    expect(getIntentsQuoteValidityMs('eth', 'btc')).toBe(30 * 60 * 1000)
    expect(getIntentsQuoteValidityMs('ZCASH', 'near')).toBe(30 * 60 * 1000)

    const now = Date.parse('2026-09-04T00:00:00.000Z')
    expect(createIntentsDeadline('near', 'eth', now)).toBe('2026-09-04T00:10:00.000Z')
    expect(createIntentsDeadline('zec', 'near', now)).toBe('2026-09-04T00:30:00.000Z')
  })
})

test.describe('Intents progress lifecycle', () => {
  test('keeps the first-seen time and links a later local transaction', () => {
    const original = registerIntentsProgress(INPUT, undefined, 1_000)
    const linked = registerIntentsProgress({ ...INPUT, transactionId: 'tx-1' }, original, 2_000)

    expect(linked.createdAt).toBe(1_000)
    expect(linked.lastStatusChangeAt).toBe(1_000)
    expect(linked.transactionId).toBe('tx-1')
  })

  test('only resets the stale timer when the remote status changes', () => {
    const pending = registerIntentsProgress(INPUT, undefined, 1_000)
    const unchanged = updateIntentsProgressStatus(pending, 'PENDING_DEPOSIT', 2_000)
    const processing = updateIntentsProgressStatus(unchanged, 'PROCESSING', 3_000)

    expect(unchanged).toBe(pending)
    expect(processing.lastStatusChangeAt).toBe(3_000)
    expect(isIntentsProgressStale(processing, 3_000 + INTENTS_PROGRESS_STALE_MS - 1)).toBe(false)
    expect(isIntentsProgressStale(processing, 3_000 + INTENTS_PROGRESS_STALE_MS)).toBe(true)
  })

  test('validates persisted entries and migrates the previous monitor shape', () => {
    const migrated = normalizeIntentsProgressEntry(INPUT, 4_000)
    expect(migrated).toMatchObject({
      ...INPUT,
      status: 'PENDING_DEPOSIT',
      createdAt: 4_000,
      lastStatusChangeAt: 4_000
    })
    expect(normalizeIntentsProgressEntry({ depositAddress: 'missing-fields' })).toBeNull()
  })
})

test.describe('Intents user-facing status copy', () => {
  test('defines every 1Click status in one mapping', () => {
    const statuses = [
      'KNOWN_DEPOSIT_TX',
      'PENDING_DEPOSIT',
      'INCOMPLETE_DEPOSIT',
      'PROCESSING',
      'SUCCESS',
      'REFUNDED',
      'FAILED'
    ]
    const copies = Object.fromEntries(
      statuses.map(status => [status, getIntentsStatusCopy(status)])
    )
    const labels = Object.fromEntries(statuses.map(status => [status, copies[status].label]))

    expect(labels).toEqual({
      KNOWN_DEPOSIT_TX: 'Deposit confirming',
      PENDING_DEPOSIT: 'Waiting for deposit',
      INCOMPLETE_DEPOSIT: 'Deposit amount too low',
      PROCESSING: 'Intents processing',
      SUCCESS: 'Transaction complete',
      REFUNDED: 'Refund submitted',
      FAILED: 'Failed'
    })
    expect(statuses.map(status => copies[status].tone)).toEqual([
      'neutral',
      'neutral',
      'warning',
      'neutral',
      'success',
      'neutral',
      'error'
    ])
    expect(copies.FAILED.tone).toBe('error')
  })

  test('treats Intents SUCCESS as final except while Zcash destination confirmation is pending', () => {
    const completed = getIntentsStatusCopy('SUCCESS', {
      actionName: 'Swap',
      hasDestinationTxHash: true
    })
    expect(completed).toMatchObject({
      label: 'Swap complete',
      resultStatus: 'success',
      tone: 'success'
    })
    expect(getIntentsStatusCopy('SUCCESS', { actionName: 'Swap' }).resultStatus).toBe('success')
    expect(
      getIntentsStatusCopy('SUCCESS', {
        actionName: 'Swap',
        waitsForZcashConfirmations: true,
        destinationConfirmations: 2,
        requiredConfirmations: 10
      }).resultStatus
    ).toBe('loading')
  })

  test('opens Activity for a failed swap while preserving confidential funding actions', () => {
    expect(getSwapResultAction(getIntentsStatusCopy('PENDING_DEPOSIT').resultStatus, false)).toBe(
      'view-activity'
    )
    expect(getSwapResultAction(getIntentsStatusCopy('SUCCESS').resultStatus, false)).toBe('done')
    expect(getSwapResultAction(getIntentsStatusCopy('FAILED').resultStatus, false)).toBe(
      'view-activity'
    )
    expect(getSwapResultAction('failed', false, true)).toBe('done')
    expect(getSwapResultAction('loading', true)).toBe('continue')
  })

  test('maps local Activity states without consumers comparing display strings', () => {
    const base = {
      id: 'tx-1',
      txHash: 'origin-hash',
      status: 'pending',
      type: 'swap',
      amount: '1',
      to: 'destination',
      from: 'source',
      fromType: 'shielded',
      fee: '0.0001',
      timestamp: 1_000,
      network: 'mainnet',
      depositAddress: 'deposit'
    }

    expect(getTransactionStatusCopy(base, 1_000)).toMatchObject({
      key: 'waiting_confirmation',
      tone: 'neutral'
    })
    expect(getTransactionStatusCopy(base, 1_000 + INTENTS_PROGRESS_STALE_MS).label).toBe(
      'Status unavailable'
    )
    expect(getTransactionStatusCopy({ ...base, status: 'success' }).tone).toBe('neutral')
    expect(
      getTransactionStatusCopy({
        ...base,
        status: 'success',
        destinationTxHash: 'destination-hash'
      }).tone
    ).toBe('success')
    expect(getTransactionStatusCopy({ ...base, status: 'failed' }).tone).toBe('error')
  })
})
