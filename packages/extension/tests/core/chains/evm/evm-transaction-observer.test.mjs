import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  EvmRpcError,
  broadcastSignedEvmTransaction,
  observeEvmTransaction
} from '../../../../src/infrastructure/chains/evm/index.ts'

const transactionHash = `0x${'a'.repeat(64)}`
const otherTransactionHash = `0x${'c'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`

function rpc(overrides = {}) {
  return {
    broadcastRawTransaction: async () => transactionHash,
    hasTransaction: async () => true,
    getTransactionReceipt: async () => null,
    getTransactionLocation: async () => ({ status: 'pending' }),
    getFinalizedBlockNumber: async () => '100',
    ...overrides
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function receipt(status, blockNumber = '100') {
  return { transactionHash, blockHash, blockNumber, status }
}

test.describe('EVM broadcast and receipt observer', () => {
  test('requires the RPC broadcast hash to match the WASM-signed hash', async () => {
    await expect(
      broadcastSignedEvmTransaction({
        rawTransaction: '0x02',
        expectedTransactionHash: transactionHash,
        rpc: rpc()
      })
    ).resolves.toBe(transactionHash)

    const mismatch = await captureError(
      broadcastSignedEvmTransaction({
        rawTransaction: '0x02',
        expectedTransactionHash: transactionHash,
        rpc: rpc({ broadcastRawTransaction: async () => otherTransactionHash })
      })
    )
    expect(mismatch).toBeInstanceOf(EvmRpcError)
    expect(mismatch.code).toBe('invalid-response')
  })

  test('keeps an RPC-proven pending transaction at broadcast without guessing failure', async () => {
    await expect(observeEvmTransaction(transactionHash, rpc())).resolves.toEqual({
      status: 'broadcast',
      transactionHash
    })
  })

  test('treats a missing receipt without pending evidence as unresolved', async () => {
    await expect(
      observeEvmTransaction(
        transactionHash,
        rpc({ getTransactionLocation: async () => ({ status: 'unknown' }) })
      )
    ).resolves.toBeNull()
    await expect(
      observeEvmTransaction(
        transactionHash,
        rpc({
          getTransactionLocation: async () => ({
            status: 'included',
            blockHash,
            blockNumber: '100'
          })
        })
      )
    ).resolves.toBeNull()
  })

  test('treats a mined successful receipt as confirmed without waiting for finalized', async () => {
    await expect(
      observeEvmTransaction(
        transactionHash,
        rpc({
          getTransactionReceipt: async () => receipt('success', '101'),
          getFinalizedBlockNumber: async () => {
            throw new Error('finalized block must not be requested')
          }
        })
      )
    ).resolves.toEqual({
      status: 'final',
      transactionHash,
      blockHash,
      blockNumber: '101',
      receiptStatus: 'success'
    })
  })

  test('treats a mined reverted receipt as terminal failure', async () => {
    await expect(
      observeEvmTransaction(
        transactionHash,
        rpc({
          getTransactionReceipt: async () => receipt('failed', '101')
        })
      )
    ).resolves.toEqual({
      status: 'failed',
      transactionHash,
      blockHash,
      blockNumber: '101',
      failureCode: 'execution-reverted'
    })
  })

  test('rejects malformed block numbers from an injected RPC boundary', async () => {
    const error = await captureError(
      observeEvmTransaction(
        transactionHash,
        rpc({ getTransactionReceipt: async () => receipt('success', '0x64') })
      )
    )
    expect(error).toBeInstanceOf(EvmRpcError)
    expect(error.code).toBe('invalid-response')
  })

  test('rejects a receipt for another transaction', async () => {
    const error = await captureError(
      observeEvmTransaction(
        transactionHash,
        rpc({
          getTransactionReceipt: async () => ({
            ...receipt('success'),
            transactionHash: otherTransactionHash
          })
        })
      )
    )
    expect(error).toBeInstanceOf(EvmRpcError)
    expect(error.code).toBe('invalid-response')
  })
})
