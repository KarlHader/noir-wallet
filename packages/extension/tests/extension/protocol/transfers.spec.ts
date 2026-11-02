import {
  registerProtocolFixtures,
  BUILD_SWAP_URL,
  ETH_ASSET,
  QUOTE_URL,
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
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/protocol-wallet'
import type { Hex } from '../../helpers/protocol-wallet'

registerProtocolFixtures()

test('routes a dApp Private transfer through Confidential and returns the destination hash', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  const protocolApis = await mockProtocolApis(context)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })

  const dapp = await connectEvmDApp(context)
  await popup.bringToFront()
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  await popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByRole('radio', { name: 'Use Confidential address for dApps' })
    .click()
  const privateSetupDialog = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  if (await privateSetupDialog.isVisible()) {
    await privateSetupDialog.getByRole('button', { name: 'Turn on' }).click()
  }
  await expect
    .poll(async () => (await readEvmAccounts(dapp.page))[0], { timeout: 30_000 })
    .not.toBe(dapp.address)
  const [resolvedPrivateAddress] = await readEvmAccounts(dapp.page)
  expect(resolvedPrivateAddress).toMatch(/^0x[0-9a-f]{40}$/)
  evmNetwork.setAddressBalanceRaw(resolvedPrivateAddress, 1_000_000_000_000_000_000n)

  await dapp.page.bringToFront()
  const approvalPromise = context.waitForEvent('page')
  const transactionPromise = dapp.page.evaluate(
    async ({ from, to }) => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      try {
        return {
          result: await provider.request({
            method: 'eth_sendTransaction',
            params: [{ from, to, value: '0x1' }]
          })
        }
      } catch (error) {
        const providerError = error as { code?: unknown; message?: unknown }
        return { error: { code: providerError.code, message: providerError.message } }
      }
    },
    { from: resolvedPrivateAddress, to: '0x1111111111111111111111111111111111111111' }
  )
  void transactionPromise.catch(() => undefined)
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByRole('heading', { name: 'Confidential transfer' })).toBeVisible({
    timeout: 30_000
  })
  await expect(approval.getByText('Confidential → Intents → Recipient')).toBeVisible()
  await expect(approval.getByText('Minimum received', { exact: true })).toBeVisible()
  await expect(approval.getByText('0.000000000000000001 ETH').first()).toBeVisible()
  expect(evmNetwork.getBroadcastCount()).toBe(0)

  await expect.poll(() => protocolApis.getQuoteRequests().length).toBeGreaterThan(0)
  const quote = protocolApis.getQuoteRequests().at(-1)
  expect(quote).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: ETH_ASSET,
    amount: '1',
    confidentiality: 'basic'
  })
  expect(quote?.refundTo.toLowerCase()).toBe(resolvedPrivateAddress.toLowerCase())
  expect(quote?.recipient).toBe('0x1111111111111111111111111111111111111111')
  await expect
    .poll(() =>
      approval.evaluate(() => [
        document.documentElement.clientWidth,
        document.documentElement.scrollWidth
      ])
    )
    .toEqual([375, 375])
  await captureScreenshot(approval, 'THU-DEMO-dApp-Private-Confidential-transfer.png')

  await approval.getByRole('button', { name: 'Send privately', exact: true }).click()
  await expect(transactionPromise).resolves.toEqual({ result: `0x${'f'.repeat(64)}` })
  await expect.poll(evmNetwork.getBroadcastCount, { timeout: 30_000 }).toBe(1)
})

