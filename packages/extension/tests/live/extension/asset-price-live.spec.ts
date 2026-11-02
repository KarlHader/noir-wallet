import { expect, test } from '../../helpers/extension-fixtures'

test.describe('live asset prices in MV3', () => {
  test.skip(
    process.env.LIVE_ASSET_PRICE_INTEGRATION !== '1',
    'Set LIVE_ASSET_PRICE_INTEGRATION=1 to enable'
  )

  test('serves a fresh price and 24h change during a cold extension startup', async ({
    context,
    popup
  }) => {
    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    serviceWorker.on('console', message => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log(`[Service Worker ${message.type()}] ${message.text()}`)
      }
    })
    const response = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_ASSET_PRICES', action: 'refresh' })
    )

    expect(response?.result).toMatchObject({
      status: 'ready',
      missingAssetIds: []
    })
    const expectedMinimumQuoteCount = (
      process.env.ENABLED_CHAIN_FEATURE_FLAGS ?? 'chain.evm'
    ).includes('chain.evm')
      ? 10
      : 1
    expect(response.result.quotes.length).toBeGreaterThanOrEqual(expectedMinimumQuoteCount)
    expect(
      response.result.quotes.every(
        (quote: { priceUsd?: unknown }) =>
          typeof quote.priceUsd === 'string' && Number(quote.priceUsd) > 0
      )
    ).toBe(true)
    expect(
      response.result.quotes.some(
        (quote: { marketChange?: { percent24h?: unknown } }) =>
          typeof quote.marketChange?.percent24h === 'string'
      )
    ).toBe(true)
  })
})

test.describe('live asset market history in MV3', () => {
  test.skip(
    process.env.LIVE_MARKET_HISTORY_INTEGRATION !== '1',
    'Set LIVE_MARKET_HISTORY_INTEGRATION=1 to enable'
  )

  test('loads ordered ETH history from a cold extension cache', async ({ popup }) => {
    await popup.evaluate(() => chrome.storage.local.remove('asset_market_history_cache_v2'))
    const response = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'GET_ASSET_MARKET_HISTORY',
        assetId: 'eip155:1/slip44:60',
        range: '1d',
        action: 'refresh'
      })
    )

    expect(response?.result).toMatchObject({
      source: 'geckoterminal-keyless',
      assetId: 'eip155:1/slip44:60',
      range: '1d',
      freshness: 'fresh'
    })
    expect(response.result.points.length).toBeGreaterThanOrEqual(20)
    expect(
      response.result.points.every(
        (point: { priceUsd?: unknown; timestamp?: unknown }, index: number) =>
          typeof point.priceUsd === 'string' &&
          Number(point.priceUsd) > 0 &&
          typeof point.timestamp === 'number' &&
          (index === 0 || point.timestamp > response.result.points[index - 1].timestamp)
      )
    ).toBe(true)
  })
})
