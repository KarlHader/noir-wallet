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
  stopImportedZcashSync,
  terminateExtensionServiceWorker,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'
import { mockProtocolApis } from '../../helpers/protocol-wallet'

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
  popup,
  extensionId
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
  await expect(
    popup.getByTestId('home-total-assets').locator('[data-slot="tooltip-trigger"]')
  ).toHaveCount(1)
  await popup.getByRole('button', { name: /Total assets .*show asset breakdown/ }).hover()
  const breakdown = popup.getByRole('tooltip')
  await expect(breakdown.getByText('Public', { exact: true }).locator('..')).toContainText('$')
  await expect(breakdown.getByText('Shield', { exact: true }).locator('..')).toContainText('—')
  await expect(breakdown.getByText('Private', { exact: true }).locator('..')).toContainText(/\$|—/)
  await captureScreenshot(popup, 'private-defi-home-address-totals.png')
  await popup.mouse.move(0, 0)

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
  await expect(popup.getByRole('textbox', { name: 'ETH amount' })).toBeVisible()
  await expect(popup.getByLabel('Send To')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Change asset' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Select send asset' })).toContainText('ETH')
  await expect(popup.getByText('Ethereum', { exact: true })).toBeVisible()
  const sendSourceButton = popup.getByRole('button', {
    name: 'Choose source account, current main'
  })
  await expect(sendSourceButton).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Choose send source account' })).toHaveCount(0)
  await expect(popup.getByText('Send to', { exact: true })).toBeVisible()
  await expect(popup.getByText('Amount', { exact: true })).toBeVisible()
  await expect(popup.getByLabel('Send To')).toHaveCSS('height', '54px')
  await expect(popup.getByTestId('send-amount-card')).toHaveCSS('min-height', '92px')
  await expect(popup.getByText('Fee', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'release-default-send-input-cards.png')
  await sendSourceButton.click()
  const sendSourceDialog = popup.getByRole('dialog', { name: 'Choose source account' })
  await expect(sendSourceDialog).toContainText('Choose an account for this action')
  await expect(sendSourceDialog.getByText('Selected', { exact: true })).toHaveCount(0)
  await sendSourceDialog.getByRole('radio', { name: /Private account/ }).click()
  await expect(popup.getByRole('heading', { name: 'Move' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await captureScreenshot(popup, 'release-default-move-private-source.png')

  const tokenRequestsBeforeHomeReturn = tokenCatalogRequests
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()
  await popup.waitForTimeout(1_500)
  expect(portfolioRpcRequests.slice(requestCountBeforeReload)).toEqual([])
  expect(lendingCatalogRequests).toBe(lendingRequestsBeforeReload)
  expect(tokenCatalogRequests).toBe(tokenRequestsBeforeHomeReturn)

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

test('REF-13211 blocks a Private USDC Move without native gas before preparation', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  await mockExternalAssetIcons(context)
  await mockProtocolApis(context)
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context, 'mainnet', {
    nativeBalanceRaw: 0n,
    bundledUsdcBalanceRaw: 1_764_712n
  })
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)

  await popup.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime) as (
      message: unknown
    ) => Promise<unknown>
    const gate = window as typeof window & {
      pendingModeReads?: number
      deferredModeReadModes?: string[]
      releaseInitialModeRead?: () => void
    }
    const releasePending: Array<() => void> = []
    gate.pendingModeReads = 0
    gate.deferredModeReadModes = []
    let released = false
    gate.releaseInitialModeRead = () => {
      released = true
      for (const release of releasePending.splice(0)) release()
      gate.pendingModeReads = 0
    }
    chrome.runtime.sendMessage = (async (message: unknown) => {
      const shouldDefer =
        !released &&
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'GET_DAPP_EXECUTION_MODE'
      const response = await originalSendMessage(message)
      if (!shouldDefer || released) return response
      const mode =
        typeof response === 'object' &&
        response !== null &&
        'state' in response &&
        typeof response.state === 'object' &&
        response.state !== null &&
        'mode' in response.state
          ? response.state.mode
          : undefined
      if (typeof mode === 'string') gate.deferredModeReadModes?.push(mode)
      return new Promise(resolve => {
        releasePending.push(() => resolve(response))
        gate.pendingModeReads = releasePending.length
      })
    }) as typeof chrome.runtime.sendMessage
  })

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('status', { name: 'Loading additional networks' })).toHaveCount(0, {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await expect(popup.getByRole('button', { name: 'Select send asset' })).toContainText('USDC')
  await expect(popup.getByText('Ethereum', { exact: true })).toBeVisible()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current main' })
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

  await expect
    .poll(() =>
      popup.evaluate(
        () => (window as typeof window & { pendingModeReads?: number }).pendingModeReads
      )
    )
    .toBeGreaterThan(0)
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Private account/ })
    .click()
  await expect(
    popup.evaluate(
      () => (window as typeof window & { deferredModeReadModes?: string[] }).deferredModeReadModes
    )
  ).resolves.toContain('main')
  await popup.evaluate(async () => {
    const gate = window as typeof window & { releaseInitialModeRead?: () => void }
    if (!gate.releaseInitialModeRead)
      throw new Error('Initial execution mode read was not deferred')
    gate.releaseInitialModeRead()
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Move' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await popup.getByRole('button', { name: 'To: Shield. Change account' }).click()
  await popup
    .getByRole('dialog')
    .filter({ has: popup.getByRole('tablist', { name: 'Wallet accounts' }) })
    .getByRole('button', { name: 'Select Public account' })
    .click()
  await expect(popup.getByRole('button', { name: 'To: Public. Change account' })).toBeVisible()
  await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('1')
  await expect(
    popup.getByRole('button', { name: 'From: Private. Change account' }).locator('..')
  ).toContainText('1.7647')
  await expect(
    popup.getByRole('alert').filter({ hasText: 'Insufficient ETH balance.' })
  ).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Transfer', exact: true })).toBeDisabled()
  await captureScreenshot(popup, 'REF-13211-private-move-gated.png')
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
  await stopImportedZcashSync(popup)

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
  const addresses = popup.getByRole('dialog', { name: 'Account 1 addresses' })
  await addresses.getByRole('button', { name: 'View all' }).click()
  await expect(popup.getByRole('heading', { name: 'Address', exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .getByRole('dialog', { name: 'Accounts' })
    .getByRole('button', { name: 'Accounts', exact: true })
    .click()
  await popup.getByRole('button', { name: 'Account actions for Account 1' }).click()
  await popup.getByRole('menuitem', { name: 'Account details' }).click()
  await popup.getByRole('button', { name: 'More account actions' }).click()
  await popup.getByRole('menuitem', { name: 'Resync Zcash' }).click()
  const resyncDialog = popup.getByRole('dialog')
  await expect(resyncDialog.getByRole('heading', { name: 'Resync Zcash' })).toBeVisible()
  await expect(
    resyncDialog.getByRole('textbox', { name: 'Zcash resync block height' })
  ).not.toHaveValue('')
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

  await seedSettledZcashBalance(
    popup,
    {
      total: '0.512',
      transparent: '0.002',
      shielded: '0.51',
      spendable: '0.5',
      available: '0.5',
      shieldable: '0.002',
      pending: { total: '0.01', transparent: '0', shielded: '0.01' }
    },
    { hydrateBackground: true }
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const zecRow = popup.getByRole('button', { name: 'View ZEC details on Zcash' })
  await expect(zecRow).toBeVisible({ timeout: 30_000 })
  await expect(zecRow.locator('..')).toContainText('0.01 ZEC pending')
  await captureScreenshot(popup, 'REF-13197-noirv2-pending-balance.png')
  await zecRow.click()
  const zcashBalanceBreakdown = popup.getByLabel('Zcash balance breakdown')
  await expect(zcashBalanceBreakdown).toContainText('0.51 ZEC')
  await expect(zcashBalanceBreakdown).toContainText('0.002 ZEC')
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
