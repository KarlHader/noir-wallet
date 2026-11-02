import {
  registerProtocolFixtures,
  BASE_USDC_CONTRACT,
  BUILD_SWAP_URL,
  ETHEREUM_USDC_CONTRACT,
  ETH_ASSET,
  POLYGON_USDC_CONTRACT,
  POL_ASSET,
  QUOTE_URL,
  TRIAL_CONTRACT,
  bitcoinEnabled,
  captureScreenshot,
  connectEvmDApp,
  expect,
  expectNoOverflow,
  importTestWallet,
  mockBitcoinNetwork,
  mockEvmNetwork,
  mockProtocolApis,
  networks,
  parseTransaction,
  readEvmAccounts,
  readPersistedSwapSource,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/protocol-wallet'
import type { Hex, Route } from '../../helpers/protocol-wallet'
import { getZcashChainId } from '../../../src/core/chains/registry'

registerProtocolFixtures()

test('renders usable Swap assets while unrelated chain catalogs are pending', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  const pageErrors: string[] = []
  popup.on('pageerror', error => pageErrors.push(error.message))
  let releaseSources: (() => void) | undefined
  const sourcesPending = new Promise<void>(resolve => {
    releaseSources = resolve
  })
  let releaseDestinations: (() => void) | undefined
  const destinationsPending = new Promise<void>(resolve => {
    releaseDestinations = resolve
  })
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  let pendingRequests = 0
  const catalogChains: number[] = []
  const delayCatalog = async (route: Route) => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    catalogChains.push(chainId)
    if (route.request().url().includes('supported_to_tokens')) {
      await destinationsPending
    } else {
      await sourcesPending
    }
    if (chainId !== 1 && chainId !== 900010) {
      pendingRequests += 1
      await pending
    }
    await route.fallback()
  }
  await context.route('https://api.rhea.finance/get_chain_prices**', delayCatalog)
  await context.route('https://api.rhea.finance/api/swap/supported_to_tokens**', delayCatalog)
  try {
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup.getByRole('button', { name: 'Swap', exact: true }).click()
    await expect(popup.getByRole('status', { name: 'Loading swap assets' })).toBeVisible()
    await captureScreenshot(popup, 'protocol-swap-initial-skeleton.png')
    releaseSources?.()
    await expect(popup.getByRole('button', { name: 'From asset' })).toBeVisible()
    await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('ZEC')
    expect([...new Set(catalogChains)].sort((left, right) => left - right)).toEqual([1, 900010])
    expect(pendingRequests).toBe(0)
    await popup.getByRole('button', { name: 'From asset' }).click()
    const selector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
    await expect(selector.getByRole('button', { name: /^ETH on Ethereum/ })).toBeVisible()
    await selector.getByRole('button', { name: 'Close', exact: true }).click()
    // Keep destination requests blocked across React commits to exercise the former update loop.
    await popup.evaluate(async () => {
      for (let frame = 0; frame < 20; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
    })
    expect(pageErrors).toEqual([])
    await expect(popup.getByRole('button', { name: 'From asset' })).toBeVisible()
    releaseDestinations?.()
    await expect(popup.getByRole('button', { name: 'To asset' })).toBeEnabled()
    await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('ETH')
    await expect(popup.getByRole('status', { name: 'Loading swap assets' })).toHaveCount(0)
    await expect.poll(() => pendingRequests).toBeGreaterThan(0)
    await popup.locator('input[placeholder="0"]').fill('1')
    await expectNoOverflow(popup)
    await captureScreenshot(popup, 'protocol-swap-progressive-loading.png')
    await popup.getByRole('button', { name: 'Switch assets', exact: true }).click()
    await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('ETH')
    await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('ZEC')
    await popup.getByRole('button', { name: 'From asset' }).click()
    const nextSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
    await nextSelector.getByPlaceholder('Search tokens').fill('NOTLISTED')
    await expect(
      nextSelector.getByText('Searching more networks...', { exact: true })
    ).toBeVisible()
    await expect(nextSelector.getByText('No tokens found')).toHaveCount(0)
    await nextSelector.getByPlaceholder('Search tokens').fill('USDC')
    const usdcSource = nextSelector.getByRole('button', {
      name: /^USDC on Ethereum, balance 10 USDC$/
    })
    await expect(usdcSource).toBeVisible()
    await usdcSource.click()
    await expect(nextSelector).toHaveCount(0)
    await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('USDC')
    await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('ZEC')
    expect(pageErrors).toEqual([])
  } finally {
    releaseSources?.()
    releaseDestinations?.()
    release?.()
  }
})

