import {
  EVM_NETWORK_CONFIGS,
  type Route,
  bitcoinEnabled,
  captureScreenshot,
  expect,
  importTestWallet,
  mockEvmHistoryProxy,
  mockExternalAssetIcons,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  mockUnknownZcashAccountHistory,
  seedFreshAssetPrices,
  seedSettledZcashBalance,
  terminateExtensionServiceWorker,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'

test('shows an estimated Home total when one chain fails and cached prices become stale', async ({
  context,
  popup
}) => {
  test.skip(!bitcoinEnabled, 'Uses an unavailable Bitcoin RPC to reproduce the partial portfolio')
  test.setTimeout(180_000)
  await context.route('https://**', route => route.abort())
  await mockReleasedEvmRpc(context)
  await context.route('https://mempool.space/api/**', route => route.abort())
  await context.route('https://blockstream.info/api/**', route => route.abort())
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toContainText(
    '$6,400',
    { timeout: 60_000 }
  )
  await expect(popup.getByRole('button', { name: /^Estimated total assets/ })).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Loading total assets' })).toHaveCount(0)
  await expect(popup.getByTestId('home-total-assets')).toContainText('$')
  await expect(popup.getByTestId('home-total-assets')).not.toContainText('≈')
  await popup.evaluate(async () => {
    const stored = await chrome.storage.local.get('asset_price_cache_v1')
    const cache = stored.asset_price_cache_v1
    const timestamp = Date.now() - 10 * 60_000
    await chrome.storage.local.remove([
      'asset_market_change_cache_v1',
      'defi_llama_market_change_cache_v1'
    ])
    await chrome.storage.local.set({
      asset_price_cache_v1: {
        ...cache,
        fetchedAt: timestamp,
        quotes: cache.quotes.map((quote: { sourceUpdatedAt: number }) => ({
          ...quote,
          sourceUpdatedAt: timestamp
        }))
      }
    })
  })
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_ASSET_PRICES',
          action: 'read'
        })
        return response.result?.quotes.find(
          (quote: { assetId: string }) => quote.assetId === 'eip155:1/slip44:60'
        )?.freshness
      })
    )
    .toBe('stale')
  await popup.reload()
  await expect(popup.getByRole('button', { name: /^Estimated total assets/ })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('status', { name: 'Loading total assets' })).toHaveCount(0)
  await popup.getByRole('button', { name: /^Estimated total assets/ }).hover()
  await expect(popup.getByRole('tooltip')).toContainText(
    'Some balances or prices are unavailable or out of date.'
  )
  await captureScreenshot(popup, 'home-total-assets-partial.png')
})

