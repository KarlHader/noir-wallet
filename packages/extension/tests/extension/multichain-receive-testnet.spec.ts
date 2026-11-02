import type { BrowserContext, Page, Route } from '@playwright/test'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'multichain-receive-password'
const TESTNET_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
const EXPECTED_EVM_ADDRESS = '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
const EXPECTED_BITCOIN_ADDRESS = 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
const EXPECTED_EVM_NETWORK_LABELS = Object.freeze([
  'Ethereum Sepolia',
  'BSC Testnet',
  'Arbitrum Sepolia',
  'Base Sepolia',
  'OP Sepolia',
  'Polygon Amoy',
  'Avalanche Fuji'
])
const EXPECTED_NETWORK_LABELS = Object.freeze([
  'Zcash',
  ...EXPECTED_EVM_NETWORK_LABELS,
  'Bitcoin',
  'Solana Devnet',
  'NEAR Testnet'
])

async function mockEmptyBitcoinNetwork(context: BrowserContext): Promise<void> {
  const emptyStats = Object.freeze({
    tx_count: 0,
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0
  })
  const fulfillJson = (route: Route, body: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    const marker = '/testnet/api/'
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex < 0) throw new Error(`Unexpected Bitcoin test URL: ${url.href}`)
    const path = decodeURIComponent(url.pathname.slice(markerIndex + marker.length))
    if (path === 'block-height/0') {
      await route.fulfill({ contentType: 'text/plain', body: TESTNET_GENESIS })
      return
    }
    if (path === 'blocks/tip/height') {
      await route.fulfill({ contentType: 'text/plain', body: '2500000' })
      return
    }
    if (/^address\/.+\/(?:txs|utxo)$/.test(path)) {
      await fulfillJson(route, [])
      return
    }
    const addressMatch = /^address\/([^/]+)$/.exec(path)
    if (addressMatch) {
      await fulfillJson(route, {
        address: addressMatch[1],
        chain_stats: emptyStats,
        mempool_stats: emptyStats
      })
      return
    }
    throw new Error(`Unhandled Bitcoin test path: ${path}`)
  }

  await context.route('https://mempool.space/testnet/api/**', handler)
  await context.route('https://blockstream.info/testnet/api/**', handler)
}

async function mockChainIcons(context: BrowserContext): Promise<void> {
  await context.route('https://assets.zknoir.com/chain/**', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#00d18a"/></svg>'
    })
  )
}

async function importTestWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await expect(page.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(TEST_MNEMONIC_24)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page, { birthdayHeight: 3_000_000 })
  await page.getByPlaceholder('8–64 characters').fill(TEST_PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(TEST_PASSWORD)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
}

async function expectPopupFits(page: Page, footerExpected = true): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewportHeight: document.documentElement.clientHeight,
        footerBottom: document.querySelector('.page-footer')?.getBoundingClientRect().bottom
      }))
    )
    .toEqual({
      viewportWidth: 375,
      documentWidth: 375,
      viewportHeight: 600,
      footerBottom: footerExpected ? 600 : undefined
    })
}