test('uses a selected Zcash wallet recipient for Swap from an EVM-only wallet', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  let assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await assets.getByPlaceholder('Search tokens').fill('ETH')
  await assets
    .getByRole('button', { name: /^ETH on Ethereum/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await assets.getByPlaceholder('Search tokens').fill('ZEC')
  await assets
    .getByRole('button', { name: /^ZEC on Zcash/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  const ownAddresses = popup.getByRole('dialog', { name: 'Select Recipient' })
  await expect(ownAddresses.getByRole('button', { name: /Send to .* Shielded/ })).toHaveCount(1)
  await expect(ownAddresses.getByRole('button', { name: /Send to .* Transparent/ })).toHaveCount(1)
  await captureScreenshot(popup, 'swap-zec-own-addresses.png')
  await ownAddresses.getByRole('button', { name: 'Close', exact: true }).click()
  await popup.getByRole('button', { name: 'Back', exact: true }).click()
  const zcashRecipient = await popup.evaluate(async zcashChainId => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const active = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const zcash = active?.networks?.find(
      (network: { chainId?: unknown }) => network.chainId === zcashChainId
    )
    return zcash?.addresses?.find(
      (address: { scheme?: unknown }) => address.scheme === 'zcash-shielded-unified'
    )?.value as string | undefined
  }, getZcashChainId('mainnet'))
  expect(zcashRecipient).toMatch(/^u1/)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Add Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Private Key', exact: true }).click()
  await popup.getByLabel('Wallet name').fill('Synthetic EVM')
  await popup.getByLabel('Private key', { exact: true }).fill(`0x${'00'.repeat(31)}01`)
  await expect(popup.getByText('Detected network', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByText('EVM address preview', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
    timeout: 60_000
  })

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await assets.getByPlaceholder('Search tokens').fill('ZEC')
  await assets
    .getByRole('button', { name: /^ZEC on Zcash/ })
    .first()
    .click()
  await expect(popup.getByRole('textbox', { name: 'Receive at' })).toBeVisible()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('0.01')
  await popup.getByRole('textbox', { name: 'Receive at' }).fill('not-a-zcash-address')
  await expect(popup.getByText('Enter a valid Zcash address.')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeDisabled()
  await popup.waitForTimeout(1_000)
  expect(api.getQuoteRequests()).toHaveLength(0)

  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  const recipients = popup.getByRole('dialog', { name: 'Select Recipient' })
  const unavailableAccount = recipients.getByRole('button', {
    name: /Unavailable on this network/
  })
  await expect(unavailableAccount).toHaveCount(1)
  await expect(unavailableAccount).toBeDisabled()
  await captureScreenshot(popup, 'swap-zec-unavailable-account.png')
  await expect(recipients.getByRole('button', { name: /Send to .* Shielded/ })).toBeVisible()
  await recipients.getByRole('button', { name: /Send to .* Shielded/ }).click()
  await expect(popup.getByRole('textbox', { name: 'Receive at' })).toHaveValue(zcashRecipient!)
  await captureScreenshot(popup, 'swap-evm-only-zec-recipient.png')
  await expect.poll(() => api.getQuoteRequests().at(-1)?.recipient).toBe(zcashRecipient)
  const review = popup.getByRole('button', { name: 'Swap', exact: true })
  await expect(review).toBeEnabled({ timeout: 30_000 })
  await review.click()
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible()
  await expect(popup.getByText(zcashRecipient!, { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'swap-evm-only-zec-review.png')
})

test('shows only the header title on the Swap review page in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  for (const [direction, symbol, network] of [
    ['To', 'USDC', 'Polygon'],
    ['From', 'ETH', 'Ethereum']
  ] as const) {
    await popup.getByRole('button', { name: `${direction} asset` }).click()
    const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
    await assets.getByPlaceholder('Search tokens').fill(symbol)
    await assets
      .getByRole('button', { name: new RegExp(`^${symbol} on ${network}`) })
      .first()
      .click()
  }
  await popup.getByRole('textbox', { name: 'From amount' }).fill('0.01')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled()
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Swap', exact: true })).toBeVisible()
  await expect(popup.getByRole('heading')).toHaveCount(1)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-review-single-header.png')
})

test('allows reversing the initial asset selected from asset details', async ({
  context,
  popup,
  extensionId
}) => {
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  const from = popup.getByRole('button', { name: 'From asset' })
  const to = popup.getByRole('button', { name: 'To asset' })
  await expect(from).toContainText('ETH')
  await expect(to).toContainText('USDC')
  await captureScreenshot(popup, 'swap-asset-detail-initial-pair.png')
  await popup.getByRole('button', { name: 'Switch assets', exact: true }).click()
  await expect(from).toContainText('USDC')
  await expect(to).toContainText('ETH')
  await expect.poll(() => readPersistedSwapSource(popup)).not.toBe(ETH_ASSET)
  await captureScreenshot(popup, 'swap-asset-detail-reversed-pair.png')
  await popup.getByRole('button', { name: 'Switch assets', exact: true }).click()
  await expect(from).toContainText('ETH')
  await expect(to).toContainText('USDC')
})

for (const sourceMode of ['main', 'private'] as const) {
  test(`reserves actual contract gas for native Swap Max from ${sourceMode} in real MV3`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(120_000)
    const rpc = await mockEvmNetwork(context, { contractGas: '0x249f0' })
    await mockBitcoinNetwork(context)
    const api = await mockProtocolApis(context)
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup.getByRole('button', { name: 'Swap', exact: true }).click()
    for (const [direction, symbol, network] of [
      ['To', 'USDC', sourceMode === 'private' ? 'Base' : 'Polygon'],
      ['From', 'ETH', 'Ethereum']
    ] as const) {
      await popup.getByRole('button', { name: `${direction} asset` }).click()
      const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
      await assets.getByPlaceholder('Search tokens').fill(symbol)
      await assets
        .getByRole('button', { name: new RegExp(`^${symbol} on ${network}`) })
        .first()
        .click()
    }
    if (sourceMode === 'private') {
      await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
      await popup
        .getByRole('dialog', { name: 'Choose source account' })
        .getByRole('radio', { name: /Confidential account/ })
        .click()
    }
    await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('USDC')
    const balance = popup.getByRole('button', { name: /^Use maximum balance:/ })
    const balanceLabel = await balance.getAttribute('aria-label')
    let probeStarted = false
    let releaseProbe!: () => void
    const probePending = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    await context.route(QUOTE_URL, async route => {
      if (!probeStarted) {
        probeStarted = true
        await probePending
      }
      await route.fallback()
    })
    await balance.click()
    try {
      await expect.poll(() => probeStarted).toBe(true)
      await expect(popup.getByRole('textbox', { name: 'From amount' })).toHaveValue('')
      await expect(balance).toBeDisabled()
      await expect(balance).toHaveAttribute('aria-label', balanceLabel!)
      await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeDisabled()
      await captureScreenshot(popup, `swap-native-max-${sourceMode}-calculating.png`)
    } finally {
      releaseProbe()
    }
    await expect(popup.getByRole('textbox', { name: 'From amount' })).toHaveValue('0.999325', {
      timeout: 30_000
    })
    await expect(balance).toHaveAttribute('aria-label', balanceLabel!)
    await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled()
    expect(api.getQuoteRequests().map(request => request.amount)).toEqual([
      '500000000000000000',
      '999325000000000000'
    ])
    await captureScreenshot(popup, `swap-native-max-${sourceMode}-ready.png`)
    await popup.getByRole('button', { name: 'Swap', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Review Swap', exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(popup.getByText('0.00054 ETH', { exact: true })).toBeVisible()
    expect(api.getQuoteRequests().at(-1)?.amount).toBe('999325000000000000')
    expect(rpc.getContractGasEstimateCount()).toBeGreaterThanOrEqual(2)
    expect(rpc.getBroadcastCount()).toBe(0)
    await expectNoOverflow(popup)
    await captureScreenshot(
      popup,
      sourceMode === 'main'
        ? 'swap-native-max-main-contract-gas.png'
        : 'swap-native-max-private-contract-gas.png'
    )
    await popup.getByRole('button', { name: 'Edit network fee' }).click()
    await popup
      .getByRole('dialog', { name: 'Network Fee' })
      .getByRole('radio', { name: /Fast/ })
      .click()
    await expect(popup.getByRole('heading', { name: 'Review Swap', exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(popup.getByText('0.00072 ETH', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(api.getQuoteRequests().at(-1)?.amount).toBe('999100000000000000')
    expect(rpc.getBroadcastCount()).toBe(0)
    await captureScreenshot(
      popup,
      sourceMode === 'main'
        ? 'swap-native-max-main-fast-gas.png'
        : 'swap-native-max-private-fast-gas.png'
    )
  })
}

test('recalculates ETH Swap Max when the source balance changes', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpc = await mockEvmNetwork(context, { contractGas: '0x249f0' })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  for (const [direction, symbol, network] of [
    ['To', 'USDC', 'Polygon'],
    ['From', 'ETH', 'Ethereum']
  ] as const) {
    await popup.getByRole('button', { name: `${direction} asset` }).click()
    const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
    await assets.getByPlaceholder('Search tokens').fill(symbol)
    await assets
      .getByRole('button', { name: new RegExp(`^${symbol} on ${network}`) })
      .first()
      .click()
  }
  const amount = popup.getByRole('textbox', { name: 'From amount' })
  await popup.getByRole('button', { name: /^Use maximum balance:/ }).click()
  await expect(amount).toHaveValue('0.999325', { timeout: 30_000 })

  const mainAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const account = response?.result?.accounts?.find(
      (item: { active?: unknown }) => item.active === true
    )
    const network = account?.networks?.find(
      (item: { chainId?: unknown }) => item.chainId === 'eip155:1'
    )
    const address = network?.addresses?.find(
      (item: { preferredForReceive?: unknown }) => item.preferredForReceive
    )?.value
    if (typeof address !== 'string') throw new Error('Ethereum Main address unavailable')
    return address
  })
  rpc.setAddressBalanceRaw(mainAddress, 800_000_000_000_000_000n)
  await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PORTFOLIO',
      action: 'refresh',
      chainIds: ['eip155:1']
    })
    if (response?.error) throw new Error('Portfolio refresh failed')
  })

  await expect(amount).toHaveValue('0.799325', { timeout: 30_000 })
  await expect(popup.getByText('Insufficient ETH balance', { exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled()
  expect(rpc.getBroadcastCount()).toBe(0)
})

test('recovers expired Swap review and shows preparation loading in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpc = await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context)
  let markBuildStarted = () => {}
  const buildStarted = new Promise<void>(resolve => {
    markBuildStarted = resolve
  })
  let releaseBuild = () => {}
  const buildGate = new Promise<void>(resolve => {
    releaseBuild = resolve
  })
  await context.route(BUILD_SWAP_URL, async route => {
    markBuildStarted()
    await buildGate
    await route.fallback()
  })
  let maxQuoteRequests = 0
  await context.route(QUOTE_URL, route => {
    const amount = String(route.request().postDataJSON().amountIn)
    if (amount !== '500000000000000000') {
      return route.fallback()
    }
    maxQuoteRequests += 1
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 1, msg: 'Price moved too much, please re-quote', data: null })
    })
  })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup
    .getByRole('button', { name: /^USDC on Ethereum/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  const sourceSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await sourceSelector.getByPlaceholder('Search tokens').fill('ETH')
  await sourceSelector
    .getByRole('button', { name: /^ETH on Ethereum, balance 1 ETH$/ })
    .first()
    .click()
  expect(maxQuoteRequests).toBe(0)
  const maxButton = popup.getByRole('button', { name: 'Use maximum balance: 1' })
  await expect(maxButton).toBeEnabled({ timeout: 30_000 })
  await maxButton.click()
  await expect.poll(() => maxQuoteRequests).toBe(1)
  await expect(popup.getByRole('textbox', { name: 'From amount', exact: true })).toHaveValue('0.95')
  await expect(maxButton).toHaveAttribute('aria-label', 'Use maximum balance: 1')
  await captureScreenshot(popup, 'swap-max-fallback-balance.png')
  await expect(popup.getByText('Could not calculate Max amount.')).toHaveCount(0)
  await popup.getByRole('textbox', { name: 'From amount', exact: true }).fill('0.002')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('textbox', { name: 'From amount', exact: true }).fill('0.001')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-max-estimate-error-recovery.png')
  const swapButton = popup.getByRole('button', { name: 'Swap', exact: true })
  await swapButton.click()
  try {
    await buildStarted
    await expect(swapButton).toBeDisabled()
    await expect(swapButton.locator('svg.animate-spin')).toBeVisible()
  } finally {
    releaseBuild()
  }
  await expect(popup.getByRole('heading', { name: 'Review Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  const inputQuoteCount = () =>
    api.getQuoteRequests().filter(request => request.amount === '1000000000000000').length
  const quotesBeforeRefresh = inputQuoteCount()
  await popup.clock.setFixedTime(new Date(Date.now() + 6 * 60_000))
  await popup.getByRole('button', { name: 'Confirm Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Swap', exact: true })).toHaveCount(0)
  await expect(popup.getByText('Swap review expired. Getting a new quote.')).toBeVisible()
  await expect(popup.getByRole('textbox', { name: 'From amount', exact: true })).toHaveValue(
    '0.001'
  )
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expect.poll(inputQuoteCount).toBeGreaterThan(quotesBeforeRefresh)
  expect(rpc.getBroadcastCount()).toBe(0)
})

test('reviews dApp gas funding from same-chain Main without the Swap input page', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const network = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const dapp = await connectEvmDApp(context)
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  await popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByRole('radio', { name: 'Use Confidential address for dApps' })
    .click()
  const setup = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  if (await setup.isVisible()) await setup.getByRole('button', { name: 'Turn on' }).click()
  await expect.poll(async () => (await readEvmAccounts(dapp.page))[0]).not.toBe(dapp.address)
  const [privateAddress] = await readEvmAccounts(dapp.page)
  network.setAddressBalanceRaw(privateAddress, 1n)
  const approvalPromise = context.waitForEvent('page')
  const transactionPromise = dapp.page.evaluate(async from => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: { request: (input: { method: string; params: unknown[] }) => Promise<unknown> }
        }
      }
    ).noirwallet.ethereum
    try {
      await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from,
            to: '0x3333333333333333333333333333333333333333',
            data: '0x12345678'
          }
        ]
      })
      return { code: null }
    } catch (error) {
      return { code: (error as { code?: unknown }).code }
    }
  }, privateAddress)
  const approval = await approvalPromise
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByRole('button', { name: 'Fund gas', exact: true })).toBeVisible()
  await approval.getByRole('button', { name: 'Fund gas', exact: true }).click()
  await expect(approval.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
  await expect(approval.getByRole('heading')).toHaveCount(1)
  await expect(approval.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(approval.getByRole('button', { name: 'From asset' })).toHaveCount(0)
  await expect(approval.getByRole('button', { name: 'To asset' })).toHaveCount(0)
  await expect(approval.getByText('Add to Confidential', { exact: true })).toHaveCount(0)
  await expect.poll(() => api.getQuoteRequests().at(-1)?.originAsset).toBe(ETH_ASSET)
  expect(api.getQuoteRequests().at(-1)?.destinationAsset).toBe(ETH_ASSET)
  expect(api.getQuoteRequests().at(-1)?.refundTo.toLowerCase()).toBe(dapp.address.toLowerCase())
  expect(api.getQuoteRequests().at(-1)?.recipient.toLowerCase()).toBe(privateAddress.toLowerCase())
  await captureScreenshot(approval, 'dapp-same-chain-gas-transfer-review.png')
  expect(network.getBroadcastCount()).toBe(0)
  await approval.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(() => network.getBroadcastCount()).toBeGreaterThan(0)
  await expect(approval.getByRole('button', { name: 'Done', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await approval.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(approval.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await captureScreenshot(approval, 'dapp-gas-funded-resume-approval.png')
  await approval.getByRole('button', { name: 'Reject', exact: true }).click()
  expect((await transactionPromise).code).toBe(4001)
})

test('selects independent source and destination accounts in Swap in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  for (const [direction, symbol] of [
    ['To', 'USDC'],
    ['From', 'ETH']
  ] as const) {
    await popup.getByRole('button', { name: `${direction} asset` }).click()
    const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
    await assets.getByPlaceholder('Search tokens').fill(symbol)
    await assets
      .getByRole('button', { name: new RegExp(`^${symbol} on Ethereum`) })
      .first()
      .click()
  }
  const addresses = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const account = response?.result?.accounts?.find(
      (item: { active?: unknown }) => item.active === true
    )
    const network = account?.networks?.find(
      (item: { chainId?: unknown }) => item.chainId === 'eip155:1'
    )
    const mainAddress = network?.addresses?.find(
      (item: { preferredForReceive?: unknown }) => item.preferredForReceive
    )?.value
    if (typeof mainAddress !== 'string' || typeof network?.privateExecutionAddress !== 'string') {
      throw new Error('Ethereum execution addresses unavailable')
    }
    return { main: mainAddress, private: network.privateExecutionAddress }
  })
  await popup.getByRole('textbox', { name: 'From amount' }).fill('0.01')
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(addresses.main.toLowerCase())
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.refundTo.toLowerCase())
    .toBe(addresses.main.toLowerCase())
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  await popup
    .getByRole('dialog', { name: 'Select Recipient' })
    .getByRole('button', { name: /Send to .* Confidential/ })
    .click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current main' })
  ).toBeVisible()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('0.01')
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(addresses.private.toLowerCase())
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-main-to-confidential.png')

  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('0.01')
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(addresses.private.toLowerCase())
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.refundTo.toLowerCase())
    .toBe(addresses.private.toLowerCase())
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  await popup
    .getByRole('dialog', { name: 'Select Recipient' })
    .getByRole('button', { name: /Send to .* Public/ })
    .click()
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(addresses.main.toLowerCase())
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.refundTo.toLowerCase())
    .toBe(addresses.private.toLowerCase())
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-confidential-to-main.png')

  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  await captureScreenshot(popup, 'swap-destination-account-selector.png')
  await popup
    .getByRole('dialog', { name: 'Select Recipient' })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  const customAddress = '0x1111111111111111111111111111111111111111'
  await popup.getByRole('textbox', { name: 'Receive at' }).fill(customAddress)
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(customAddress)
  await captureScreenshot(popup, 'swap-custom-destination.png')
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  await popup
    .getByRole('dialog', { name: 'Select Recipient' })
    .getByRole('button', { name: /Send to .* Public/ })
    .click()
  await expect
    .poll(() => api.getQuoteRequests().at(-1)?.recipient.toLowerCase())
    .toBe(addresses.main.toLowerCase())
  for (const confidential of [true, false]) {
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup
      .getByRole('button', { name: `dApp address: ${confidential ? 'Public' : 'Confidential'}` })
      .click()
    await popup
      .getByRole('dialog', { name: 'dApp address' })
      .getByRole('radio', {
        name: `Use ${confidential ? 'Confidential' : 'Public'} address for dApps`
      })
      .click()
    const setup = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
    if (await setup.isVisible()) await setup.getByRole('button', { name: 'Turn on' }).click()
    await expect(
      popup.getByRole('button', {
        name: `dApp address: ${confidential ? 'Confidential' : 'Public'}`
      })
    ).toBeVisible()
    await popup.getByRole('button', { name: 'Swap', exact: true }).click()
    for (const [direction, symbol] of [
      ['From', 'ETH'],
      ['To', 'USDC']
    ] as const) {
      await popup.getByRole('button', { name: `${direction} asset` }).click()
      const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
      await assets.getByPlaceholder('Search tokens').fill(symbol)
      await assets
        .getByRole('button', { name: new RegExp(`^${symbol} on Ethereum`) })
        .first()
        .click()
    }
    const mode = confidential ? 'private' : 'main'
    await expect(
      popup.getByRole('button', { name: `Choose source account, current ${mode}` })
    ).toBeVisible()
    await expect(popup.getByRole('textbox', { name: 'Receive at' })).toHaveValue(
      confidential ? addresses.private : addresses.main
    )
    const notification = popup.getByRole('button', { name: 'Dismiss notification' })
    if (await notification.isVisible()) await notification.click()
    await captureScreenshot(
      popup,
      mode === 'main' ? 'swap-global-main-defaults.png' : 'swap-global-private-defaults.png'
    )
  }
})

