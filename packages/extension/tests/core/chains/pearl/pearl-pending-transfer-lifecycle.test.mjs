import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  PEARL_INTERRUPTED_SIGNING_GRACE_MS,
  assertPearlDiscoverySigner,
  assertPearlTransferRejectable,
  isPearlSigningInterrupted,
  pearlTransferHoldsReservations,
  selectPearlFinalizedConflict,
  startsPearlSigning
} from '../../../../src/infrastructure/chains/pearl/index.ts'

const ACCOUNT = 'prl1paccount'
const OTHER = 'prl1pother'

function awaitableTransfer(overrides = {}) {
  return {
    phase: 'awaiting-approval',
    transactionId: 'transaction:pearl:one',
    ...overrides
  }
}

test.describe('Pearl pending transfer lifecycle', () => {
  test('claims signing before a signature can exist and keeps the claim', () => {
    const pending = awaitableTransfer()
    const claimed = startsPearlSigning(pending, 1_000)
    expect(claimed.phase).toBe('signing')
    expect(claimed.signingStartedAt).toBe(1_000)
    expect(startsPearlSigning(claimed, 2_000)).toBe(claimed)
    expect(pearlTransferHoldsReservations(claimed)).toBe(true)
    expect(pearlTransferHoldsReservations(pending)).toBe(false)
  })

  test('rejects signing claims that never started and invalid timestamps', () => {
    expect(() => startsPearlSigning(awaitableTransfer({ phase: 'signed' }), 1)).toThrow(
      /approved request/
    )
    expect(() => startsPearlSigning(awaitableTransfer(), -1)).toThrow(/start time/)
  })

  test('refuses rejection once signing may have produced a signature', () => {
    expect(() => assertPearlTransferRejectable(awaitableTransfer())).not.toThrow()
    expect(() => assertPearlTransferRejectable(awaitableTransfer({ phase: 'signing' }))).toThrow(
      /cannot be rejected/
    )
  })

  test('only reconciles interrupted signing claims after the grace period', () => {
    const claimed = startsPearlSigning(awaitableTransfer(), 10_000)
    expect(isPearlSigningInterrupted(claimed, 10_000 + PEARL_INTERRUPTED_SIGNING_GRACE_MS - 1)).toBe(
      false
    )
    expect(isPearlSigningInterrupted(claimed, 10_000 + PEARL_INTERRUPTED_SIGNING_GRACE_MS)).toBe(
      true
    )
    expect(isPearlSigningInterrupted(awaitableTransfer(), Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test('requires the discovered signer to be the selected ChainAccount identity', () => {
    expect(() => assertPearlDiscoverySigner(ACCOUNT, ACCOUNT)).not.toThrow()
    expect(() => assertPearlDiscoverySigner(OTHER, ACCOUNT)).toThrow(/selected ChainAccount/)
    expect(() => assertPearlDiscoverySigner(undefined, ACCOUNT)).toThrow(/missing from discovery/)
  })
})

test.describe('Pearl finalized conflict selection', () => {
  const reserved = [`${'a'.repeat(64)}:0`, `${'a'.repeat(64)}:1`]

  test('selects a confirmed conflicting spend of a reserved outpoint', () => {
    const conflict = selectPearlFinalizedConflict({
      transactionHash: 'b'.repeat(64),
      reservedOutpoints: reserved,
      spends: [
        {
          transactionId: 'c'.repeat(64),
          spentOutpoints: [`${'a'.repeat(64)}:1`],
          confirmations: 3,
          blockHash: 'd'.repeat(64),
          blockHeight: 50
        }
      ]
    })
    expect(conflict).toEqual({
      transactionHash: 'c'.repeat(64),
      spentOutpoint: `${'a'.repeat(64)}:1`,
      blockHash: 'd'.repeat(64),
      blockHeight: 50,
      confirmations: 3
    })
  })

  test('ignores the transfer itself, unconfirmed spends, and unrelated outpoints', () => {
    expect(
      selectPearlFinalizedConflict({
        transactionHash: 'b'.repeat(64),
        reservedOutpoints: reserved,
        spends: [
          {
            transactionId: 'b'.repeat(64),
            spentOutpoints: reserved,
            confirmations: 6,
            blockHash: 'd'.repeat(64),
            blockHeight: 50
          },
          {
            transactionId: 'c'.repeat(64),
            spentOutpoints: reserved,
            confirmations: 0,
            blockHash: 'd'.repeat(64),
            blockHeight: 50
          },
          {
            transactionId: 'e'.repeat(64),
            spentOutpoints: [`${'f'.repeat(64)}:3`],
            confirmations: 6,
            blockHash: 'd'.repeat(64),
            blockHeight: 50
          }
        ]
      })
    ).toBeNull()
  })

  test('prefers the most confirmed conflict and rejects invalid input', () => {
    const conflict = selectPearlFinalizedConflict({
      transactionHash: 'b'.repeat(64),
      reservedOutpoints: reserved,
      spends: [
        {
          transactionId: 'c'.repeat(64),
          spentOutpoints: reserved,
          confirmations: 1,
          blockHash: 'd'.repeat(64),
          blockHeight: 40
        },
        {
          transactionId: 'e'.repeat(64),
          spentOutpoints: reserved,
          confirmations: 9,
          blockHash: 'd'.repeat(64),
          blockHeight: 45
        }
      ]
    })
    expect(conflict?.transactionHash).toBe('e'.repeat(64))
    expect(() =>
      selectPearlFinalizedConflict({
        transactionHash: 'nope',
        reservedOutpoints: reserved,
        spends: []
      })
    ).toThrow(/transaction hash/)
    expect(() =>
      selectPearlFinalizedConflict({
        transactionHash: 'b'.repeat(64),
        reservedOutpoints: [],
        spends: []
      })
    ).toThrow(/reserved outpoints/)
  })
})