test('reviews a funded Private EVM send before broadcasting through Intents', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const protocolApis = await mockProtocolApis(context)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 30_000
  })

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()

  const privateSourceAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const activeAccount = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const ethereum = activeAccount?.networks?.find(
      (network: { chainId?: unknown; privateExecutionAddress?: unknown }) =>
        network.chainId === 'eip155:1' && typeof network.privateExecutionAddress === 'string'
    )
    if (typeof ethereum?.privateExecutionAddress !== 'string') {
      throw new Error('Ethereum Private Execution Address is unavailable')
    }
    return ethereum.privateExecutionAddress
  })
  const recipient = '0x9C73842d02D1Fe00000000000000000000000000'
  await popup.getByLabel('Send To').fill(recipient)
  await popup.getByLabel('ETH amount').fill('0.01')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expect(popup.getByText('Recipient', { exact: true })).toBeVisible()
  await expect(popup.getByText(recipient, { exact: true })).toBeVisible()

  await expect.poll(() => protocolApis.getQuoteRequests().length).toBeGreaterThan(0)
  const quote = protocolApis.getQuoteRequests().at(-1)
  expect(quote).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: ETH_ASSET,
    amount: '10000000000000000',
    confidentiality: 'basic'
  })
  expect(quote?.refundTo.toLowerCase()).toBe(privateSourceAddress.toLowerCase())
  expect(quote?.recipient.toLowerCase()).toBe(recipient.toLowerCase())
  expect(evmNetwork.getBroadcastCount()).toBe(0)
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'private-send-confidential-review-route.png')
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(evmNetwork.getBroadcastCount, { timeout: 30_000 }).toBe(1)
  await expect(popup.getByRole('region', { name: 'Transaction progress' })).toBeVisible()
})

test('keeps transfer input free of warnings while route readiness is pending', async ({
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
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible()

  let releaseCatalog: () => void = () => {}
  const catalogPending = new Promise<void>(resolve => {
    releaseCatalog = resolve
  })
  await context.route('https://api.rhea.finance/get_chain_prices?chain=1', async route => {
    await catalogPending
    await route.fallback()
  })
  try {
    await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click()
    await popup
      .getByRole('button', { name: 'Transfer ETH between Public and Confidential' })
      .click()
    const dialog = popup.getByRole('dialog', { name: 'Transfer ETH' })
    const amount = dialog.getByLabel('Transfer amount')
    const review = dialog.getByRole('button', { name: 'Review transfer' })
    await expect(review).toBeDisabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await amount.fill('0.')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await amount.fill('0.01')
    await expect(review).toBeDisabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await captureScreenshot(popup, 'balance-transfer-route-loading.png')
    releaseCatalog()
    await expect(review).toBeEnabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await amount.fill('999')
    await expect(dialog.getByRole('alert')).toContainText('Amount exceeds')
    await expect(review).toBeDisabled()
    await amount.fill('0.01')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(review).toBeEnabled()
    await expectNoOverflow(popup)
    await captureScreenshot(popup, 'balance-transfer-clean-input.png')
  } finally {
    releaseCatalog()
  }
})

for (const direction of ['main-to-private', 'private-to-main'] as const) {
  test(`deducts native gas from Available and Max in ${direction} balance transfer`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(120_000)
    const rpc = await mockEvmNetwork(context, {
      balanceRaw: 2_976_040_456_329_000n,
      contractGas: '0x249f0'
    })
    await mockBitcoinNetwork(context)
    const api = await mockProtocolApis(context)
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    const ethDetails = popup.getByRole('button', { name: 'View ETH details on Ethereum' })
    await expect(ethDetails).toBeVisible({ timeout: 30_000 })
    await ethDetails.click()
    await popup
      .getByRole('button', { name: 'Transfer ETH between Public and Confidential' })
      .click()
    const sheet = popup.getByRole('dialog', { name: 'Transfer ETH' })
    if (direction === 'private-to-main')
      await sheet.getByRole('button', { name: 'Switch transfer direction' }).click()
    await expect(sheet.getByTestId('private-balance-transfer-amount')).toContainText(
      'Balance 0.002976 ETH',
      { timeout: 30_000 }
    )
    await sheet.getByLabel('Transfer amount').fill('0.002976040456329')
    await sheet.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(sheet.getByLabel('Transfer amount')).toHaveValue('0.002301040456329', {
      timeout: 30_000
    })
    await expect(sheet.getByTestId('private-balance-transfer-amount')).toContainText(
      'Available 0.002301 ETH'
    )
    await expectNoOverflow(popup)
    await captureScreenshot(
      popup,
      direction === 'main-to-private'
        ? 'transfer-native-max-main-to-private-available.png'
        : 'transfer-native-max-private-to-main-available.png'
    )
    await sheet.getByRole('button', { name: 'Review transfer' }).click()
    await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
      timeout: 60_000
    })
    await expect(popup.getByText('0.00054 ETH', { exact: true })).toBeVisible()
    expect(api.getQuoteRequests().at(-1)?.amount).toBe('2301040456329000')
    await captureScreenshot(
      popup,
      direction === 'main-to-private'
        ? 'transfer-native-max-main-to-private-review.png'
        : 'transfer-native-max-private-to-main-review.png'
    )
    await popup.getByRole('button', { name: 'Edit network fee' }).click()
    await popup
      .getByRole('dialog', { name: 'Network Fee' })
      .getByRole('radio', { name: /Fast/ })
      .click()
    await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
      timeout: 60_000
    })
    await expect(popup.getByText('0.00072 ETH', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(api.getQuoteRequests().at(-1)?.amount).toBe('2076040456329000')
    expect(rpc.getBroadcastCount()).toBe(0)
    await captureScreenshot(
      popup,
      direction === 'main-to-private'
        ? 'transfer-native-max-main-to-private-fast.png'
        : 'transfer-native-max-private-to-main-fast.png'
    )
  })
}

