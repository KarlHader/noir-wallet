import {
  BITCOIN_MAINNET_CHAIN_ID,
  BITCOIN_TESTNET_CHAIN_ID,
  BUILTIN_EVM_NETWORKS,
  type BrowserContext,
  EVM_NETWORK_CONFIGS,
  NEAR_NETWORKS,
  RPC_REGISTRY,
  type Route,
  SOLANA_NETWORKS,
  TEST_PASSWORD,
  ZCASH_MAINNET_CHAIN_ID,
  ZCASH_TESTNET_CHAIN_ID,
  bitcoinEnabled,
  captureScreenshot,
  chromium,
  expect,
  expectPopupWidth,
  expectVisibleImagesLoaded,
  extensionDir,
  findChainEndpointOverride,
  importTestWallet,
  mkdtemp,
  mockAssetMarketHistory,
  mockBetaInviteApi,
  mockCustomRpcEndpoints,
  mockEvmHistoryProxy,
  mockExternalAssetIcons,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  mockUnknownZcashAccountHistory,
  nearEnabled,
  openExtensionPopup,
  path,
  readLocalTransactions,
  readPersistedEndpointModes,
  rm,
  seedFreshAssetPrices,
  selectNewZcashAccountHistory,
  serveSdkExample,
  solanaEnabled,
  terminateExtensionServiceWorker,
  test,
  tmpdir,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'

test('attests custom endpoints for every released chain including Zcash', async ({
  context,
  popup
}) => {
  const requests = await mockCustomRpcEndpoints(context)

  await waitForBackgroundWalletInitialization(popup)
  const settings = {
    schemaVersion: 1,
    activeEvmChainId: 'eip155:1',
    customEvmNetworks: [],
    overrides: [
      {
        chainId: 'eip155:1',
        rpc: {
          protocol: 'evm-json-rpc',
          label: 'Custom Ethereum RPC',
          url: 'https://endpoint-release.noir.test/ethereum'
        },
        explorer: {
          label: 'Custom Ethereum Explorer',
          baseUrl: 'https://explorer-release.noir.test/ethereum',
          transactionPath: 'transaction'
        }
      },
      {
        chainId: ZCASH_MAINNET_CHAIN_ID,
        rpc: {
          protocol: 'zcash-lightwalletd',
          label: 'Custom Zcash RPC',
          url: 'https://endpoint-release.noir.test/zcash'
        },
        explorer: {
          label: 'Custom Zcash Explorer',
          baseUrl: 'https://explorer-release.noir.test/zcash',
          transactionPath: 'tx'
        }
      },
      {
        chainId: BITCOIN_MAINNET_CHAIN_ID,
        rpc: {
          protocol: 'bitcoin-esplora',
          label: 'Custom Bitcoin RPC',
          url: 'https://endpoint-release.noir.test/bitcoin/'
        },
        explorer: {
          label: 'Custom Bitcoin Explorer',
          baseUrl: 'https://explorer-release.noir.test/bitcoin',
          transactionPath: 'tx'
        }
      },
      {
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpc: {
          protocol: 'solana-json-rpc',
          label: 'Custom Solana RPC',
          url: 'https://endpoint-release.noir.test/solana'
        }
      },
      {
        chainId: NEAR_NETWORKS.mainnet.chainId,
        rpc: {
          protocol: 'near-json-rpc',
          label: 'Custom NEAR RPC',
          url: 'https://endpoint-release.noir.test/near'
        }
      }
    ]
  }
  const disabledEndpointIds = new Set([
    ...(!bitcoinEnabled ? [BITCOIN_MAINNET_CHAIN_ID] : []),
    ...(!solanaEnabled ? [SOLANA_NETWORKS.mainnet.chainId] : []),
    ...(!nearEnabled ? [NEAR_NETWORKS.mainnet.chainId] : [])
  ])
  settings.overrides = settings.overrides.filter(
    override => !disabledEndpointIds.has(override.chainId)
  )
  const applied = await popup.evaluate(
    value => chrome.runtime.sendMessage({ type: 'APPLY_CHAIN_ENDPOINT_SETTINGS', settings: value }),
    settings
  )
  const expectedSettings = settings
  expect(applied).toEqual({ result: expectedSettings })
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' }))
    )
    .toEqual({ result: expectedSettings })
  expect(requests).toEqual(
    expect.arrayContaining([
      'POST /ethereum',
      ...(solanaEnabled ? ['POST /solana'] : []),
      ...(nearEnabled ? ['POST /near'] : []),
      ...(bitcoinEnabled ? ['GET /bitcoin/block-height/0'] : [])
    ])
  )
  expect(requests).toContain('POST /zcash/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo')
})

test('adds, persists, selects and removes custom RPCs through the real popup', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await context.route('https://rpc.zknoir.com/v1/rpc-endpoints?scope=multichain', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(RPC_REGISTRY) })
  )
  await mockCustomRpcEndpoints(context)
  await mockExternalAssetIcons(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.getByRole('button', { name: 'Settings', exact: true }).click()
  await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'RPC Endpoints' })).toBeVisible()

  const releasedRpcChains = [
    ['Arbitrum', 'arbitrum'],
    ...(bitcoinEnabled ? [['Bitcoin', 'bitcoin/']] : []),
    ...(solanaEnabled ? [['Solana', 'solana']] : []),
    ...(nearEnabled ? [['NEAR', 'near']] : []),
    ['Zcash', 'zcash']
  ]
  for (const [index, [chain, path]] of releasedRpcChains.entries()) {
    const customUrl =
      chain === 'Zcash'
        ? 'https://zcashwebrpc.deltarpc.com'
        : `https://endpoint-release.noir.test/${path}`
    await popup.getByRole('button', { name: `Configure ${chain} RPC` }).click()
    const dialog = popup.getByRole('dialog')
    await expect(dialog.getByLabel(`${chain} RPC URL`)).toHaveCount(0)
    if (chain === 'Arbitrum') {
      for (const provider of ['dRPC', 'PublicNode', 'ZAN']) {
        await expect(dialog.getByRole('button', { name: `Use ${provider} RPC` })).toBeVisible()
      }
      await expect(dialog.getByRole('button', { name: 'Use automatic RPC' })).toContainText(
        'Starts with dRPC · arbitrum.drpc.org'
      )
      await captureScreenshot(popup, 'rpc-arbitrum-presets.png')
      await dialog.getByRole('button', { name: 'Use automatic RPC' }).click()
      await expect(dialog).toHaveCount(0)
      await popup.getByRole('button', { name: 'Configure Arbitrum RPC' }).click()
      await dialog.getByRole('button', { name: 'Use dRPC RPC' }).click()
      await expect(dialog).toHaveCount(0)
      await popup.getByRole('button', { name: 'Configure Arbitrum RPC' }).click()
      await expect(dialog.getByRole('button', { name: 'Use dRPC RPC' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    }
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.getByLabel('Custom RPC name').fill(`My ${chain}`)
    await dialog.getByLabel(`${chain} RPC URL`).fill(customUrl)
    if (chain === 'Arbitrum' || chain === 'Zcash') {
      await dialog
        .getByLabel(`${chain} RPC URL`)
        .fill(`https://endpoint-release.noir.test/${path}-wrong`)
      await dialog.getByRole('button', { name: 'Verify & Add' }).click()
      await expect(popup.getByText('RPC Validation Failed', { exact: true })).toBeVisible()
      const settings = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
      )
      expect(settings.result.savedRpcEndpoints ?? []).toHaveLength(index)
      await dialog.getByLabel(`${chain} RPC URL`).fill(customUrl)
    }
    await captureScreenshot(
      popup,
      chain === 'Arbitrum'
        ? 'rpc-add-arbitrum.png'
        : chain === 'Bitcoin'
          ? 'rpc-add-bitcoin.png'
          : chain === 'Solana'
            ? 'rpc-add-solana.png'
            : chain === 'NEAR'
              ? 'rpc-add-near.png'
              : 'rpc-add-zcash.png'
    )
    await dialog.getByRole('button', { name: 'Verify & Add' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  }

  await popup.reload()
  await popup.getByRole('button', { name: 'Settings', exact: true }).click()
  await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'RPC Endpoints' })).toBeVisible()
  const stored = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
  )
  expect(stored.result.savedRpcEndpoints).toHaveLength(releasedRpcChains.length)
  expect(await readPersistedEndpointModes(popup)).toEqual(['mainnet'])
  for (const [chain] of releasedRpcChains) {
    await popup.getByRole('button', { name: `Configure ${chain} RPC` }).click()
    const dialog = popup.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: `Use My ${chain} RPC` })).toBeVisible()
    await dialog.getByRole('button', { name: `Use My ${chain} RPC` }).click()
    if (chain === 'Zcash') {
      await expect(dialog.getByRole('button', { name: `Use My ${chain} RPC` })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    } else {
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      await popup.getByRole('button', { name: `Configure ${chain} RPC` }).click()
    }
    await captureScreenshot(
      popup,
      chain === 'Arbitrum'
        ? 'rpc-saved-arbitrum.png'
        : chain === 'Bitcoin'
          ? 'rpc-saved-bitcoin.png'
          : chain === 'Solana'
            ? 'rpc-saved-solana.png'
            : chain === 'NEAR'
              ? 'rpc-saved-near.png'
              : 'rpc-saved-zcash.png'
    )
    if (chain === 'Arbitrum') {
      const offlinePrimary = (route: Route) => route.abort()
      await context.route('https://arbitrum.drpc.org/**', offlinePrimary)
      await dialog.getByRole('button', { name: 'Use automatic RPC' }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      await context.unroute('https://arbitrum.drpc.org/**', offlinePrimary)
      const autoSettings = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
      )
      expect(findChainEndpointOverride(autoSettings.result, 'eip155:42161')?.rpc).toBeUndefined()
      await popup.getByRole('button', { name: 'Configure Arbitrum RPC' }).click()
      await expect(dialog.getByRole('button', { name: 'Use automatic RPC' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    }
    await expect
      .poll(() =>
        popup.evaluate(() =>
          document
            .getAnimations()
            .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .every(animation => animation.playState === 'finished')
        )
      )
      .toBe(true)
    await expect(dialog.getByRole('button', { name: 'Verify & Save' })).toHaveCount(0)
    const width = await popup.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(375)
    await popup
      .getByRole('dialog')
      .getByRole('button', { name: `Remove My ${chain}` })
      .click()
    await popup.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(popup.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 })
  }
  const removed = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
  )
  expect(removed.result.savedRpcEndpoints).toEqual([])
  expect(removed.result.overrides).toEqual([])

  const sidePanel = await context.newPage()
  await sidePanel.setViewportSize({ width: 480, height: 900 })
  await sidePanel.goto(`chrome-extension://${extensionId}/index.html?surface=side-panel`)
  await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click()
  await sidePanel.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  await sidePanel.getByRole('button', { name: 'Configure Arbitrum RPC' }).click()
  const sidePanelDialog = sidePanel.getByRole('dialog')
  const presets = sidePanelDialog.getByTestId('provider-presets')
  await expect(sidePanelDialog.getByRole('button', { name: 'Use ZAN RPC' })).toBeInViewport()
  expect(await presets.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
  await captureScreenshot(sidePanel, 'rpc-arbitrum-presets-side-panel.png')
  await sidePanel.close()
})