test('shows verified EVM, Bitcoin, Solana and NEAR addresses without releasing waiting transactions', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  let productionProtocolRequests = 0
  await context.route('https://api.rhea.finance/api/1click/**', route => {
    productionProtocolRequests += 1
    return route.abort()
  })
  await mockChainIcons(context)
  await mockEmptyBitcoinNetwork(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  expect(await popup.evaluate(() => crossOriginIsolated)).toBe(true)

  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  let executionModeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  const mainMode = executionModeCard.getByRole('radio', { name: 'Use Public address for dApps' })
  const privateMode = executionModeCard.getByRole('radio', {
    name: 'Use Confidential address for dApps'
  })
  await expect(mainMode).toBeChecked()
  await expect(privateMode).toBeEnabled()
  await privateMode.click()
  const privateModeDialog = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  await expect(privateModeDialog).toContainText(
    'Supported connected dApps will switch from your Public address to your Confidential address'
  )
  await privateModeDialog.getByRole('button', { name: 'Turn on' }).click()
  await expect(popup.getByRole('button', { name: 'dApp address: Confidential' })).toBeVisible()
  await expect(popup.getByText('dApp privacy is on', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'dApp address: Confidential' }).click()
  executionModeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  await executionModeCard.getByRole('radio', { name: 'Use Public address for dApps' }).click()
  await expect(popup.getByRole('button', { name: 'dApp address: Public' })).toBeVisible()

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByText('Noir Wallet', { exact: true })).toBeVisible()
  const networksTrigger = popup.getByRole('button', { name: 'Expand account networks' })
  await expect(networksTrigger).toContainText(`Networks (${EXPECTED_NETWORK_LABELS.length})`)
  await networksTrigger.click()
  const networksRegion = popup.getByRole('region', { name: 'Account networks' })
  for (const label of ['Zcash', 'EVM', 'Bitcoin', 'Solana Devnet', 'NEAR Testnet']) {
    await expect(networksRegion.getByText(label, { exact: true })).toBeVisible()
  }
  for (const [chainName, iconFile] of [
    ['Zcash', 'zcash.svg'],
    ['Ethereum', 'ethereum.svg'],
    ['Bitcoin', 'bitcoin.svg'],
    ['Solana', 'solana.svg'],
    ['NEAR', 'near.svg']
  ] as const) {
    const icon = networksRegion.getByRole('img', { name: chainName })
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('src', `https://assets.zknoir.com/chain/${iconFile}`)
    await expect
      .poll(() => icon.evaluate(image => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  }
  await expect(networksRegion.locator(`[title="${EXPECTED_EVM_ADDRESS}"]`)).toHaveCount(1)
  await expect(networksRegion.locator(`[title="${EXPECTED_BITCOIN_ADDRESS}"]`)).toBeVisible()
  for (const type of ['Native SegWit', 'Legacy', 'Nested SegWit', 'Taproot']) {
    await expect(networksRegion.getByText(type, { exact: true })).toBeVisible()
  }
  await expect(networksRegion.getByText('Shielded', { exact: true })).toBeVisible()
  await expect(networksRegion.getByText('Transparent', { exact: true })).toBeVisible()
  const zcashAddressButtons = networksRegion.getByRole('button', {
    name: /Copy Zcash .* address/
  })
  await expect(zcashAddressButtons).toHaveCount(2)
  const zcashAddressTopPositions = await zcashAddressButtons.evaluateAll(buttons =>
    buttons.map(button => button.getBoundingClientRect().top)
  )
  expect(Math.abs(zcashAddressTopPositions[0] - zcashAddressTopPositions[1])).toBeGreaterThan(10)
  const nearAddressButtons = networksRegion.getByRole('button', {
    name: /Copy NEAR Testnet .* address/
  })
  await expect(nearAddressButtons).toHaveCount(1)
  await expect(nearAddressButtons.first().locator('..')).toHaveClass(/flex-col/)
  await expectPopupFits(popup)
  await captureScreenshot(popup, 'multichain-account-networks-expanded.png')
  await networksRegion.getByRole('button', { name: 'Copy EVM transparent address' }).click()
  await expect(popup.getByText('Address copied', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Collapse account networks' }).click()

  await popup.getByRole('button', { name: 'Account actions for Account 1' }).click()
  await popup.getByRole('menuitem', { name: 'Addresses' }).click()
  const addressSearch = popup.getByLabel('Search Networks')
  await expect(addressSearch).toBeVisible()
  const accountAddresses = popup.getByRole('region', { name: 'Account network addresses' })
  for (const label of EXPECTED_NETWORK_LABELS) {
    await expect(accountAddresses.getByRole('heading', { name: label, exact: true })).toBeVisible()
  }
  for (const [chainName, iconFile] of [
    ['Zcash', 'zcash.svg'],
    ['Ethereum', 'ethereum.svg'],
    ['Bitcoin', 'bitcoin.svg'],
    ['Solana', 'solana.svg'],
    ['NEAR', 'near.svg']
  ] as const) {
    const icon = accountAddresses.getByRole('img', { name: chainName })
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('src', `https://assets.zknoir.com/chain/${iconFile}`)
    await expect
      .poll(() => icon.evaluate(image => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  }
  await expect(accountAddresses.getByRole('button', { name: /Copy Zcash .* address/ })).toHaveCount(
    2
  )
  await expect(accountAddresses.locator(`[title="${EXPECTED_EVM_ADDRESS}"]`)).toHaveCount(
    EXPECTED_EVM_NETWORK_LABELS.length
  )
  await expect(accountAddresses.getByText('Confidential', { exact: true })).toHaveCount(
    EXPECTED_EVM_NETWORK_LABELS.length
  )
  await expect(accountAddresses.locator(`[title="${EXPECTED_BITCOIN_ADDRESS}"]`)).toBeVisible()
  for (const type of ['Native SegWit', 'Legacy', 'Nested SegWit', 'Taproot']) {
    await expect(accountAddresses.getByText(type, { exact: true })).toBeVisible()
  }
  await expectPopupFits(popup, false)
  await captureScreenshot(popup, 'multichain-addresses-list.png')

  await addressSearch.fill('Bitcoin')
  await expect(
    accountAddresses.getByRole('heading', { name: 'Bitcoin', exact: true })
  ).toBeVisible()
  await expect(accountAddresses.getByRole('heading', { name: 'Zcash', exact: true })).toHaveCount(0)
  await expectPopupFits(popup, false)
  await captureScreenshot(popup, 'multichain-addresses-bitcoin-formats.png')

  await accountAddresses
    .getByRole('button', {
      name: 'Show Bitcoin Native SegWit address QR code'
    })
    .first()
    .click()
  const bitcoinQrDialog = popup.getByRole('dialog')
  await expect(
    bitcoinQrDialog.getByRole('heading', { name: 'Bitcoin Native SegWit address' })
  ).toBeVisible()
  await expect(bitcoinQrDialog.getByLabel('Bitcoin address QR code')).toBeVisible()
  await expect(bitcoinQrDialog.getByText(EXPECTED_BITCOIN_ADDRESS, { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'multichain-address-qr.png')
  await bitcoinQrDialog.getByRole('button', { name: 'Close' }).click()
  await accountAddresses
    .getByRole('button', { name: 'Copy Bitcoin Native SegWit address' })
    .first()
    .click()
  await expect(popup.getByText('Address copied', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Noir Wallet', { exact: true })).toBeVisible()
  await expect(popup.getByText('Account 1', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(popup.getByLabel('Search Networks')).toBeVisible()
  const homeReceiveAddresses = popup.getByRole('region', { name: 'Account network addresses' })
  for (const label of EXPECTED_NETWORK_LABELS) {
    await expect(
      homeReceiveAddresses.getByRole('heading', { name: label, exact: true })
    ).toBeVisible()
  }
  await expect(homeReceiveAddresses.locator(`[title="${EXPECTED_EVM_ADDRESS}"]`)).toHaveCount(
    EXPECTED_EVM_NETWORK_LABELS.length
  )
  await expect(homeReceiveAddresses.getByText('Confidential', { exact: true })).toHaveCount(0)
  await expect(homeReceiveAddresses.locator(`[title="${EXPECTED_BITCOIN_ADDRESS}"]`)).toBeVisible()
  await expectPopupFits(popup, false)
  await captureScreenshot(popup, 'multichain-receive-addresses.png')

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  executionModeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  await executionModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' }).click()
  await expect(popup.getByRole('button', { name: 'dApp address: Confidential' })).toBeVisible()

  const privateExecutionAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const activeAccount = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const evmNetwork = activeAccount?.networks?.find(
      (network: { privateExecutionAddress?: unknown }) =>
        typeof network.privateExecutionAddress === 'string'
    )
    if (typeof evmNetwork?.privateExecutionAddress !== 'string') {
      throw new Error('Private Execution Address is unavailable')
    }
    return evmNetwork.privateExecutionAddress
  })

  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  const privateReceiveAddresses = popup.getByRole('region', {
    name: 'Account network addresses'
  })
  await expect(privateReceiveAddresses.locator(`[title="${EXPECTED_EVM_ADDRESS}"]`)).toHaveCount(0)
  await expect(privateReceiveAddresses.locator(`[title="${privateExecutionAddress}"]`)).toHaveCount(
    EXPECTED_EVM_NETWORK_LABELS.length
  )
  await expect(privateReceiveAddresses.getByText('Confidential', { exact: true })).toHaveCount(
    EXPECTED_EVM_NETWORK_LABELS.length
  )
  await captureScreenshot(popup, 'multichain-receive-private-addresses.png')

  for (const path of ['swap', 'lending', 'supply', 'withdraw']) {
    await popup.goto('about:blank')
    await popup.goto(`chrome-extension://${extensionId}/index.html#/${path}`)
    await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  }
  expect(productionProtocolRequests).toBe(0)
})