test('keeps a Main USDC send to the owned private address in Main Activity and allows cancellation', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpc = await mockEvmNetwork(context, { allowBroadcast: true, pendingBroadcast: true })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  const privateAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const active = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const ethereum = active?.networks?.find(
      (entry: { chainId?: unknown }) => entry.chainId === 'eip155:1'
    )
    if (typeof ethereum?.privateExecutionAddress !== 'string')
      throw new Error('Private EVM address is unavailable')
    return ethereum.privateExecutionAddress as string
  })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await popup.getByLabel('Send To').fill(privateAddress)
  await popup.getByLabel('USDC amount').fill('5')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await popup
    .getByRole('dialog', { name: 'Review Send' })
    .getByRole('button', { name: 'Send', exact: true })
    .click()
  await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(1)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const row = popup.getByRole('button', { name: 'View Sent USDC details' })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).not.toHaveAttribute('data-activity-account-mode', 'private')
  await captureScreenshot(popup, 'main-usdc-to-private-public-activity.png')
  await row.click()
  await popup.getByRole('button', { name: 'Cancel transaction' }).click()
  await expect(
    popup.getByRole('dialog', { name: 'Cancel transaction' }).last().getByText('Nonce', {
      exact: true
    })
  ).toBeVisible()
  expect(rpc.getBroadcastCount()).toBe(1)
  await captureScreenshot(popup, 'main-usdc-to-private-cancel-review.png')
  await popup
    .getByRole('dialog', { name: 'Cancel transaction' })
    .last()
    .getByRole('button', { name: 'Confirm cancel', exact: true })
    .click()
  await expect(popup.getByText('Cancellation submitted', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(2)
  const [originalRaw, cancellationRaw] = rpc.getBroadcastRawTransactions()
  const original = parseTransaction(originalRaw as Hex)
  const cancellation = parseTransaction(cancellationRaw as Hex)
  expect(cancellation.nonce).toBe(original.nonce)
  expect(cancellation.value ?? 0n).toBe(0n)
  expect(cancellation.maxFeePerGas).toBeGreaterThan(original.maxFeePerGas ?? 0n)
  expect(cancellation.maxPriorityFeePerGas).toBeGreaterThan(original.maxPriorityFeePerGas ?? 0n)
  await captureScreenshot(popup, 'main-usdc-to-private-cancel-submitted.png')
})