test('shows compact account icons in Swap and Confidential labels in address views in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinationAssets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await destinationAssets.getByPlaceholder('Search tokens').fill('USDC')
  await destinationAssets
    .getByRole('button', { name: /^USDC on Ethereum/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  const assets = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await assets.getByPlaceholder('Search tokens').fill('ETH')
  const ethereumEth = assets.getByRole('button', { name: /^ETH on Ethereum/ }).first()
  await expect(ethereumEth).toBeVisible({ timeout: 30_000 })
  await ethereumEth.click()
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()
  const icon = popup.getByRole('button', { name: 'Choose source account, current private' })
  await expect(icon).toBeVisible()
  await expect(icon).not.toContainText('Confidential')
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-confidential-icon.png')
  await icon.hover()
  await expect(popup.getByRole('tooltip')).toContainText('Confidential')
  await captureScreenshot(popup, 'swap-confidential-icon-hover.png', { preservePointer: true })

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Show account addresses' }).click()
  const addresses = popup.getByLabel('Account address menu')
  await expect(
    addresses.getByRole('button', { name: 'Copy EVM Confidential address' })
  ).toContainText('Confidential')
  await captureScreenshot(popup, 'account-address-confidential-label.png')
  await addresses.getByRole('button', { name: 'View all' }).click()
  await expect(
    popup.getByRole('button', { name: 'Copy Confidential address' }).first()
  ).toBeVisible()
  await expect(popup.getByText('Confidential', { exact: true }).first()).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'address-list-confidential-label.png')
})

