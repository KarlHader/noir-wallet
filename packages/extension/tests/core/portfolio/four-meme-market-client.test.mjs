import { test } from 'node:test'
import { expect } from '@playwright/test'

import { FourMemeMarketClient } from '../../../src/infrastructure/prices/four-meme-market-client.ts'

const NOW = 1_794_300_588_000
const CONTRACT = '0xb4bd2f581630eb5b8e3e827e50d9cfdf5f264444'
const ASSET_ID = `eip155:56/erc20:${CONTRACT}`

function reply(data, code = 0) {
  return new Response(JSON.stringify({ code, msg: 'success', data }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function token(overrides = {}) {
  return {
    address: CONTRACT,
    networkCode: 'BSC',
    status: 'PUBLISH',
    symbol: 'BNB',
    image: '/market/example.png',
    tokenPrice: { price: '0.000000004632948118', modifyDate: String(NOW - 1_000) },
    ...overrides
  }
}

const config = [
  {
    symbol: 'BNB',
    symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    networkCode: 'BSC',
    decimals: 18
  }
]

test('reads a BSC curve token with its official icon and BNB-denominated market price once', async () => {
  const requests = []
  const client = new FourMemeMarketClient({
    now: () => NOW,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init })
      return String(input).endsWith('/public/config') ? reply(config) : reply(token())
    }
  })

  const [first, second] = await Promise.all([client.getToken(ASSET_ID), client.getToken(ASSET_ID)])
  expect(first).toEqual(second)
  expect(first).toEqual({
    assetId: ASSET_ID,
    phase: 'curve',
    iconUrl: 'https://static.four.meme/market/example.png',
    market: {
      price: '0.000000004632948118',
      quoteAssetId: 'eip155:56/slip44:714',
      quoteDecimals: 18,
      sourceUpdatedAt: NOW - 1_000
    }
  })
  await client.getToken(ASSET_ID)
  expect(requests).toHaveLength(2)
  expect(requests[0].url).toBe(
    `https://four.meme/meme-api/v1/private/token/get/v2?address=${CONTRACT}`
  )
  expect(requests[0].init).toMatchObject({
    method: 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error'
  })
})

test('keeps a graduated token icon without treating its reported price as a curve quote', async () => {
  const requests = []
  const client = new FourMemeMarketClient({
    now: () => NOW,
    fetch: async input => {
      requests.push(String(input))
      return reply(
        token({
          status: 'TRADE',
          image: 'https://static.four.meme/market/example.webp',
          tokenPrice: { price: '0.01237', modifyDate: String(NOW - 1_000) }
        })
      )
    }
  })

  await expect(client.getToken(ASSET_ID)).resolves.toEqual({
    assetId: ASSET_ID,
    phase: 'dex',
    iconUrl: 'https://static.four.meme/market/example.webp'
  })
  expect(requests).toHaveLength(1)
})

test('rejects mismatched identity and ambiguous quote configuration', async () => {
  for (const overrides of [
    { networkCode: 'ETH' },
    { address: `0x${'a'.repeat(40)}` },
    { status: 'UNKNOWN' }
  ]) {
    const wrongIdentity = new FourMemeMarketClient({
      now: () => NOW,
      fetch: async () => reply(token(overrides))
    })
    await expect(wrongIdentity.getToken(ASSET_ID)).resolves.toBeNull()
    await expect(wrongIdentity.getToken('eip155:1/erc20:' + CONTRACT)).resolves.toBeNull()
  }
  for (const tokenPrice of [
    { price: '-1', modifyDate: String(NOW) },
    { price: '1', modifyDate: String(NOW + 24 * 60 * 60_000) }
  ]) {
    const invalidMarket = new FourMemeMarketClient({
      now: () => NOW,
      fetch: async () => reply(token({ tokenPrice }))
    })
    expect((await invalidMarket.getToken(ASSET_ID))?.market).toBeUndefined()
  }

  const ambiguous = new FourMemeMarketClient({
    now: () => NOW,
    fetch: async input =>
      String(input).endsWith('/public/config') ? reply([...config, ...config]) : reply(token())
  })
  await expect(ambiguous.getToken(ASSET_ID)).resolves.toEqual({
    assetId: ASSET_ID,
    phase: 'curve',
    iconUrl: 'https://static.four.meme/market/example.png'
  })

  const untrustedIcon = new FourMemeMarketClient({
    now: () => NOW,
    fetch: async () =>
      reply(token({ status: 'TRADE', image: 'https://other.example/market/icon.png' }))
  })
  await expect(untrustedIcon.getToken(ASSET_ID)).resolves.toEqual({
    assetId: ASSET_ID,
    phase: 'dex'
  })
})