for (const sourceMode of ['main', 'private'] as const) {
  test(`deducts native gas from Available and Max in ${sourceMode} Send`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(120_000)
    const rpc = await mockEvmNetwork(context, {
      allowBroadcast: sourceMode === 'private',
      balanceRaw: 2_976_040_456_329_000n,
      contractGas: '0x249f0'
    })
    await mockBitcoinNetwork(context)
    await mockProtocolApis(context)
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup.getByRole('button', { name: 'Send', exact: true }).click()
    await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
    await popup.getByLabel('Send To').fill('0x2222222222222222222222222222222222222222')
    if (sourceMode === 'private') {
      await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
      await popup
        .getByRole('dialog', { name: 'Choose source account' })
        .getByRole('radio', { name: /Confidential account/ })
        .click()
    }
    const amount = sourceMode === 'main' ? '0.002897290456329' : '0.002301040456329'
    await expect(popup.getByRole('button', { name: 'Max', exact: true })).toBeEnabled({
      timeout: 30_000
    })
    await popup.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(popup.getByLabel('ETH amount')).toHaveValue(amount, { timeout: 30_000 })
    await expect(popup.getByTestId('send-amount-card')).toContainText(
      sourceMode === 'main' ? 'Available 0.002897 ETH' : 'Available 0.002301 ETH'
    )
    await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 30_000
    })
    await expectNoOverflow(popup)
    await captureScreenshot(
      popup,
      sourceMode === 'main'
        ? 'send-native-max-main-available.png'
        : 'send-native-max-private-available.png'
    )
    await popup.getByRole('button', { name: 'Continue', exact: true }).click()
    if (sourceMode === 'main') {
      await expect(
        popup
          .getByRole('dialog', { name: 'Review Send' })
          .getByRole('button', { name: 'Send anyway', exact: true })
      ).toBeEnabled({ timeout: 30_000 })
      expect(rpc.getBroadcastCount()).toBe(0)
      await captureScreenshot(popup, 'send-native-max-main-review.png')
    } else {
      await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
        timeout: 30_000
      })
      expect(rpc.getBroadcastCount()).toBe(0)
      await captureScreenshot(popup, 'send-native-max-private-review.png')
      await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect
        .poll(() => rpc.getBroadcastValues().at(-1), { timeout: 30_000 })
        .toBe(2_301_040_456_329_000n)
      await expect(popup.getByRole('region', { name: 'Transaction progress' })).toBeVisible()
      await captureScreenshot(popup, 'send-native-max-private-result.png')
    }
  })
}

test('reviews and submits Main to Confidential from the unified transfer sheet', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { orderStatus: 'pending' })
  let releasePreparation: () => void = () => {}
  let preparationFails = true
  const preparationPending = new Promise<void>(resolve => {
    releasePreparation = resolve
  })
  await context.route(BUILD_SWAP_URL, async route => {
    await preparationPending
    if (preparationFails) {
      await route.fulfill({ status: 502, body: 'Unavailable' })
      return
    }
    await route.fallback()
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })
  await popup
    .getByRole('button', {
      name: /(?:Estimated total assets|Total assets) .*show Public and Confidential totals/
    })
    .hover()
  await expect(popup.getByRole('tooltip')).toContainText('Public')
  await expect(popup.getByRole('tooltip')).toContainText('Confidential')
  await expect(popup.getByRole('tooltip')).toContainText('$')
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'home-total-assets-amount-hover.png', {
    preservePointer: true
  })
  await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Transfer ETH between Public and Confidential' }).click()
  const transferDialog = popup.getByRole('dialog', { name: 'Transfer ETH' })
  await expect(transferDialog.locator('p[title^="0x"]')).toHaveCount(2)
  await captureScreenshot(popup, 'balance-transfer-public-confidential-addresses.png')
  await transferDialog.getByLabel('Transfer amount').fill('0.01')
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeEnabled({
    timeout: 30_000
  })
  await transferDialog.getByRole('button', { name: 'Review transfer' }).click()

  try {
    await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled({
      timeout: 30_000
    })
    await expect(popup.getByText('0.01 ETH', { exact: true })).toBeVisible()
    await expect(popup.getByText('Network fee', { exact: true })).toBeVisible()
    await expect(popup.getByText('Preparing transfer', { exact: true })).toHaveCount(0)
    expect(evmNetwork.getBroadcastCount()).toBe(0)
    await expectNoOverflow(popup)
    await captureScreenshot(popup, 'balance-transfer-main-to-confidential-preparing.png')
  } finally {
    releasePreparation()
  }
  await expect(popup.getByRole('alert')).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()
  expect(evmNetwork.getBroadcastCount()).toBe(0)
  await expect(popup.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport({
    ratio: 1
  })
  await captureScreenshot(popup, 'balance-transfer-main-to-confidential-preparation-error.png')
  preparationFails = false
  await popup.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('heading')).toHaveCount(1)
  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByText('From', { exact: true })).toBeVisible()
  await expect(popup.getByText('Receive in', { exact: true })).toBeVisible()
  await expect(popup.getByText('Send To', { exact: true })).toBeVisible()
  await expect(popup.getByText('You receive', { exact: true })).toBeVisible()
  await expect(popup.getByText('Estimated time', { exact: true })).toBeVisible()
  await expect(popup.getByText('3-5 min', { exact: true })).toBeVisible()
  await expect(popup.getByText('Public', { exact: true })).toBeVisible()
  await expect(popup.getByText('Confidential', { exact: true })).toBeVisible()
  await expect(popup.getByText('Price Impact', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Slippage Tolerance', { exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Confirm' })).toBeEnabled({
    timeout: 30_000
  })
  expect(evmNetwork.getBroadcastCount()).toBe(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'balance-transfer-main-to-confidential-review.png')

  await popup.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => evmNetwork.getBroadcastCount(), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByRole('region', { name: 'Transaction progress' })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Confirming transfer' })).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'balance-transfer-main-to-confidential-progress.png')

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const accountTransferRow = popup.locator('[data-activity-kind="transfer"]')
  await expect(accountTransferRow).toHaveCount(1)
  await expect(accountTransferRow).toContainText('Account Transfer')
  await expect(accountTransferRow).toContainText('Public → Confidential')
  await expect(
    accountTransferRow.locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
  ).toHaveCount(1)
  const transferIconLeft = await accountTransferRow
    .locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
    .evaluate(icon => icon.getBoundingClientRect().left)
  const transferRowLeft = await accountTransferRow.evaluate(row => row.getBoundingClientRect().left)
  expect(transferIconLeft - transferRowLeft).toBe(20)
  await expect(popup.getByRole('button', { name: /^View Sent ETH/ })).toHaveCount(0)
  await captureScreenshot(popup, 'activity-public-to-confidential-transfer.png')
})