test('shows Swap asset icons, sent amount, and route clearly in Activity', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(150_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const protocolApis = await mockProtocolApis(context, { orderStatus: 'pending' })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'View USDC details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('status', { name: 'Loading additional networks' })).toHaveCount(0, {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinationSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await destinationSelector.getByPlaceholder('Search tokens').fill('USDC')
  await destinationSelector
    .getByRole('button', { name: /^USDC on Polygon/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  const sourceSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  await sourceSelector.getByPlaceholder('Search tokens').fill('ETH')
  const ethereumSource = sourceSelector.getByRole('button', { name: /^ETH on Ethereum/ }).first()
  await expect(ethereumSource).toBeVisible({ timeout: 30_000 })
  await ethereumSource.click()
  await popup.locator('input[placeholder="0"]').fill('0.01')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible({ timeout: 60_000 })
  await popup.getByRole('button', { name: 'Confirm Swap', exact: true }).click()
  await expect.poll(evmNetwork.getBroadcastCount, { timeout: 30_000 }).toBe(1)

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const row = popup.locator('[data-activity-kind="swap"]').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText('Swap ETH → USDC')
  await expect(row).toContainText('Ethereum → Polygon')
  await expect(row).toContainText('−0.01 ETH')
  await expect(row).not.toContainText('Quoted')
  await expect(row.locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')).toHaveCount(2)
  const tokenPositions = await row
    .locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
    .evaluateAll(icons => icons.map(icon => icon.getBoundingClientRect().left))
  const swapRowLeft = await row.evaluate(element => element.getBoundingClientRect().left)
  expect(tokenPositions[0] - swapRowLeft).toBe(20)
  expect(tokenPositions[1] - tokenPositions[0]).toBeLessThan(30)
  await expect(row).toContainText(/Source submitted|Waiting for Intents/)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-activity-route-row.png')

  await row.click()
  const detail = popup.locator('[data-activity-swap-detail]')
  await expect(detail.locator('[data-slot="token-icon"]')).toHaveCount(2)
  await expect(detail).toContainText('−0.01 ETH')
  await expect(popup.getByText('Route', { exact: true })).toBeVisible()
  await expect(popup.getByText('From network', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('To network', { exact: true })).toHaveCount(0)
  await expect(popup.locator('[data-activity-status-value]')).toHaveText(
    /^(Source submitted|Waiting for Intents)$/
  )
  await expect(popup.getByText('To', { exact: true })).toBeVisible()
  await expect(popup.getByTitle(/^0x[0-9a-fA-F]{40}$/).first()).toBeVisible()
  await expect(popup.getByTitle('0x4444444444444444444444444444444444444444')).toHaveCount(0)
  await expect(popup.getByText('Outgoing Hash', { exact: true })).toHaveCount(0)
  await expect(popup.locator('[data-progress-step] a[title^="0x"]')).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-activity-route-detail.png')

  const swapActivityId = await row.getAttribute('data-activity-id')
  await popup.evaluate(async () => {
    await chrome.alarms.create('evm-transaction-monitor-alarm', { when: Date.now() + 100 })
  })
  await expect
    .poll(
      async () => {
        const response = (await popup.evaluate(() =>
          chrome.runtime.sendMessage({ type: 'GET_ACTIVITY', action: 'read' })
        )) as {
          result?: {
            items?: Array<{ id: string; segments: Array<{ role: string; status: string }> }>
          }
        }
        return response.result?.items
          ?.find(item => item.id === swapActivityId)
          ?.segments.find(segment => segment.role === 'origin')?.status
      },
      { timeout: 30_000 }
    )
    .toBe('final')
  protocolApis.setOrderStatus('completed')
  await popup.evaluate(async () => {
    await chrome.alarms.create('rhea-swap-transaction-monitor-alarm', { when: Date.now() + 100 })
  })
  await expect(popup.locator('[data-activity-status-value]')).toHaveText('Confirmed', {
    timeout: 30_000
  })
  const destinationHash = popup.locator('[data-progress-step] a[title^="0x"]').last()
  await expect(destinationHash).toHaveAttribute('title', `0x${'f'.repeat(64)}`)
  await destinationHash.scrollIntoViewIfNeeded()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-activity-route-final-detail.png')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const completedRow = popup.locator('[data-activity-kind="swap"]').first()
  await expect(completedRow).toHaveAttribute('data-activity-status', 'final', { timeout: 30_000 })
  await expect(completedRow).toContainText('−0.01 ETH')
  await expect(completedRow).not.toContainText('Confirmed')
  await captureScreenshot(popup, 'swap-activity-route-final-row.png')
})

test('prepares and rejects wallet-owned EVM Swap reviews in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(240_000)
  const evmNetwork = await mockEvmNetwork(context)
  const protocolApis = await mockProtocolApis(context, { quoteResponseDelayMs: 300 })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('button', { name: 'Transfer to Confidential' })
    .click()
  const fundingDialog = popup.getByRole('dialog', { name: 'Transfer ETH' })
  await expect(fundingDialog).toBeVisible()
  await fundingDialog.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
  await expect(fundingDialog.getByRole('button', { name: 'Review transfer' })).toBeEnabled()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'private-defi-add-funds-input.png')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByText('Swap', { exact: true }).first()).toBeVisible()
  const fromAsset = popup.getByRole('button', { name: 'From asset' })
  await expect(fromAsset).toBeEnabled({ timeout: 30_000 })
  await fromAsset.click()
  const sourceSelector = popup.getByRole('dialog', { name: 'SELECT ASSET' })
  const zecSwapSource = sourceSelector.getByRole('button', {
    name: /^ZEC on Zcash, balance 0 ZEC$/
  })
  const usdcSwapSource = sourceSelector.getByRole('button', {
    name: 'USDC on Ethereum, balance 10 USDC'
  })
  await expect(
    sourceSelector.getByRole('button', { name: 'USDC on Polygon, balance 10 USDC' })
  ).toBeVisible()
  const polSwapSource = sourceSelector.getByRole('button', {
    name: /^POL on Polygon, balance 1 POL$/
  })
  const trialSwapSource = sourceSelector.getByRole('button', {
    name: /^TRIAL on Ethereum$/
  })
  await zecSwapSource.click()
  await expect(fromAsset).toContainText('ZEC')
  await fromAsset.click()
  await expect(zecSwapSource).toContainText('0 ZEC')
  await expect(usdcSwapSource).toContainText('10 USDC')
  await expect(polSwapSource).toContainText('1 POL')
  const bitcoinSource = sourceSelector.getByRole('button', { name: /^BTC on Bitcoin/ })
  if (bitcoinEnabled) {
    await expect(bitcoinSource).toBeVisible()
  } else {
    await expect(bitcoinSource).toHaveCount(0)
  }
  await expect(trialSwapSource).toBeVisible()
  await expect(sourceSelector.getByText('Powered by CoinGecko', { exact: true })).toHaveCount(0)
  const [tokenSearchBox, networkFilterBox] = await Promise.all([
    sourceSelector.getByPlaceholder('Search tokens').boundingBox(),
    sourceSelector
      .getByRole('button', { name: 'Filter assets by network: All Networks' })
      .boundingBox()
  ])
  if (!tokenSearchBox || !networkFilterBox) {
    throw new Error('Swap asset selector controls do not have layout boxes')
  }
  expect(tokenSearchBox.y).toBeLessThan(networkFilterBox.y)
  await expect
    .poll(() =>
      usdcSwapSource
        .getByRole('img', { name: 'USDC', exact: true })
        .evaluate(image => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0)
  for (const [row, symbol] of [
    [zecSwapSource, 'ZEC'],
    [sourceSelector.getByRole('button', { name: /^BNB on BNB Chain/ }), 'BNB'],
    [polSwapSource, 'POL']
  ] as const) {
    const icon = row.getByRole('img', { name: symbol, exact: true })
    await expect
      .poll(() => icon.evaluate(image => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  }
  await expect(sourceSelector.getByText('Ethereum', { exact: true }).first()).toBeVisible()
  await expect(zecSwapSource).toHaveAttribute('aria-pressed', 'true')
  await expect(usdcSwapSource).toHaveAttribute('aria-pressed', 'false')
  await expect(sourceSelector.locator('[data-token-selection-indicator]')).toHaveCount(0)
  const swapNetworkFilter = sourceSelector.getByRole('button', {
    name: 'Filter assets by network: All Networks'
  })
  await swapNetworkFilter.click()
  const networkFilterContent = popup.getByRole('menu')
  await expect(networkFilterContent).toBeVisible()
  await expect
    .poll(async () => (await networkFilterContent.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(12)
  const bitcoinFilter = popup.getByRole('menuitemradio', { name: 'Bitcoin', exact: true })
  if (bitcoinEnabled) {
    await expect(bitcoinFilter).toBeVisible()
  } else {
    await expect(bitcoinFilter).toHaveCount(0)
  }
  await popup.getByRole('menuitemradio', { name: 'Polygon', exact: true }).click()
  await expect(zecSwapSource).toHaveCount(0)
  await expect(polSwapSource).toBeVisible()
  await sourceSelector.getByRole('button', { name: 'Filter assets by network: Polygon' }).click()
  await popup.getByRole('menuitemradio', { name: 'All Networks', exact: true }).click()
  await expect(zecSwapSource).toBeVisible()
  await captureScreenshot(popup, 'protocol-wallet-swap-source-selector.png')
  await sourceSelector.getByRole('button', { name: 'Close', exact: true }).click()
  await popup.getByRole('button', { name: 'Switch assets', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('ETH')
  const swapSourceButton = popup.getByRole('button', {
    name: 'Choose source account, current main'
  })
  await expect(swapSourceButton).toBeVisible()
  await captureScreenshot(popup, 'private-defi-swap-account-main.png')
  await swapSourceButton.click()
  let swapSourceDialog = popup.getByRole('dialog', { name: 'Choose source account' })
  await expect(swapSourceDialog.getByText('Selected', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'private-defi-swap-account-selector.png')
  await swapSourceDialog.getByRole('radio', { name: /Confidential account/ }).click()
  const privateSwapSourceButton = popup.getByRole('button', {
    name: 'Choose source account, current private'
  })
  await expect(privateSwapSourceButton).toBeVisible()
  await captureScreenshot(popup, 'private-defi-swap-account-private.png')
  const privateSwapSourceAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const activeAccount = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const evmNetwork = activeAccount?.networks?.find(
      (network: { chainId?: unknown; privateExecutionAddress?: unknown }) =>
        network.chainId === 'eip155:1' && typeof network.privateExecutionAddress === 'string'
    )
    if (typeof evmNetwork?.privateExecutionAddress !== 'string') {
      throw new Error('Ethereum Private Execution Address is unavailable')
    }
    return evmNetwork.privateExecutionAddress
  })
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup.getByRole('button', { name: /USDC.*Base/i }).click()
  const privateQuoteCount = protocolApis.getQuoteRequests().length
  await popup.locator('input[placeholder="0"]').fill('0.01')
  await expect.poll(() => protocolApis.getQuoteRequests().length).toBe(privateQuoteCount + 1)
  const privateSwapQuote = protocolApis.getQuoteRequests().at(-1)
  expect(privateSwapQuote).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: BASE_USDC_CONTRACT,
    amount: '10000000000000000',
    confidentiality: 'basic'
  })
  expect(privateSwapQuote?.refundTo.toLowerCase()).toBe(privateSwapSourceAddress.toLowerCase())
  expect(privateSwapQuote?.recipient).toMatch(/^0x[0-9a-fA-F]{40}$/)
  await popup.locator('input[placeholder="0"]').fill('')
  await privateSwapSourceButton.click()
  swapSourceDialog = popup.getByRole('dialog', { name: 'Choose source account' })
  await swapSourceDialog.getByRole('radio', { name: /Public account/ }).click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current main' })
  ).toBeVisible()
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup.getByRole('button', { name: /USDC.*Polygon/i }).click()
  await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('USDC')
  const swapAmountInput = popup.locator('input[placeholder="0"]')
  const quoteCountBeforeInsufficientAmount = protocolApis.getQuoteRequests().length
  await swapAmountInput.fill('2')
  const fromCard = popup.locator('section').filter({ hasText: /^From/ }).first()
  await expect(fromCard.getByText('Insufficient ETH balance', { exact: true })).toBeVisible()
  await expect
    .poll(() => protocolApis.getQuoteRequests().length)
    .toBe(quoteCountBeforeInsufficientAmount + 1)
  expect(protocolApis.getQuoteRequests().at(-1)).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: POLYGON_USDC_CONTRACT,
    amount: '2000000000000000000',
    dry: false
  })
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeDisabled()
  const quoteCountBeforeUntrackedSource = protocolApis.getQuoteRequests().length
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('TRIAL')
  await popup.getByRole('button', { name: /^TRIAL on Ethereum$/ }).click()
  await swapAmountInput.fill('2')
  await expect(fromCard.getByText('Insufficient TRIAL balance', { exact: true })).toBeVisible()
  await expect
    .poll(() => protocolApis.getQuoteRequests().length)
    .toBe(quoteCountBeforeUntrackedSource + 1)
  expect(protocolApis.getQuoteRequests().at(-1)).toMatchObject({
    originAsset: TRIAL_CONTRACT,
    destinationAsset: POLYGON_USDC_CONTRACT,
    amount: '2000000000000000000',
    dry: false
  })
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeDisabled()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('ETH')
  await popup.getByRole('button', { name: /^ETH on Ethereum/ }).click()
  await swapAmountInput.fill('0.009')
  await swapAmountInput.fill('0.01')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-source-evm-input.png')
  await popup.locator('button[aria-expanded]').click()
  await expect(popup.getByText('Refund to this wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  const liveQuote = protocolApis.getQuoteRequests().at(-1)
  expect(liveQuote).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: POLYGON_USDC_CONTRACT,
    amount: '10000000000000000',
    dry: false
  })
  expect(liveQuote?.refundTo).toMatch(/^0x[0-9a-f]{40}$/i)
  expect(liveQuote?.recipient).toMatch(/^0x[0-9a-f]{40}$/i)
  const quoteCountBeforeReview = protocolApis.getQuoteRequests().length
  await popup.evaluate(() => {
    const target = window as typeof window & { restoreQuoteClock?: () => void }
    const realNow = Date.now
    const staleNow = realNow() + 30 * 60_000 + 1
    target.restoreQuoteClock = () => {
      Date.now = realNow
      delete target.restoreQuoteClock
    }
    Date.now = () => staleNow
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect.poll(() => protocolApis.getQuoteRequests().length).toBe(quoteCountBeforeReview + 1)
  // Keep the replacement quote on the background's clock; review still requires confirmation.
  await popup.evaluate(() => {
    ;(window as typeof window & { restoreQuoteClock?: () => void }).restoreQuoteClock?.()
  })
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible({
    timeout: 60_000
  })
  expect(protocolApis.getQuoteRequests()).toHaveLength(quoteCountBeforeReview + 1)
  await expect(popup.getByText('Network Fee', { exact: true })).toBeVisible()
  await expect(
    popup
      .getByText('Source Wallet', { exact: true })
      .locator('..')
      .getByRole('img', { name: 'Ethereum', exact: true })
  ).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-source-evm-review.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const activity = popup.getByRole('region', { name: 'Multichain activity' })
  await expect(activity).toBeVisible()
  await expect(activity.locator('[data-activity-kind="swap"]')).toHaveCount(0)
  await captureScreenshot(popup, 'protocol-wallet-swap-activity-list.png')

  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const value = (await chrome.storage.local.get('swap_token_catalog_cache_v1'))
          .swap_token_catalog_cache_v1
        return Array.isArray(value?.tokens) ? value.tokens.length : 0
      })
    )
    .toBeGreaterThan(0)
  protocolApis.setTokenOnline(false)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await expect(
    popup.getByRole('dialog', { name: 'SELECT ASSET' }).getByRole('button', {
      name: /^ETH on Ethereum, balance 1 ETH$/
    })
  ).toBeVisible({ timeout: 5_000 })
  await captureScreenshot(popup, 'protocol-wallet-swap-cached-catalog.png')

  expect(evmNetwork.getBroadcastCount()).toBe(0)
})

test('waits for ERC-20 approval confirmation before preparing the Swap call', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true, pendingBroadcast: true })
  await mockBitcoinNetwork(context)
  const protocolApis = await mockProtocolApis(context, { evmApproval: true })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'View USDC details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup
    .getByRole('dialog', { name: 'SELECT ASSET' })
    .getByRole('button', { name: 'USDC on Ethereum, balance 10 USDC' })
    .click()
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('USDC')
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup.getByRole('button', { name: /USDC.*Polygon/i }).click()
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('USDC')
  await popup.locator('input[placeholder="0"]').fill('2')
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 60_000
  })
  expect(protocolApis.getQuoteRequests().at(-1)).toMatchObject({
    originAsset: ETHEREUM_USDC_CONTRACT,
    destinationAsset: POLYGON_USDC_CONTRACT
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible({
    timeout: 60_000
  })
  await expect(popup.getByRole('button', { name: 'Approve USDC' })).toBeVisible()
  expect(evmNetwork.getContractGasEstimateCount()).toBe(0)

  await popup.getByRole('button', { name: 'Approve USDC' }).click()
  await expect(popup.getByRole('heading', { name: 'Token approval', exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(popup.getByText('Token approval submitted')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View Activity' })).toBeVisible()
  await expectNoOverflow(popup)
  expect(evmNetwork.getBroadcastCount()).toBe(1)
  expect(evmNetwork.getContractGasEstimateCount()).toBe(0)
  const approval = parseTransaction(evmNetwork.getBroadcastRawTransactions()[0] as Hex)
  expect(approval.to?.toLowerCase()).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
  expect(approval.data).toMatch(/^0x095ea7b3/)
  expect(BigInt(`0x${approval.data?.slice(-64)}`)).toBe(2_000_000n)
  await captureScreenshot(popup, 'swap-approval-pending.png')
  await popup.getByRole('button', { name: 'View Activity' }).click()
  await expect(popup.getByRole('region', { name: 'Multichain activity' })).toBeVisible()
  await captureScreenshot(popup, 'swap-approval-view-activity.png')
})

test('uses the active Polygon wallet source and POL fees in Swap', async ({ context, popup }) => {
  test.setTimeout(300_000)
  const evmNetwork = await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, {
    mcaId: 'rhea00000x.multica.near',
    includeMultichainMarkets: true
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const activeAccount = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const state = typeof stored === 'string' ? JSON.parse(stored).state : stored?.state
    return { walletId: state?.currentWalletId, accountId: state?.currentAccountId }
  })
  expect(activeAccount).toEqual({ walletId: expect.any(String), accountId: expect.any(String) })
  if (!activeAccount.walletId || !activeAccount.accountId) {
    throw new Error('Active Account fixture is missing')
  }
  const addedAccount = await popup.evaluate(walletId => {
    return chrome.runtime.sendMessage({ type: 'ADD_ACCOUNT', walletId })
  }, activeAccount.walletId)
  expect(addedAccount).toMatchObject({ success: true, accountId: expect.any(String) })
  const addedAccountId = (addedAccount as { accountId: string }).accountId

  const switchResult = await popup.evaluate(async () => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
    if (!current?.result) throw new Error('Chain endpoint settings are unavailable')
    return chrome.runtime.sendMessage({
      type: 'APPLY_CHAIN_ENDPOINT_SETTINGS',
      settings: { ...current.result, activeEvmChainId: 'eip155:137' }
    })
  })
  expect(switchResult).toMatchObject({ result: { activeEvmChainId: 'eip155:137' } })

  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('POL')
  const polSwapSource = popup
    .getByRole('button')
    .filter({ hasText: /POL.*Polygon/i })
    .first()
  await expect(polSwapSource).toBeVisible()
  await polSwapSource.click()
  await expect
    .poll(() => readPersistedSwapSource(popup), {
      message: 'selected Swap source should persist for the active Wallet Account'
    })
    .toBe(POL_ASSET)

  await popup.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('POL', {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('ZEC')
  await popup.getByRole('button', { name: /ZEC.*Zcash/i }).click()
  const swapAmountInput = popup.locator('input[placeholder="0"]')
  await popup.getByRole('button', { name: /^Use maximum balance:/ }).click()
  await expect(swapAmountInput).toHaveValue('0.9999055', { timeout: 30_000 })
  await expectNoOverflow(popup)
  const submitSwap = popup.getByRole('button', { name: 'Swap', exact: true })
  await expect(submitSwap).toBeEnabled({ timeout: 60_000 })
  await submitSwap.click()
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible({
    timeout: 60_000
  })
  await expect(popup.getByRole('button', { name: 'Show full amount' }).first()).toHaveText(
    '0.9999055'
  )
  await expect(popup.getByRole('button', { name: 'Show full POL amount' })).toHaveText(
    '0.0000756 POL'
  )
  for (const alt of ['POL', 'Polygon', 'ZEC', 'Zcash']) {
    await expect
      .poll(() =>
        popup
          .getByAltText(alt, { exact: true })
          .first()
          .evaluate(image => (image as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
  }
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-source-polygon-review.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeVisible({
    timeout: 60_000
  })
  const pendingSwapId = await popup.evaluate(async () => {
    const session = await chrome.storage.session.get(null)
    const keys = Object.keys(session).filter(key => key.startsWith('evm_pending_transfer:'))
    if (keys.length !== 1) return undefined
    const candidate = session[keys[0]] as { transactionId?: unknown; phase?: unknown }
    return candidate.phase === 'awaiting-approval' && typeof candidate.transactionId === 'string'
      ? candidate.transactionId
      : undefined
  })
  expect(pendingSwapId).toEqual(expect.any(String))

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: activeAccount.walletId, accountId: addedAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  await expect(popup.getByRole('heading', { name: 'Review Swap' })).toBeHidden({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('ZEC', {
    timeout: 5_000
  })
  await expect(popup.locator('input[placeholder="0"]')).toHaveValue('')
  await expect(
    popup.evaluate(transactionId => {
      return chrome.runtime.sendMessage({ type: 'GET_PENDING_EVM_TRANSFER', transactionId })
    }, pendingSwapId)
  ).resolves.toEqual({ result: null })
  await captureScreenshot(popup, 'protocol-wallet-source-account-switch-reset.png')

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: activeAccount.walletId, accountId: activeAccount.accountId }
    )
  ).resolves.toMatchObject({ success: true })
  await expect
    .poll(async () => {
      const response = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
      )) as { result?: { items?: Array<{ id?: string }> } }
      return response.result?.items?.find(item => item.id === pendingSwapId)
    })
    .toBeUndefined()
  expect(evmNetwork.getBroadcastCount()).toBe(0)
})

test('restores the account-scoped Swap source after a popup reload', async ({ context, popup }) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { tokenResponseDelayMs: 1_500 })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await expect(popup.getByRole('status', { name: 'Loading total assets' })).toBeVisible()
  await captureScreenshot(popup, 'protocol-wallet-home-total-assets-skeleton.png')
  await expect(popup.getByRole('button', { name: 'View POL details on Polygon' })).toBeVisible({
    timeout: 60_000
  })

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('POL')
  const polygonSource = popup
    .getByRole('button')
    .filter({ hasText: /POL.*Polygon/i })
    .first()
  await expect(polygonSource).toBeVisible({ timeout: 60_000 })
  await polygonSource.click()

  await expect.poll(() => readPersistedSwapSource(popup)).toBe(POL_ASSET)
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Loading total assets' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()

  await popup.reload()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'From asset' })).toContainText('POL', {
    timeout: 30_000
  })
  await expectNoOverflow(popup)
})