test('serves cached EVM balances across Popup reload without repeating RPC reads', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  let lendingCatalogRequests = 0
  let tokenCatalogRequests = 0
  await context.route('**/get_multichain_lending_tokens_data**', route => {
    lendingCatalogRequests += 1
    return route.abort()
  })
  await context.route('https://1click.chaindefuser.com/v0/tokens', route => {
    tokenCatalogRequests += 1
    return route.abort()
  })
  const portfolioRpcRequests = await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  await seedSettledZcashBalance(popup, {
    total: '0',
    transparent: '0',
    shielded: '0',
    spendable: '0',
    available: '0'
  })
  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await expect
    .poll(
      () =>
        popup.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({
            type: 'GET_PORTFOLIO',
            action: 'read'
          })
          const model = response.result?.model
          return {
            status: model?.status,
            nonReadyChains: model?.chains
              .filter((chain: { status: string }) => chain.status !== 'ready')
              .map(
                (chain: {
                  chain: { id: string }
                  status: string
                  errorCodes: readonly string[]
                }) => ({
                  chainId: chain.chain.id,
                  status: chain.status,
                  errorCodes: chain.errorCodes
                })
              )
          }
        }),
      { timeout: 30_000 }
    )
    .toEqual({ status: 'ready', nonReadyChains: [] })
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
  await expect(popup.getByRole('button', { name: /^Balances incomplete\./ })).toHaveCount(0, {
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    popup
      .getByRole('button', { name: 'View ETH details on Ethereum' })
      .getByTestId('asset-unit-price')
  ).toContainText('$3,200')
  await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const walletId = walletState?.state?.currentWalletId
    const accountId = walletState?.state?.currentAccountId
    if (typeof walletId !== 'string' || typeof accountId !== 'string') {
      throw new Error('Active Wallet fixture is missing')
    }
    const market = (tokenId: string, symbol: string, supplied: string, suppliedUsd: string) => ({
      id: tokenId,
      tokenId,
      destinationAssetId: `nep141:${tokenId}`,
      symbol,
      displayName: symbol,
      decimals: symbol === 'USDC' ? 6 : 24,
      priceUsd: 1,
      supplyApy: '0',
      totalSupplied: supplied,
      totalSuppliedUsd: suppliedUsd,
      supplied,
      suppliedUsd
    })
    await chrome.storage.local.set({
      lending_market_cache_v1: {
        version: 3,
        entries: {
          [`${walletId}:${accountId}:mainnet`]: {
            cachedAt: Date.now(),
            markets: [
              market('usdc.test.near', 'USDC', '0.000666', '0.00'),
              market('lst.rhealab.near', 'rNEAR', '0.000000000002021', '0.00')
            ]
          }
        }
      }
    })
  })
  await popup.reload()
  await popup.getByRole('tab', { name: 'Lending' }).click()
  await expect(popup.getByText('0.000666 USDC', { exact: true })).toBeVisible()
  await expect(popup.getByText('<0.00000001 rNEAR', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'REF-13215-lending-small-decimal-balances.png')
  await popup.getByRole('tab', { name: 'Assets' }).click()
  await expect(
    popup.getByTestId('home-total-assets').locator('[data-slot="tooltip-trigger"]')
  ).toHaveCount(1)
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  const dappAddressDialog = popup.getByRole('dialog', { name: 'dApp address' })
  await expect(dappAddressDialog.getByTestId('main-address-total')).toHaveText(/^\$/)
  await expect(dappAddressDialog.getByTestId('private-address-total')).toHaveText(/^\$/)
  await captureScreenshot(popup, 'private-defi-home-address-totals.png')
  await dappAddressDialog.getByRole('button', { name: 'Close' }).click()

  const ethereumRpcUrl = new URL(EVM_NETWORK_CONFIGS.mainnet[0].rpcUrl).href
  let abortedEthereumRpcRequests = 0
  const abortEthereumRpc = (route: Route) => {
    abortedEthereumRpcRequests += 1
    return route.abort()
  }
  let lastRequestCount = -1
  let stablePolls = 0
  await expect
    .poll(
      () => {
        const current = portfolioRpcRequests.length
        stablePolls = current === lastRequestCount ? stablePolls + 1 : 0
        lastRequestCount = current
        return stablePolls
      },
      { intervals: [250], timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(4)
  const requestCountBeforeReload = portfolioRpcRequests.length
  const lendingRequestsBeforeReload = lendingCatalogRequests
  const tokenRequestsBeforeReload = tokenCatalogRequests
  await context.route(ethereumRpcUrl, abortEthereumRpc)
  await popup.reload()

  const portfolioSyncing = popup.getByRole('status', { name: 'Portfolio data is syncing' })
  await expect(portfolioSyncing).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()
  await expect(popup.getByRole('button', { name: /retry/i })).toHaveCount(0)
  await expect(popup.getByText('Prices delayed', { exact: true })).toHaveCount(0)
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])
  expect(lendingCatalogRequests).toBe(lendingRequestsBeforeReload)
  expect(tokenCatalogRequests).toBe(tokenRequestsBeforeReload)
  await captureScreenshot(popup, 'release-default-network-persistent-cache.png')

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Send ETH on Ethereum' })).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Loading additional networks' })).toHaveCount(0)
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])

  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await expect(popup.getByLabel('Send To')).toBeFocused()
  await expect(popup.getByRole('button', { name: 'Change asset' })).toHaveCount(0)
  await expect(popup.getByTestId('send-asset-header')).toContainText('ETH')
  await expect(popup.getByTestId('send-asset-header')).toContainText('Ethereum')
  const sendSourceButton = popup.getByRole('button', {
    name: 'Choose source account, current main'
  })
  await expect(sendSourceButton).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Choose send source account' })).toHaveCount(0)
  await sendSourceButton.click()
  let sendSourceDialog = popup.getByRole('dialog', { name: 'Choose source account' })
  await expect(sendSourceDialog).toContainText('This choice applies only to this wallet action.')
  await expect(sendSourceDialog.getByText('Selected', { exact: true })).toHaveCount(0)
  await sendSourceDialog.getByRole('radio', { name: /Confidential account/ }).click()
  const privateSendSourceButton = popup.getByRole('button', {
    name: 'Choose source account, current private'
  })
  await expect(privateSendSourceButton).toBeVisible()
  await captureScreenshot(popup, 'release-default-send-private-source.png')
  await privateSendSourceButton.click()
  sendSourceDialog = popup.getByRole('dialog', { name: 'Choose source account' })
  await sendSourceDialog.getByRole('radio', { name: /Public account/ }).click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current main' })
  ).toBeVisible()
  await expect(popup.getByText('Send to', { exact: true })).toBeVisible()
  await expect(popup.getByText('Amount', { exact: true })).toBeVisible()
  await expect(popup.getByLabel('Send To')).toHaveCSS('height', '56px')
  await expect(popup.getByTestId('send-amount-card')).toHaveCSS('min-height', '92px')
  await expect(popup.getByTestId('send-network-fee')).toBeVisible()
  await captureScreenshot(popup, 'release-default-send-input-cards.png')
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])
  expect(lendingCatalogRequests).toBe(lendingRequestsBeforeReload)
  expect(tokenCatalogRequests).toBe(tokenRequestsBeforeReload)

  await popup.getByRole('button', { name: 'Expand low value assets' }).click()
  await popup.getByRole('button', { name: 'View USDC details on Ethereum' }).click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()
  await expect(
    popup.getByTestId('asset-detail-token-icon').getByRole('img', { name: 'Ethereum' })
  ).toBeVisible()
  await expect(popup.getByText('Ethereum', { exact: true })).toHaveCount(0)
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])
  const ethereumRequestsAfterFirstDetail = abortedEthereumRpcRequests

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  const expandLowValueAssets = popup.getByRole('button', { name: 'Expand low value assets' })
  if (await expandLowValueAssets.isVisible()) await expandLowValueAssets.click()
  await popup.getByRole('button', { name: 'View USDC details on Ethereum' }).click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])
  expect(abortedEthereumRpcRequests).toBe(ethereumRequestsAfterFirstDetail)
  await captureScreenshot(popup, 'release-default-token-chain-badge.png')

  await context.unroute(ethereumRpcUrl, abortEthereumRpc)
})

