import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  fetchQuote,
  fetchIntentsWalletTokens,
  fetchSwapStatus,
  getCachedTokens,
  parseCoinGeckoIconCatalogResponse,
  parseQuoteSuccessResponse,
  parseSwapStatusResponse,
  parseSwapTokenCatalogResponse,
  refreshSwapTokenCatalog
} from '../../../src/core/services/intents-api.ts'

test('swap quote sends the configured 35 bps app fee', async () => {
  const originalFetch = globalThis.fetch
  let submittedBody
  globalThis.fetch = async (_input, init) => {
    submittedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ message: 'No route' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  try {
    const result = await fetchQuote({
      originAsset: 'nep141:zec.omft.near',
      destinationAsset: 'nep141:wrap.near',
      amount: '100000000',
      refundTo: 'zs1refund',
      recipient: 'recipient.near'
    })
    expect(result.quoteStatus).toBe('error')
    expect(submittedBody.appFees).toEqual([{ recipient: 'noir_swap.near', fee: 35 }])
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
      if (url === 'https://1click.chaindefuser.com/v0/tokens') {
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
      await expect(refreshSwapTokenCatalog()).resolves.toEqual([
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
      if (url === 'https://1click.chaindefuser.com/v0/tokens') {
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
      if (url === 'https://1click.chaindefuser.com/v0/tokens') {
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
      await expect(refreshSwapTokenCatalog()).resolves.toEqual([
        { ...goodToken, icon: rheaIcon, coingeckoIcon: null },
        { ...unavailableToken, coingeckoIcon: null }
      ])
      await expect(refreshSwapTokenCatalog()).resolves.toEqual([
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
  test('uses the RHEA status response without calling the backup', async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls = []
    globalThis.fetch = async input => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({ status: 'PENDING_DEPOSIT', status_response: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    try {
      await expect(fetchSwapStatus('deposit address')).resolves.toEqual({
        status: 'PENDING_DEPOSIT'
      })
      expect(requestedUrls).toEqual([
        'https://api.rhea.finance/api/1click/status?depositAddress=deposit%20address'
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to 1Click when the RHEA status endpoint is unavailable', async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls = []
    globalThis.fetch = async input => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.startsWith('https://api.rhea.finance/')) {
        return new Response(JSON.stringify({ message: 'Unavailable' }), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          status: 'SUCCESS',
          swapDetails: {
            amountOutFormatted: '0.5',
            destinationChainTxHashes: [{ hash: '0xdestination' }]
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      await expect(fetchSwapStatus('deposit address')).resolves.toEqual({
        status: 'SUCCESS',
        swapDetails: {
          amountOutFormatted: '0.5',
          destinationChainTxHashes: [{ hash: '0xdestination' }]
        }
      })
      expect(requestedUrls).toEqual([
        'https://api.rhea.finance/api/1click/status?depositAddress=deposit%20address',
        'https://1click.chaindefuser.com/v0/status?depositAddress=deposit%20address'
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
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
