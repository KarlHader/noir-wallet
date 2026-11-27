import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ONE_CLICK_TOKEN_CATALOG_URL } from '../../../src/config/intents.ts'

import {
  fetchQuote,
  fetchIntentsWalletTokens,
  fetchSwapTokens,
  evaluateIntentsStatusQuoteBinding,
  getCachedTokens,
  INTENTS_SWAP_TOKEN_CATALOG_TTL_MS,
  parseCoinGeckoIconCatalogResponse,
  parseQuoteSuccessResponse,
  parseSwapStatusResponse,
  parseSwapTokenCatalogResponse,
  refreshSwapTokenIcons,
  refreshSwapTokenCatalog
} from '../../../src/core/services/intents-api.ts'

Object.defineProperty(globalThis, '__CONFIDENTIAL_ONE_CLICK_API_URL__', {
  value: '',
  configurable: true
})

test('Intents token directory stays cached for one hour', async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = originalNow()
  let calls = 0
  const token = {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    contractAddress: null,
    decimals: 18,
    icon: null,
    price: 1,
    priceUpdatedAt: new Date(now).toISOString(),
    symbol: 'ETH'
  }
  Date.now = () => now
  globalThis.fetch = async input => {
    expect(String(input)).toBe('https://api.zknoir.com/v1/1click/v0/tokens')
    calls++
    return Response.json([token])
  }
  try {
    getCachedTokens().splice(0)
    expect(INTENTS_SWAP_TOKEN_CATALOG_TTL_MS).toBe(60 * 60 * 1_000)
    await fetchSwapTokens()
    now += INTENTS_SWAP_TOKEN_CATALOG_TTL_MS - 1
    await fetchSwapTokens()
    expect(calls).toBe(1)
    now += 1
    await fetchSwapTokens()
    expect(calls).toBe(2)
  } finally {
    getCachedTokens().splice(0)
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('Intents settlement checks the quoted raw minimum with destination precision', () => {
  const binding = {
    originAsset: 'nep141:zec.omft.near',
    destinationAsset: 'nep141:usdc.omft.near',
    minAmountOut: '900000'
  }
  const status = {
    status: 'SUCCESS',
    originAsset: binding.originAsset,
    destinationAsset: binding.destinationAsset,
    swapDetails: { amountOutFormatted: '0.9' }
  }
  expect(evaluateIntentsStatusQuoteBinding(binding, status, 6)).toBe('valid')
  expect(
    evaluateIntentsStatusQuoteBinding(
      binding,
      {
        ...status,
        swapDetails: { amountOutFormatted: '0.89' }
      },
      6
    )
  ).toBe('mismatch')
  expect(evaluateIntentsStatusQuoteBinding(binding, status)).toBe('unknown')
  expect(
    evaluateIntentsStatusQuoteBinding(
      binding,
      {
        ...status,
        destinationAsset: 'nep141:other.omft.near'
      },
      6
    )
  ).toBe('mismatch')
})

test('swap quote keeps the shielded refund and binds a separate viewer through the proxy', async () => {
  const originalFetch = globalThis.fetch
  const shieldedRefund = `u1${'q'.repeat(55)}`
  const viewerAddress = `t1${'A'.repeat(33)}`
  const depositMemo = ' memo+1 & 2 '
  let quoteUrl
  let submittedBody
  globalThis.fetch = async (input, init) => {
    quoteUrl = String(input)
    submittedBody = JSON.parse(init.body)
    return Response.json(response({ depositMemo }))
  }

  try {
    const result = await fetchQuote({
      originAsset: 'nep141:zec.omft.near',
      destinationAsset: 'nep141:wrap.near',
      amount: '100000000',
      refundTo: shieldedRefund,
      recipient: 'recipient.near',
      viewer: { chainFamily: 'zcash', walletAddress: viewerAddress, signingMode: 'derived' }
    })
    expect(result.quoteSuccessResult?.quote.depositMemo).toBe(depositMemo)
    expect(quoteUrl).toBe('https://api.rhea.finance/proxy/1click/v0/quote')
    expect(submittedBody).toMatchObject({
      dry: false,
      refundType: 'ORIGIN_CHAIN',
      refundTo: shieldedRefund,
      user: viewerAddress,
      userChainFamily: 'zcash',
      appFees: [{ recipient: 'noir_swap.near', fee: 20 }]
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('protected Intents quote requires a matching request echo', async () => {
  const originalFetch = globalThis.fetch
  let requestedBody
  globalThis.fetch = async (_input, init) => {
    requestedBody = JSON.parse(init.body)
    return new Response(JSON.stringify(response()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  try {
    const request = {
      originAsset: 'nep141:base-usdc.omft.near',
      destinationAsset: 'nep141:zec.omft.near',
      amount: '1000000',
      refundTo: '0x1111111111111111111111111111111111111111',
      recipient: 'u1destination',
      validateQuoteRequest: true,
      viewer: { chainFamily: 'zcash', walletAddress: 't1viewer', signingMode: 'transparent' }
    }
    const { viewer, ...withoutViewer } = request
    expect((await fetchQuote(withoutViewer)).quoteStatus).toBe('error')
    expect(requestedBody).toBeUndefined()
    expect((await fetchQuote(request)).quoteStatus).toBe('error')
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ ...response(), quoteRequest: { ...requestedBody, recipient: 't1other' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    expect((await fetchQuote(request)).quoteStatus).toBe('error')
    globalThis.fetch = async () =>
      Response.json({ ...response(), quoteRequest: { ...requestedBody, user: 't1other' } })
    expect((await fetchQuote(request)).quoteStatus).toBe('error')
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ...response(), quoteRequest: requestedBody }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    expect((await fetchQuote(request)).quoteStatus).toBe('success')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function response(overrides = {}) {
  return {
    quote: {
      amountIn: '1000',
      amountOut: '900',
      minAmountOut: '895',
      amountInFormatted: '0.000000000000001',
      amountOutFormatted: '0.000009',
      amountInUsd: '0.01',
      amountOutUsd: '0.009',
      depositAddress: '0x2222222222222222222222222222222222222222',
      deadline: '2026-08-11T01:00:00.000Z',
      providerMetadataMayGrow: true,
      ...overrides
    },
    providerEnvelopeMayGrow: true
  }
}

test.describe('Near Intents quote response parsing', () => {
  test('keeps only the bounded fields used for review and signing', () => {
    expect(parseQuoteSuccessResponse(response())).toEqual({
      quoteStatus: 'success',
      quoteSuccessResult: {
        quote: {
          amountIn: '1000',
          amountOut: '900',
          minAmountOut: '895',
          amountInFormatted: '0.000000000000001',
          amountOutFormatted: '0.000009',
          amountInUsd: '0.01',
          amountOutUsd: '0.009',
          depositAddress: '0x2222222222222222222222222222222222222222',
          deadline: '2026-08-11T01:00:00.000Z'
        }
      }
    })
  })

  test('rejects malformed amounts, deadlines, addresses, and impossible minimum output', () => {
    for (const invalid of [
      { amountIn: '1.5' },
      { amountOut: '-1' },
      { minAmountOut: '901' },
      { deadline: 'not-a-date' },
      { depositAddress: ' address ' },
      { depositAddress: `x${'0'.repeat(512)}` }
    ]) {
      expect(() => parseQuoteSuccessResponse(response(invalid))).toThrow(/Near Intents/)
    }
  })
})

test.describe('Near Intents token catalog parsing', () => {
  const now = Date.parse('2026-08-25T18:30:00.000Z')
  const token = {
    assetId: 'nep141:zec.omft.near',
    blockchain: 'zec',
    decimals: 8,
    price: 795.03,
    priceUpdatedAt: '2026-08-25T18:23:00.837Z',
    symbol: 'ZEC',
    coingeckoId: 'zcash'
  }

  test('keeps only validated provider token fields', () => {
    expect(parseSwapTokenCatalogResponse([{ ...token, ignored: true }], now)).toEqual([token])
  })

  test('rejects malformed, duplicate, and untrusted provider tokens', () => {
    for (const invalid of [
      [],
      [{ ...token, decimals: -1 }],
      [{ ...token, price: Number.NaN }],
      [{ ...token, priceUpdatedAt: 'not-a-date' }],
      [{ ...token, icon: 'http://untrusted.example/zec.svg' }],
      [token, token]
    ]) {
      expect(() => parseSwapTokenCatalogResponse(invalid, now)).toThrow(/Swap token/)
    }
  })
})

test.describe('CoinGecko token icon parsing', () => {
  test('accepts only bounded CoinGecko image records', () => {
    expect([
      ...parseCoinGeckoIconCatalogResponse([
        {
          id: 'usd-coin',
          image: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694',
          ignored: true
        }
      ])
    ]).toEqual([
      ['usd-coin', 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694']
    ])
  })

  test('rejects duplicate IDs and images from untrusted hosts', () => {
    const valid = {
      id: 'usd-coin',
      image: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png'
    }
    for (const invalid of [
      [{ ...valid, image: 'https://example.com/usdc.png' }],
      [valid, valid],
      [{ ...valid, id: ' custom ' }]
    ]) {
      expect(() => parseCoinGeckoIconCatalogResponse(invalid)).toThrow(/CoinGecko token icon/)
    }
  })

  test('enriches the 1Click catalog from RHEA and one CoinGecko batch', async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls = []
    const priceUpdatedAt = new Date().toISOString()
    const token = {
      assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
      blockchain: 'eth',
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
      price: 1,
      priceUpdatedAt,
      symbol: 'USDC',
      coingeckoId: 'usd-coin'
    }
    const rheaIcon = 'https://assets.rhea.finance/usdc.png'
    const coinGeckoIcon =
      'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694'

    globalThis.fetch = async input => {
      const url = String(input)
      requestedUrls.push(url)
      if (url === ONE_CLICK_TOKEN_CATALOG_URL) {
        return Response.json([token])
      }
      if (url.startsWith('https://api.rhea.finance/get_multichain_lending_tokens_data')) {
        return Response.json([{ assetId: token.assetId, icon: rheaIcon }])
      }
      if (url.startsWith('https://api.coingecko.com/api/v3/coins/markets')) {
        const parsed = new URL(url)
        expect(parsed.searchParams.get('ids')).toBe('usd-coin')
        return Response.json([{ id: 'usd-coin', image: coinGeckoIcon }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    try {
      await refreshSwapTokenCatalog()
      await expect(refreshSwapTokenIcons()).resolves.toEqual([
        { ...token, icon: rheaIcon, coingeckoIcon: coinGeckoIcon }
      ])
      expect(
        requestedUrls.filter(url =>
          url.startsWith('https://api.coingecko.com/api/v3/coins/markets')
        )
      ).toHaveLength(1)
    } finally {
      getCachedTokens().splice(0)
      globalThis.fetch = originalFetch
    }
  })

  test('enriches wallet-discovered tokens with CoinGecko icons when RHEA has none', async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls = []
    const coingeckoIcon = 'https://coin-images.coingecko.com/coins/images/99999/large/new-token.png'
    const token = {
      assetId: 'nep141:new-token.near',
      blockchain: 'near',
      contractAddress: 'new-token.near',
      decimals: 18,
      icon: null,
      price: 1,
      priceUpdatedAt: new Date().toISOString(),
      symbol: 'NEW',
      coingeckoId: 'new-wallet-token'
    }

    globalThis.fetch = async input => {
      const url = String(input)
      requestedUrls.push(url)
      if (url === ONE_CLICK_TOKEN_CATALOG_URL) {
        return Response.json([token])
      }
      if (url.startsWith('https://api.rhea.finance/get_multichain_lending_tokens_data')) {
        return Response.json([{ assetId: token.assetId, icon: null }])
      }
      if (url.startsWith('https://api.coingecko.com/api/v3/coins/markets')) {
        expect(new URL(url).searchParams.get('ids')).toBe('new-wallet-token')
        return Response.json([{ id: 'new-wallet-token', image: coingeckoIcon }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    try {
      await fetchIntentsWalletTokens()
      await refreshSwapTokenIcons()
      await expect(fetchIntentsWalletTokens()).resolves.toEqual([{ ...token, coingeckoIcon }])
      expect(
        requestedUrls.some(url => url.endsWith('/get_multichain_lending_tokens_data?chains=near'))
      ).toBe(true)
    } finally {
      getCachedTokens().splice(0)
      globalThis.fetch = originalFetch
    }
  })

  test('isolates RHEA icon failures by chain and preserves the last cached icon', async () => {
    const originalFetch = globalThis.fetch
    const originalConsoleError = console.error
    const requestedUrls = []
    let catalogRequests = 0
    const priceUpdatedAt = new Date().toISOString()
    const goodToken = {
      assetId: 'asset:icon-chain-good',
      blockchain: 'icon-chain-good',
      contractAddress: 'good-token',
      decimals: 6,
      price: 1,
      priceUpdatedAt,
      symbol: 'GOOD'
    }
    const cachedIcon = 'https://tokens.example/cached.png'
    const unavailableToken = {
      assetId: 'asset:icon-chain-unavailable',
      blockchain: 'icon-chain-unavailable',
      contractAddress: 'unavailable-token',
      decimals: 6,
      icon: cachedIcon,
      price: 1,
      priceUpdatedAt,
      symbol: 'OLD'
    }
    const rheaIcon = 'https://assets.rhea.finance/good.png'

    console.error = () => undefined
    globalThis.fetch = async input => {
      const url = String(input)
      requestedUrls.push(url)
      if (url === ONE_CLICK_TOKEN_CATALOG_URL) {
        catalogRequests += 1
        return Response.json([
          goodToken,
          catalogRequests === 1 ? unavailableToken : { ...unavailableToken, icon: null }
        ])
      }
      if (url.endsWith('?chains=icon-chain-good')) {
        return Response.json([{ assetId: goodToken.assetId, icon: rheaIcon }])
      }
      if (url.endsWith('?chains=icon-chain-unavailable')) {
        return new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' })
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    try {
      await refreshSwapTokenCatalog()
      await expect(refreshSwapTokenIcons()).resolves.toEqual([
        { ...goodToken, icon: rheaIcon, coingeckoIcon: null },
        { ...unavailableToken, coingeckoIcon: null }
      ])
      await refreshSwapTokenCatalog()
      await expect(refreshSwapTokenIcons()).resolves.toEqual([
        { ...goodToken, icon: rheaIcon, coingeckoIcon: null },
        { ...unavailableToken, coingeckoIcon: null }
      ])
      expect(
        requestedUrls.filter(url =>
          url.startsWith('https://api.rhea.finance/get_multichain_lending_tokens_data')
        )
      ).toHaveLength(2)
    } finally {
      getCachedTokens().splice(0)
      console.error = originalConsoleError
      globalThis.fetch = originalFetch
    }
  })
})

test.describe('Near Intents status response parsing', () => {
  test('normalizes settled raw amounts at their original precision', () => {
    expect(
      parseSwapStatusResponse({ status: 'COMPLETED', swapDetails: { amountOut: '1' } }, 24)
    ).toEqual({
      status: 'SUCCESS',
      swapDetails: { amountOutFormatted: '0.000000000000000000000001' }
    })
  })

  test('parses an empty status response envelope while the deposit is pending', () => {
    expect(parseSwapStatusResponse({ status: 'PENDING_DEPOSIT', status_response: null })).toEqual({
      status: 'PENDING_DEPOSIT'
    })
  })

  test('keeps only bounded protocol evidence from provider envelopes', () => {
    expect(
      parseSwapStatusResponse({
        status: 'SUCCESS',
        swapDetails: {
          amountOutFormatted: '0.5',
          originChainTxHashes: [{ hash: '0xorigin', explorerUrl: 'https://example.test/o' }],
          destinationChainTxHashes: [{ hash: 'destination' }],
          ignored: true
        },
        quoteResponse: {
          quoteRequest: {
            originAsset: 'nep141:eth.omft.near',
            destinationAsset: 'nep141:zec.omft.near'
          }
        },
        ignored: true
      })
    ).toEqual({
      status: 'SUCCESS',
      swapDetails: {
        amountOutFormatted: '0.5',
        originChainTxHashes: [{ hash: '0xorigin', explorerUrl: 'https://example.test/o' }],
        destinationChainTxHashes: [{ hash: 'destination' }]
      },
      originAsset: 'nep141:eth.omft.near',
      destinationAsset: 'nep141:zec.omft.near'
    })
  })

  test('keeps successful transaction hashes when the provider omits explorer URLs', () => {
    expect(
      parseSwapStatusResponse({
        status: 'SUCCESS',
        swapDetails: {
          amountOutFormatted: '0.000333614829033292',
          originChainTxHashes: [{ hash: '0xorigin', explorerUrl: '' }],
          destinationChainTxHashes: [{ hash: '0xdestination', explorerUrl: '' }]
        }
      })
    ).toEqual({
      status: 'SUCCESS',
      swapDetails: {
        amountOutFormatted: '0.000333614829033292',
        originChainTxHashes: [{ hash: '0xorigin' }],
        destinationChainTxHashes: [{ hash: '0xdestination' }]
      }
    })
  })

  test('parses the RHEA status envelope and treats missing output amounts as unavailable', () => {
    for (const amountOutFormatted of [null, '']) {
      expect(
        parseSwapStatusResponse({
          status: 'PROCESSING',
          status_response: {
            status: 'PROCESSING',
            swapDetails: {
              amountOutFormatted,
              originChainTxHashes: [{ hash: '0xorigin' }],
              destinationChainTxHashes: []
            },
            quoteResponse: {
              quoteRequest: {
                originAsset: 'nep141:zec.omft.near',
                destinationAsset: 'nep141:usdc.omft.near'
              }
            }
          }
        })
      ).toEqual({
        status: 'PROCESSING',
        swapDetails: {
          originChainTxHashes: [{ hash: '0xorigin' }],
          destinationChainTxHashes: []
        },
        originAsset: 'nep141:zec.omft.near',
        destinationAsset: 'nep141:usdc.omft.near'
      })
    }
  })

  test('rejects unknown status and unbounded or duplicate transaction evidence', () => {
    for (const invalid of [
      { status: 'COMPLETE' },
      { status: 'PROCESSING', status_response: 'not-an-object' },
      { status: 'PROCESSING', swapDetails: { amountOutFormatted: 0.5 } },
      { status: 'SUCCESS', swapDetails: { originChainTxHashes: '0xhash' } },
      {
        status: 'SUCCESS',
        swapDetails: { originChainTxHashes: [{ hash: 'same' }, { hash: 'same' }] }
      },
      {
        status: 'SUCCESS',
        swapDetails: {
          destinationChainTxHashes: Array.from({ length: 33 }, (_, index) => ({
            hash: `hash-${index}`
          }))
        }
      }
    ]) {
      expect(() => parseSwapStatusResponse(invalid)).toThrow(/Near Intents/)
    }
  })
})