test('REF-13211 shows the Private USDC Gas requirement before transfer preparation', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  await mockExternalAssetIcons(context)
  await context.route('**/get_multichain_lending_tokens_data**', route => route.abort())
  await context.route('https://1click.chaindefuser.com/v0/tokens', route => route.abort())
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context, 'mainnet', {
    nativeBalanceRaw: 0n,
    bundledUsdcBalanceRaw: 1_764_712n
  })
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('status', { name: 'Loading additional networks' })).toHaveCount(0, {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Send USDC on Arbitrum' }).click()
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()

  await expect(popup.getByTestId('send-asset-header')).toContainText('USDC')
  await expect(
    popup.getByTestId('send-asset-header').getByText('To Arbitrum', { exact: true })
  ).toBeVisible()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toBeVisible()
  await popup.getByLabel('Send To').fill('0x9C73842d02D1Fe00000000000000000000000000')
  await popup.getByLabel('USDC amount').fill('1')
  await expect(popup.getByTestId('send-amount-card')).toContainText('Available 1.7647 USDC')
  const missingGasAlert = popup.getByRole('alert').filter({
    hasText: 'Insufficient ETH balance.'
  })
  await expect(missingGasAlert).toBeVisible()
  await expect(popup.getByRole('button', { name: /View (?:Private )?address/ })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await missingGasAlert.scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'REF-13207-noirv2-improve-balance-message.png')
  await captureScreenshot(popup, 'REF-13211-noirv2-still-errors.png')
})

test('resyncs only active Wallet Zcash data and preserves EVM and Bitcoin state', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const addedAccount = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const walletId = walletState?.state?.currentWalletId
    if (typeof walletId !== 'string') throw new Error('Active Wallet fixture is missing')
    return chrome.runtime.sendMessage({ type: 'ADD_ACCOUNT', walletId })
  })
  expect(addedAccount).toMatchObject({ success: true, accountId: expect.any(String) })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  const beforeZcashResync = await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.initializeResyncIsolationProbe()
  )
  expect(beforeZcashResync.portfolio).toHaveLength(2)
  expect(beforeZcashResync.activity).toHaveLength(2)

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Show account addresses' }).click()
  await popup.getByLabel('Account address menu').getByRole('button', { name: 'View all' }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await popup.getByRole('button', { name: 'Open Zcash settings' }).click()
  await expect(popup.getByRole('heading', { name: 'Zcash settings' })).toBeVisible()
  const resyncZcashButton = popup.getByRole('button', { name: 'Resync Zcash' })
  await resyncZcashButton.scrollIntoViewIfNeeded()
  await resyncZcashButton.click()
  const resyncDialog = popup.getByRole('dialog')
  await expect(resyncDialog.getByRole('heading', { name: 'Resync Zcash' })).toBeVisible()
  await expect(resyncDialog.locator('input[type="number"]')).not.toHaveValue('')
  await resyncDialog.getByRole('button', { name: 'Resync', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  const afterZcashResync = await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.inspectResyncIsolationProbe()
  )
  expect(afterZcashResync).toEqual(beforeZcashResync)

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  const switchAfterResync = await popup.evaluate(async addedAccountId => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const walletId = walletState?.state?.currentWalletId
    const originalAccountId = walletState?.state?.currentAccountId
    if (typeof walletId !== 'string' || typeof originalAccountId !== 'string') {
      throw new Error('Active Wallet fixture is missing after Zcash resync')
    }
    const switched = await chrome.runtime.sendMessage({
      type: 'SWITCH_ACCOUNT',
      walletId,
      accountId: addedAccountId
    })
    const restored = await chrome.runtime.sendMessage({
      type: 'SWITCH_ACCOUNT',
      walletId,
      accountId: originalAccountId
    })
    return { switched, restored }
  }, addedAccount.accountId)
  expect(switchAfterResync).toMatchObject({
    switched: { success: true },
    restored: { success: true }
  })
})