test('renders and switches the released EVM catalog and chain-scoped endpoint settings', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    !bitcoinEnabled || !nearEnabled,
    'This mixed-chain journey requires explicit Bitcoin and NEAR flags'
  )
  test.setTimeout(300_000)
  const evmHistoryRequests = await mockEvmHistoryProxy(context, 1_500)
  const portfolioRpcRequests = await mockReleasedEvmRpc(context)
  const bitcoinRequests = await mockReleasedBitcoinEsplora(context)
  const marketHistoryRequests = await mockAssetMarketHistory(context)
  await context.route('https://1click.chaindefuser.com/**', route => route.abort())
  await context.route('https://api.dexscreener.com/**', route => route.abort())
  const transferEth = {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    chainId: 1,
    contractAddress: null,
    decimals: 18,
    price: 3_200,
    priceUpdatedAt: new Date().toISOString(),
    symbol: 'ETH',
    address: 'nep141:eth.omft.near',
    isNative: true
  }
  await context.route('https://api.rhea.finance/get_chain_prices**', route => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: chainId === 1 ? { [transferEth.assetId]: transferEth } : {}
      })
    })
  })
  await context.route('https://api.rhea.finance/api/swap/supported_to_tokens**', route => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: { tokens: chainId === 1 ? [transferEth] : [] }
      })
    })
  })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await removeZcashHistoryMock()
  await popup.reload()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: /Portfolio network filter/ })).toHaveCount(0)
  await expect(popup.getByRole('status', { name: 'Loading portfolio' })).toHaveCount(0, {
    timeout: 30_000
  })

  await expect(popup.getByRole('button', { name: 'View ZEC details on Zcash' })).toContainText(
    '0 ZEC'
  )
  await expect(popup.getByRole('button', { name: 'View SOL details on Solana' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'View NEAR details on NEAR' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'View BTC details on Bitcoin' })).toHaveCount(1)
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toContainText(
    '2 ETH',
    { timeout: 30_000 }
  )

  const assetsTab = popup.getByRole('tab', { name: 'Assets' })
  const activityTab = popup.getByRole('tab', { name: 'Activity' })
  await activityTab.click()
  const activityLoading = popup.getByRole('status', { name: 'Loading activity' })
  if (await activityLoading.isVisible()) {
    await captureScreenshot(popup, 'release-default-activity-loading-skeleton.png')
  }
  await expect(popup.getByText('Unable to load activity', { exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await expect(popup.getByText('+0.005872 ETH', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('+1e-18 ETH', { exact: true })).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Loading activity' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  const activityFilter = popup.getByRole('button', {
    name: 'Filter activity by network: All Networks'
  })
  await expect(activityFilter).toBeVisible()
  const activityFilterPosition = await activityFilter.boundingBox()
  if (!activityFilterPosition) throw new Error('Activity network filter has no layout box')
  await activityFilter.click()
  await popup.getByRole('menuitemradio', { name: 'Ethereum', exact: true }).click()
  await expect(popup.getByRole('link', { name: 'Full history' })).toHaveAttribute(
    'href',
    /^https:\/\/etherscan\.io\/address\/0x[0-9a-fA-F]{40}$/
  )
  await expect.poll(() => evmHistoryRequests.length).toBe(4)
  expect(new Set(evmHistoryRequests.map(request => JSON.stringify(request))).size).toBe(4)
  expect(new Set(evmHistoryRequests.map(request => request.address)).size).toBe(2)
  expect(evmHistoryRequests.every(request => request.blockchains.length === 9)).toBe(true)
  await expect
    .poll(() =>
      popup.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('noir-wallet-evm-history-cache', 2)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction('records', 'readonly')
              const count = transaction.objectStore('records').count()
              count.onerror = () => reject(count.error)
              count.onsuccess = () => resolve(count.result)
              transaction.oncomplete = () => database.close()
            }
          })
      )
    )
    .toBe(18)
  const firstHistoryRequestCount = evmHistoryRequests.length
  const firstPortfolioRpcRequestCount = portfolioRpcRequests.length
  const firstBitcoinAttestationCount = bitcoinRequests.filter(request =>
    request.endsWith('/block-height/0')
  ).length
  await assetsTab.click()
  await expect(assetsTab).toHaveAttribute('data-state', 'active')
  const portfolioFilterForAlignment = popup.getByRole('button', {
    name: 'Filter portfolio by network: Ethereum'
  })
  await expect(portfolioFilterForAlignment).toBeVisible()
  const portfolioFilterPosition = await portfolioFilterForAlignment.boundingBox()
  if (!portfolioFilterPosition) throw new Error('Portfolio network filter has no layout box')
  expect(Math.abs(portfolioFilterPosition.x - activityFilterPosition.x)).toBeLessThan(0.5)
  expect(Math.abs(portfolioFilterPosition.y - activityFilterPosition.y)).toBeLessThan(0.5)
  await portfolioFilterForAlignment.click()
  await popup.getByRole('menuitemradio', { name: 'All Networks', exact: true }).click()
  await activityTab.click()
  await expect(
    popup.getByRole('button', { name: 'Filter activity by network: All Networks' })
  ).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Loading activity' })).toHaveCount(0)
  await expect(popup.getByText('+0.005872 ETH', { exact: true })).toBeVisible()
  await popup.waitForTimeout(500)
  expect(evmHistoryRequests).toHaveLength(firstHistoryRequestCount)
  expect(portfolioRpcRequests).toHaveLength(firstPortfolioRpcRequestCount)
  expect(bitcoinRequests.filter(request => request.endsWith('/block-height/0'))).toHaveLength(
    firstBitcoinAttestationCount
  )
  await captureScreenshot(popup, 'release-default-activity-session-cache.png')
  await assetsTab.click()
  await expect(assetsTab).toHaveAttribute('data-state', 'active')

  const walletChooser = popup.getByRole('button', { name: 'Choose wallet' })
  await expect(walletChooser).toBeVisible()
  await expect(walletChooser).toHaveText('')
  const accountAddresses = popup.getByRole('button', { name: 'Show account addresses' })
  await expect(accountAddresses).toBeVisible()
  await expect(accountAddresses).toContainText('Account 1')
  await expect(popup.getByRole('button', { name: 'Choose account' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: /Copy .* account address/ })).toHaveCount(0)

  await accountAddresses.click()
  const accountAddressMenu = popup.getByLabel('Account address menu')
  await expect(accountAddressMenu).toBeVisible()
  await expect(accountAddressMenu.getByText('Zcash', { exact: true })).toBeVisible()
  await expect(accountAddressMenu.getByText('EVM', { exact: true })).toBeVisible()
  await expect(accountAddressMenu.getByText('Bitcoin', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-home-account-address-menu.png')
  await accountAddressMenu.getByRole('button', { name: 'View all' }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(popup.getByRole('region', { name: 'Account network addresses' })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send ETH on Ethereum' })).toContainText('2 ETH', {
    timeout: 30_000
  })
  await expect(popup.getByRole('status', { name: 'Loading additional networks' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Send BNB on BNB Chain' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send POL on Polygon' })).toContainText(
    '2,468 POL'
  )
  await expect(popup.getByRole('button', { name: 'Send BTC on Bitcoin' })).toContainText('0 BTC')
  await expect(popup.getByText(/bsc-mainnet|arbitrum-one|base-mainnet/i)).toHaveCount(0)
  await expect(popup.getByText('Available', { exact: true })).toHaveCount(0)
  await expect(popup.getByText(/^≈\$/).first()).toBeVisible()
  const sendNetworkFilter = popup.getByRole('button', { name: 'All Networks', exact: true })
  await expect(sendNetworkFilter).toHaveCSS('cursor', 'pointer')
  await sendNetworkFilter.click()
  const ethereumSendFilter = popup.getByRole('menuitemradio', { name: 'Ethereum', exact: true })
  await expect(ethereumSendFilter.locator('img')).toHaveCount(1)
  await expect(ethereumSendFilter).toHaveCSS('cursor', 'pointer')
  await captureScreenshot(popup, 'release-default-send-network-filter.png')
  await popup.getByRole('menuitemradio', { name: 'All Networks', exact: true }).click()
  const orderedSendAssets = await popup
    .locator('button[aria-label^="Send "]')
    .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  const ethereumEthIndex = orderedSendAssets.indexOf('Send ETH on Ethereum')
  const bnbIndex = orderedSendAssets.indexOf('Send BNB on BNB Chain')
  const polygonIndex = orderedSendAssets.indexOf('Send POL on Polygon')
  const ethereumUsdcIndex = orderedSendAssets.indexOf('Send USDC on Ethereum')
  expect(ethereumEthIndex).toBeGreaterThanOrEqual(0)
  expect(bnbIndex).toBeGreaterThan(ethereumEthIndex)
  expect(polygonIndex).toBeGreaterThan(bnbIndex)
  expect(ethereumUsdcIndex).toBeGreaterThan(polygonIndex)
  await captureScreenshot(popup, 'release-default-send-assets.png')
  await popup.getByRole('button', { name: 'Send NEAR on NEAR' }).click()
  await expect(popup.getByPlaceholder('alice.near or implicit account')).toBeVisible()
  await expect(popup.getByText(/Beta transfer/)).toHaveCount(0)
  await expect(popup.getByText(/NEAR Testnet/)).toHaveCount(0)
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Send NEAR on NEAR' })).toBeVisible()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await expect(popup.getByLabel('Send To')).toBeFocused()
  await expect(popup.getByRole('button', { name: 'Change asset' })).toHaveCount(0)
  await expect
    .poll(() =>
      popup
        .locator('#evm-send-recipient, input[aria-label="ETH amount"]')
        .evaluateAll(elements =>
          elements.map(element => element.id || element.getAttribute('aria-label'))
        )
    )
    .toEqual(['evm-send-recipient', 'ETH amount'])
  await captureScreenshot(popup, 'release-default-evm-send-form.png')
  await popup.getByRole('button', { name: 'Select Recipient' }).click()
  const recipientDialog = popup.getByRole('dialog')
  await expect(recipientDialog.getByRole('heading', { name: 'Select Recipient' })).toBeVisible()
  await expect(recipientDialog.getByRole('tab', { name: 'My Accounts' })).toHaveAttribute(
    'data-state',
    'active'
  )
  await expect(
    recipientDialog.getByRole('button', { name: 'Send to Account 2 Public' })
  ).toBeVisible()
  await captureScreenshot(popup, 'release-default-recipient-my-accounts.png')
  await recipientDialog.getByRole('tab', { name: 'Address Book' }).click()
  await expect(recipientDialog.getByText('No saved recipients', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-recipient-selector.png')
  await recipientDialog.getByRole('button', { name: 'Close' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Send ZEC on Zcash' }).click()
  await expect(popup.getByLabel('Send To')).toBeFocused()
  await expect
    .poll(() =>
      popup
        .locator('#zcash-send-recipient, input[aria-label="ZEC amount"]')
        .evaluateAll(elements =>
          elements.map(element => element.id || element.getAttribute('aria-label'))
        )
    )
    .toEqual(['zcash-send-recipient', 'ZEC amount'])
  await expect(popup.getByTestId('zcash-amount-card')).toHaveCSS('min-height', '92px')
  await expect(popup.getByText('Memo (optional)', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-zcash-send-form.png')
  await popup.getByRole('button', { name: 'Select Recipient' }).click()
  const zcashRecipientDialog = popup.getByRole('dialog')
  await expect(
    zcashRecipientDialog.getByRole('button', { name: 'Send to Account 1 Transparent' })
  ).toBeVisible()
  await expect(
    zcashRecipientDialog.getByRole('button', { name: 'Send to Account 2 Shielded' })
  ).toBeVisible()
  await expect(
    zcashRecipientDialog.getByRole('button', { name: 'Send to Account 2 Transparent' })
  ).toBeVisible()
  await captureScreenshot(popup, 'release-default-zcash-recipient-my-accounts.png')
  await zcashRecipientDialog.getByRole('button', { name: 'Close' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(popup.getByLabel('Search Networks')).toBeVisible()
  const receiveAddresses = popup.getByRole('region', { name: 'Account network addresses' })
  await expect(receiveAddresses.getByRole('heading', { name: 'Zcash' })).toBeVisible()
  await expect(receiveAddresses.getByRole('heading', { name: 'Bitcoin' })).toBeVisible()
  await expect(receiveAddresses.getByRole('heading', { name: 'Ethereum' })).toBeVisible()
  await expect(receiveAddresses.getByText('Native SegWit', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-receive-addresses.png')
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Hide balances' }).click()
  await expect(popup.getByRole('button', { name: 'Show balances' })).toBeVisible()
  await expect(popup.getByLabel('Total balance hidden')).toHaveText('••••')
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const raw = (await chrome.storage.local.get('wallet_settings')).wallet_settings
        const state = typeof raw === 'string' ? JSON.parse(raw).state : raw?.state
        return state?.balancesHidden
      })
    )
    .toBe(true)
  await popup.getByRole('button', { name: 'Show balances' }).click()
  await expect(popup.getByRole('button', { name: 'Hide balances' })).toBeVisible()

  const homeScroll = popup.getByTestId('home-scroll-container')
  await expect(homeScroll).toBeVisible()
  expect(
    await homeScroll.evaluate(
      element =>
        [...element.querySelectorAll('*')].filter(child => {
          const overflowY = getComputedStyle(child).overflowY
          return overflowY === 'auto' || overflowY === 'scroll'
        }).length
    )
  ).toBe(0)
  await expect(popup.getByRole('button', { name: 'Show token view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const portfolioNetworkFilter = popup.getByRole('button', {
    name: 'Filter portfolio by network: All Networks'
  })
  await expect(portfolioNetworkFilter).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Refresh portfolio' })).toBeVisible()
  await expect(popup.getByText('Updating', { exact: true })).toHaveCount(0)
  const portfolio = popup.getByRole('region', { name: 'Portfolio' })
  await expect(portfolio.getByText(/^\d+ Addresses?$/)).toHaveCount(0)
  const lowValueAssets = popup.getByRole('button', { name: 'Expand low value assets' })
  await expect(lowValueAssets).toBeVisible()
  await lowValueAssets.click()
  const bitcoinAsset = popup.getByRole('button', { name: 'View BTC details on Bitcoin' })
  await expect(bitcoinAsset).not.toContainText('Bitcoin')
  await expect(bitcoinAsset.getByText('$63,014', { exact: true })).toBeVisible()
  await expect(bitcoinAsset).toContainText('+1.25%')
  await popup.getByRole('button', { name: 'Collapse low value assets' }).click()
  const ethereumAsset = popup.getByRole('button', { name: 'View ETH details on Ethereum' })
  await expect(ethereumAsset).toContainText('ETH')
  await expect(ethereumAsset).not.toContainText('Ethereum')
  await expect(ethereumAsset).toContainText('$3,200')
  await expect(ethereumAsset).toContainText('+0.42%')
  await expect(ethereumAsset).not.toContainText(/\d+ Networks?/)
  const assetRows = portfolio.locator('button[aria-label^="View "][aria-label*=" details on "]')
  await expect(assetRows.first()).toHaveAttribute('aria-label', 'View ETH details on Ethereum')
  await expect(assetRows.nth(1)).toHaveAttribute('aria-label', 'View ETH details on Arbitrum')
  await expect(popup.getByRole('button', { name: /^Network unavailable\./ })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: /^Balances incomplete\./ })).toHaveCount(0)
  await expectVisibleImagesLoaded(popup)
  await captureScreenshot(popup, 'release-default-home-figma-aligned.png')

  const syncWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await syncWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'SYNC_PROGRESS',
      isSyncing: true,
      syncProgress: 42,
      currentHeight: 2_900_042,
      latestHeight: 3_000_000,
      etaMs: 120_000
    })
  })
  const zcashSyncProgress = popup.getByRole('status', { name: 'Zcash sync progress: 42%' })
  await expect(zcashSyncProgress).toBeVisible()
  const syncProgressBox = await zcashSyncProgress.boundingBox()
  const tokenViewBox = await popup.getByRole('button', { name: 'Show token view' }).boundingBox()
  if (!syncProgressBox || !tokenViewBox) {
    throw new Error('Portfolio sync progress or token view control is not measurable')
  }
  expect(syncProgressBox.x + syncProgressBox.width).toBeLessThan(tokenViewBox.x)
  await captureScreenshot(popup, 'release-default-home-zcash-sync-progress.png')
  await syncWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', isSyncing: false })
  })
  await expect(zcashSyncProgress).toHaveCount(0)

  const ethereumRpcUrl = new URL(EVM_NETWORK_CONFIGS.mainnet[0].rpcUrl).href
  const abortEthereumRpc = (route: Route) => route.abort()
  await context.route(ethereumRpcUrl, abortEthereumRpc)
  await popup.reload()
  await popup.getByRole('button', { name: 'Refresh portfolio' }).click()
  const portfolioSyncing = popup.getByRole('status', { name: 'Portfolio data is syncing' })
  await expect(portfolioSyncing).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: /retry/i })).toHaveCount(0)
  await context.unroute(ethereumRpcUrl, abortEthereumRpc)
  await expect(portfolioSyncing).toHaveCount(0, { timeout: 30_000 })

  await popup.evaluate(() =>
    chrome.storage.local.remove(['asset_price_cache_v1', 'asset_market_change_cache_v1'])
  )
  await popup.reload()
  await expect(portfolioSyncing).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: /retry/i })).toHaveCount(0)
  await captureScreenshot(popup, 'release-default-price-auto-sync.png')
  await seedFreshAssetPrices(popup)
  await expect(portfolioSyncing).toHaveCount(0, { timeout: 30_000 })

  await portfolioNetworkFilter.click()
  await popup.getByRole('menuitemradio', { name: 'Ethereum', exact: true }).click()
  await expect(
    popup.getByRole('button', { name: 'Filter portfolio by network: Ethereum' })
  ).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View BNB details on BNB Chain' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'View BTC details on Bitcoin' })).toHaveCount(0)
  await popup.reload()
  await expect(
    popup.getByRole('button', { name: 'Filter portfolio by network: Ethereum' })
  ).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Filter portfolio by network: Ethereum' }).click()
  await popup.getByRole('menuitemradio', { name: 'All Networks', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Expand low value assets' })).toBeVisible()

  const bitcoinAddressRequests = () =>
    bitcoinRequests.filter(request => /\/api\/address\/[^/]+$/.test(request)).length
  await expect.poll(bitcoinAddressRequests, { timeout: 60_000 }).toBe(1)
  expect(bitcoinRequests).toContain('https://mempool.space/api/block-height/0')
  expect(
    bitcoinRequests.filter(request => request.startsWith('https://blockstream.info/'))
  ).toEqual([])
  const completedDiscoveryRequestCount = bitcoinRequests.length
  await popup.reload()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.waitForTimeout(1_500)
  expect(bitcoinRequests).toHaveLength(completedDiscoveryRequestCount)

  const ethereumEthDetail = popup.getByRole('button', {
    name: 'View ETH details on Ethereum'
  })
  await expect(ethereumEthDetail).toBeVisible()
  await expect(ethereumEthDetail.getByText('$6,400', { exact: true })).toHaveCount(1)
  await captureScreenshot(popup, 'release-default-home-token-networks.png')
  await ethereumEthDetail.click()
  await expect(popup.getByRole('heading', { name: 'ETH', exact: true })).toBeVisible()
  await expect(
    popup.getByTestId('asset-detail-token-icon').getByRole('img', { name: 'Ethereum' })
  ).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible()
  await expect(popup.getByText('Ethereum · Mainnet', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Asset type', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Decimals', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Network', { exact: true })).toHaveCount(0)
  const priceChart = popup.getByRole('img', { name: '1D price history' })
  await expect(priceChart).toBeVisible()
  const priceChartLine = priceChart.locator('path[fill="none"]')
  await expect(priceChartLine).toHaveCount(1)
  expect(await priceChartLine.evaluate(element => getComputedStyle(element).strokeDasharray)).toBe(
    'none'
  )
  await popup.getByRole('button', { name: '1W', exact: true }).click()
  await expect(popup.getByRole('img', { name: '1W price history' })).toBeVisible()
  expect(
    marketHistoryRequests.some(url => new URL(url).searchParams.get('aggregate') === '4')
  ).toBe(true)
  await expect(popup.getByRole('heading', { name: 'Recent activity' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View all' })).toBeVisible()
  for (const amount of ['+0.005872 ETH', '+1e-18 ETH']) {
    const amountLabel = popup.getByText(amount, { exact: true })
    await expect(amountLabel).toBeVisible()
    expect(
      await amountLabel.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
      })
    ).toBe(true)
  }
  await captureScreenshot(popup, 'release-default-asset-detail.png')
  await popup.getByRole('button', { name: 'Transfer ETH between Public and Confidential' }).click()
  const transferDialog = popup.getByRole('dialog', { name: 'Transfer ETH' })
  await expect(transferDialog).toBeVisible()
  await expect(transferDialog.getByText('Public', { exact: true })).toBeVisible()
  await expect(transferDialog.getByText('Confidential', { exact: true }).first()).toBeVisible()
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeDisabled()
  await transferDialog.getByLabel('Transfer amount').fill('0.1')
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeEnabled()
  await captureScreenshot(popup, 'THU-DEMO-03-Main-to-Private-transfer-sheet.png')
  await transferDialog.getByRole('button', { name: 'Switch transfer direction' }).click()
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeDisabled()
  await transferDialog.getByLabel('Transfer amount').fill('0.1')
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeEnabled()
  await captureScreenshot(popup, 'THU-DEMO-04-Private-to-Main-transfer-sheet.png')
  await transferDialog.getByRole('button', { name: 'Close' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await popup.getByRole('button', { name: 'Expand low value assets' }).click()
  await popup.getByRole('button', { name: 'View USDC details on Ethereum' }).click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()
  await expect(
    popup.getByTestId('asset-detail-token-icon').getByRole('img', { name: 'Ethereum' })
  ).toBeVisible()
  await expect(popup.getByText('Ethereum', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Ethereum · Mainnet', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Contract address', { exact: true })).toBeVisible()
  await expect(popup.getByRole('img', { name: '1D price history' })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Recent activity' })).toBeVisible()
  await captureScreenshot(popup, 'release-default-token-asset-detail.png')
  await popup.getByRole('heading', { name: 'Details' }).scrollIntoViewIfNeeded()
  await expect(popup.getByText('Contract address', { exact: true })).toBeInViewport()
  await captureScreenshot(popup, 'release-default-token-asset-details.png')
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await popup.getByRole('button', { name: 'Expand low value assets' }).click()
  await popup.getByRole('button', { name: 'View BTC details on Bitcoin' }).click()
  await expect(popup.getByRole('heading', { name: 'BTC', exact: true })).toBeVisible()
  await expect(
    popup.getByTestId('asset-detail-token-icon').getByRole('img', { name: 'Bitcoin' })
  ).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Receive address' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Copy Bitcoin receive address' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Receive Bitcoin' })).toBeVisible()
  const bitcoinAccounts = popup.getByRole('region', { name: 'Bitcoin accounts' })
  await expect(bitcoinAccounts).toContainText('Balance and activity use the selected address only.')
  const bitcoinAccountSelector = bitcoinAccounts.getByRole('button', {
    name: /Bitcoin account Native SegWit/
  })
  await expect(bitcoinAccountSelector).toBeVisible()
  await bitcoinAccountSelector.click()
  await expect(popup.getByRole('button', { name: /Nested SegWit BIP-49/ })).toBeVisible()
  await expect(popup.getByRole('button', { name: /Taproot BIP-86/ })).toBeVisible()
  await expect(popup.getByRole('button', { name: /Legacy BIP-44/ })).toBeVisible()
  await popup.getByRole('button', { name: /Taproot BIP-86/ }).click()
  await expect(
    bitcoinAccounts.getByRole('button', { name: /Bitcoin account Taproot/ })
  ).toBeVisible({ timeout: 60_000 })
  await expect.poll(bitcoinAddressRequests, { timeout: 60_000 }).toBe(2)
  await captureScreenshot(popup, 'release-default-bitcoin-asset-detail.png')
  await popup.getByRole('heading', { name: 'Details' }).scrollIntoViewIfNeeded()
  await expect(popup.getByRole('heading', { name: 'Receive address' })).toBeInViewport()
  await expect(popup.getByRole('button', { name: 'Receive Bitcoin' })).toBeInViewport()
  await captureScreenshot(popup, 'release-default-bitcoin-asset-details.png')
  await popup.getByRole('button', { name: 'Receive Bitcoin' }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(
    popup
      .getByRole('region', { name: 'Account network addresses' })
      .getByRole('heading', { name: 'Bitcoin' })
  ).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'BTC', exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Addresses', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(popup.getByRole('region', { name: 'Account network addresses' })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Bitcoin' })).toBeVisible()
  const bitcoinAddress = popup.getByRole('region', { name: 'Bitcoin' })
  await expect(bitcoinAddress).toBeVisible()
  await expect(bitcoinAddress.getByText('Native SegWit', { exact: true })).toBeVisible()
  await expect(bitcoinAddress.getByText('Nested SegWit', { exact: true })).toBeVisible()
  await expect(bitcoinAddress.getByText('Legacy', { exact: true })).toBeVisible()
  await expect(bitcoinAddress).toContainText('Taproot')
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'BTC', exact: true })).toBeVisible()

  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(popup.getByText('Taproot', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'BTC', exact: true })).toBeVisible()

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByTestId('send-asset-header')).toContainText('Bitcoin · Taproot · BIP-86')
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Send BTC on Bitcoin' })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'BTC', exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Show chain view' }).click()
  await expect(popup.getByRole('button', { name: 'Show chain view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const raw = (await chrome.storage.local.get('wallet_settings')).wallet_settings
        const state = typeof raw === 'string' ? JSON.parse(raw).state : raw?.state
        return state?.portfolioViewMode
      })
    )
    .toBe('chains')
  const chainGroupButtons = portfolio.locator(
    'button[aria-label^="Expand "][aria-label$=" tokens"]'
  )
  const expectedChains = [
    'Ethereum',
    'Arbitrum',
    'Optimism',
    'Base',
    'BNB Chain',
    'Polygon',
    'X Layer',
    'Avalanche',
    'Berachain',
    'Gnosis',
    'Plasma',
    'Monad',
    'Bitcoin',
    'Solana',
    'NEAR',
    'Zcash'
  ]
  const chainLabels = await chainGroupButtons.evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label')?.replace(/^Expand | tokens$/g, ''))
  )
  expect(chainLabels.slice(0, 4)).toEqual(['Ethereum', 'Arbitrum', 'Optimism', 'Base'])
  expect(chainLabels).toHaveLength(expectedChains.length)
  expect(chainLabels).toEqual(expect.arrayContaining(expectedChains))
  await popup.getByRole('button', { name: 'Expand Ethereum tokens' }).click()
  const ethereumBalances = popup.getByRole('region', { name: 'Ethereum token balances' })
  await expect(ethereumBalances).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()
  await ethereumBalances.getByRole('button', { name: /Low value/ }).click()
  await expect(popup.getByRole('button', { name: 'View USDC details on Ethereum' })).toBeVisible()
  await captureScreenshot(popup, 'release-default-home-chain-tokens.png')
  const scrollMetrics = await homeScroll.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }))
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
  await homeScroll.hover()
  await popup.mouse.wheel(0, 600)
  await expect.poll(() => homeScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await homeScroll.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() =>
      homeScroll.evaluate(
        element => element.scrollHeight - element.clientHeight - element.scrollTop
      )
    )
    .toBe(0)
  await popup.getByRole('button', { name: 'Show token view' }).click()
  await homeScroll.evaluate(element => {
    element.scrollTop = 0
  })

  await popup.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Settings' })).toBeVisible()

  await expect(popup.getByRole('button', { name: 'Preferred Explorer', exact: true })).toHaveCount(
    0
  )
  await expect(popup.getByRole('button', { name: 'RPC Endpoint', exact: true })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Networks', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Networks' })).toBeVisible()
  for (const network of ['Zcash', 'Bitcoin', ...BUILTIN_EVM_NETWORKS, 'Solana', 'NEAR']) {
    await expect(popup.getByRole('button', { name: `Configure ${network} network` })).toBeVisible()
  }
  await expect(popup.getByText('Local EVM', { exact: true })).toHaveCount(0)
  await expect(popup.locator('button[aria-label^="Configure "][aria-pressed]')).toHaveCount(0)
  await expectPopupWidth(popup)
  await expectVisibleImagesLoaded(popup)
  await captureScreenshot(popup, 'release-default-networks.png')

  await popup.getByRole('button', { name: 'Configure Zcash network' }).click()
  await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  const zcashRpcDialog = popup.getByRole('dialog')
  await expect(zcashRpcDialog.getByRole('heading', { name: 'Zcash RPC' })).toBeVisible()
  await expect(
    zcashRpcDialog.getByRole('button', { name: 'Use automatic Zcash RPC' })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(zcashRpcDialog.getByRole('button', { name: 'Use DeltaRPC RPC' })).toBeVisible()
  await expect(
    zcashRpcDialog.getByRole('button', { name: /^Use (?!automatic).* RPC$/ })
  ).toHaveCount(1)
  await captureScreenshot(popup, 'release-default-zcash-rpc-selector.png')
  await popup.keyboard.press('Escape')
  await expect(zcashRpcDialog).toHaveCount(0)
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'Configure Ethereum network' }).click()
  await expect(popup.getByRole('button', { name: 'RPC Endpoint', exact: true })).toContainText(
    new URL(EVM_NETWORK_CONFIGS.mainnet[0].rpcUrl).host
  )
  await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  const ethereumRpcDialog = popup.getByRole('dialog')
  await expect(
    ethereumRpcDialog.getByRole('button', { name: 'Use automatic RPC' })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(ethereumRpcDialog.getByRole('button', { name: 'Use DeltaRPC RPC' })).toBeVisible()
  await expect(ethereumRpcDialog.getByText('eth.deltarpc.com', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-ethereum-rpc-presets.png')
  await popup.keyboard.press('Escape')
  await expect(ethereumRpcDialog).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Block Explorer', exact: true })).toContainText(
    'etherscan.io'
  )
  await popup.getByRole('button', { name: 'Block Explorer', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Ethereum Explorer' })).toBeVisible()
  await expectPopupWidth(popup)
  await captureScreenshot(popup, 'release-default-ethereum-explorers.png')
  await popup.keyboard.press('Escape')
  await popup.getByRole('button', { name: 'Back' }).click()

  for (const network of [
    { name: 'Solana', provider: 'Delta' },
    { name: 'NEAR', provider: 'Fastnear' }
  ]) {
    await popup.getByRole('button', { name: `Configure ${network.name} network` }).click()
    await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
    const networkRpcDialog = popup.getByRole('dialog')
    await expect(
      networkRpcDialog.getByRole('button', { name: /^Use (?!automatic).* RPC$/ })
    ).toHaveCount(1)
    await networkRpcDialog.getByRole('button', { name: `Use ${network.provider} RPC` }).click()
    await expect(networkRpcDialog).toHaveCount(0)
    await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
    await expect(
      networkRpcDialog.getByRole('button', { name: `Use ${network.provider} RPC` })
    ).toHaveAttribute('aria-pressed', 'true')
    await popup.keyboard.press('Escape')
    await popup.getByRole('button', { name: 'Back' }).click()
  }

  await popup.getByRole('button', { name: 'Configure Bitcoin network' }).click()
  await popup.getByRole('button', { name: 'RPC Endpoint', exact: true }).click()
  const rpcDialog = popup.getByRole('dialog')
  await expect(rpcDialog.getByLabel('Bitcoin RPC URL')).toHaveCount(0)
  await rpcDialog.getByRole('button', { name: 'Use automatic RPC' }).click()
  await expect(rpcDialog).toHaveCount(0)
  await expect(popup.getByText('Auto RPC Enabled', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()

  const addedAccount = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const walletId = walletState?.state?.currentWalletId
    if (typeof walletId !== 'string') throw new Error('Active Wallet fixture is missing')
    return chrome.runtime.sendMessage({ type: 'ADD_ACCOUNT', walletId })
  })
  expect(addedAccount).toMatchObject({ success: true, accountId: expect.any(String) })
  const accountNetworkCoverage = await popup.evaluate(
    () =>
      new Promise<Readonly<{ accountCount: number; accountNetworkCounts: readonly number[] }>>(
        (resolve, reject) => {
          const request = indexedDB.open('noir-wallet-storage-v2-db')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(['metadata', 'accounts', 'chainAccounts'])
            const metadata = transaction.objectStore('metadata').get('active-pointer')
            metadata.onerror = () => reject(metadata.error)
            metadata.onsuccess = () => {
              const generationId = (metadata.result as { generationId?: unknown } | undefined)
                ?.generationId
              if (typeof generationId !== 'string') {
                reject(new Error('Active Storage V2 pointer is missing'))
                return
              }
              const accountRecords = transaction.objectStore('accounts').getAll()
              const chainAccountRecords = transaction.objectStore('chainAccounts').getAll()
              transaction.onerror = () => reject(transaction.error)
              transaction.oncomplete = () => {
                database.close()
                const accounts = (
                  accountRecords.result as Array<{
                    generationId?: unknown
                    entity?: { id?: unknown }
                  }>
                ).filter(record => record.generationId === generationId)
                const chainAccounts = (
                  chainAccountRecords.result as Array<{
                    generationId?: unknown
                    entity?: { scope?: { accountId?: unknown; chainId?: unknown } }
                  }>
                ).filter(record => record.generationId === generationId)
                resolve({
                  accountCount: accounts.length,
                  accountNetworkCounts: accounts.map(account => {
                    const accountId = account.entity?.id
                    return new Set(
                      chainAccounts
                        .filter(record => record.entity?.scope?.accountId === accountId)
                        .map(record => record.entity?.scope?.chainId)
                    ).size
                  })
                })
              }
            }
          }
        }
      )
  )
  expect(accountNetworkCoverage).toEqual({
    accountCount: 3,
    accountNetworkCounts: [23, 23, 23]
  })

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  await popup.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVITY', action: 'refresh' }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
            return
          }
          if (response?.error) {
            reject(new Error(response.error))
            return
          }
          resolve()
        })
      })
  )
  expect(evmHistoryRequests).toHaveLength(firstHistoryRequestCount)
})