test('shows a page-level retry state when RHEA token catalogs are unavailable', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)

  let failedCatalogRequests = 0
  const failCatalogRequest = async (route: Route) => {
    failedCatalogRequests += 1
    await new Promise(resolve => setTimeout(resolve, 300))
    await route.abort('failed')
  }
  await context.route('https://api.rhea.finance/get_chain_prices**', failCatalogRequest)
  await context.route('https://api.rhea.finance/api/swap/supported_to_tokens**', failCatalogRequest)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()

  const catalogSkeleton = popup.getByRole('status', { name: 'Loading swap assets' })
  await expect(catalogSkeleton).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From asset' })).toHaveCount(0)
  await expect(popup.getByText('Unavailable', { exact: true })).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-rhea-catalog-skeleton.png')

  const unavailableHeading = popup.getByRole('heading', {
    name: 'Unable to load assets'
  })
  await expect(unavailableHeading).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: 'From asset' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'To asset' })).toHaveCount(0)
  await expect(popup.getByText('Receive address', { exact: true })).toHaveCount(0)
  await expect(
    popup.getByText('RHEA Swap is unavailable in this build or network', { exact: true })
  ).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-rhea-catalog-unavailable.png')

  const requestsBeforeRetry = failedCatalogRequests
  await popup.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => failedCatalogRequests).toBeGreaterThan(requestsBeforeRetry)
  await expect(unavailableHeading).toBeVisible({ timeout: 30_000 })
})

