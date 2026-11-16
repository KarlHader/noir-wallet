import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  estimateRheaRouteMaximum,
  fallbackTransferMaximum,
  resolveTransferSpendableRaw,
  isTransferAmountSpendable
} from '../../../src/popup/services/transfer-maximum.ts'
import { EvmWalletClientError } from '../../../src/popup/services/evm-wallet-client.ts'
import { TransferMaximumEstimateCache } from '../../../src/popup/services/transfer-maximum-cache.ts'

const maximum = amountRaw => ({
  amountRaw,
  networkFeeRaw: '100',
  networkFeeSymbol: 'ETH',
  networkFeeDecimals: 18
})

test('Max reuse is scoped to the current recipient, balance and account context', async () => {
  const cache = new TransferMaximumEstimateCache()
  const original = 'account-a:recipient-a:balance-1000'
  const changed = 'account-b:recipient-b:balance-500'
  cache.setScope(original)
  let completeOld
  const old = cache.request(
    original,
    () =>
      new Promise(resolve => {
        completeOld = resolve
      })
  )
  cache.setScope(changed)
  expect(cache.read(changed)).toBeNull()
  cache.setScope(original)
  const fresh = await cache.request(original, async () => maximum('800'))
  completeOld(maximum('900'))
  await old
  expect(cache.read(original)).toEqual(fresh)
  expect(cache.read(changed)).toBeNull()
})