test('shows Shield on positive transparent ZEC and uses the readable modal backdrop', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await mockUnknownZcashAccountHistory(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  await seedSettledZcashBalance(popup, {
    total: '0.512',
    transparent: '0.002',
    shielded: '0.51',
    spendable: '0.5',
    available: '0.5',
    shieldable: '0.002',
    pending: { total: '0.01', transparent: '0', shielded: '0.01' }
  })

  await terminateExtensionServiceWorker(context, popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const zecRow = popup.getByRole('button', { name: 'View ZEC details on Zcash' })
  await expect(zecRow).toBeVisible({ timeout: 30_000 })
  await expect(zecRow.locator('..')).toContainText('0.01 ZEC pending')
  await captureScreenshot(popup, 'REF-13197-noirv2-pending-balance.png')
  await zecRow.click()
  const zcashBalanceBreakdown = popup.getByLabel('Zcash balance breakdown')
  await expect(zcashBalanceBreakdown).toBeVisible()
  await expect(zcashBalanceBreakdown.getByText('Pending', { exact: true })).toHaveCount(0)
  const shieldButton = popup.getByRole('button', { name: 'Shield transparent ZEC' })
  await expect(shieldButton).toBeVisible()
  await captureScreenshot(popup, 'REF-13213-yellow-unspendable-balance.png')
  await captureScreenshot(popup, 'release-default-zcash-balance-and-shield.png')

  await shieldButton.click()
  await expect(popup.getByRole('dialog', { name: 'Shield Funds' })).toBeVisible()
  await captureScreenshot(popup, 'release-default-shield-modal-backdrop.png')
})

test('labels an outgoing shielded Zcash activity without a stale rotated address', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await removeZcashHistoryMock()

  const added = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const state = walletState?.state
    const walletId = state?.currentWalletId
    const accountId = state?.currentAccountId
    const wallet = state?.wallets?.find((item: { id?: unknown }) => item.id === walletId)
    const account = wallet?.accounts?.find((item: { id?: unknown }) => item.id === accountId)
    const shieldedAddress = account?.addresses?.shielded
    if (
      typeof walletId !== 'string' ||
      typeof accountId !== 'string' ||
      typeof shieldedAddress !== 'string'
    ) {
      throw new Error('Active Zcash account fixture is missing')
    }
    return chrome.runtime.sendMessage({
      type: 'ADD_TRANSACTION',
      accountKey: `mainnet_${walletId}_${accountId}`,
      transaction: {
        txHash: 'a'.repeat(64),
        status: 'success',
        type: 'send',
        amount: '0.001',
        to: 't1ExampleDestination',
        from: shieldedAddress,
        fromType: 'shielded',
        fee: '0.00015',
        timestamp: Date.now(),
        network: 'mainnet'
      }
    })
  })
  expect(added).toMatchObject({ success: true })

  await popup.getByRole('tab', { name: 'Activity' }).click()
  const activity = popup.getByRole('button', { name: 'View Sent ZEC details on Zcash' })
  await expect(activity).toBeVisible({ timeout: 30_000 })
  await activity.click()
  const detail = popup.locator('[data-activity-detail-id]')
  await expect(detail.getByText('Shielded Pool', { exact: true })).toBeVisible()
  await expect(detail.getByText(/^u1/)).toHaveCount(0)
  await captureScreenshot(popup, 'release-default-zcash-shielded-source-activity.png')
})