test('retries a failed quote below the destination asset card in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  let quoteUnavailable = true
  const requests: Record<string, unknown>[] = []
  await context.route(QUOTE_URL, route => {
    requests.push(route.request().postDataJSON())
    if (!quoteUnavailable) return route.fallback()
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 1, msg: 'Request timed out', data: null })
    })
  })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('USDC')
  await popup
    .getByRole('button', { name: /^USDC on Polygon/ })
    .first()
    .click()
  await popup.getByRole('button', { name: 'From asset' }).click()
  await popup.getByPlaceholder('Search tokens').fill('ETH')
  await popup
    .getByRole('button', { name: /^ETH on Ethereum/ })
    .first()
    .click()
  await popup.getByRole('textbox', { name: 'From amount', exact: true }).fill('0.01')
  const error = popup.getByRole('alert')
  await expect(error.getByText('Request timed out.', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(error.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  const destinationCard = popup
    .locator('section')
    .filter({ has: popup.getByRole('button', { name: 'To asset' }) })
  await expect(destinationCard.getByRole('alert')).toHaveCount(0)
  const cardBounds = await destinationCard.boundingBox()
  const errorBounds = await error.boundingBox()
  expect(cardBounds).not.toBeNull()
  expect(errorBounds).not.toBeNull()
  if (cardBounds && errorBounds) {
    expect(errorBounds.y).toBeGreaterThanOrEqual(cardBounds.y + cardBounds.height)
  }
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'swap-quote-error-below-card.png')
  const inputQuotes = () => requests.filter(request => request.amountIn === '10000000000000000')
  expect(inputQuotes()).toHaveLength(1)
  expect(inputQuotes()[0]).toMatchObject({
    tokenIn: ETH_ASSET,
    tokenOut: POLYGON_USDC_CONTRACT
  })
  quoteUnavailable = false
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  expect(inputQuotes()).toHaveLength(2)
  expect(inputQuotes()[1]).toMatchObject({
    fromChain: inputQuotes()[0].fromChain,
    toChain: inputQuotes()[0].toChain,
    tokenIn: inputQuotes()[0].tokenIn,
    tokenOut: inputQuotes()[0].tokenOut,
    amountIn: inputQuotes()[0].amountIn,
    sender: inputQuotes()[0].sender,
    recipient: inputQuotes()[0].recipient
  })
  await expect(popup.getByRole('textbox', { name: 'From amount', exact: true })).toHaveValue('0.01')
  await captureScreenshot(popup, 'swap-quote-retry-success.png')
})