test('round-trips the installed package across global modes without mixing network data', async () => {
  test.skip(
    !bitcoinEnabled || !solanaEnabled || !nearEnabled,
    'This mixed-chain journey requires an explicit five-chain verification profile'
  )
  test.setTimeout(240_000)
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'noir-network-mode-'))
  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    await mockBetaInviteApi(context)
    await mockExternalAssetIcons(context)
    await mockReleasedEvmRpc(context)
    const initial = await openExtensionPopup(context)
    const popup = initial.popup
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })

    const before = await popup.evaluate(async () => {
      const raw = (await chrome.storage.local.get('wallet_state')).wallet_state
      const state = typeof raw === 'string' ? JSON.parse(raw).state : raw?.state
      const wallet = state.wallets.find(
        (candidate: { id: string }) => candidate.id === state.currentWalletId
      )
      const account = wallet.accounts.find(
        (candidate: { id: string }) => candidate.id === state.currentAccountId
      )
      return {
        currentNetwork: state.currentNetwork,
        walletId: state.currentWalletId,
        accountId: state.currentAccountId,
        transparent: account.addresses.transparent,
        shielded: account.addresses.shielded
      }
    })
    expect(before.currentNetwork).toBe('mainnet')
    expect(before.transparent).toMatch(/^t1/)
    expect(before.shielded).toMatch(/^u1/)

    const importedPrivateAccounts = await popup.evaluate(
      async ({
        evmPrivateKey,
        bitcoinPrivateKey,
        solanaPrivateKey,
        nearPrivateKey,
        walletId,
        accountId
      }) => {
        for (const input of [
          {
            privateKey: evmPrivateKey,
            chainFamily: 'eip155',
            displayName: 'Mode EVM Private'
          },
          {
            privateKey: bitcoinPrivateKey,
            chainFamily: 'bip122',
            displayName: 'Mode Bitcoin Mainnet Private'
          },
          {
            privateKey: solanaPrivateKey,
            chainFamily: 'solana',
            displayName: 'Mode Solana Mainnet Private'
          },
          {
            privateKey: nearPrivateKey,
            chainFamily: 'near',
            displayName: 'Mode NEAR Mainnet Private'
          }
        ]) {
          const result = await chrome.runtime.sendMessage({
            type: 'IMPORT_PRIVATE_KEY_WALLET',
            ...input
          })
          if (result?.success !== true)
            throw new Error(result?.error ?? 'Private-key import failed')
        }
        const catalog = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
        const selection = await chrome.runtime.sendMessage({
          type: 'SWITCH_ACCOUNT',
          walletId,
          accountId
        })
        if (selection?.success !== true) {
          throw new Error(selection?.error ?? 'Original Account selection failed')
        }
        return catalog.result?.accounts
          ?.filter((entry: { walletDisplayName?: string }) =>
            entry.walletDisplayName?.startsWith('Mode ')
          )
          .map(
            (entry: {
              walletDisplayName: string
              walletSource: unknown
              networks: readonly { chainId: string }[]
            }) => ({
              walletDisplayName: entry.walletDisplayName,
              walletSource: entry.walletSource,
              chainIds: entry.networks.map(network => network.chainId)
            })
          )
      },
      {
        evmPrivateKey: `0x${'00'.repeat(31)}01`,
        bitcoinPrivateKey: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn',
        solanaPrivateKey: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx',
        nearPrivateKey: 'ed25519:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
        walletId: before.walletId,
        accountId: before.accountId
      }
    )
    expect(importedPrivateAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          walletDisplayName: 'Mode EVM Private',
          walletSource: { kind: 'private-key', chainFamily: 'eip155' },
          chainIds: expect.arrayContaining(['eip155:1', 'eip155:56'])
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode Bitcoin Mainnet Private',
          walletSource: {
            kind: 'private-key',
            chainFamily: 'bip122',
            bitcoinNetwork: 'mainnet'
          },
          chainIds: [BITCOIN_MAINNET_CHAIN_ID]
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode Solana Mainnet Private',
          walletSource: { kind: 'private-key', chainFamily: 'solana' },
          chainIds: [SOLANA_NETWORKS.mainnet.chainId]
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode NEAR Mainnet Private',
          walletSource: { kind: 'private-key', chainFamily: 'near' },
          chainIds: [NEAR_NETWORKS.mainnet.chainId]
        })
      ])
    )

    const mainnetEndpointSettings = {
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: BITCOIN_MAINNET_CHAIN_ID,
          explorer: {
            label: 'Mainnet release explorer',
            baseUrl: 'https://mainnet-explorer.noir.test/bitcoin',
            transactionPath: 'tx'
          }
        }
      ]
    }
    await expect(
      popup.evaluate(
        settings => chrome.runtime.sendMessage({ type: 'APPLY_CHAIN_ENDPOINT_SETTINGS', settings }),
        mainnetEndpointSettings
      )
    ).resolves.toEqual({ result: mainnetEndpointSettings })
    await expect(readPersistedEndpointModes(popup)).resolves.toEqual(['mainnet'])
    const mainnetAccountKey = `mainnet_${before.walletId}_${before.accountId}`
    const mainnetTransactionHash = '11'.repeat(32)
    await expect(
      popup.evaluate(
        ({ accountKey, transaction }) =>
          chrome.runtime.sendMessage({ type: 'ADD_TRANSACTION', accountKey, transaction }),
        {
          accountKey: mainnetAccountKey,
          transaction: {
            txHash: mainnetTransactionHash,
            status: 'success',
            type: 'send',
            amount: '0.01',
            to: before.transparent,
            from: before.transparent,
            fromType: 'transparent',
            fee: '0.0001',
            timestamp: 1_700_000_000_000,
            network: 'mainnet'
          }
        }
      )
    ).resolves.toMatchObject({ success: true })

    await popup.getByRole('button', { name: 'Settings', exact: true }).click()
    await popup.getByRole('button', { name: 'Developer Settings' }).click()
    await expect(popup.getByRole('heading', { name: 'Developer Settings' })).toBeVisible()
    await popup.getByRole('switch', { name: 'Testnet Mode' }).click()
    await expect(popup.getByRole('heading', { name: 'Enable Testnet Mode?' })).toBeVisible()

    await popup.getByRole('button', { name: 'Enable & Restart' }).click()
    await expect.poll(() => popup.isClosed(), { timeout: 90_000 }).toBe(true)
    await context.close()
    context = null

    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    await mockBetaInviteApi(context)
    await context.route('https://provider-release.noir.test/**', serveSdkExample)
    await mockExternalAssetIcons(context)
    await mockReleasedEvmRpc(context, 'testnet')
    const restarted = await openExtensionPopup(context)
    expect(restarted.extensionId).toBe(initial.extensionId)
    const restartedPopup = restarted.popup
    await expect(restartedPopup.getByText('TESTNET', { exact: true })).toBeVisible({
      timeout: 90_000
    })
    await expect(restartedPopup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
    await restartedPopup.getByPlaceholder('Enter Password').fill(TEST_PASSWORD)
    await restartedPopup.getByRole('button', { name: 'Unlock' }).click()
    await expect(restartedPopup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({
      timeout: 90_000
    })

    const after = await restartedPopup.evaluate(async () => {
      const local = await chrome.storage.local.get(['wallet_state', 'wallet_settings'])
      const walletState =
        typeof local.wallet_state === 'string'
          ? JSON.parse(local.wallet_state).state
          : local.wallet_state?.state
      const settingsState =
        typeof local.wallet_settings === 'string'
          ? JSON.parse(local.wallet_settings).state
          : local.wallet_settings?.state
      const wallet = walletState.wallets.find(
        (candidate: { id: string }) => candidate.id === walletState.currentWalletId
      )
      const account = wallet.accounts.find(
        (candidate: { id: string }) => candidate.id === walletState.currentAccountId
      )
      const networks = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      const activeAccount = networks.result?.accounts?.find(
        (entry: { active?: boolean }) => entry.active === true
      )
      return {
        currentNetwork: walletState.currentNetwork,
        networkMode: settingsState.networkMode,
        activeTransparent: account.addresses.transparent,
        activeShielded: account.addresses.shielded,
        mainnetTransparent: account.networkAddresses.mainnet.transparent,
        mainnetShielded: account.networkAddresses.mainnet.shielded,
        networkChainIds: activeAccount?.networks?.map((entry: { chainId: string }) => entry.chainId)
      }
    })
    expect(after.currentNetwork).toBe('testnet')
    expect(after.networkMode).toBe('testnet')
    expect(after.activeTransparent).toMatch(/^tm/)
    expect(after.activeShielded).toMatch(/^utest1/)
    expect(after.mainnetTransparent).toBe(before.transparent)
    expect(after.mainnetShielded).toBe(before.shielded)
    expect(after.networkChainIds).toEqual(
      expect.arrayContaining([ZCASH_TESTNET_CHAIN_ID, BITCOIN_TESTNET_CHAIN_ID, 'eip155:11155111'])
    )
    expect(after.networkChainIds).not.toContain(ZCASH_MAINNET_CHAIN_ID)
    expect(after.networkChainIds).not.toContain(BITCOIN_MAINNET_CHAIN_ID)

    const testnetDApp = await context.newPage()
    await testnetDApp.goto('https://provider-release.noir.test/example/')
    await testnetDApp.waitForFunction(() => 'noirwallet' in window)
    await testnetDApp.getByRole('button', { name: 'Testnet', exact: true }).click()
    await testnetDApp.getByRole('button', { name: 'Solana Devnet', exact: true }).click()
    await expect(testnetDApp.getByRole('heading', { name: 'Solana dApp provider' })).toBeVisible()
    await expect(
      testnetDApp.getByText("Balance and token reads use the dApp's own Solana RPC client.")
    ).toBeVisible()
    await testnetDApp.getByRole('button', { name: 'NEAR Testnet', exact: true }).click()
    await expect(testnetDApp.getByRole('heading', { name: 'NEAR dApp provider' })).toBeVisible()
    await expect(
      testnetDApp.getByText("Balance and token reads use the dApp's own NEAR RPC client.")
    ).toBeVisible()
    await testnetDApp.close()

    const testnetPrivateAccounts = await restartedPopup.evaluate(async () => {
      const catalog = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      return catalog.result?.accounts
        ?.filter((entry: { walletDisplayName?: string }) =>
          entry.walletDisplayName?.startsWith('Mode ')
        )
        .map((entry: { walletDisplayName: string; networks: readonly { chainId: string }[] }) => ({
          walletDisplayName: entry.walletDisplayName,
          chainIds: entry.networks.map(network => network.chainId)
        }))
    })
    expect(testnetPrivateAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          walletDisplayName: 'Mode EVM Private',
          chainIds: expect.arrayContaining(['eip155:11155111', 'eip155:97'])
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode Bitcoin Mainnet Private',
          chainIds: []
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode Solana Mainnet Private',
          chainIds: []
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode NEAR Mainnet Private',
          chainIds: []
        })
      ])
    )
    const ethereumAsset = restartedPopup.getByRole('button', {
      name: 'View ETH details on Ethereum'
    })
    await expect(ethereumAsset).toBeVisible({ timeout: 60_000 })
    await ethereumAsset.scrollIntoViewIfNeeded()
    const ethereumTokenIcon = ethereumAsset.getByRole('img', { name: 'ETH', exact: true })
    await expect
      .poll(() => ethereumTokenIcon.evaluate(image => (image as HTMLImageElement).naturalWidth), {
        timeout: 15_000
      })
      .toBeGreaterThan(0)
    const ethereumChainIcon = ethereumAsset.getByRole('img', { name: 'Ethereum', exact: true })
    await expect(ethereumChainIcon).toHaveAttribute(
      'src',
      'https://assets.zknoir.com/chain/ethereum.svg'
    )
    await expect
      .poll(() => ethereumChainIcon.evaluate(image => (image as HTMLImageElement).naturalWidth), {
        timeout: 15_000
      })
      .toBeGreaterThan(0)
    await captureScreenshot(restartedPopup, 'release-default-testnet-mode.png')

    await expect(
      restartedPopup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
      )
    ).resolves.toEqual({
      result: { schemaVersion: 1, customEvmNetworks: [], overrides: [] }
    })
    await expect(readPersistedEndpointModes(restartedPopup)).resolves.toEqual(['mainnet'])
    const testnetEndpointSettings = {
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: BITCOIN_TESTNET_CHAIN_ID,
          explorer: {
            label: 'Testnet release explorer',
            baseUrl: 'https://testnet-explorer.noir.test/bitcoin',
            transactionPath: 'tx'
          }
        }
      ]
    }
    await expect(
      restartedPopup.evaluate(
        settings => chrome.runtime.sendMessage({ type: 'APPLY_CHAIN_ENDPOINT_SETTINGS', settings }),
        testnetEndpointSettings
      )
    ).resolves.toEqual({ result: testnetEndpointSettings })
    await expect(readPersistedEndpointModes(restartedPopup)).resolves.toEqual([
      'mainnet',
      'testnet'
    ])
    const testnetAccountKey = `testnet_${before.walletId}_${before.accountId}`
    const testnetTransactionHash = '22'.repeat(32)
    await expect(
      restartedPopup.evaluate(
        ({ accountKey, transaction }) =>
          chrome.runtime.sendMessage({ type: 'ADD_TRANSACTION', accountKey, transaction }),
        {
          accountKey: testnetAccountKey,
          transaction: {
            txHash: testnetTransactionHash,
            status: 'success',
            type: 'send',
            amount: '0.02',
            to: after.activeTransparent,
            from: after.activeTransparent,
            fromType: 'transparent',
            fee: '0.0001',
            timestamp: 1_700_000_000_001,
            network: 'testnet'
          }
        }
      )
    ).resolves.toMatchObject({ success: true })
    await expect(readLocalTransactions(restartedPopup, mainnetAccountKey)).resolves.toEqual([
      expect.objectContaining({ txHash: mainnetTransactionHash, network: 'mainnet' })
    ])
    await expect(readLocalTransactions(restartedPopup, testnetAccountKey)).resolves.toEqual([
      expect.objectContaining({ txHash: testnetTransactionHash, network: 'testnet' })
    ])

    await restartedPopup.getByRole('button', { name: 'Settings', exact: true }).click()
    await restartedPopup.getByRole('button', { name: 'Developer Settings' }).click()
    await restartedPopup.getByRole('switch', { name: 'Testnet Mode' }).click()
    await expect(restartedPopup.getByRole('heading', { name: 'Return to Mainnet?' })).toBeVisible()
    await expect(readPersistedEndpointModes(restartedPopup)).resolves.toEqual([
      'mainnet',
      'testnet'
    ])
    await restartedPopup.getByRole('button', { name: 'Switch & Restart' }).click()
    await expect.poll(() => restartedPopup.isClosed(), { timeout: 90_000 }).toBe(true)
    await context.close()
    context = null

    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    await mockBetaInviteApi(context)
    const restored = await openExtensionPopup(context)
    expect(restored.extensionId).toBe(initial.extensionId)
    const restoredPopup = restored.popup
    await expect(restoredPopup.getByRole('heading', { name: 'Enter your password' })).toBeVisible({
      timeout: 90_000
    })
    await expect(restoredPopup.getByText('TESTNET', { exact: true })).toHaveCount(0)
    await restoredPopup.getByPlaceholder('Enter Password').fill(TEST_PASSWORD)
    await restoredPopup.getByRole('button', { name: 'Unlock' }).click()
    await expect(restoredPopup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({
      timeout: 90_000
    })

    const restoredState = await restoredPopup.evaluate(async () => {
      const local = await chrome.storage.local.get(['wallet_state', 'wallet_settings'])
      const walletState =
        typeof local.wallet_state === 'string'
          ? JSON.parse(local.wallet_state).state
          : local.wallet_state?.state
      const settingsState =
        typeof local.wallet_settings === 'string'
          ? JSON.parse(local.wallet_settings).state
          : local.wallet_settings?.state
      const wallet = walletState.wallets.find(
        (candidate: { id: string }) => candidate.id === walletState.currentWalletId
      )
      const account = wallet.accounts.find(
        (candidate: { id: string }) => candidate.id === walletState.currentAccountId
      )
      const networks = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      const activeAccount = networks.result?.accounts?.find(
        (entry: { active?: boolean }) => entry.active === true
      )
      const endpoints = await chrome.runtime.sendMessage({
        type: 'GET_CHAIN_ENDPOINT_SETTINGS'
      })
      return {
        currentNetwork: walletState.currentNetwork,
        networkMode: settingsState.networkMode,
        activeTransparent: account.addresses.transparent,
        activeShielded: account.addresses.shielded,
        testnetTransparent: account.networkAddresses.testnet.transparent,
        testnetShielded: account.networkAddresses.testnet.shielded,
        networkChainIds: activeAccount?.networks?.map(
          (entry: { chainId: string }) => entry.chainId
        ),
        endpoints: endpoints.result,
        endpointModes: Object.keys(settingsState.chainEndpointSettingsByNetwork).sort()
      }
    })
    expect(restoredState).toMatchObject({
      currentNetwork: 'mainnet',
      networkMode: 'mainnet',
      activeTransparent: before.transparent,
      activeShielded: before.shielded,
      testnetTransparent: after.activeTransparent,
      testnetShielded: after.activeShielded,
      endpoints: mainnetEndpointSettings,
      endpointModes: ['mainnet', 'testnet']
    })
    expect(restoredState.networkChainIds).toEqual(
      expect.arrayContaining([ZCASH_MAINNET_CHAIN_ID, BITCOIN_MAINNET_CHAIN_ID, 'eip155:1'])
    )
    expect(restoredState.networkChainIds).not.toContain(ZCASH_TESTNET_CHAIN_ID)
    expect(restoredState.networkChainIds).not.toContain(BITCOIN_TESTNET_CHAIN_ID)
    const restoredPrivateAccounts = await restoredPopup.evaluate(async () => {
      const catalog = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      return catalog.result?.accounts
        ?.filter((entry: { walletDisplayName?: string }) =>
          entry.walletDisplayName?.startsWith('Mode ')
        )
        .map((entry: { walletDisplayName: string; networks: readonly { chainId: string }[] }) => ({
          walletDisplayName: entry.walletDisplayName,
          chainIds: entry.networks.map(network => network.chainId)
        }))
    })
    expect(restoredPrivateAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          walletDisplayName: 'Mode EVM Private',
          chainIds: expect.arrayContaining(['eip155:1', 'eip155:56'])
        }),
        expect.objectContaining({
          walletDisplayName: 'Mode Bitcoin Mainnet Private',
          chainIds: [BITCOIN_MAINNET_CHAIN_ID]
        })
      ])
    )
    await expect(readLocalTransactions(restoredPopup, mainnetAccountKey)).resolves.toEqual([
      expect.objectContaining({ txHash: mainnetTransactionHash, network: 'mainnet' })
    ])
    await expect(readLocalTransactions(restoredPopup, testnetAccountKey)).resolves.toEqual([
      expect.objectContaining({ txHash: testnetTransactionHash, network: 'testnet' })
    ])
    await captureScreenshot(restoredPopup, 'release-default-mainnet-restored.png')
  } finally {
    await context?.close().catch(() => {})
    await rm(profileDirectory, { recursive: true, force: true })
  }
})
