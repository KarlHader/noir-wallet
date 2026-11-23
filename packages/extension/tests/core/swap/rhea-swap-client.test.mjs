import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createRheaSwapClient,
  getRheaSwapErrorMessage,
  RheaSwapClientError
} from '../../../src/popup/services/rhea-swap-client.ts'
import { RHEA_SWAP_CHAIN_CATALOG } from '../../../src/core/services/rhea-swap/index.ts'
import { EvmWalletClientError } from '../../../src/popup/services/evm-wallet-client.ts'
import { isSwapQuotePriceMoved } from '../../../src/popup/services/swap-quote-error-message.ts'

function token() {
  return {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    contractAddress: null,
    decimals: 18,
    icon: null,
    price: 1,
    priceUpdatedAt: '2026-09-02T00:00:00.000Z',
    symbol: 'ETH',
    rheaChainId: '1',
    tokenListChainId: 1,
    rheaAddress: 'nep141:eth.omft.near',
    isNative: true
  }
}

test('shows native NEAR in the from catalog without storing a second wrap.near row', async () => {
  let sends = 0
  const wrap = {
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    contractAddress: 'wrap.near',
    decimals: 24,
    icon: null,
    price: 5,
    priceUpdatedAt: '2026-09-02T00:00:00.000Z',
    symbol: 'wNEAR',
    rheaChainId: 'near',
    tokenListChainId: 900001,
    rheaAddress: 'wrap.near',
    isNative: false,
    sources: ['nearintents']
  }
  const usdt = {
    ...wrap,
    assetId: 'nep141:usdt.tether-token.near',
    contractAddress: 'usdt.tether-token.near',
    decimals: 6,
    symbol: 'USDT',
    rheaAddress: 'usdt.tether-token.near',
    price: 1
  }
  const client = createRheaSwapClient(async () => {
    sends += 1
    return { result: { tokens: [usdt, wrap], failedChainIds: [] } }
  })
  const request = { direction: 'from', tokenListChainIds: [900001] }
  const listed = await client.listTokens(request)
  expect(listed.tokens.map(token => [token.symbol, token.isNative])).toEqual([
    ['USDT', false],
    ['NEAR', true],
    ['wNEAR', false]
  ])
  expect(sends).toBe(1)
  const cached = await client.listTokens(request)
  expect(cached.tokens.map(token => token.symbol)).toEqual(['USDT', 'NEAR', 'wNEAR'])
  expect(sends).toBe(1)
  const destination = await client.listTokens({
    direction: 'cross-chain-to',
    tokenListChainIds: [900001]
  })
  expect(destination.tokens.map(token => token.symbol)).toEqual(['USDT', 'wNEAR'])
  expect(sends).toBe(2)
})

test('shows the useful minimum from RHEA quote and swap errors', () => {
  expect(
    getRheaSwapErrorMessage(new RheaSwapClientError('RHEA Swap returned an invalid response'))
  ).toBe('Swap provider returned an invalid quote. Try again.')
  expect(
    getRheaSwapErrorMessage(new RheaSwapClientError('RHEA Swap build does not match its quote'))
  ).toBe('Swap transaction details differ from the quote. Get a new quote.')
  expect(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('Temporary swap limits: minimum swap amount is $1,000')
    )
  ).toBe('Minimum swap amount is $1,000.')
  expect(getRheaSwapErrorMessage(new Error('Minimum swap amount is $1,000'))).toBe(
    'Amount is below the current minimum for this Swap route.'
  )
  expect(
    getRheaSwapErrorMessage(
      new EvmWalletClientError(
        'quote-expired',
        'RHEA Swap quote expired. Get a new quote and review it again.'
      )
    )
  ).toBe('Swap quote expired. Get a new quote and review it again.')
  const moved = new RheaSwapClientError('Price moved too much, please re-quote')
  expect(isSwapQuotePriceMoved(moved)).toBe(true)
  expect(getRheaSwapErrorMessage(moved)).toBe('Price moved too much, please re-quote')
  expect(getRheaSwapErrorMessage(new Error(moved.message))).toBe(moved.message)
  expect(isSwapQuotePriceMoved(new RheaSwapClientError('Slippage tolerance exceeded'))).toBe(false)
})