test('Max shares a fresh estimate, expires it and retries a failed calculation', async () => {
  let now = 1_000
  const cache = new TransferMaximumEstimateCache(() => now)
  cache.setScope('transfer')
  let complete
  const pending = cache.request(
    'transfer',
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const joined = cache.request('transfer', async () => {
    throw new Error('must share pending')
  })
  complete({ ...maximum('900'), expiresAt: 2_000 })
  expect(await joined).toEqual(await pending)
  expect(cache.read('transfer')?.amountRaw).toBe('900')
  now = 2_000
  expect(cache.read('transfer')).toBeNull()
  await expect(
    cache.request('transfer', async () => {
      throw new Error('fee unavailable')
    })
  ).rejects.toThrow('fee unavailable')
  expect(cache.read('transfer')).toBeNull()
  await expect(cache.request('transfer', async () => maximum('850'))).resolves.toMatchObject({
    amountRaw: '850',
    expiresAt: 32_000
  })
})

test('an exact review adjustment supersedes an older in-flight Max estimate', async () => {
  const cache = new TransferMaximumEstimateCache()
  cache.setScope('transfer')
  let complete
  const pending = cache.request(
    'transfer',
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const adjusted = cache.update('transfer', maximum('700'))
  complete(maximum('900'))
  await pending
  expect(cache.read('transfer')).toEqual(adjusted)
})

test('uses one fee-adjusted amount for display, Max and validation without deducting token gas', () => {
  expect(resolveTransferSpendableRaw('1000', null, true)).toBe('1000')
  expect(isTransferAmountSpendable('1000', null)).toBe(false)
  const available = resolveTransferSpendableRaw('1000', '900', true)
  expect(isTransferAmountSpendable('900', available)).toBe(true)
  expect(isTransferAmountSpendable('901', available)).toBe(false)
  expect(resolveTransferSpendableRaw('1000', null, false)).toBe('1000')
  expect(() => resolveTransferSpendableRaw('1000', '1001', true)).toThrow('Invalid')
})

test('fee-estimate failure leaves a positive native proposal with a fee reserve on each family', () => {
  for (const [family, decimals, availableRaw, symbol] of [
    ['evm', 18, '4867000000000000', 'ETH'],
    ['bitcoin', 8, '100000', 'BTC'],
    ['solana', 9, '2500000000', 'SOL'],
    ['near', 24, '2500000000000000000000000', 'NEAR']
  ]) {
    const source = {
      family,
      asset: { balance: { availableRaw }, metadata: { decimals } },
      networkFeeAsset: { metadata: { symbol, decimals } }
    }
    const fallback = fallbackTransferMaximum(source)
    expect(BigInt(fallback.amountRaw)).toBeGreaterThan(0n)
    expect(BigInt(fallback.amountRaw)).toBeLessThan(BigInt(availableRaw))
    expect(BigInt(fallback.amountRaw) + BigInt(fallback.networkFeeRaw)).toBe(BigInt(availableRaw))
  }
})

test('estimates confidential native gas using the actual smaller route and discards the unsigned quote', async () => {
  const calls = []
  const token = {
    rheaChainId: '1',
    rheaAddress: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    decimals: 18,
    isNative: true
  }
  const source = {
    family: 'evm',
    refundAddress: '0x1111111111111111111111111111111111111111',
    asset: { balance: { availableRaw: '1000000000000000000' } }
  }
  const transaction = {
    chainId: 1,
    to: '0x4444444444444444444444444444444444444444',
    value: '500000000000000000',
    data: '0x12345678'
  }
  const dependencies = {
    rhea: {
      quote: async (request, purpose) => {
        calls.push(['quote', request, purpose])
        return { quoteHandle: 'probe' }
      },
      prepare: async () => ({
        amountIn: '500000000000000000',
        execution: { kind: 'evm-transaction', target: transaction.to }
      }),
      getEvmTransactionPlan: async () => ({ transaction }),
      discard: async handle => {
        calls.push(['discard', handle])
      }
    },
    transfer: {
      estimateMaximum: async request => {
        calls.push(['estimate', request])
        return { amountRaw: '999550000000000000' }
      }
    }
  }
  const input = {
    source,
    tokenIn: token,
    tokenOut: token,
    recipient: '0x2222222222222222222222222222222222222222',
    confidential: true,
    purpose: 'private-swap',
    executionMode: 'private',
    feeTier: 'fast'
  }
  await expect(estimateRheaRouteMaximum(input, dependencies)).resolves.toMatchObject({
    amountRaw: '999550000000000000'
  })
  expect(calls[0]).toMatchObject([
    'quote',
    {
      amountIn: '500000000000000000',
      confidentiality: 'basic',
      sender: source.refundAddress,
      recipient: input.recipient
    },
    'private-swap'
  ])
  expect(calls[1]).toMatchObject([
    'estimate',
    {
      executionMode: 'private',
      feeTier: 'fast',
      evmTransaction: transaction,
      quotedAmountRaw: '500000000000000000'
    }
  ])
  expect(calls[2]).toEqual(['discard', 'probe'])
  dependencies.transfer.estimateMaximum = async () => {
    throw new Error('RPC failed')
  }
  await expect(estimateRheaRouteMaximum(input, dependencies)).rejects.toThrow('RPC failed')
  expect(calls.at(-1)).toEqual(['discard', 'probe'])
})

test('re-quotes a smaller bound route when gas costs more than half the native balance', async () => {
  const amounts = []
  const purposes = []
  const discarded = []
  const token = {
    rheaChainId: '1',
    rheaAddress: 'native',
    symbol: 'ETH',
    decimals: 18,
    isNative: true
  }
  const source = {
    family: 'evm',
    refundAddress: 'sender',
    asset: { balance: { availableRaw: '1000' } }
  }
  const dependencies = {
    rhea: {
      quote: async (request, purpose) => {
        amounts.push(request.amountIn)
        purposes.push(purpose)
        return { quoteHandle: request.amountIn }
      },
      prepare: async handle => ({
        amountIn: handle,
        execution: { kind: 'evm-transaction', target: 'router' }
      }),
      getEvmTransactionPlan: async handle => ({ transaction: { value: handle, data: '0x1234' } }),
      discard: async handle => {
        discarded.push(handle)
      }
    },
    transfer: {
      estimateMaximum: async request => {
        if (BigInt(request.evmTransaction.value) + 700n > 1000n)
          throw new EvmWalletClientError('insufficient-funds', 'Not enough gas')
        return { amountRaw: '300' }
      }
    }
  }
  await expect(
    estimateRheaRouteMaximum(
      {
        source,
        tokenIn: token,
        tokenOut: token,
        recipient: 'recipient',
        confidential: true,
        purpose: 'confidential-funding',
        executionMode: 'main'
      },
      dependencies
    )
  ).resolves.toMatchObject({ amountRaw: '300' })
  expect(amounts).toEqual(['500', '250'])
  expect(purposes).toEqual(['confidential-funding', 'confidential-funding'])
  expect(discarded).toEqual(['500', '250'])
})
