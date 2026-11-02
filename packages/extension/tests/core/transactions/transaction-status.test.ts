import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getCrossChainCompletionStatus,
  isZcashDestination
} from '../../../src/lib/cross-chain-transaction'
import {
  getRequiredConfirmations,
  isRecoverableZcashFailure,
  mergeTransactionUpdate
} from '../../../src/lib/transaction-status'
import { shouldRestoreZcashOriginMonitor } from '../../../src/background/tx-monitor-policy'
import { lookupTransaction } from '../../../src/lib/zcash-node-rpc'
import type { Transaction } from '../../../src/types/wallet'

const txHash = 'a'.repeat(64)
const failedTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'tx_local',
  txHash,
  status: 'failed',
  type: 'send',
  amount: '1',
  to: 't1recipient',
  from: 'u1sender',
  fee: '0.0001',
  timestamp: 1,
  network: 'mainnet',
  failureReason: 'timeout',
  notified: true,
  ...overrides
})

test.describe('Cross-chain completion status', () => {
  test('outbound supply and swap are final when the relay succeeds', () => {
    expect(getCrossChainCompletionStatus('supply')).toBe('success')
    expect(getCrossChainCompletionStatus('swap', { destinationChain: 'near' })).toBe('success')
  })

  test('withdraw, claim, and inbound swaps wait for destination Zcash confirmations', () => {
    expect(getCrossChainCompletionStatus('withdraw')).toBe('relay_confirmed')
    expect(getCrossChainCompletionStatus('claim')).toBe('relay_confirmed')
    expect(getCrossChainCompletionStatus('swap', { destinationChain: 'zec' })).toBe(
      'relay_confirmed'
    )
    expect(isZcashDestination({ destinationAsset: 'nep141:zec.omft.near' })).toBe(true)
  })

  test('restores monitors for failed local Zcash transactions with hashes only', () => {
    expect(shouldRestoreZcashOriginMonitor(failedTransaction())).toBe(true)
    expect(shouldRestoreZcashOriginMonitor(failedTransaction({ type: 'unshield' }))).toBe(true)
    expect(
      shouldRestoreZcashOriginMonitor(failedTransaction({ status: 'pending', type: 'receive' }))
    ).toBe(false)
    expect(
      shouldRestoreZcashOriginMonitor(
        failedTransaction({ id: 'wasm_tx', txHash: '', type: 'send' })
      )
    ).toBe(false)
    expect(shouldRestoreZcashOriginMonitor(failedTransaction({ type: 'swap' }))).toBe(false)
    expect(getRequiredConfirmations('unshield')).toBe(getRequiredConfirmations('send'))
    expect(isRecoverableZcashFailure(failedTransaction({ type: 'unshield' }))).toBe(true)
    expect(isRecoverableZcashFailure(failedTransaction({ type: 'supply' }))).toBe(false)
  })

  test('rejects mismatched tx identity and invalid confirmation counts from the node', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const result of [
        { txid: 'b'.repeat(64), confirmations: 10 },
        { txid: txHash, confirmations: -1 },
        { txid: txHash, confirmations: 1.5 }
      ]) {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ result }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        await expect(lookupTransaction('https://node.example', txHash)).resolves.toEqual({
          status: 'error'
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('recovers failed standalone activity only with matching mature Zcash confirmation proof', () => {
    const failed = failedTransaction()
    const requiredConfirmations = getRequiredConfirmations('send')
    const recover = (confirmation: { txHash: string; confirmations: number }) =>
      mergeTransactionUpdate(failed, { status: 'success', txHash }, confirmation)

    expect(recover({ txHash, confirmations: requiredConfirmations })).toMatchObject({
      status: 'success',
      confirmations: requiredConfirmations,
      notified: false,
      requiredConfirmations
    })
    expect(recover({ txHash: 'b'.repeat(64), confirmations: requiredConfirmations }).status).toBe(
      'failed'
    )
    expect(recover({ txHash, confirmations: requiredConfirmations - 1 }).status).toBe('failed')
    expect(
      mergeTransactionUpdate(
        failedTransaction({ type: 'swap' }),
        { status: 'success', txHash },
        { txHash, confirmations: 10 }
      ).status
    ).toBe('failed')
    const failedUnshield = failedTransaction({ type: 'unshield' })
    const unshieldConfirmations = getRequiredConfirmations('unshield')
    expect(
      mergeTransactionUpdate(
        failedUnshield,
        { status: 'success', txHash },
        { txHash, confirmations: unshieldConfirmations }
      )
    ).toMatchObject({
      status: 'success',
      confirmations: unshieldConfirmations,
      requiredConfirmations: unshieldConfirmations,
      notified: false
    })
    expect(mergeTransactionUpdate(failed, { status: 'success', txHash }).status).toBe('failed')
  })
})
