import {
  BITCOIN_MAINNET_CHAIN_ID,
  EVM_NETWORK_CONFIGS,
  PROVIDER_ICON_DATA_URL,
  TEST_ICON_SVG,
  TEST_PASSWORD,
  bitcoinEnabled,
  captureScreenshot,
  expect,
  expectDAppConnectionHeader,
  expectDAppRequestHeader,
  expectDAppTabFavicon,
  importTestWallet,
  mockExternalAssetIcons,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  mockUnknownZcashAccountHistory,
  nearEnabled,
  readEvmProviderChainIds,
  selectNewZcashAccountHistory,
  serveSdkExample,
  solanaEnabled,
  terminateExtensionServiceWorker,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'

test('exposes the released multichain provider surface by default', async ({ context }) => {
  await context.route('https://provider-release.noir.test/**', serveSdkExample)
  await context.route('https://assets.zknoir.com/chain/**', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: TEST_ICON_SVG
    })
  )
  const page = await context.newPage()
  await page.addInitScript(() => {
    const announcements: unknown[] = []
    Reflect.set(window, 'ethereum', Object.freeze({ isMetaMask: true }))
    window.addEventListener('eip6963:announceProvider', event => {
      announcements.push((event as CustomEvent).detail)
    })
    Reflect.set(window, '__noirInitialEip6963Announcements', announcements)
  })
  await page.goto('https://provider-release.noir.test/example/')
  await page.waitForFunction(() => 'noirwallet' in window)

  await expect(page.getByRole('heading', { name: 'Multichain SDK Playground' })).toBeVisible()
  await expect(page.getByText('SDK Example V2', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Provider examples' })).toBeVisible()
  await page.getByRole('button', { name: 'Ethereum', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'EVM provider' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'EVM provider' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect EVM' })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Smart contract testing' })).toBeVisible()
  await expect(page.getByLabel('NoirTestBench address')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Verify revert block' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Ethereum', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Avalanche', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Testnet' }).click()
  await expect(page.getByRole('button', { name: 'Sepolia', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Avalanche Fuji', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Solana Devnet', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'NEAR Testnet', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mainnet' }).click()
  await expect(page.getByRole('button', { name: 'Solana', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'NEAR', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Solana', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Solana dApp provider' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign serialized transaction' })).toBeVisible()
  await expect(
    page.getByText("Balance and token reads use the dApp's own Solana RPC client.")
  ).toBeVisible()
  await expect(page.getByLabel('CAIP-19 token asset ID')).toHaveCount(0)
  await page.getByRole('button', { name: 'NEAR', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'NEAR dApp provider' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign NEAR function call' })).toBeVisible()
  await expect(
    page.getByText("Balance and token reads use the dApp's own NEAR RPC client.")
  ).toBeVisible()
  await page.getByRole('button', { name: 'Ethereum', exact: true }).click()
  const providerNetworkButtons = page.locator('.provider-network-button')
  const providerNetworkButtonCount = await providerNetworkButtons.count()
  const providerNetworkIcons = page.locator('.provider-network-icon-frame img')
  expect(
    await providerNetworkIcons.evaluateAll(images =>
      images.every(image =>
        image.getAttribute('src')?.startsWith('https://assets.zknoir.com/chain/')
      )
    )
  ).toBe(true)
  expect(
    await providerNetworkButtons.evaluateAll(
      buttons => new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size
    )
  ).toBeLessThanOrEqual(2)
  const titleWidth = await page
    .getByRole('heading', { name: 'Multichain SDK Playground' })
    .evaluate(heading => ({ clientWidth: heading.clientWidth, scrollWidth: heading.scrollWidth }))
  expect(titleWidth.scrollWidth).toBeLessThanOrEqual(titleWidth.clientWidth)
  await expect
    .poll(
      () =>
        providerNetworkIcons.evaluateAll(
          images =>
            images.filter(image => {
              const element = image as HTMLImageElement
              return !element.hidden && element.complete && element.naturalWidth > 0
            }).length
        ),
      { timeout: 15_000 }
    )
    .toBe(providerNetworkButtonCount)
  await captureScreenshot(page, 'sdk-example-evm.png')
  await page.getByRole('button', { name: 'Bitcoin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bitcoin provider' })).toBeVisible()
  if (bitcoinEnabled)
    await expect(page.getByRole('button', { name: 'Connect Bitcoin' })).toBeEnabled()
  else await expect(page.getByRole('button', { name: 'Connect Bitcoin' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Validate network' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Validate chain' })).toBeDisabled()
  await captureScreenshot(page, 'sdk-example-bitcoin.png')

  await page.setViewportSize({ width: 375, height: 812 })
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
  await expect(page.getByRole('button', { name: 'Connect Bitcoin' })).toBeVisible()

  const result = await page.evaluate(() => {
    const announcements: unknown[] = []
    const nearConnectWallets: unknown[] = []
    window.addEventListener('eip6963:announceProvider', event => {
      announcements.push((event as CustomEvent).detail)
    })
    window.addEventListener('near-wallet-injected', event => {
      nearConnectWallets.push((event as CustomEvent).detail)
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    window.dispatchEvent(new Event('near-selector-ready'))
    const nearConnectWallet = nearConnectWallets[0] as
      | {
          manifest?: {
            id?: unknown
            name?: unknown
            icon?: unknown
            features?: { signInWithoutAddKey?: unknown; signAndSendTransaction?: unknown }
          }
          signIn?: unknown
        }
      | undefined
    const target = window as typeof window & {
      noirwallet?: {
        zcash?: { request?: unknown }
        ethereum?: unknown
        bitcoin?: unknown
        solana?: {
          getAccounts?: unknown
          getTokenBalance?: unknown
          sendTokenTransfer?: unknown
          signTransaction?: unknown
          signAllTransactions?: unknown
          signAndSendTransaction?: unknown
          signMessage?: unknown
        }
        near?: {
          getAccounts?: unknown
          getTokenBalance?: unknown
          sendTokenTransfer?: unknown
          requestSignIn?: unknown
          signTransaction?: unknown
          requestSignTransactions?: unknown
          signMessage?: unknown
        }
      }
      ethereum?: unknown
    }
    const originalEthereum = target.ethereum
    const laterWalletProvider = Object.freeze({
      isMetaMask: true,
      request: async () => []
    })
    const acceptsLaterWallet = Reflect.set(target, 'ethereum', laterWalletProvider)
    const laterWalletBecameDefault = target.ethereum === laterWalletProvider
    const laterWalletRegistered = (
      target.ethereum as { providers?: readonly unknown[] } | undefined
    )?.providers?.includes(laterWalletProvider)
    const noirProviderStayedAvailable = target.noirwallet?.ethereum !== undefined
    if (acceptsLaterWallet) Reflect.set(target, 'ethereum', originalEthereum)
    const initialAnnouncements = Reflect.get(window, '__noirInitialEip6963Announcements')
    const initialNoirAnnouncementObserved = Array.isArray(initialAnnouncements)
      ? initialAnnouncements.filter(
          detail =>
            typeof detail === 'object' &&
            detail !== null &&
            typeof Reflect.get(detail, 'info') === 'object' &&
            Reflect.get(Reflect.get(detail, 'info'), 'name') === 'Noir Wallet'
        ).length > 0
      : false
    return {
      zcashRequestType: typeof target.noirwallet?.zcash?.request,
      hasNoirEthereum: target.noirwallet?.ethereum !== undefined,
      hasNoirBitcoin: target.noirwallet?.bitcoin !== undefined,
      hasNoirSolana: target.noirwallet?.solana !== undefined,
      hasNoirNear: target.noirwallet?.near !== undefined,
      solanaGetAccountsType: typeof target.noirwallet?.solana?.getAccounts,
      solanaTokenBalanceType: typeof target.noirwallet?.solana?.getTokenBalance,
      solanaTokenTransferType: typeof target.noirwallet?.solana?.sendTokenTransfer,
      solanaSignTransactionType: typeof target.noirwallet?.solana?.signTransaction,
      solanaSignAllTransactionsType: typeof target.noirwallet?.solana?.signAllTransactions,
      solanaSignAndSendTransactionType: typeof target.noirwallet?.solana?.signAndSendTransaction,
      solanaSignMessageType: typeof target.noirwallet?.solana?.signMessage,
      nearTokenBalanceType: typeof target.noirwallet?.near?.getTokenBalance,
      nearGetAccountsType: typeof target.noirwallet?.near?.getAccounts,
      nearTokenTransferType: typeof target.noirwallet?.near?.sendTokenTransfer,
      nearRequestSignInType: typeof target.noirwallet?.near?.requestSignIn,
      nearSignTransactionType: typeof target.noirwallet?.near?.signTransaction,
      nearRequestSignTransactionsType: typeof target.noirwallet?.near?.requestSignTransactions,
      nearSignMessageType: typeof target.noirwallet?.near?.signMessage,
      nearConnectAnnouncementCount: nearConnectWallets.length,
      nearConnectWalletId: nearConnectWallet?.manifest?.id,
      nearConnectWalletName: nearConnectWallet?.manifest?.name,
      nearConnectWalletIcon:
        typeof nearConnectWallet?.manifest?.icon === 'string'
          ? nearConnectWallet.manifest.icon
          : null,
      nearConnectSignInType: typeof nearConnectWallet?.signIn,
      nearConnectSignInWithoutAddKey: nearConnectWallet?.manifest?.features?.signInWithoutAddKey,
      nearConnectSignAndSendTransaction:
        nearConnectWallet?.manifest?.features?.signAndSendTransaction,
      hasDefaultEthereum: target.ethereum !== undefined,
      acceptsLaterWallet,
      laterWalletBecameDefault,
      laterWalletRegistered,
      noirProviderStayedAvailable,
      initialNoirAnnouncementObserved,
      announcementCount: announcements.length
    }
  })

  expect(result).toEqual({
    zcashRequestType: 'function',
    hasNoirEthereum: true,
    hasNoirBitcoin: bitcoinEnabled,
    hasNoirSolana: solanaEnabled,
    hasNoirNear: nearEnabled,
    solanaGetAccountsType: solanaEnabled ? 'function' : 'undefined',
    solanaTokenBalanceType: 'undefined',
    solanaTokenTransferType: 'undefined',
    solanaSignTransactionType: solanaEnabled ? 'function' : 'undefined',
    solanaSignAllTransactionsType: solanaEnabled ? 'function' : 'undefined',
    solanaSignAndSendTransactionType: solanaEnabled ? 'function' : 'undefined',
    solanaSignMessageType: solanaEnabled ? 'function' : 'undefined',
    nearTokenBalanceType: 'undefined',
    nearGetAccountsType: nearEnabled ? 'function' : 'undefined',
    nearTokenTransferType: 'undefined',
    nearRequestSignInType: nearEnabled ? 'function' : 'undefined',
    nearSignTransactionType: nearEnabled ? 'function' : 'undefined',
    nearRequestSignTransactionsType: nearEnabled ? 'function' : 'undefined',
    nearSignMessageType: nearEnabled ? 'function' : 'undefined',
    nearConnectAnnouncementCount: nearEnabled ? 1 : 0,
    nearConnectWalletId: nearEnabled ? 'noir-wallet' : undefined,
    nearConnectWalletName: nearEnabled ? 'Noir Wallet' : undefined,
    nearConnectWalletIcon: nearEnabled ? PROVIDER_ICON_DATA_URL : null,
    nearConnectSignInType: nearEnabled ? 'function' : 'undefined',
    nearConnectSignInWithoutAddKey: nearEnabled ? true : undefined,
    nearConnectSignAndSendTransaction: nearEnabled ? true : undefined,
    hasDefaultEthereum: true,
    acceptsLaterWallet: true,
    laterWalletBecameDefault: false,
    laterWalletRegistered: true,
    noirProviderStayedAvailable: true,
    initialNoirAnnouncementObserved: true,
    announcementCount: 1
  })
  await page.close()
})

test('creates one CAIP-25 session for every released provider', async ({ context, popup }) => {
  test.skip(
    !bitcoinEnabled || !solanaEnabled || !nearEnabled,
    'Requires an explicit five-chain verification profile'
  )
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require an explicit real-browser approval run'
  )
  test.setTimeout(180_000)
  const origin = 'https://provider-release.noir.test'
  await context.route(`${origin}/**`, serveSdkExample)
  await mockExternalAssetIcons(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const page = await context.newPage()
  await page.goto(`${origin}/example/`)
  await page.waitForFunction(() => 'noirwallet' in window)
  await expectDAppTabFavicon(page, popup)

  const approvalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect all networks' }).click()
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(approval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`
  })
  await expect(approval.locator('[data-caip25-scope]')).toHaveCount(5)
  await expect(approval.getByText('5 networks · 5 selected', { exact: true })).toBeVisible()
  await expect(approval.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await captureScreenshot(approval, 'caip25-multichain-session-approval.png')
  const firstScope = approval.locator('[data-caip25-scope]').first()
  await firstScope.locator(':scope > button').click()
  await expect(firstScope.locator('[data-caip25-account]')).toHaveCount(1)
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()

  await expect(page.getByText('5 networks authorized', { exact: true })).toBeVisible()
  const storedSession = await popup.evaluate(async expectedOrigin => {
    const stored = await chrome.storage.local.get('connectedDApps')
    const connections = Array.isArray(stored.connectedDApps) ? stored.connectedDApps : []
    const connection = connections.find(
      candidate =>
        typeof candidate === 'object' &&
        candidate !== null &&
        Reflect.get(candidate, 'origin') === expectedOrigin
    )
    return connection ? Reflect.get(connection, 'caip25Session') : null
  }, origin)
  expect(storedSession).toEqual(expect.objectContaining({ scopes: expect.any(Array) }))
  await page.reload()
  await page.waitForFunction(() => 'noirwallet' in window)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const wallet = Reflect.get(window, 'noirwallet') as
          | { multichain?: { getSession(): Promise<{ scopes: Record<string, unknown> } | null> } }
          | undefined
        if (!wallet?.multichain) return { scopeCount: 0, error: 'Provider unavailable' }
        try {
          const session = await wallet.multichain.getSession()
          return { scopeCount: session ? Object.keys(session.scopes).length : 0, error: null }
        } catch (error) {
          return {
            scopeCount: 0,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      })
    )
    .toEqual({ scopeCount: 5, error: null })
  await expect(page.getByText('5 networks authorized', { exact: true })).toBeVisible()
  const providerState = await page.evaluate(async () => {
    type Session = {
      scopes: Record<string, { accounts: readonly string[] }>
    }
    type RequestProvider = {
      request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
    }
    type AccountsProvider = {
      getAccounts(): Promise<readonly string[]>
    }
    const wallet = Reflect.get(window, 'noirwallet') as
      | {
          multichain: {
            getSession(): Promise<Session | null>
            invokeMethod(params: {
              scope: string
              request: { method: string; params?: readonly unknown[] }
            }): Promise<unknown>
          }
          ethereum: RequestProvider
          bitcoin: AccountsProvider
          solana: AccountsProvider
          near: AccountsProvider
        }
      | undefined
    if (!wallet?.multichain) throw new Error('Multichain provider is unavailable.')
    const session = await wallet.multichain.getSession()
    const invokedAccounts = await wallet.multichain.invokeMethod({
      scope: 'eip155:1',
      request: { method: 'eth_accounts', params: [] }
    })
    let deniedCode: number | null = null
    try {
      await wallet.ethereum.request({ method: 'eth_blockNumber' })
    } catch (error) {
      deniedCode =
        typeof error === 'object' &&
        error !== null &&
        typeof Reflect.get(error, 'code') === 'number'
          ? Reflect.get(error, 'code')
          : null
    }
    return {
      scopeCount: session ? Object.keys(session.scopes).length : 0,
      scopeAccountCounts: session
        ? Object.values(session.scopes).map(scope => scope.accounts.length)
        : [],
      invokedAccounts,
      evmAccounts: await wallet.ethereum.request({ method: 'eth_accounts' }),
      bitcoinAccounts: await wallet.bitcoin.getAccounts(),
      solanaAccounts: await wallet.solana.getAccounts(),
      nearAccounts: await wallet.near.getAccounts(),
      deniedCode
    }
  })
  expect(providerState.scopeCount).toBe(5)
  expect(providerState.scopeAccountCounts).toEqual([1, 1, 1, 1, 1])
  expect(providerState.invokedAccounts).toEqual(providerState.evmAccounts)
  expect(providerState.bitcoinAccounts).toHaveLength(1)
  expect(providerState.solanaAccounts).toHaveLength(1)
  expect(providerState.nearAccounts).toHaveLength(1)
  expect(providerState.deniedCode).toBe(4100)

  await page.evaluate(async () => {
    const wallet = Reflect.get(window, 'noirwallet') as
      | { multichain?: { revokeSession(): Promise<null> } }
      | undefined
    if (!wallet?.multichain) throw new Error('Multichain provider is unavailable.')
    await wallet.multichain.revokeSession()
  })
  await expect(page.getByRole('button', { name: 'Connect all networks' })).toBeVisible()
  const revokedState = await page.evaluate(async () => {
    const wallet = Reflect.get(window, 'noirwallet') as
      | {
          multichain: { getSession(): Promise<unknown> }
          ethereum: { request(args: { method: string }): Promise<unknown> }
          bitcoin: { getAccounts(): Promise<readonly string[]> }
          solana: { getAccounts(): Promise<readonly string[]> }
          near: { getAccounts(): Promise<readonly string[]> }
        }
      | undefined
    if (!wallet) throw new Error('Noir Wallet provider is unavailable.')
    return {
      session: await wallet.multichain.getSession(),
      evmAccounts: await wallet.ethereum.request({ method: 'eth_accounts' }),
      bitcoinAccounts: await wallet.bitcoin.getAccounts(),
      solanaAccounts: await wallet.solana.getAccounts(),
      nearAccounts: await wallet.near.getAccounts()
    }
  })
  expect(revokedState).toEqual({
    session: null,
    evmAccounts: [],
    bitcoinAccounts: [],
    solanaAccounts: [],
    nearAccounts: []
  })
})

test('adds a Zcash account after the service worker restores an unlocked session', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await expect(popup.getByRole('button', { name: 'Choose wallet' })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'Show account addresses' })).toBeVisible()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  try {
    await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
    await selectNewZcashAccountHistory(popup)
    await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(popup.getByText('Account setup incomplete')).toHaveCount(0)
  } finally {
    await removeZcashHistoryMock()
  }
})

test('wallet-side Connect restores an existing EVM site for the active account', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  const origin = 'https://wallet-connect.noir.test'
  await context.route(`${origin}/**`, route =>
    route.fulfill({ contentType: 'text/html', body: '<title>Wallet Connect</title>' })
  )
  await mockReleasedEvmRpc(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const previous = await popup.evaluate(async () => {
    const walletState = (await chrome.storage.local.get('wallet_state')).wallet_state as {
      state: { currentWalletId: string; currentAccountId: string }
    }
    return {
      walletId: walletState.state.currentWalletId,
      accountId: walletState.state.currentAccountId
    }
  })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await removeZcashHistoryMock()
  await popup.getByRole('button', { name: 'Switch to Account 2' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const walletState = (await chrome.storage.local.get('wallet_state')).wallet_state as {
          state: { currentAccountId: string }
        }
        return walletState.state.currentAccountId
      })
    )
    .not.toBe(previous.accountId)
  const active = await popup.evaluate(async () => {
    const walletState = (await chrome.storage.local.get('wallet_state')).wallet_state as {
      state: { currentWalletId: string; currentAccountId: string }
    }
    return {
      walletId: walletState.state.currentWalletId,
      accountId: walletState.state.currentAccountId
    }
  })
  expect(active.accountId).not.toBe(previous.accountId)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Switch to Account 1' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByText('Account 1', { exact: true })).toBeVisible()
  await popup.evaluate(
    ({ site, account }) =>
      chrome.storage.local.set({
        connectedDApps: [
          {
            id: 'wallet-connect-existing-evm',
            name: 'Wallet Connect',
            host: 'wallet-connect.noir.test',
            origin: site,
            favicon: '',
            connectedAt: Date.now(),
            lastActiveAt: Date.now(),
            chainAuthorizations: [{ chainId: 'eip155:1', accounts: [account], binding: account }]
          }
        ]
      }),
    { site: origin, account: previous }
  )
  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()

  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => Boolean(Reflect.get(window, 'noirwallet')))
  await page.evaluate(() => {
    const provider = Reflect.get(Reflect.get(window, 'noirwallet'), 'ethereum') as {
      on(eventName: string, listener: (accounts: string[]) => void): void
    }
    ;(window as typeof window & { walletConnectEvents: string[][] }).walletConnectEvents = []
    provider.on('accountsChanged', accounts => {
      ;(window as typeof window & { walletConnectEvents: string[][] }).walletConnectEvents.push(
        accounts
      )
    })
  })
  const readAccounts = () =>
    page.evaluate(async () => {
      const provider = Reflect.get(Reflect.get(window, 'noirwallet'), 'ethereum') as {
        request(input: { method: string }): Promise<string[]>
      }
      return provider.request({ method: 'eth_accounts' })
    })
  const [previousAddress] = await readAccounts()
  expect(previousAddress).toMatch(/^0x[0-9a-f]{40}$/)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Switch to Account 2' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible()
  await expect.poll(readAccounts).toEqual([previousAddress])
  await expect(popup.getByTestId('dapp-connect-prompt')).toBeVisible()
  await popup.getByTestId('dapp-connect-prompt').getByRole('button', { name: 'Connect' }).click()
  await expect(popup.getByTestId('dapp-connect-prompt')).toHaveCount(0)
  await expect
    .poll(readAccounts)
    .toEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/), previousAddress])
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { walletConnectEvents: string[][] }).walletConnectEvents
      )
    )
    .toContainEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/), previousAddress])

  const connection = await popup.evaluate(async site => {
    const stored = (await chrome.storage.local.get('connectedDApps')).connectedDApps as Array<{
      origin: string
      chainAuthorizations: Array<{
        chainId: string
        accounts: Array<{ walletId: string; accountId: string }>
        binding: { walletId: string; accountId: string }
      }>
      authorizedAccounts?: unknown
    }>
    return stored.find(item => item.origin === site)
  }, origin)
  expect(connection?.chainAuthorizations).toEqual([
    { chainId: 'eip155:1', accounts: [previous, active], binding: active }
  ])
  expect(connection?.authorizedAccounts).toBeUndefined()
  await captureScreenshot(popup, 'wallet-side-evm-connect-success.png')
})

test('connects the SDK example with multi-wallet Zcash, EVM, Bitcoin, Solana, and named NEAR accounts', async ({
  context,
  popup
}) => {
  test.skip(
    !bitcoinEnabled || !solanaEnabled || !nearEnabled,
    'Requires an explicit five-chain verification profile'
  )
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require an explicit real-browser approval run'
  )
  test.setTimeout(180_000)
  const origin = 'https://provider-release.noir.test'
  await context.route(`${origin}/**`, serveSdkExample)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await context.route('https://api.fastnear.com/v0/public_key/**', async route => {
    const publicKey = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        public_key: publicKey,
        account_ids: ['noir-sdk-example.near']
      })
    })
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await removeZcashHistoryMock()

  const page = await context.newPage()
  await page.goto(`${origin}/example/`)
  await page.waitForFunction(() => 'noirwallet' in window)
  await expectDAppTabFavicon(page, popup)

  const zcashApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect Noir Wallet' }).click()
  const zcashApproval = await zcashApprovalPromise
  await zcashApproval.waitForURL(/#approval\?requestId=/)
  await zcashApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(zcashApproval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`,
    hiddenChain: 'Zcash'
  })
  await captureScreenshot(zcashApproval, 'zcash-dapp-connect-multi-approval.png')
  await zcashApproval.getByRole('button', { name: 'Edit accounts' }).click()
  await expect(zcashApproval.locator('[data-dapp-account-option="true"]')).toHaveCount(2)
  await zcashApproval.locator('[data-dapp-account-option="true"]').nth(1).click()
  await zcashApproval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Ethereum', exact: true }).click()
  const evmApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect EVM' }).click()
  const evmApproval = await evmApprovalPromise
  await evmApproval.waitForURL(/#approval\?requestId=/)
  await evmApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(evmApproval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`,
    hiddenChain: 'Ethereum'
  })
  await captureScreenshot(evmApproval, 'evm-dapp-connect-multi-approval.png')
  await evmApproval.getByRole('button', { name: 'Edit accounts' }).click()
  await expect(evmApproval.locator('[data-dapp-account-option="true"]')).toHaveCount(2)
  await evmApproval.locator('[data-dapp-account-required="false"]').click()
  await evmApproval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.provider-result')).toContainText(/^Connected 0x[0-9a-f]{40}$/)

  const arbitrumRpc = EVM_NETWORK_CONFIGS.mainnet.find(
    network => network.chainId === 'eip155:42161'
  )
  if (!arbitrumRpc) throw new Error('Arbitrum RPC is unavailable in the test catalog')
  await context.route(
    url => url.href === new URL(arbitrumRpc.rpcUrl).href,
    async route => {
      const request = route.request().postDataJSON() as { method?: string }
      if (request.method === 'eth_chainId') {
        await route.abort('timedout')
        return
      }
      await route.fallback()
    }
  )

  const arbitrumApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Arbitrum', exact: true }).click()
  const arbitrumApproval = await arbitrumApprovalPromise
  await arbitrumApproval.waitForURL(/#approval\?requestId=/)
  await arbitrumApproval.getByRole('button', { name: 'Switch Network' }).click()
  await expect(page.getByText('0xa4b1', { exact: true })).toBeVisible()
  await expect
    .poll(() => readEvmProviderChainIds(page))
    .toEqual({
      property: '0xa4b1',
      request: '0xa4b1'
    })
  const arbitrumCall = await page.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: { request: (input: { method: string; params: unknown[] }) => Promise<unknown> }
        }
      }
    ).noirwallet.ethereum
    return provider.request({
      method: 'eth_call',
      params: [
        { to: '0x1111111111111111111111111111111111111111', data: '0x', chainId: '0xa4b1' },
        'latest'
      ]
    })
  })
  expect(arbitrumCall).toBe('0x')

  const ethereumApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Ethereum', exact: true }).click()
  const ethereumApproval = await ethereumApprovalPromise
  await ethereumApproval.waitForURL(/#approval\?requestId=/)
  await ethereumApproval.getByRole('button', { name: 'Switch Network' }).click()
  await expect(page.getByText('0x1', { exact: true })).toBeVisible()
  await expect
    .poll(() => readEvmProviderChainIds(page))
    .toEqual({
      property: '0x1',
      request: '0x1'
    })

  await page.getByRole('button', { name: 'Bitcoin', exact: true }).click()
  const bitcoinApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect Bitcoin' }).click()
  const bitcoinApproval = await bitcoinApprovalPromise
  await bitcoinApproval.waitForURL(/#approval\?requestId=/)
  await bitcoinApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(bitcoinApproval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`,
    hiddenChain: 'Bitcoin'
  })
  await captureScreenshot(bitcoinApproval, 'bitcoin-dapp-connect-multi-approval.png')
  await bitcoinApproval.getByRole('button', { name: 'Edit accounts' }).click()
  await expect(bitcoinApproval.locator('[data-dapp-account-option="true"]')).toHaveCount(2)
  await bitcoinApproval.locator('[data-dapp-account-required="false"]').click()
  await bitcoinApproval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.provider-result')).toContainText(/^Connected bc1/)

  await page.getByRole('button', { name: 'Solana', exact: true }).click()
  const solanaApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect Solana' }).click()
  const solanaApproval = await solanaApprovalPromise
  await solanaApproval.waitForURL(/#approval\?requestId=/)
  await solanaApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(solanaApproval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`,
    hiddenChain: 'Solana'
  })
  await captureScreenshot(solanaApproval, 'solana-dapp-connect-approval.png')
  await solanaApproval.getByRole('button', { name: 'Edit accounts' }).click()
  await expect(solanaApproval.locator('[data-dapp-account-option="true"]')).toHaveCount(2)
  await solanaApproval.locator('[data-dapp-account-required="false"]').click()
  await solanaApproval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.provider-result')).toContainText(/^Connected [1-9A-HJ-NP-Za-km-z]+$/)

  const solanaMessageApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Sign message', exact: true }).click()
  const solanaMessageApproval = await solanaMessageApprovalPromise
  await solanaMessageApproval.waitForURL(/#approval\?requestId=/)
  await solanaMessageApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(solanaMessageApproval, {
    action: 'Sign message',
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`
  })
  await captureScreenshot(solanaMessageApproval, 'solana-dapp-sign-message-approval.png')
  await solanaMessageApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  await expect(page.locator('.provider-result')).toContainText(/^Signature: /)

  await page.getByRole('button', { name: 'NEAR', exact: true }).click()
  const nearApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect NEAR' }).click()
  const nearApproval = await nearApprovalPromise
  await nearApproval.waitForURL(/#approval\?requestId=/)
  await nearApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppConnectionHeader(nearApproval, {
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`,
    hiddenChain: 'NEAR'
  })
  await captureScreenshot(nearApproval, 'near-dapp-connect-approval.png')
  await nearApproval.getByRole('button', { name: 'Edit accounts' }).click()
  await expect(nearApproval.locator('[data-dapp-account-option="true"]')).toHaveCount(2)
  await nearApproval.locator('[data-dapp-account-required="false"]').click()
  await nearApproval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.provider-result')).toHaveText('Connected noir-sdk-example.near')

  await page.getByPlaceholder('receiver.near').fill('noir-sdk-example.near')
  const nearMessageApprovalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Sign message', exact: true }).click()
  const nearMessageApproval = await nearMessageApprovalPromise
  await nearMessageApproval.waitForURL(/#approval\?requestId=/)
  await nearMessageApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(nearMessageApproval, {
    action: 'Sign message',
    domain: 'provider-release.noir.test',
    pageUrl: `${origin}/example/`
  })
  await captureScreenshot(nearMessageApproval, 'near-dapp-sign-message-approval.png')
  await nearMessageApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  await expect(page.locator('.provider-result')).toContainText(/^Signature: /)
})

test('imports and exports scoped EVM and Bitcoin private-key Wallets across Worker restart', async ({
  context,
  popup
}) => {
  test.skip(!bitcoinEnabled, 'Requires an explicit Bitcoin verification profile')
  test.setTimeout(240_000)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const evmPrivateKey = `0x${'00'.repeat(31)}01`
  const bitcoinPrivateKey = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn'
  const importWallet = async (family: 'EVM' | 'Bitcoin', walletName: string): Promise<void> => {
    const addWallet = popup.getByRole('button', { name: 'Add Wallet', exact: true })
    const chooseWallet = popup.getByRole('button', { name: 'Choose wallet' })
    await expect(addWallet.or(chooseWallet)).toBeVisible({ timeout: 30_000 })
    if (await chooseWallet.isVisible()) {
      await chooseWallet.click()
      await expect(addWallet).toBeVisible({ timeout: 30_000 })
    }
    await addWallet.click()
    await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
    await popup.getByRole('button', { name: 'Private Key', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Import private key' })).toBeVisible()
    const accountCountBeforePreview = await popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      return response.result?.accounts?.length ?? 0
    })
    await popup.getByLabel('Wallet name').fill(walletName)
    await popup
      .getByLabel('Private key', { exact: true })
      .fill(family === 'EVM' ? evmPrivateKey : bitcoinPrivateKey)
    await expect(popup.getByText('Detected network', { exact: true })).toBeVisible()
    await expect(popup.getByText(family, { exact: true })).toBeVisible()
    if (family === 'EVM') {
      await popup.getByRole('button', { name: 'Change', exact: true }).click()
      await expect(popup.getByRole('button', { name: 'Solana', exact: true })).toBeVisible()
      await expect(popup.getByRole('button', { name: 'NEAR', exact: true })).toBeVisible()
      await popup.getByRole('button', { name: 'Bitcoin', exact: true }).click()
      await expect(popup.getByText('Import as', { exact: true })).toBeVisible()
      await popup.getByLabel('Private key', { exact: true }).fill('')
      await popup.getByLabel('Private key', { exact: true }).fill(evmPrivateKey)
      await expect(popup.getByText('Detected network', { exact: true })).toBeVisible()
      await expect(popup.getByText('EVM', { exact: true })).toBeVisible()
    }
    await popup.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(popup.getByText(`${family} address preview`, { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(
      popup.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
        return response.result?.accounts?.length ?? 0
      })
    ).resolves.toBe(accountCountBeforePreview)
    await expect(
      popup.getByText(
        family === 'EVM'
          ? `Available on ${EVM_NETWORK_CONFIGS.mainnet.length} EVM networks`
          : 'Native SegWit · 3 additional Bitcoin address formats',
        { exact: true }
      )
    ).toBeVisible()
    if (family === 'EVM') {
      await expect(
        popup.getByText('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', { exact: true })
      ).toBeVisible()
    }
    if (family === 'EVM') {
      await captureScreenshot(popup, 'release-default-import-evm-private-key.png')
    } else {
      await captureScreenshot(popup, 'release-default-import-bitcoin-private-key.png')
    }
    await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
    if (family === 'Bitcoin') {
      await expect(popup.getByRole('button', { name: 'Expand low value assets' })).toHaveCount(0)
    }
    await expect(
      popup.getByRole('button', {
        name: family === 'EVM' ? 'View ETH details on Ethereum' : 'View BTC details on Bitcoin'
      })
    ).toBeVisible({
      timeout: 60_000
    })
    await expect(popup.getByText('Unable to load portfolio', { exact: true })).toHaveCount(0)
  }

  await importWallet('EVM', 'Imported EVM Test')
  const evmAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) => account.walletDisplayName === 'Imported EVM Test'
    )
  })
  expect(evmAccount).toMatchObject({
    walletSource: { kind: 'private-key', chainFamily: 'eip155' },
    active: true,
    networks: expect.arrayContaining([
      expect.objectContaining({ chainId: 'eip155:1' }),
      expect.objectContaining({ chainId: 'eip155:56' }),
      expect.objectContaining({ chainId: 'eip155:42161' }),
      expect.objectContaining({ chainId: 'eip155:8453' })
    ])
  })
  expect(evmAccount.networks).toHaveLength(EVM_NETWORK_CONFIGS.mainnet.length)
  expect(
    new Set(
      evmAccount.networks.flatMap((network: { addresses: readonly { value: string }[] }) =>
        network.addresses.map(address => address.value)
      )
    )
  ).toEqual(new Set(['0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf']))

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .locator('section[aria-label="Wallet group Imported Private Key"]')
    .getByRole('button', { name: `Account actions for ${evmAccount.accountDisplayName}` })
    .first()
    .click()
  await popup.getByRole('menuitem', { name: 'Export private key' }).click()
  const evmExportOption = popup.getByRole('button', { name: 'EVM', exact: true })
  await expect(evmExportOption.locator('[data-slot="chain-icon-group"] img')).toHaveCount(4)
  await expect(popup.getByRole('button', { name: 'Ethereum', exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'BNB Chain', exact: true })).toHaveCount(0)
  await popup.getByLabel('Enter password').fill(TEST_PASSWORD)
  await popup.getByRole('button', { name: 'Reveal private key' }).click()
  await expect(popup.getByText(evmPrivateKey, { exact: true })).toHaveClass(/blur/)
  await expect(popup.locator('[data-slot="chain-icon-group"] img')).toHaveCount(4)
  await popup.getByRole('button', { name: 'Reveal', exact: true }).click()
  await expect(popup.getByText(evmPrivateKey, { exact: true })).not.toHaveClass(/blur/)
  await captureScreenshot(popup, 'release-default-export-evm-private-key.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await importWallet('Bitcoin', 'Imported Bitcoin Test')
  const bitcoinAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported Bitcoin Test'
    )
  })
  expect(bitcoinAccount).toMatchObject({
    walletSource: { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
    active: true,
    networks: [
      {
        chainId: BITCOIN_MAINNET_CHAIN_ID,
        addresses: expect.arrayContaining([
          expect.objectContaining({ scheme: 'bitcoin-p2pkh' }),
          expect.objectContaining({ scheme: 'bitcoin-p2sh-p2wpkh' }),
          expect.objectContaining({ scheme: 'bitcoin-p2wpkh', preferredForReceive: true }),
          expect.objectContaining({ scheme: 'bitcoin-p2tr' })
        ])
      }
    ]
  })
  expect(bitcoinAccount.networks[0].addresses).toHaveLength(4)

  const nextPassword = `${TEST_PASSWORD}-next`
  await expect(
    popup.evaluate(
      ({ currentPassword, newPassword }) =>
        chrome.runtime.sendMessage({
          type: 'CHANGE_WALLET_PASSWORD',
          currentPassword,
          newPassword
        }),
      { currentPassword: TEST_PASSWORD, newPassword: nextPassword }
    )
  ).resolves.toEqual({ success: true })

  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByPlaceholder('Enter Password').fill(nextPassword)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(
      () =>
        popup.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
          return (response.result?.accounts ?? [])
            .map((account: { walletDisplayName?: string }) => account.walletDisplayName)
            .filter((name: unknown): name is string => typeof name === 'string')
            .filter(name => name.startsWith('Imported '))
            .sort()
        }),
      { timeout: 30_000 }
    )
    .toEqual(['Imported Bitcoin Test', 'Imported EVM Test'])
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Noir Wallet' })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByText('Imported EVM Test', { exact: true })).toBeVisible()
  await expect(popup.getByText('Imported Bitcoin Test', { exact: true })).toBeVisible()
  await popup
    .locator('section[aria-label="Wallet group Imported Private Key"]')
    .getByRole('button', { name: `Account actions for ${bitcoinAccount.accountDisplayName}` })
    .last()
    .click()
  await popup.getByRole('menuitem', { name: 'Export private key' }).click()
  await popup.getByLabel('Enter password').fill(TEST_PASSWORD)
  await popup.getByRole('button', { name: 'Reveal private key' }).click()
  await expect(popup.locator('p.text-danger')).toContainText(/password|vault/i)
  await popup.getByLabel('Enter password').fill(nextPassword)
  await popup.getByRole('button', { name: 'Reveal private key' }).click()
  const exportedBitcoin = popup.locator('p.font-mono')
  await expect(exportedBitcoin).toHaveText(/^K[1-9A-HJ-NP-Za-km-z]{51}$/)
  await expect(exportedBitcoin).toHaveClass(/blur/)
  await popup.getByRole('button', { name: 'Reveal', exact: true }).click()
  await captureScreenshot(popup, 'release-default-export-bitcoin-private-key.png')
})

test('shows the global dApp account mode before an EVM dApp connects', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  const priceUpdatedAt = new Date().toISOString()
  const canonicalEth = {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    chainId: 1,
    contractAddress: null,
    decimals: 18,
    price: 3_200,
    priceUpdatedAt,
    symbol: 'ETH',
    address: 'nep141:eth.omft.near',
    isNative: true
  }
  await context.route('https://1click.chaindefuser.com/v0/tokens', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([canonicalEth])
    })
  )
  await context.route('https://api.rhea.finance/get_chain_prices**', route => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: chainId === 1 ? { [canonicalEth.assetId]: canonicalEth } : {}
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
        data: { tokens: chainId === 1 ? [canonicalEth] : [] }
      })
    })
  })
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })

  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  const executionModeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  await expect(executionModeCard).toBeVisible()
  await expect(executionModeCard.getByText('No dApps connected.', { exact: true })).toBeVisible()
  await expect(
    executionModeCard.getByRole('radio', { name: 'Use Public address for dApps' })
  ).toBeChecked()
  await expect(
    executionModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' })
  ).toBeEnabled({ timeout: 30_000 })

  await expect
    .poll(async () => {
      const [cardBox, viewportHeight] = await Promise.all([
        executionModeCard.boundingBox(),
        popup.evaluate(() => document.documentElement.clientHeight)
      ])
      return Boolean(
        cardBox && cardBox.y >= 0 && cardBox.y + cardBox.height <= viewportHeight + 0.5
      )
    })
    .toBe(true)
  await captureScreenshot(popup, 'release-default-dapp-mode-empty.png')
  await executionModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' }).click()
  const privateSetupDialog = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  if (await privateSetupDialog.isVisible()) {
    await privateSetupDialog.getByRole('button', { name: 'Turn on' }).click()
  }
  await expect(popup.getByRole('button', { name: 'dApp address: Confidential' })).toBeVisible()
  await popup.getByRole('button', { name: 'dApp address: Confidential' }).click()
  const privateModeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  await expect(
    privateModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' })
  ).toBeChecked()
  await captureScreenshot(popup, 'release-default-dapp-mode-private.png')
  await popup.getByRole('button', { name: 'Close' }).click()

  await popup.getByRole('button', { name: 'Show account addresses' }).click()
  const accountAddressMenu = popup.getByLabel('Account address menu')
  await expect(
    accountAddressMenu.getByRole('button', { name: 'Copy EVM Confidential address' })
  ).toBeVisible()
  await captureScreenshot(popup, 'release-default-private-address-menu.png')
  await accountAddressMenu.getByRole('button', { name: 'View all' }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(
    popup.getByRole('button', { name: 'Copy Confidential address' }).first()
  ).toBeVisible()
  await captureScreenshot(popup, 'release-default-private-addresses.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  const privateSendSource = popup.getByRole('button', {
    name: 'Choose source account, current private'
  })
  await expect(privateSendSource).toBeVisible()
  await captureScreenshot(popup, 'release-default-send-global-private.png')
  await privateSendSource.click()
  await expect(
    popup
      .getByRole('dialog', { name: 'Choose source account' })
      .getByRole('radio', { name: /Confidential account/ })
  ).toBeChecked()
  await popup.getByRole('button', { name: 'Close' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('status', { name: 'Loading swap assets' })).toHaveCount(0, {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'From asset' }).click()
  const sourceSelector = popup.getByRole('dialog')
  await sourceSelector
    .getByRole('button', { name: 'Filter assets by network: All Networks' })
    .click()
  await popup.getByRole('menuitemradio', { name: 'Ethereum', exact: true }).click()
  await sourceSelector.getByPlaceholder('Search tokens').fill('ETH')
  await sourceSelector
    .getByRole('button', { name: /^ETH on Ethereum/ })
    .first()
    .click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toBeVisible({ timeout: 30_000 })
  await captureScreenshot(popup, 'release-default-swap-global-private.png')
})