test('reviews and submits Confidential to Main from the unified transfer sheet', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { orderStatus: 'pending' })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Transfer ETH between Public and Confidential' }).click()
  const transferDialog = popup.getByRole('dialog', { name: 'Transfer ETH' })
  await transferDialog.getByRole('button', { name: 'Switch transfer direction' }).click()
  await transferDialog.getByLabel('Transfer amount').fill('0.01')
  await expect(transferDialog.getByRole('button', { name: 'Review transfer' })).toBeEnabled({
    timeout: 30_000
  })
  await transferDialog.getByRole('button', { name: 'Review transfer' }).click()

  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('heading')).toHaveCount(1)
  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByText('From', { exact: true })).toBeVisible()
  await expect(popup.getByText('Receive in', { exact: true })).toBeVisible()
  await expect(popup.getByText('Send To', { exact: true })).toBeVisible()
  await expect(popup.getByText('You receive', { exact: true })).toBeVisible()
  await expect(popup.getByText('Estimated time', { exact: true })).toBeVisible()
  await expect(popup.getByText('3-5 min', { exact: true })).toBeVisible()
  await expect(popup.getByText('Confidential', { exact: true })).toBeVisible()
  await expect(popup.getByText('Public', { exact: true })).toBeVisible()
  await expect(popup.getByText('Price Impact', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Slippage Tolerance', { exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Confirm' })).toBeEnabled({
    timeout: 30_000
  })
  expect(evmNetwork.getBroadcastCount()).toBe(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'balance-transfer-confidential-to-main-review.png')

  await popup.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => evmNetwork.getBroadcastCount(), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByRole('region', { name: 'Transaction progress' })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Confirming transfer' })).toHaveCount(0)
  await expect(popup.getByText('Refund', { exact: true })).toHaveCount(0)
  const transferActivity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as {
    result?: {
      items?: Array<{
        kind: string
        source: string
        segments: Array<{ role: string; evidence?: { transactionHash?: string } }>
      }>
    }
  }
  const transferRecord = transferActivity.result?.items?.find(
    item => item.source === 'wallet-v2' && item.segments.some(segment => segment.role === 'relay')
  )
  expect(transferRecord?.kind).toBe('transfer')
  const outgoingHash = transferRecord?.segments.find(segment => segment.role === 'origin')?.evidence
    ?.transactionHash
  expect(outgoingHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'balance-transfer-confidential-to-main-progress.png')

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  await popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByRole('radio', { name: 'Use Confidential address for dApps' })
    .click()
  const privacyDialog = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: 'Turn on', exact: true }).click()
  }
  await expect(popup.getByRole('button', { name: 'dApp address: Confidential' })).toBeVisible()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const accountTransferRow = popup.locator('[data-activity-kind="transfer"]')
  await expect(accountTransferRow).toHaveCount(1)
  await expect(accountTransferRow).toContainText('Account Transfer')
  await expect(accountTransferRow).toContainText('Confidential → Public')
  await expect(
    accountTransferRow.locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
  ).toHaveCount(1)
  await expect(popup.getByRole('button', { name: /^View Sent ETH/ })).toHaveCount(0)
  await captureScreenshot(popup, 'activity-confidential-to-public-transfer.png')
  const privateRow = popup.locator('[data-activity-account-mode="private"]').first()
  await expect(privateRow).toBeVisible()
  const privateIcon = privateRow.locator('[aria-label="Confidential"]')
  await expect(privateIcon).toBeVisible()
  await expect(privateIcon).toHaveText('')
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'activity-confidential-icon.png')
  await privateIcon.hover()
  await expect(popup.getByRole('tooltip')).toContainText('Confidential')
  await captureScreenshot(popup, 'activity-confidential-icon-hover.png', {
    preservePointer: true
  })
  await privateRow.click()
  const transferDetail = popup.locator('[data-activity-detail-id]')
  await expect(transferDetail).toBeVisible()
  await expect(transferDetail.getByRole('heading', { name: 'Account Transfer' })).toBeVisible()
  await expect(
    transferDetail.locator('[data-activity-swap-detail] [data-slot="token-icon"]')
  ).toHaveCount(1)
  await expect(transferDetail.getByText('Network', { exact: true })).toBeVisible()
  await expect(transferDetail.getByText('Route', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'activity-confidential-to-public-transfer-detail.png')
  await expect(transferDetail.getByText('Outgoing Hash', { exact: true })).toHaveCount(0)
  await expect(
    transferDetail.locator(`[data-progress-step] a[title="${outgoingHash}"]`)
  ).toBeVisible()
  await expect(transferDetail.getByText('Refund', { exact: true })).toHaveCount(0)
})

