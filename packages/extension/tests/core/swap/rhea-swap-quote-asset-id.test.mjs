import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  normalizeCrossChainToTokenList,
  normalizeFromTokenList,
  serializeQuoteRequest
} from '@rhea-finance/cross-chain-aggregation-dex'
import {
  parseRheaSwapQuoteRequest,
  toRheaSwapToken,
  toSdkQuoteRequest
} from '../../../src/core/services/rhea-swap/rhea-swap-model.ts'
import { parseRheaSwapToken } from '../../../src/core/services/rhea-swap/rhea-swap-runtime.ts'
import {
  filterSelectableSwapDestinationTokens,
  filterSwapDestinationTokens
} from '../../../src/popup/services/swap-page-model.ts'
import {
  getRheaSwapErrorMessage,
  RheaSwapClientError
} from '../../../src/popup/services/rhea-swap-client.ts'
import {
  MemoryRheaSwapQuoteSessionStore,
  RheaSwapService
} from '../../../src/core/services/rhea-swap/rhea-swap-service.ts'

const zcashCatalogRow = Object.freeze({
  assetId: 'zec:mainnet:native',
  address: 'zec:mainnet:native',
  symbol: 'ZEC',
  decimals: 8,
  platform: 'nearIntents'
})

it('quotes Zcash catalog aliases in both directions without changing the wallet asset identity', async () => {
  const legacyRow = { ...zcashCatalogRow, assetId: 'nep141:zec.omft.near', address: 'zec' }
  const rows = [zcashCatalogRow, legacyRow]
  const service = new RheaSwapService(
    {
      getFromTokens: async () =>
        normalizeFromTokenList({ native: rows[0], legacy: rows[1] }, 900010),
      getCrossChainToTokens: async () => normalizeCrossChainToTokenList({ tokens: rows }, 900010)
    },
    new MemoryRheaSwapQuoteSessionStore()
  )
  for (const direction of ['from', 'cross-chain-to']) {
    const result = await service.listTokens({ direction, tokenListChainIds: [900010] })
    assert.deepEqual(result.failedChainIds, [])
    assert.equal(result.tokens.length, 1)
    const [token] = result.tokens
    assert.equal(token.assetId, 'nep141:zec.omft.near')
    assert.equal(token.rheaAddress, 'zec')
    assert.equal(token.isNative, true)
    assert.equal(token.contractAddress, null)
    const serialized = serializeQuoteRequest(
      toSdkQuoteRequest(
        parseRheaSwapQuoteRequest({
          fromChain: 'zcash',
          toChain: '42161',
          tokenIn: { chain: 'zcash', address: token.rheaAddress, isNative: token.isNative },
          tokenOut: { chain: '42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
          amountIn: '392010232',
          slippageBps: 100,
          sender: 't1sender',
          recipient: `0x${'2'.repeat(40)}`
        })
      )
    )
    assert.equal(serialized.tokenIn, 'zec')
    assert.equal(serialized.tokenOut, '0xaf88d065e77c8cc2239327c5edb3a432268e5831')
  }
})

it('normalizes retained Zcash quote addresses for source and destination at the SDK boundary', () => {
  for (const reverse of [false, true]) {
    const zcash = { chain: 'zcash', address: 'zec:mainnet:native', isNative: false }
    const arbitrum = { chain: '42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }
    const tokenIn = reverse ? arbitrum : zcash
    const tokenOut = reverse ? zcash : arbitrum
    const request = parseRheaSwapQuoteRequest({
      fromChain: tokenIn.chain,
      toChain: tokenOut.chain,
      tokenIn,
      tokenOut,
      amountIn: '392010232',
      slippageBps: 100,
      sender: 'test-sender',
      recipient: 'test-recipient'
    })
    const serialized = serializeQuoteRequest(toSdkQuoteRequest(request))
    assert.equal(reverse ? serialized.tokenOut : serialized.tokenIn, 'zec')
    assert.equal(zcash.address, 'zec:mainnet:native')
  }
})

it('quotes an EVM ERC-20 by its on-chain contract while retaining the catalog asset ID', () => {
  const assetId = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
  const contractAddress = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const token = toRheaSwapToken({
    chain: '8453',
    address: assetId,
    assetId,
    symbol: 'USDC',
    decimals: 6,
    isNative: false,
    tokenListChainId: 8453,
    blockchain: 'base',
    contractAddress,
    coinType: null,
    name: 'USD Coin',
    logoURI: null,
    price: '1',
    priceUpdatedAt: null,
    sources: ['nearintents'],
    raw: { address: contractAddress, assetId }
  })
  assert.equal(token.rheaAddress, contractAddress)
  assert.equal(token.contractAddress, contractAddress)
  assert.deepEqual(token.sources, ['nearintents'])

  const request = toSdkQuoteRequest(
    parseRheaSwapQuoteRequest({
      fromChain: '1',
      toChain: token.rheaChainId,
      tokenIn: { chain: '1', address: 'nep141:eth.omft.near', isNative: true },
      tokenOut: {
        chain: token.rheaChainId,
        address: token.rheaAddress,
        isNative: token.isNative
      },
      amountIn: '10000000000000000',
      slippageBps: 50,
      sender: `0x${'1'.repeat(40)}`,
      recipient: `0x${'2'.repeat(40)}`,
      confidentiality: 'basic'
    })
  )
  const serialized = serializeQuoteRequest(request)
  assert.equal(serialized.tokenOut, contractAddress)
  assert.notEqual(serialized.tokenOut, assetId)
})

it('keeps Main destinations while limiting Private to declared NearIntents sources', () => {
  const near = { assetId: 'near', sources: ['nearIntents'] }
  const preSwap = { assetId: 'pre', sources: ['preswap-nearintents'] }
  const ordinary = { assetId: 'ordinary', sources: ['lifi', 'okx'] }
  const unknown = { assetId: 'unknown' }
  const catalog = [near, preSwap, ordinary, unknown]
  assert.equal(filterSwapDestinationTokens(catalog, undefined), catalog)
  assert.deepEqual(filterSwapDestinationTokens(catalog, 'basic'), [near, preSwap])
})

it('applies the Private route limit before cross-chain Send destination grouping', () => {
  const sourceToken = { rheaChainId: '1', isNative: true, sources: ['lifi'] }
  const near = { rheaChainId: '8453', isNative: true, sources: ['nearintents'] }
  const ordinary = { rheaChainId: '8453', isNative: true, sources: ['lifi'] }
  const options = {
    tokens: [near, ordinary],
    sourceToken,
    crossChainSendRequested: true,
    capabilities: { evm: true, solana: false }
  }
  assert.deepEqual(
    filterSelectableSwapDestinationTokens({ ...options, confidentiality: undefined }),
    [near, ordinary]
  )
  assert.deepEqual(
    filterSelectableSwapDestinationTokens({ ...options, confidentiality: 'basic' }),
    [near]
  )
})

it('treats a legacy token without route sources as unknown in Private', () => {
  const token = toRheaSwapToken({
    chain: '8453',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    assetId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    decimals: 6,
    isNative: false,
    tokenListChainId: 8453,
    blockchain: 'base',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    coinType: null,
    name: null,
    logoURI: null,
    price: null,
    priceUpdatedAt: null,
    sources: ['nearintents'],
    raw: {}
  })
  const { sources: _sources, ...legacy } = token
  const parsed = parseRheaSwapToken(legacy)
  assert.deepEqual(parsed.sources, [])
  assert.deepEqual(filterSwapDestinationTokens([parsed], 'basic'), [])
  assert.deepEqual(filterSwapDestinationTokens([parsed], undefined), [parsed])
})

it('gives a usable destination error without exposing backend route details', () => {
  const error = new RheaSwapClientError(
    'Cross-chain quote failed: nearintents: unsupported destination token 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 on chain137'
  )
  assert.equal(
    getRheaSwapErrorMessage(error),
    'This destination is unavailable for this swap. Choose another asset.'
  )
})

it('uses a valid EVM quote address when the catalog omits contract metadata', () => {
  const assetId = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
  const contractAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const token = toRheaSwapToken({
    chain: '1',
    address: contractAddress,
    assetId,
    symbol: 'USDC',
    decimals: 6,
    isNative: false,
    tokenListChainId: 1,
    blockchain: 'eth',
    contractAddress: null,
    coinType: null,
    name: null,
    logoURI: null,
    price: null,
    priceUpdatedAt: null,
    sources: ['nearintents'],
    raw: { assetId }
  })
  assert.equal(token.rheaAddress, contractAddress)
  assert.equal(token.contractAddress, null)
})

it('excludes an EVM catalog row without an executable contract or quote address', () => {
  const assetId = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
  assert.throws(
    () =>
      toRheaSwapToken({
        chain: '1',
        address: assetId,
        assetId,
        symbol: 'USDC',
        decimals: 6,
        isNative: false,
        tokenListChainId: 1,
        blockchain: 'eth',
        contractAddress: null,
        coinType: null,
        name: null,
        logoURI: null,
        price: null,
        priceUpdatedAt: null,
        sources: ['nearintents'],
        raw: { assetId }
      }),
    /quote token address is invalid/
  )
})
