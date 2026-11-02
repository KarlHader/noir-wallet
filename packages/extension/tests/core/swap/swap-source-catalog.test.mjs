import assert from 'node:assert/strict'
import { it } from 'node:test'
import { normalizeFromTokenList } from '@rhea-finance/cross-chain-aggregation-dex'
import {
  MemoryRheaSwapQuoteSessionStore,
  RheaSwapService,
  toRheaSwapToken
} from '../../../src/core/services/rhea-swap/index.ts'
import { mergeSelectedSwapSourceCatalog } from '../../../src/popup/services/swap-catalog-loading.ts'
import { filterSwapDestinationTokens } from '../../../src/popup/services/swap-page-model.ts'
import { getSwapDestinationTokens } from '../../../src/popup/services/swap-token-selection.ts'

function token(blockchain, chainId, symbol) {
  return {
    assetId: `${blockchain}:${symbol}`,
    blockchain,
    rheaChainId: String(chainId),
    tokenListChainId: chainId,
    rheaAddress: symbol,
    symbol
  }
}

const ZEC = token('zec', 900010, 'ZEC')
const ETH = token('eth', 1, 'ETH')
const USDC = token('eth', 1, 'USDC')
const USDT = token('eth', 1, 'USDT')
const POL = token('pol', 137, 'POL')

it('keeps same-chain destinations after selecting Ethereum USDC from a progressively loaded source selector', () => {
  const current = [ZEC]
  const selectorCatalog = [ZEC, ETH, USDC, USDT, POL]
  const sources = mergeSelectedSwapSourceCatalog(current, selectorCatalog, USDC)
  const destinations = getSwapDestinationTokens(USDC, sources, [ZEC]).filter(
    candidate => candidate.assetId !== USDC.assetId
  )

  assert.deepEqual(destinations, [ETH, USDT, ZEC])
  assert.deepEqual(sources, [ZEC, ETH, USDC, USDT])
  assert.deepEqual(current, [ZEC])
})

it('completes a partially retained source chain even when the selected token is already present', () => {
  const staleUsdc = { ...USDC, price: 0.99 }
  const sources = mergeSelectedSwapSourceCatalog([ZEC, staleUsdc], [ETH, USDC, USDT], USDC)

  assert.deepEqual(sources, [ZEC, USDC, ETH, USDT])
  assert.equal(
    sources.find(candidate => candidate.assetId === USDC.assetId),
    USDC
  )
  assert.deepEqual(mergeSelectedSwapSourceCatalog([ZEC], [], USDC), [ZEC, USDC])
})

function arbitrumNativeCatalog() {
  return normalizeFromTokenList(
    {
      lifi: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
        isNative: true,
        platform: 'lifi'
      },
      okx: {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        symbol: 'ETH',
        decimals: 18,
        isNative: true,
        platform: 'okx'
      },
      nearIntents: {
        address: 'nep141:arb.omft.near',
        assetId: 'nep141:arb.omft.near',
        contractAddress: null,
        symbol: 'ETH',
        decimals: 18,
        platform: 'nearIntents'
      }
    },
    42161
  )
}

it('recognizes Arbitrum native ETH by its chain-specific protocol ID when the API omits isNative', () => {
  const item = arbitrumNativeCatalog().find(item => item.sources.includes('nearIntents'))
  const eth = toRheaSwapToken(item)

  assert.equal(eth.isNative, true)
  assert.equal(eth.assetId, 'nep141:arb.omft.near')
  assert.equal(eth.rheaAddress, 'nep141:arb.omft.near')
  assert.equal(eth.contractAddress, null)
})

it('retains Arbitrum ETH as a Private destination after merging native provider aliases', async () => {
  const service = new RheaSwapService(
    { getFromTokens: async () => arbitrumNativeCatalog() },
    new MemoryRheaSwapQuoteSessionStore()
  )
  const catalog = await service.listTokens({ direction: 'from', tokenListChainIds: [42161] })
  const arbUsdc = {
    ...token('arb', 42161, 'USDC'),
    assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    rheaAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    sources: ['nearIntents']
  }
  const sources = mergeSelectedSwapSourceCatalog([ZEC], [...catalog.tokens, arbUsdc], arbUsdc)
  const destinations = filterSwapDestinationTokens(
    getSwapDestinationTokens(arbUsdc, sources, []),
    'basic'
  ).filter(candidate => candidate.assetId !== arbUsdc.assetId)

  assert.equal(catalog.tokens.length, 1)
  assert.deepEqual(catalog.failedChainIds, [])
  assert.deepEqual(catalog.tokens[0].sources, ['lifi', 'okx', 'nearIntents'])
  assert.equal(catalog.tokens[0].rheaAddress, '0x0000000000000000000000000000000000000000')
  assert.equal(destinations.length, 1)
  assert.equal(destinations[0].assetId, 'nep141:arb.omft.near')
  assert.equal(destinations[0].symbol, 'ETH')
})

it('does not treat a protocol native asset ID from another EVM chain as Arbitrum ETH', () => {
  const item = arbitrumNativeCatalog().find(item => item.sources.includes('nearIntents'))

  assert.throws(
    () =>
      toRheaSwapToken({
        ...item,
        address: 'nep141:eth.omft.near',
        assetId: 'nep141:eth.omft.near',
        raw: { address: 'nep141:eth.omft.near' }
      }),
    /quote token address is invalid/
  )
})