test('reviews a same-token cross-chain Send with the destination address in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context, { evmApproval: true })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await expect(popup.getByRole('group', { name: 'Send mode' })).toHaveCount(0)
  await expect(popup.getByText('To Ethereum', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'cross-chain-send-network-entry.png')
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send route, current Cross-chain' })).toBeVisible()
  await expect(popup.getByRole('dialog', { name: 'SELECT NETWORK' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinations = popup.getByRole('dialog', { name: 'SELECT NETWORK' })
  await destinations.getByPlaceholder('Search tokens').fill('USDC')
  await destinations.getByRole('button', { name: /^USDC on Polygon/ }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByRole('group', { name: 'Send mode' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'From asset' })).toBeDisabled()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('1')
  await expect(popup.getByRole('button', { name: 'Review Send' })).toBeEnabled({
    timeout: 30_000
  })
  const walletRecipient = api.getQuoteRequests().at(-1)?.recipient
  expect(walletRecipient).toMatch(/^0x[0-9a-fA-F]{40}$/)
  const externalRecipient = `0x${'12'.repeat(20)}`
  await popup.getByRole('textbox', { name: 'Receive at' }).fill(externalRecipient)
  await expect.poll(() => api.getQuoteRequests().at(-1)?.recipient).toBe(externalRecipient)
  expect(walletRecipient).not.toBe(externalRecipient)
  await expect(popup.getByRole('button', { name: 'Review Send' })).toBeEnabled({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'cross-chain-send-input.png')
  await popup.getByRole('button', { name: 'Review Send' }).click()

  await expect(popup.getByRole('heading', { name: 'Review Send' })).toBeVisible()
  await expect(popup.getByText('Polygon', { exact: true })).toBeVisible()
  await expect(popup.getByText('Recipient', { exact: true })).toBeVisible()
  await expect(popup.locator('span[title^="0x"]', { hasText: externalRecipient })).toBeVisible()
  const recipientBounds = await popup
    .locator('span[title^="0x"]', { hasText: /^0x[0-9a-fA-F]{40}$/ })
    .boundingBox()
  if (!recipientBounds) throw new Error('Recipient address is missing from the review')
  expect(recipientBounds.y + recipientBounds.height).toBeLessThan(535)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'cross-chain-send-review.png')

  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Send route, current Cross-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'On-chain' }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send route, current On-chain' })).toBeVisible()
  await expect(popup.getByText('To Ethereum', { exact: true })).toBeVisible()
  await expect(popup.getByRole('group', { name: 'Send mode' })).toHaveCount(0)
})

test('shows cross-chain Send result for an imported EVM private-key wallet', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  popup.on('pageerror', error => pageErrors.push(error.message))
  const evmNetwork = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const protocolApis = await mockProtocolApis(context, { orderStatus: 'pending' })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Add Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Private Key', exact: true }).click()
  await popup.getByLabel('Wallet name').fill('Synthetic EVM Wallet')
  await popup.getByLabel('Private key', { exact: true }).fill(`0x${'00'.repeat(31)}01`)
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByText('EVM address preview', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
  const legacyWalletId = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const state = typeof stored === 'string' ? JSON.parse(stored).state : stored?.state
    return state?.currentWalletId ?? null
  })
  expect(legacyWalletId).toBeNull()

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinations = popup.getByRole('dialog', { name: 'SELECT NETWORK' })
  await destinations.getByPlaceholder('Search tokens').fill('USDC')
  await destinations.getByRole('button', { name: /^USDC on Polygon/ }).click()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('1')
  await popup.getByRole('button', { name: 'Review Send' }).click()
  await expect(popup.getByRole('heading', { name: 'Review Send' })).toBeVisible()
  await popup.getByRole('button', { name: 'Confirm Send', exact: true }).click()

  await expect.poll(evmNetwork.getBroadcastCount, { timeout: 30_000 }).toBe(1)
  await expect(popup.getByRole('heading', { name: 'Cross-chain Send' })).toBeVisible()
  await expect(popup.getByRole('region', { name: 'Transaction progress' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View Activity' })).toBeVisible()
  expect(pageErrors).toEqual([])
  await captureScreenshot(popup, 'cross-chain-send-private-key-result.png')

  protocolApis.setOrderStatus('completed')
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECHECK_PENDING_TRANSACTIONS' }))
  await expect(popup.getByRole('button', { name: 'Done', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  expect(evmNetwork.getBroadcastCount()).toBe(1)
  expect(pageErrors).toEqual([])
  const activity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as {
    result?: { items?: Array<{ kind: string; segments: Array<{ role: string }> }> }
  }
  expect(
    activity.result?.items?.some(
      item => item.kind === 'transfer' && item.segments.some(segment => segment.role === 'relay')
    )
  ).toBe(true)
})

test('returns to the selected Send asset after switching to the cross-chain route', async ({
  context,
  popup,
  extensionId
}) => {
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Send route, current On-chain' })).toBeVisible()
  await expect(popup.getByText('To Ethereum', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Send ETH on Ethereum' })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})

test('shows the provider quote error on cross-chain Send', async ({
  context,
  popup,
  extensionId
}) => {
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  const providerFailure =
    'Quote failed (400): {"message":"Temporary swap limits: minimum swap amount is $1,000","correlationId":"provider-reference"}'
  await context.route(QUOTE_URL, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 422,
        msg: `Cross-chain quote failed: ${Array(5).fill(providerFailure).join('; ')}`,
        data: null
      })
    })
  )
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinations = popup.getByRole('dialog', { name: 'SELECT NETWORK' })
  await destinations.getByPlaceholder('Search tokens').fill('USDC')
  await destinations.getByRole('button', { name: /^USDC on Polygon/ }).click()
  await popup.getByRole('textbox', { name: 'From amount' }).fill('1')

  await expect(popup.getByText('Minimum swap amount is $1,000.', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'cross-chain-send-provider-minimum.png')
})

test('formats long Send balances and reviews without a redundant Confidential route card in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpc = await mockEvmNetwork(context, { balanceRaw: 4_744_096_852_704_854n })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await popup.getByLabel('Send To').fill('0x2222222222222222222222222222222222222222')
  await popup.getByLabel('ETH amount').fill('0.001234567890123456')
  const amountCard = popup.getByTestId('send-amount-card')
  await expect(amountCard).toContainText('Balance 0.004744 ETH')
  await expect(amountCard.locator('[title^="0.004744096852704854 ETH"]')).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-formatted-main-amount.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  const review = popup.getByRole('dialog')
  await expect(review.getByText('0.001234567890123456', { exact: true })).toBeVisible()
  await expect(review.locator('[title="0.001234567890123456"]')).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-formatted-amount-review.png')
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(popup.getByLabel('ETH amount')).toHaveValue('0.001234567890123456')
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()
  await popup.getByLabel('ETH amount').fill('0.001')
  await expect(popup.getByText('Confidential route', { exact: true })).toHaveCount(0)
  await expect(popup.getByTestId('send-network-fee')).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-formatted-confidential-amount.png')
  expect(rpc.getBroadcastCount()).toBe(0)
})

test('selects the current wallet alternate address in Send in real MV3', async ({
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
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Send ETH on Ethereum' })).toBeVisible()
  await expect(popup.getByRole('button', { name: /^Choose source account/ })).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-asset-selection.png')
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  const addresses = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const account = response?.result?.accounts?.find(
      (item: { active?: unknown }) => item.active === true
    )
    const network = account?.networks?.find(
      (item: { chainId?: unknown }) => item.chainId === 'eip155:1'
    )
    const main = network?.addresses?.find(
      (item: { preferredForReceive?: unknown }) => item.preferredForReceive
    )?.value
    if (typeof main !== 'string' || typeof network?.privateExecutionAddress !== 'string') {
      throw new Error('Ethereum addresses unavailable')
    }
    return { main, private: network.privateExecutionAddress }
  })
  const source = popup.getByRole('button', { name: 'Choose source account, current main' })
  await expect(source).toHaveCount(1)
  await expect(source).not.toContainText('Public')
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-public-from-address.png')
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  const recipients = popup.getByRole('dialog', { name: 'Select Recipient' })
  await expect(recipients.getByText('Current', { exact: true })).toBeVisible()
  await expect(recipients.getByRole('button', { name: /Send to .*Public$/ })).toHaveCount(0)
  const privateRecipient = recipients.getByRole('button', { name: /Send to .*Confidential$/ })
  await expect(privateRecipient).toBeVisible()
  await captureScreenshot(popup, 'send-current-wallet-confidential-recipient.png')
  await privateRecipient.click()
  await expect(popup.getByLabel('Send To')).toHaveValue(addresses.private)
  await source.click()
  const sources = popup.getByRole('dialog', { name: 'Choose source account' })
  await captureScreenshot(popup, 'send-source-address-selector.png')
  await sources.getByRole('radio', { name: /Confidential account/ }).click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toBeVisible()
  await captureScreenshot(popup, 'send-confidential-from-address.png')
  await popup.getByRole('button', { name: 'Select Recipient', exact: true }).click()
  await expect(recipients.getByRole('button', { name: /Send to .*Confidential$/ })).toHaveCount(0)
  await recipients.getByRole('button', { name: /Send to .*Public$/ }).click()
  await expect(popup.getByLabel('Send To')).toHaveValue(addresses.main)
  await expectNoOverflow(popup)
  await popup.getByRole('button', { name: 'Choose source account, current private' }).click()
  await popup.getByRole('button', { name: 'Transfer to Confidential', exact: true }).click()
  const transfer = popup.getByRole('dialog', { name: 'Transfer ETH' })
  await expect(transfer).toBeVisible()
  await expect(transfer.getByRole('button', { name: 'Switch transfer direction' })).toHaveCount(0)
  await captureScreenshot(popup, 'send-topup-transfer-amount.png')
  await transfer.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
  await transfer.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
  await expect(popup.getByRole('heading')).toHaveCount(1)
  await expect(popup.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From asset' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'To asset' })).toHaveCount(0)
  await expect(popup.getByText('Add to Confidential', { exact: true })).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-topup-transfer-review.png')
})
