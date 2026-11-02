import {
  registerProtocolFixtures,
  BASE_USDC_CONTRACT,
  QUOTE_URL,
  captureScreenshot,
  expect,
  expectNoOverflow,
  importTestWallet,
  mockBitcoinNetwork,
  mockEvmNetwork,
  mockProtocolApis,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/protocol-wallet'

registerProtocolFixtures()

test('loads live RHEA source and destination catalogs in the real MV3 popup', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.LIVE_RHEA_SWAP_CATALOG !== '1',
    'Set LIVE_RHEA_SWAP_CATALOG=1 to call the public RHEA token-list APIs'
  )
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mockRheaCatalog: false })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const entryStartedAt = Date.now()
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()

  const fromAsset = popup.getByRole('button', { name: 'From asset' })
  await expect(fromAsset).toBeEnabled({ timeout: 60_000 })
  const entryDurationMs = Date.now() - entryStartedAt
  await expect(popup.getByRole('heading', { name: 'Unable to load assets' })).toHaveCount(0)
  console.info('RHEA initial catalog pair', {
    source: await fromAsset.innerText(),
    destination: await popup.getByRole('button', { name: 'To asset' }).innerText()
  })
  await expect(popup.getByRole('button', { name: 'To asset' })).toBeEnabled({ timeout: 60_000 })
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinationSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await expect(destinationSelector.getByRole('button', { name: / on / }).first()).toBeVisible({
    timeout: 30_000
  })
  await destinationSelector.getByPlaceholder('Search tokens').fill('USDC')
  const polygonUsdc = destinationSelector.getByRole('button', { name: /^USDC on Polygon/ })
  await expect(polygonUsdc).toBeVisible({ timeout: 45_000 })
  const destinationSelectionStartedAt = Date.now()
  await polygonUsdc.click()
  await expect(destinationSelector).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('USDC')
  console.info('RHEA live destination selection', {
    selectionDurationMs: Date.now() - destinationSelectionStartedAt
  })
  const openStartedAt = Date.now()
  await fromAsset.click()
  const sourceSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await expect(sourceSelector.getByPlaceholder('Search tokens')).toBeVisible()
  const openDurationMs = Date.now() - openStartedAt
  const searchStartedAt = Date.now()
  await sourceSelector.getByPlaceholder('Search tokens').fill('ETH')
  const searchDurationMs = Date.now() - searchStartedAt
  const ethereumToken = sourceSelector.getByRole('button', { name: /^ETH on Ethereum/ }).first()
  await expect(ethereumToken).toBeVisible({ timeout: 45_000 })
  const ethereumCatalogDurationMs = Date.now() - openStartedAt
  const selectionStartedAt = Date.now()
  await ethereumToken.click()
  await expect(sourceSelector).toHaveCount(0)
  await expect(fromAsset).toContainText('ETH')
  const selectionDurationMs = Date.now() - selectionStartedAt
  console.info('RHEA live selector timings', {
    entryDurationMs,
    openDurationMs,
    searchDurationMs,
    ethereumCatalogDurationMs,
    selectionDurationMs
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-rhea-live-token-catalogs.png')
})

test('quotes a live confidential RHEA route from the Private account', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.LIVE_RHEA_SWAP_QUOTE !== '1',
    'Set LIVE_RHEA_SWAP_QUOTE=1 to call the public RHEA quote API'
  )
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mockRheaCatalog: false, mockRheaQuote: false })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()

  const fromAsset = popup.getByRole('button', { name: 'From asset' })
  await expect(fromAsset).toBeEnabled({ timeout: 60_000 })
  await fromAsset.click()
  const sourceSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await sourceSelector.getByPlaceholder('Search tokens').fill('ETH')
  const walletEth = sourceSelector.getByRole('button', {
    name: /^ETH on Ethereum, balance 1 ETH$/
  })
  await expect(walletEth.first()).toBeVisible({ timeout: 45_000 })
  await walletEth.first().click()
  await expect(sourceSelector).toHaveCount(0)
  await expect(fromAsset).toContainText('ETH')

  await popup
    .getByRole('button', { name: /^Choose source account, current (main|private)$/ })
    .click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toBeVisible()

  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinationSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await destinationSelector.getByPlaceholder('Search tokens').fill('USDC')
  const baseUsdc = destinationSelector.getByRole('button', { name: /^USDC on Base/ })
  await expect(baseUsdc).toHaveCount(1, { timeout: 45_000 })
  await baseUsdc.click()
  await expect(destinationSelector).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('USDC')

  const liveQuoteRequest = context.waitForEvent('request', {
    predicate: request => request.url() === QUOTE_URL && request.method() === 'POST',
    timeout: 60_000
  })
  const liveQuoteResponse = context.waitForEvent('response', {
    predicate: response => response.url() === QUOTE_URL && response.request().method() === 'POST',
    timeout: 60_000
  })
  void liveQuoteRequest.catch(() => undefined)
  void liveQuoteResponse.catch(() => undefined)
  await popup.locator('input[placeholder="0"]').fill('0.01')
  const quoteRequest = await liveQuoteRequest
  const quoteInput = quoteRequest.postDataJSON() as { toChain?: unknown; tokenOut?: unknown }
  expect(quoteInput.toChain).toBe('8453')
  expect(typeof quoteInput.tokenOut === 'string' ? quoteInput.tokenOut.toLowerCase() : null).toBe(
    BASE_USDC_CONTRACT.toLowerCase()
  )
  const quoteResponse = await liveQuoteResponse
  expect(quoteResponse.ok(), `RHEA quote HTTP ${quoteResponse.status()}`).toBe(true)
  const quoteBody = (await quoteResponse.json()) as { code?: unknown }
  if (typeof quoteBody.code === 'number') {
    expect(quoteBody.code, 'RHEA quote response code').toBe(0)
  }
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 60_000
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'private-defi-live-confidential-quote.png')
})