test('hydrates a prewarmed public catalog without a token request and keeps its expiry', async () => {
  let now = 100
  let reads = 0
  let sends = 0
  const request = { direction: 'from', tokenListChainIds: [1] }
  const result = { tokens: [{ ...token(), sources: ['nearintents'] }], failedChainIds: [] }
  const client = createRheaSwapClient(
    async () => {
      sends++
      return { result }
    },
    {
      now: () => now,
      readPersistentCatalog: async () => {
        reads++
        return { result, expiresAt: 200 }
      }
    }
  )
  const [first, second] = await Promise.all([
    client.hydrateCachedTokens(request),
    client.hydrateCachedTokens(request)
  ])
  expect(first).toEqual(result)
  expect(second).toEqual(result)
  expect(reads).toBe(1)
  expect(await client.listTokens(request)).toEqual(result)
  expect(sends).toBe(0)
  now = 200
  expect(await client.listTokens(request)).toEqual(result)
  expect(sends).toBe(1)
})

test('retains both directions for every supported chain without evicting source catalogs', async () => {
  let calls = 0
  const client = createRheaSwapClient(async message => {
    calls += 1
    const chain = RHEA_SWAP_CHAIN_CATALOG.find(
      chain => chain.tokenListChainId === message.tokenListChainIds[0]
    )
    return {
      result: {
        tokens: [
          {
            ...token(),
            rheaChainId: chain.apiChainId,
            tokenListChainId: chain.tokenListChainId,
            blockchain: chain.blockchain
          }
        ],
        failedChainIds: []
      }
    }
  })
  for (const direction of ['from', 'cross-chain-to']) {
    for (const chain of RHEA_SWAP_CHAIN_CATALOG) {
      await client.listTokens({ direction, tokenListChainIds: [chain.tokenListChainId] })
    }
  }
  const initialCalls = calls
  for (const direction of ['from', 'cross-chain-to']) {
    for (const chain of RHEA_SWAP_CHAIN_CATALOG) {
      await client.listTokens({ direction, tokenListChainIds: [chain.tokenListChainId] })
    }
  }
  expect(calls).toBe(initialCalls)
})

test('reads large multi-chain catalogs while isolating and retrying a failed chain', async () => {
  const calls = new Map()
  let failPolygon = true
  const rows = new Map(
    [
      [1, 'eth'],
      [10, 'op']
    ].map(([chainId, blockchain]) => [
      chainId,
      Array.from({ length: 8_200 }, (_, index) => ({
        ...token(),
        assetId: `asset:${chainId}:${index}`,
        blockchain,
        contractAddress: `0x${index.toString(16).padStart(40, '0')}`,
        rheaChainId: String(chainId),
        tokenListChainId: chainId,
        rheaAddress: `0x${index.toString(16).padStart(40, '0')}`,
        isNative: false,
        sources: ['nearintents']
      }))
    ])
  )
  const client = createRheaSwapClient(async message => {
    const [chainId] = message.tokenListChainIds
    expect(message.tokenListChainIds).toHaveLength(1)
    calls.set(chainId, (calls.get(chainId) ?? 0) + 1)
    if (chainId === 137 && failPolygon) throw new Error('Network unavailable')
    return {
      result: {
        tokens: rows.get(chainId) ?? [
          { ...token(), blockchain: 'pol', rheaChainId: '137', tokenListChainId: 137 }
        ],
        failedChainIds: []
      }
    }
  })
  const request = { direction: 'cross-chain-to', tokenListChainIds: [137, 10, 1] }
  const [first, overlapping] = await Promise.all([
    client.listTokens(request),
    client.listTokens({ direction: request.direction, tokenListChainIds: [10, 1] })
  ])
  expect(first.tokens).toHaveLength(16_400)
  expect(first.failedChainIds).toEqual([137])
  expect(overlapping.tokens).toHaveLength(16_400)
  expect(client.readCachedTokens(request)).toBeNull()
  expect([...calls].sort((left, right) => left[0] - right[0])).toEqual([
    [1, 1],
    [10, 1],
    [137, 1]
  ])

  failPolygon = false
  const retried = await client.listTokens(request)
  expect(retried.tokens).toHaveLength(16_401)
  expect(retried.failedChainIds).toEqual([])
  expect(client.readCachedTokens(request)).toEqual(retried)
  expect([...calls].sort((left, right) => left[0] - right[0])).toEqual([
    [1, 1],
    [10, 1],
    [137, 2]
  ])
})
