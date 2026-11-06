import {
  registerProtocolFixtures,
  BUILD_SWAP_URL,
  ETH_ASSET,
  TRIAL_ASSET,
  TRIAL_CONTRACT,
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
import type { Page } from '@playwright/test'
import { recoverTransactionAddress } from 'viem'
import {
  mockUnknownZcashAccountHistory,
  seedSettledZcashBalance
} from '../../helpers/release-default'

registerProtocolFixtures()

async function readStoredShieldPlan(page: Page) {
  return page.evaluate(async () => {
    const values = await chrome.storage.local.get(null)
    const stored = Object.entries(values).find(([key]) =>
      key.startsWith('confidential_funding_plan:')
    )?.[1] as
      | {
          planId: string
          operation: 'deposit' | 'withdraw' | 'cluster' | 'swap'
          phase: string
          network: string
          keyDomainId: string
          accountId: string
          sourceDomain: string
          destinationDomain: string
          source: { amountRaw: string; address: string }
          destination: { address: string }
          signerId: string
          requiresDeposit: boolean
          withdraws: readonly { amountRaw: string }[]
          orderId?: string
        }
      | undefined
    if (!stored) return null
    return {
      planId: stored.planId,
      operation: stored.operation,
      orderId: stored.orderId,
      phase: stored.phase,
      network: stored.network,
      keyDomainId: stored.keyDomainId,
      accountId: stored.accountId,
      sourceDomain: stored.sourceDomain,
      destinationDomain: stored.destinationDomain,
      sourceAmountRaw: stored.source.amountRaw,
      sourceAddress: stored.source.address,
      destinationAddress: stored.destination.address,
      signerId: stored.signerId,
      requiresDeposit: stored.requiresDeposit,
      withdrawCount: stored.withdraws.length,
      withdrawAmounts: stored.withdraws.map(row => row.amountRaw)
    }
  })
}

async function hasStoredShieldBalance(page: Page, amountRaw: string): Promise<boolean> {
  return page.evaluate(async expected => {
    const values = await chrome.storage.local.get(null)
    const snapshot = Object.entries(values).find(([key]) =>
      key.startsWith('confidential_funding_balance:')
    )?.[1] as { balances?: readonly { available: string }[] } | undefined
    return snapshot?.balances?.some(row => row.available === expected) ?? false
  }, amountRaw)
}

async function readShieldTransferIdentity(page: Page) {
  const identity = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const account = response.result.accounts.find((entry: { active: boolean }) => entry.active)
    const ethereum = account.networks.find(
      (entry: { chainId: string }) => entry.chainId === 'eip155:1'
    )
    return {
      walletId: account.walletId as string,
      accountId: account.accountId as string,
      main: ethereum.addresses.find(
        (entry: { preferredForReceive: boolean }) => entry.preferredForReceive
      ).value as string,
      private: ethereum.privateExecutionAddress as string
    }
  })
  expect(identity.main.toLowerCase()).not.toBe(identity.private.toLowerCase())
  return identity
}

async function openShieldEthTransfer(
  page: Page,
  from: 'Public' | 'Private' | 'Shield',
  to: 'Public' | 'Private' | 'Shield',
  cluster = false
) {
  await openNearShieldAction(page, 'Move')
  const initialFrom = await page
    .getByRole('button', { name: /^From: .* Change account$/ })
    .getAttribute('aria-label')
  const initialTo = await page
    .getByRole('button', { name: /^To: .* Change account$/ })
    .getAttribute('aria-label')
  expect(initialFrom?.replace('From:', '')).not.toBe(initialTo?.replace('To:', ''))
  await expect(page.getByRole('button', { name: 'Select transfer asset' })).not.toContainText('ZEC')
  await page.getByRole('button', { name: 'Select transfer asset' }).click()
  const picker = page.getByRole('dialog', { name: 'Select asset' })
  await expect(picker.getByText('ZEC', { exact: true })).toHaveCount(0)
  const eth = picker
    .getByRole('button')
    .filter({ has: page.getByText('ETH', { exact: true }) })
    .filter({ has: page.getByText('Ethereum', { exact: true }) })
  await expect(eth).toHaveCount(1, { timeout: 30_000 })
  await expect(eth.getByText('ETH', { exact: true })).toHaveCount(1)
  await eth.click()
  await page.getByRole('button', { name: /^From: .* Change account$/ }).click()
  await page
    .getByRole('dialog')
    .filter({
      has: page.getByRole('tablist', { name: 'Wallet accounts' })
    })
    .getByRole('button', { name: `Select ${from} ${from === 'Shield' ? 'balance' : 'account'}` })
    .click()
  await page.getByRole('button', { name: /^To: .* Change account$/ }).click()
  await page
    .getByRole('dialog')
    .filter({
      has: page.getByRole('tablist', { name: 'Wallet accounts' })
    })
    .getByRole('button', { name: `Select ${to} ${to === 'Shield' ? 'balance' : 'account'}` })
    .click()
  if (cluster) await page.getByRole('radio', { name: /^Cluster/ }).click()
  const connect = page.getByRole('button', { name: 'Connect Shield' })
  await expect(connect).toBeVisible({ timeout: 30_000 })
  await connect.click()
  await expect(page.getByRole('button', { name: 'Refresh Shield balance' })).toBeVisible({
    timeout: 30_000
  })
}

async function openNearShieldAction(page: Page, action: 'Move' | 'Send' | 'Swap' | 'Receive') {
  await page.getByRole('button', { name: 'Shield Funds' }).click()
  await page.getByRole('button', { name: /NEAR Confidential/ }).click()
  await page.getByRole('button', { name: action, exact: true }).click()
}

async function importNativeOnlyEvmWallet(popup: Page) {
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .getByRole('dialog', { name: 'Accounts' })
    .getByRole('button', { name: 'Accounts', exact: true })
    .click()
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
}

test('ZEC Move locks the current account as the destination in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(150_000)
  await mockUnknownZcashAccountHistory(context)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedSettledZcashBalance(
    popup,
    {
      total: '3',
      transparent: '2',
      shielded: '1',
      spendable: '1',
      available: '1',
      shieldable: '2',
      confirmed: { transparent: '2', shielded: '1' },
      pending: { total: '0', transparent: '0', shielded: '0' }
    },
    { hydrateBackground: true }
  )
  const addresses = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const state = typeof stored === 'string' ? JSON.parse(stored).state : stored?.state
    const account = state?.wallets
      ?.find((wallet: { id?: string }) => wallet.id === state.currentWalletId)
      ?.accounts?.find((entry: { id?: string }) => entry.id === state.currentAccountId)
    const transparent = account?.addresses?.transparent
    const shielded = account?.addresses?.shielded
    if (typeof transparent !== 'string' || typeof shielded !== 'string') {
      throw new Error('Current Zcash account addresses are unavailable')
    }
    return { transparent, shielded }
  })

  for (const [source, destination] of [
    ['Move to Shield', addresses.shielded],
    ['Move to Public', addresses.transparent]
  ] as const) {
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup.getByRole('button', { name: 'Shield Funds' }).click()
    await expect(popup.getByRole('button', { name: /NEAR Confidential/ })).toBeVisible()
    await expect(popup.getByRole('button', { name: /Zcash shield/ })).toBeVisible()
    await popup.getByLabel('Shield actions').getByRole('button', { name: 'Move' }).click()
    await popup
      .getByRole('dialog', { name: 'Move in' })
      .getByRole('button', { name: /Zcash/ })
      .click()
    const sources = popup.getByRole('dialog', { name: 'Move ZEC' })
    await expect(sources.getByRole('button', { name: 'Move to Shield' })).toBeVisible()
    await expect(sources.getByRole('button', { name: 'Move to Public' })).toBeVisible()
    await captureScreenshot(popup, 'shield-zec-move-source-picker.png')
    await sources.getByRole('button', { name: source }).click()
    await expect(popup.getByRole('heading', { name: 'Move', exact: true })).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Choose send source' })).toBeDisabled()
    await expect(popup.locator('#zcash-send-recipient')).toHaveCount(0)
    await expect(popup.locator(`[title="${destination}"]`)).toBeVisible()
    await captureScreenshot(
      popup,
      source === 'Move to Shield'
        ? 'shield-zec-move-to-shield.png'
        : 'shield-zec-move-to-public.png'
    )
  }
})

test('receives an external Shield deposit without spending local funds and restores its address', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const rpc = await mockEvmNetwork(context, { allowBroadcast: false })
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context, { confidentialBalanceRaw: '0' })
  let received = false
  let depositedAmount = '0'
  const depositAddress = '0x2222222222222222222222222222222222222222'
  await context.route(
    url =>
      [
        'https://api.rhea.finance/proxy/1click/v0/status',
        'https://1click.chaindefuser.com/v0/status'
      ].some(endpoint => url.href.startsWith(endpoint)),
    route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: received
            ? 'SUCCESS'
            : depositedAmount === '0'
              ? 'PENDING_DEPOSIT'
              : 'INCOMPLETE_DEPOSIT',
          quoteResponse: { quote: { depositAddress } },
          swapDetails: {
            depositedAmount,
            ...(received ? { amountOut: '10000000000000000' } : {})
          }
        })
      })
  )
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Shield Funds' }).click()
  await expect(popup.getByRole('button', { name: /NEAR Confidential/ })).toBeVisible()
  await expect(popup.getByRole('button', { name: /Zcash shield/ })).toBeVisible()
  const actions = popup.getByLabel('Shield actions')
  for (const action of ['send', 'receive', 'move']) {
    await expect(actions.getByRole('button', { name: action, exact: true })).toBeVisible()
  }
  await captureScreenshot(popup, 'shield-funds-overview-popup.png')
  await actions.getByRole('button', { name: 'receive', exact: true }).click()
  const providers = popup.getByRole('dialog', { name: 'Receive with' })
  await expect(providers.getByRole('button', { name: /NEAR Confidential/ })).toBeVisible()
  await expect(providers.getByRole('button', { name: /Zcash/ })).toBeVisible()
  await captureScreenshot(popup, 'shield-receive-provider-picker-popup.png')
  await providers.getByRole('button', { name: /NEAR Confidential/ }).click()
  await expect(popup.getByRole('heading', { name: 'Receive', exact: true })).toBeVisible()
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await importNativeOnlyEvmWallet(popup)
  const identity = await readShieldTransferIdentity(popup)
  await popup.getByRole('button', { name: 'Shield Funds' }).click()
  await popup.getByRole('button', { name: /NEAR Confidential/ }).click()
  for (const action of ['Send', 'Receive', 'Move', 'Swap']) {
    await expect(popup.getByRole('button', { name: action, exact: true })).toBeVisible()
  }
  await captureScreenshot(popup, 'shield-near-provider-actions-popup.png')
  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await popup.getByRole('button', { name: /Select token/i }).click()
  await popup.getByPlaceholder('Search tokens').fill('ETH')
  await popup.getByRole('button', { name: /^ETH on Ethereum/ }).click()
  await popup.getByLabel('Amount to receive', { exact: true }).fill('0.01')
  await expect(popup.getByLabel('Refund address', { exact: true })).toHaveValue(identity.main)
  const refund = '0x3333333333333333333333333333333333333333'
  await popup.getByLabel('Refund address', { exact: true }).fill(refund)
  await captureScreenshot(popup, 'shield-external-deposit-form.png')
  await popup.getByRole('button', { name: 'Receiving address', exact: true }).click()
  await expect(popup.getByRole('dialog', { name: 'Review receiving address' })).toBeVisible()
  await captureScreenshot(popup, 'shield-external-deposit-review.png')
  await popup.getByRole('button', { name: 'Generate address', exact: true }).click()
  await expect(popup.getByText('Awaiting deposit', { exact: true }).first()).toBeVisible({
    timeout: 60_000
  })
  const quote = api.getQuoteRequests().at(-1)
  expect(quote).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: ETH_ASSET,
    amount: '10000000000000000',
    refundTo: refund,
    dry: false,
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    recipientType: 'CONFIDENTIAL_INTENTS'
  })
  expect(quote?.recipient.toLowerCase()).toBe(identity.main.toLowerCase())
  expect(rpc.getBroadcastCount()).toBe(0)
  expect(api.getConfidentialIntentSubmitCount()).toBe(0)
  const receivingAddress = popup.getByRole('dialog', { name: 'Receiving address' })
  await expect(receivingAddress.getByText(depositAddress, { exact: true })).toBeVisible()
  await expect(receivingAddress.locator('svg[width="164"][height="164"]')).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'shield-external-deposit-address.png')
  await receivingAddress
    .getByRole('button', { name: 'Check deposit status' })
    .scrollIntoViewIfNeeded()
  await expect(receivingAddress.getByText(refund, { exact: true })).toBeInViewport()
  await expect(
    receivingAddress.getByRole('button', { name: 'Check deposit status' })
  ).toBeInViewport()
  await captureScreenshot(popup, 'shield-external-deposit-refund-popup.png')
  const quotesBeforeReload = api.getQuoteRequests().length
  await popup.reload()
  await openNearShieldAction(popup, 'Receive')
  await expect(
    popup
      .getByRole('dialog', { name: 'Receiving address' })
      .getByText(depositAddress, { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  expect(api.getQuoteRequests()).toHaveLength(quotesBeforeReload)
  const sidePanel = await context.newPage()
  await sidePanel.setViewportSize({ width: 480, height: 900 })
  await sidePanel.goto(`chrome-extension://${extensionId}/index.html?surface=side-panel`)
  await openNearShieldAction(sidePanel, 'Receive')
  const sidePanelAddress = sidePanel.getByRole('dialog', { name: 'Receiving address' })
  await expect(sidePanelAddress.getByText(depositAddress, { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(sidePanelAddress.locator('svg[width="164"][height="164"]')).toBeVisible()
  await expect(sidePanelAddress.getByText(refund, { exact: true })).toBeInViewport()
  await expect(
    sidePanelAddress.getByRole('button', { name: 'Check deposit status' })
  ).toBeInViewport()
  await expect
    .poll(() =>
      sidePanel.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 480, contentWidth: 480 })
  await captureScreenshot(sidePanel, 'shield-external-deposit-address-side-panel.png')
  await sidePanel.close()
  expect(api.getQuoteRequests()).toHaveLength(quotesBeforeReload)

  depositedAmount = '5000000000000000'
  await popup.getByRole('button', { name: 'Check deposit status', exact: true }).click()
  await expect(popup.getByText('Remaining', { exact: true })).toBeVisible()
  await expect(popup.getByText('0.005 ETH', { exact: true }).first()).toBeVisible()
  await popup.getByRole('status').getByText('Partial deposit').scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'shield-external-deposit-partial.png')
  received = true
  depositedAmount = '10000000000000000'
  api.setConfidentialBalanceRaw('10000000000000000')
  await popup.getByRole('button', { name: 'Check deposit status', exact: true }).click()
  await expect(popup.getByText('Received', { exact: true }).first()).toBeVisible({
    timeout: 30_000
  })
  await expect.poll(() => hasStoredShieldBalance(popup, '10000000000000000')).toBe(true)
  expect(rpc.getBroadcastCount()).toBe(0)
  expect(api.getConfidentialIntentSubmitCount()).toBe(0)
  await captureScreenshot(popup, 'shield-external-deposit-received.png')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByRole('region', { name: 'Multichain activity' })).toContainText('ETH')
  expect(api.getQuoteRequests()).toHaveLength(quotesBeforeReload)
  expect(rpc.getBroadcastCount()).toBe(0)
  await captureScreenshot(popup, 'shield-external-deposit-activity.png')
  await popup.locator('[data-activity-kind="shield"]').click()
  await expect(popup.locator('[data-activity-status-value]')).toBeVisible()
  await captureScreenshot(popup, 'shield-external-deposit-details.png')

  await popup.clock.install({ time: new Date() })
  const staleDepositId = await popup.evaluate(async () => {
    const values = await chrome.storage.local.get(null)
    const stored = Object.entries(values).find(([key]) =>
      key.startsWith('confidential_external_deposit:')
    )
    if (!stored) throw new Error('External Shield deposit was not persisted')
    const [originalKey, original] = stored as [string, Record<string, unknown>]
    const quote = original.quote as { quote: Record<string, unknown> }
    const depositId = 'synthetic-stale-unfunded'
    const createdAt = Date.now() - 24 * 60 * 60 * 1_000 + 10_000
    const expiresAt = createdAt + 60 * 60 * 1_000
    const stale: Record<string, unknown> = {
      ...original,
      depositId,
      transactionId: `tx:confidential-external:${depositId}`,
      phase: 'awaiting-payment',
      providerStatus: 'PENDING_DEPOSIT',
      depositedAmountRaw: '0',
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      quote: { ...quote, quote: { ...quote.quote, deadline: new Date(expiresAt).toISOString() } }
    }
    delete stale.settledOutputRaw
    delete stale.balanceRefreshedAt
    delete stale.fundingObservedAt
    await chrome.storage.local.remove(originalKey)
    await chrome.storage.local.set({ [`confidential_external_deposit:${depositId}`]: stale })
    return depositId
  })
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await openNearShieldAction(popup, 'Receive')
  const history = popup.getByRole('region', { name: 'Deposit history' })
  await expect(popup.getByRole('dialog', { name: 'Receiving address' })).toBeVisible()
  await popup.keyboard.press('Escape')
  await expect(history.getByText('Quote expired')).toBeVisible()
  await popup.clock.fastForward(20_000)
  await expect(history.getByRole('button', { name: 'Show all' })).toBeVisible()
  await expect(history.getByText('Quote expired')).toHaveCount(0)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await openNearShieldAction(popup, 'Receive')
  await expect(popup.getByRole('dialog', { name: 'Receiving address' })).toHaveCount(0)
  await history.getByRole('button', { name: 'Show all' }).click()
  await expect(history.getByText('Quote expired')).toBeVisible()
  await history.getByRole('button', { name: /ETH.*Quote expired/ }).click()
  await expect(
    popup.getByRole('dialog', { name: 'Receiving address' }).getByRole('button', {
      name: 'Check deposit status'
    })
  ).toBeEnabled()
  await captureScreenshot(popup, 'shield-external-deposit-stale-history.png')

  received = false
  depositedAmount = '5000000000000000'
  await popup.evaluate(async depositId => {
    const key = `confidential_external_deposit:${depositId}`
    const stale = (await chrome.storage.local.get(key))[key] as Record<string, unknown>
    const partialId = 'synthetic-stale-partial'
    await chrome.storage.local.set({
      [`confidential_external_deposit:${partialId}`]: {
        ...stale,
        depositId: partialId,
        transactionId: `tx:confidential-external:${partialId}`,
        depositedAmountRaw: '5000000000000000',
        fundingObservedAt: Date.now() - 24 * 60 * 60 * 1_000,
        providerStatus: 'INCOMPLETE_DEPOSIT'
      }
    })
  }, staleDepositId)
  await popup.keyboard.press('Escape')
  await expect(history.getByText('Partial deposit')).toBeVisible()
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await openNearShieldAction(popup, 'Receive')
  const partialDialog = popup.getByRole('dialog', { name: 'Receiving address' })
  await expect(partialDialog.getByRole('status')).toHaveText('Partial deposit')
  await expect(partialDialog.getByText('Quote expired', { exact: true })).toBeVisible()
  await expect(partialDialog.getByText('0.005 ETH', { exact: true }).first()).toBeVisible()
  await captureScreenshot(popup, 'shield-external-deposit-stale-partial.png')
})

for (const source of ['Public', 'Private'] as const) {
  test(`deposits ${source} ETH into Shield without a withdraw and retains the credited balance`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const rpc = await mockEvmNetwork(context, { allowBroadcast: true })
    await mockBitcoinNetwork(context)
    const api = await mockProtocolApis(context, { confidentialBalanceRaw: '0' })
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
      timeout: 30_000
    })
    const identity = await readShieldTransferIdentity(popup)
    const sourceAddress = source === 'Public' ? identity.main : identity.private

    await openShieldEthTransfer(popup, source, 'Shield')
    await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
    await expect(popup.getByRole('button', { name: 'Move', exact: true })).toBeEnabled()
    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Confirm Move' })).toBeVisible()
    const plan = await readStoredShieldPlan(popup)
    expect(plan).toMatchObject({
      operation: 'deposit',
      phase: 'prepared',
      network: 'mainnet',
      keyDomainId: identity.walletId,
      accountId: identity.accountId,
      sourceDomain: source.toLowerCase(),
      destinationDomain: 'shield',
      sourceAmountRaw: '10000000000000000',
      requiresDeposit: true,
      withdrawCount: 0
    })
    expect(plan?.sourceAddress.toLowerCase() === sourceAddress.toLowerCase()).toBe(true)
    expect(plan?.signerId.toLowerCase() === identity.main.toLowerCase()).toBe(true)
    const quote = api.getQuoteRequests().at(-1)
    expect(quote).toMatchObject({
      originAsset: ETH_ASSET,
      amount: '10000000000000000',
      depositType: 'ORIGIN_CHAIN',
      recipientType: 'CONFIDENTIAL_INTENTS'
    })
    expect(quote?.refundTo.toLowerCase() === sourceAddress.toLowerCase()).toBe(true)
    expect(quote?.recipient.toLowerCase() === identity.main.toLowerCase()).toBe(true)
    expect(
      api
        .getConfidentialAuthSignerIds()
        .every(id => id.toLowerCase() === identity.main.toLowerCase())
    ).toBe(true)
    expect(api.getConfidentialAuthSignerIds().length).toBeGreaterThan(0)
    expect(rpc.getBroadcastCount()).toBe(0)

    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(1)
    const [rawTransaction] = rpc.getBroadcastRawTransactions()
    expect(
      (
        await recoverTransactionAddress({ serializedTransaction: rawTransaction as Hex })
      ).toLowerCase() === sourceAddress.toLowerCase()
    ).toBe(true)
    api.setConfidentialBalanceRaw('10000000000000000')
    await expect
      .poll(async () => (await readStoredShieldPlan(popup))?.phase, {
        timeout: 90_000
      })
      .toBe('ready')
    expect(api.getConfidentialIntentSubmitCount()).toBe(0)
    await expect.poll(() => hasStoredShieldBalance(popup, '10000000000000000')).toBe(true)
    await popup.reload()
    expect(await readStoredShieldPlan(popup)).toMatchObject({
      planId: plan?.planId,
      phase: 'ready',
      withdrawCount: 0
    })
    expect(await hasStoredShieldBalance(popup, '10000000000000000')).toBe(true)
    expect(rpc.getBroadcastCount()).toBe(1)
    expect(api.getConfidentialIntentSubmitCount()).toBe(0)
  })
}

for (const destination of ['Public', 'Private'] as const) {
  test(`withdraws part of an existing Shield ETH balance to ${destination} without an EVM broadcast`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const rpc = await mockEvmNetwork(context, { allowBroadcast: true })
    await mockBitcoinNetwork(context)
    const api = await mockProtocolApis(context, {
      confidentialBalanceRaw: '20000000000000000'
    })
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
      timeout: 30_000
    })
    const identity = await readShieldTransferIdentity(popup)
    const destinationAddress = destination === 'Public' ? identity.main : identity.private

    await openShieldEthTransfer(popup, 'Shield', destination)
    await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
    await expect(popup.getByRole('button', { name: 'Move', exact: true })).toBeEnabled()
    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Confirm Move' })).toBeVisible()
    const plan = await readStoredShieldPlan(popup)
    expect(plan).toMatchObject({
      operation: 'withdraw',
      phase: 'prepared',
      network: 'mainnet',
      keyDomainId: identity.walletId,
      accountId: identity.accountId,
      sourceDomain: 'shield',
      destinationDomain: destination.toLowerCase(),
      sourceAmountRaw: '10000000000000000',
      requiresDeposit: false,
      withdrawCount: 1,
      withdrawAmounts: ['10000000000000000']
    })
    expect(plan?.signerId.toLowerCase() === identity.main.toLowerCase()).toBe(true)
    expect(plan?.destinationAddress.toLowerCase() === destinationAddress.toLowerCase()).toBe(true)
    expect(api.getQuoteRequests().at(-1)).toMatchObject({
      amount: '10000000000000000',
      depositType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN',
      dry: true
    })
    expect(
      api.getQuoteRequests().at(-1)?.recipient.toLowerCase() === destinationAddress.toLowerCase()
    ).toBe(true)
    expect(
      api
        .getConfidentialAuthSignerIds()
        .every(id => id.toLowerCase() === identity.main.toLowerCase())
    ).toBe(true)
    expect(api.getConfidentialAuthSignerIds().length).toBeGreaterThan(0)
    expect(rpc.getBroadcastCount()).toBe(0)

    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    await expect.poll(api.getConfidentialIntentSubmitCount, { timeout: 60_000 }).toBe(1)
    api.setConfidentialBalanceRaw('10000000000000000')
    await expect
      .poll(async () => (await readStoredShieldPlan(popup))?.phase, {
        timeout: 90_000
      })
      .toBe('ready')
    expect(rpc.getBroadcastCount()).toBe(0)
    await expect
      .poll(() => hasStoredShieldBalance(popup, '10000000000000000'), {
        timeout: 30_000
      })
      .toBe(true)
    await popup.reload()
    expect(await readStoredShieldPlan(popup)).toMatchObject({
      planId: plan?.planId,
      phase: 'ready',
      withdrawCount: 1
    })
    expect(await hasStoredShieldBalance(popup, '10000000000000000')).toBe(true)
    expect(api.getConfidentialIntentSubmitCount()).toBe(1)
    expect(rpc.getBroadcastCount()).toBe(0)
  })
}

test('withdraws Shield ETH to an external EVM recipient and restores the settled activity', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const rpc = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context, { confidentialBalanceRaw: '20000000000000000' })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Shield Funds' })).toBeVisible({ timeout: 30_000 })
  const identity = await readShieldTransferIdentity(popup)
  const recipient = '0x3333333333333333333333333333333333333333'
  await openNearShieldAction(popup, 'Send')
  await popup.getByRole('button', { name: 'Connect Shield' }).click()
  await popup.getByRole('textbox', { name: 'Send amount' }).fill('0.01')
  await popup.getByRole('textbox', { name: 'Recipient address' }).fill(recipient)
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Confirm Send' })).toBeVisible()
  const plan = await readStoredShieldPlan(popup)
  expect(plan).toMatchObject({
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    sourceAmountRaw: '10000000000000000',
    destinationAddress: recipient,
    withdrawCount: 1
  })
  expect(plan?.signerId.toLowerCase()).toBe(identity.main.toLowerCase())
  expect(api.getQuoteRequests().at(-1)).toMatchObject({
    depositType: 'CONFIDENTIAL_INTENTS',
    recipientType: 'DESTINATION_CHAIN',
    recipient,
    dry: true
  })
  await captureScreenshot(popup, 'shield-external-withdraw-review.png')
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(api.getConfidentialIntentSubmitCount, { timeout: 60_000 }).toBe(1)
  api.setConfidentialBalanceRaw('10000000000000000')
  await expect
    .poll(async () => (await readStoredShieldPlan(popup))?.phase, { timeout: 90_000 })
    .toBe('ready')
  expect(rpc.getBroadcastCount()).toBe(0)
  await popup.reload()
  expect(await readStoredShieldPlan(popup)).toMatchObject({
    planId: plan?.planId,
    operation: 'withdraw',
    destinationAddress: recipient,
    phase: 'ready'
  })
  expect(api.getConfidentialIntentSubmitCount()).toBe(1)
})

test('swaps a Shield-only holding to Shield USDC without adding a Public asset and restores the settled activity', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const rpc = await mockEvmNetwork(context, {
    allowBroadcast: true,
    zeroBalanceTokenContracts: [TRIAL_CONTRACT]
  })
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context, {
    confidentialBalanceRaw: '20000000000000000',
    confidentialAssetId: TRIAL_ASSET
  })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Shield Funds' })).toBeVisible({ timeout: 30_000 })
  const identity = await readShieldTransferIdentity(popup)
  await openNearShieldAction(popup, 'Swap')
  await popup.getByRole('button', { name: 'Connect Shield' }).click()
  const publicAssetIds = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'read' })
    if (response?.error) throw new Error('Portfolio read failed')
    return response.result.model.assets.map((asset: { asset: { id: string } }) => asset.asset.id)
  })
  expect(publicAssetIds.some((assetId: string) => assetId.includes(TRIAL_CONTRACT))).toBe(false)
  await expect(popup.getByRole('button', { name: 'Select source Shield token' })).toContainText(
    'TRIAL'
  )
  await popup.getByRole('button', { name: 'Select destination Shield token' }).click()
  const picker = popup.getByRole('dialog', { name: 'Select token' })
  await picker
    .getByRole('button')
    .filter({ hasText: 'USDC' })
    .filter({ hasText: 'Ethereum' })
    .first()
    .click()
  await popup.getByRole('textbox', { name: 'Shield swap amount' }).fill('0.01')
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Confirm Swap' })).toBeVisible()
  await expect(
    popup.getByText('Minimum receive', { exact: true }).locator('..').getByText('0.01 USDC')
  ).toBeVisible()
  const plan = await readStoredShieldPlan(popup)
  expect(plan).toMatchObject({
    operation: 'swap',
    sourceDomain: 'shield',
    destinationDomain: 'shield',
    sourceAmountRaw: '10000000000000000',
    withdrawCount: 1
  })
  expect(plan?.sourceAddress.toLowerCase()).toBe(identity.main.toLowerCase())
  expect(plan?.destinationAddress.toLowerCase()).toBe(identity.main.toLowerCase())
  expect(api.getQuoteRequests().at(-1)).toMatchObject({
    originAsset: TRIAL_ASSET,
    recipientType: 'CONFIDENTIAL_INTENTS',
    depositType: 'CONFIDENTIAL_INTENTS',
    refundType: 'CONFIDENTIAL_INTENTS',
    recipient: identity.main.toLowerCase(),
    dry: false
  })
  await captureScreenshot(popup, 'shield-internal-swap-review.png')
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(api.getConfidentialIntentSubmitCount, { timeout: 60_000 }).toBe(1)
  await expect
    .poll(async () => (await readStoredShieldPlan(popup))?.phase, { timeout: 90_000 })
    .toBe('ready')
  expect(rpc.getBroadcastCount()).toBe(0)
  await popup.reload()
  expect(await readStoredShieldPlan(popup)).toMatchObject({
    planId: plan?.planId,
    operation: 'swap',
    phase: 'ready'
  })
  expect(api.getConfidentialIntentSubmitCount()).toBe(1)
  await popup.getByRole('button', { name: 'Shield Funds' }).click()
  await captureScreenshot(popup, 'shield-independent-funds.png')
  await popup.getByRole('button', { name: /NEAR Confidential/ }).click()
  await expect(popup.getByText('TRIAL', { exact: true })).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'shield-independent-holdings.png')
  const publicAssetState = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'read' })
    if (response?.error) throw new Error('Portfolio read failed')
    return {
      ids: response.result.model.assets.map((asset: { asset: { id: string } }) => asset.asset.id),
      userAssets: response.result.userAssets
    }
  })
  expect(publicAssetState.ids.some((assetId: string) => assetId.includes(TRIAL_CONTRACT))).toBe(
    false
  )
  expect(JSON.stringify(publicAssetState.userAssets)).not.toContain(TRIAL_CONTRACT)
})

for (const source of ['Public', 'Shield'] as const) {
  test(`submits ${source} Cluster as one scheduled batch to one destination and restores its completion`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const rpc = await mockEvmNetwork(context, { allowBroadcast: true })
    await mockBitcoinNetwork(context)
    const api = await mockProtocolApis(context, {
      confidentialBalanceRaw: source === 'Shield' ? '20000000000000000' : '0'
    })
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
      timeout: 30_000
    })
    const identity = await readShieldTransferIdentity(popup)
    const destination = source === 'Public' ? 'Private' : 'Public'
    const destinationAddress = destination === 'Private' ? identity.private : identity.main
    await openShieldEthTransfer(popup, source, destination, true)
    await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
    await popup.getByRole('button', { name: 'Review Cluster', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Cluster transfer' })).toBeVisible()
    const plan = await readStoredShieldPlan(popup)
    expect(plan).toMatchObject({
      operation: 'cluster',
      phase: 'prepared',
      withdrawCount: 3,
      sourceDomain: source.toLowerCase(),
      destinationDomain: destination.toLowerCase(),
      requiresDeposit: source !== 'Shield'
    })
    await captureScreenshot(popup, `cluster-${source.toLowerCase()}-review.png`)
    await popup.getByRole('button', { name: 'Confirm Cluster', exact: true }).click()
    if (source === 'Public') {
      await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(1)
      api.setConfidentialBalanceRaw('10000000000000000')
    }
    await expect.poll(() => api.getConfidentialBatchRequests().length, { timeout: 60_000 }).toBe(1)
    const [batch] = api.getConfidentialBatchRequests()
    expect(batch.withdraws).toHaveLength(3)
    expect(batch.signer_id.toLowerCase()).toBe(identity.main.toLowerCase())
    expect(new Set(batch.withdraws.map(row => row.destination_address.toLowerCase()))).toEqual(
      new Set([destinationAddress.toLowerCase()])
    )
    expect(new Set(batch.withdraws.map(row => row.deposit_address)).size).toBe(3)
    expect(batch.withdraws.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(
      10000000000000000n
    )
    for (const row of batch.withdraws) {
      const payload = JSON.parse(row.signed_payload.payload)
      expect(payload.signer_id.toLowerCase()).toBe(identity.main.toLowerCase())
      expect(payload.intents[0].receiver_id).toBe(row.deposit_address)
      expect(row.signed_payload.signature).toMatch(/^secp256k1:/)
    }
    await expect
      .poll(async () => (await readStoredShieldPlan(popup))?.orderId)
      .toBe('protocol-cluster-1')
    expect((await readStoredShieldPlan(popup))?.phase).not.toBe('ready')
    await captureScreenshot(popup, `cluster-${source.toLowerCase()}-scheduled.png`)
    await popup.reload()
    expect(api.getConfidentialBatchRequests()).toHaveLength(1)
    api.setConfidentialBalanceRaw(source === 'Shield' ? '10000000000000000' : '0')
    api.setConfidentialBatchCompleted()
    await expect
      .poll(
        async () => {
          await popup.evaluate(
            async planId =>
              chrome.runtime.sendMessage({ type: 'GET_CONFIDENTIAL_FUNDING', planId }),
            plan!.planId
          )
          return (await readStoredShieldPlan(popup))?.phase
        },
        { timeout: 90_000 }
      )
      .toBe('ready')
    expect(api.getConfidentialBatchRequests()).toHaveLength(1)
    expect(rpc.getBroadcastCount()).toBe(source === 'Public' ? 1 : 0)
    await expect
      .poll(() => hasStoredShieldBalance(popup, source === 'Shield' ? '10000000000000000' : '0'), {
        timeout: 30_000
      })
      .toBe(true)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await popup.getByRole('tab', { name: 'Activity', exact: true }).click()
    await popup.locator(`[data-activity-id="tx:confidential:${plan!.planId}"]`).click()
    await expect(popup.locator('[data-activity-status-value]')).toHaveText('Received', {
      timeout: 30_000
    })
    await captureScreenshot(popup, `cluster-${source.toLowerCase()}-completed.png`)
  })
}

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
  await popup.getByRole('radio', { name: 'Private mode' }).click()
  await expect(popup.getByRole('radio', { name: 'Private mode' })).toBeChecked()
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
  const approval = await Promise.race([
    approvalPromise,
    transactionPromise.then(result => {
      throw new Error(`Private transfer finished before review: ${JSON.stringify(result)}`)
    })
  ])
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByRole('heading', { name: 'Confidential transfer' })).toBeVisible({
    timeout: 30_000
  })
  await expect(approval.getByText('Confidential → Intents → Recipient')).toBeVisible()
  await expect(approval.getByText('Minimum received', { exact: true })).toBeVisible()
  await approval.getByRole('button', { name: 'Show full ETH amount' }).first().click()
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

test('routes a Private EVM Send selection to Move before any signing', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
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
    .getByRole('radio', { name: /Private account/ })
    .click()
  await expect(popup.getByRole('heading', { name: 'Move', exact: true })).toBeVisible()
  await expect(popup.getByRole('textbox', { name: 'Transfer amount' })).toBeVisible()
  expect(protocolApis.getQuoteRequests()).toHaveLength(0)
  expect(evmNetwork.getBroadcastCount()).toBe(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'private-send-routes-to-move.png')
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
    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Move', exact: true })).toBeVisible()
    const amount = popup.getByRole('textbox', { name: 'Transfer amount' })
    const review = popup.getByRole('button', { name: 'Transfer', exact: true })
    await expect(review).toBeDisabled()
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await amount.fill('0.')
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await amount.fill('0.01')
    await expect(review).toBeDisabled()
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await captureScreenshot(popup, 'balance-transfer-route-loading.png')
    releaseCatalog()
    await expect(review).toBeEnabled()
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await amount.fill('999')
    await expect(popup.getByRole('alert')).toContainText('Amount exceeds')
    await expect(review).toBeDisabled()
    await amount.fill('0.01')
    await expect(popup.getByRole('alert')).toHaveCount(0)
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
    await popup.getByRole('button', { name: 'Move', exact: true }).click()
    if (direction === 'private-to-main')
      await popup.getByRole('button', { name: 'Switch transfer direction' }).click()
    const sourceAccount = popup.getByRole('button', {
      name: `From: ${direction === 'main-to-private' ? 'Public' : 'Private'}. Change account`
    })
    await expect(sourceAccount).toBeVisible()
    await expect(sourceAccount.locator('..')).toContainText('0.002976', { timeout: 30_000 })
    const amount = popup.getByRole('textbox', { name: 'Transfer amount' })
    await amount.fill('0.002976040456329')
    const maxButton = popup.getByRole('button', { name: 'Max', exact: true })
    if (direction === 'main-to-private') {
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
      try {
        await maxButton.click()
        await expect.poll(() => probeStarted).toBe(true)
        const switchDirection = popup.getByRole('button', { name: 'Switch transfer direction' })
        await switchDirection.click()
        await switchDirection.click()
        await expect(amount).toHaveValue('')
      } finally {
        releaseProbe()
      }
      await expect(maxButton).toBeEnabled()
    }
    await maxButton.click()
    await expect(amount).toHaveValue('0.002301040456329', {
      timeout: 30_000
    })
    await expectNoOverflow(popup)
    await captureScreenshot(
      popup,
      direction === 'main-to-private'
        ? 'transfer-native-max-main-to-private-available.png'
        : 'transfer-native-max-private-to-main-available.png'
    )
    await popup.getByRole('button', { name: 'Transfer', exact: true }).click()
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

test('sends Public funds privately through Confidential without retaining Shield funds', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const rpc = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  const api = await mockProtocolApis(context, { orderStatus: 'pending' })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const identity = await readShieldTransferIdentity(popup)
  rpc.setAddressBalanceRaw(identity.private, 0n)
  const recipient = '0x2222222222222222222222222222222222222222'

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum' }).click()
  await popup.getByLabel('Send To').fill(recipient)
  await popup.getByLabel('ETH amount').fill('0.01')
  await popup.getByRole('switch', { name: 'Send privately' }).click()
  await expect(popup.getByRole('button', { name: 'Use NEAR Confidential Intents' })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Use NEAR Confidential Intents' }).click()
  await expect(popup.getByRole('switch', { name: 'Send privately' })).toBeChecked()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'public-send-privately-input.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
    timeout: 60_000
  })
  expect(api.getQuoteRequests().at(-1)).toMatchObject({
    originAsset: ETH_ASSET,
    destinationAsset: ETH_ASSET,
    amount: '10000000000000000',
    recipient,
    confidentiality: 'basic'
  })
  expect(api.getQuoteRequests().at(-1)?.refundTo.toLowerCase()).toBe(identity.main.toLowerCase())
  await expect(popup.getByText('NEAR Confidential', { exact: true })).toBeVisible()
  expect(rpc.getBroadcastCount()).toBe(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'public-send-privately-review.png')

  // Returning from review must preserve the reviewed route instead of silently using a public send.
  await popup.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(popup.getByLabel('ETH amount', { exact: true })).toHaveValue('0.01')
  await expect(popup.getByLabel('Send To')).toHaveValue(recipient)
  await expect(popup.getByRole('switch', { name: 'Send privately' })).toBeChecked()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(1)
  const raw = rpc.getBroadcastRawTransactions()[0] as Hex
  expect((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase()).toBe(
    identity.main.toLowerCase()
  )
  expect(parseTransaction(raw).to?.toLowerCase()).toBe('0x4444444444444444444444444444444444444444')
  expect(await readStoredShieldPlan(popup)).toBeNull()
  await captureScreenshot(popup, 'public-send-privately-progress.png')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.locator('[data-activity-kind="transfer"]')).toHaveCount(1)
  expect(rpc.getBroadcastCount()).toBe(1)
  await captureScreenshot(popup, 'public-send-privately-activity.png')
})

test('blocks a Public send to the owned Private address and allows cancellation of an external send', async ({
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
  await expect(popup.getByText('Use Move to transfer to your Private account.')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  expect(rpc.getBroadcastCount()).toBe(0)
  await popup.getByLabel('Send To').fill('0x9C73842d02D1Fe00000000000000000000000000')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await popup.getByRole('button', { name: 'Send anyway', exact: true }).click()
  await expect.poll(rpc.getBroadcastCount, { timeout: 30_000 }).toBe(1)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const row = popup.getByRole('button', { name: 'View Sent USDC details' })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).not.toHaveAttribute('data-activity-account-mode', 'private')
  await captureScreenshot(popup, 'main-usdc-external-public-activity.png')
  await row.click()
  await popup.getByRole('button', { name: 'Cancel transaction' }).click()
  await expect(
    popup.getByRole('dialog', { name: 'Cancel transaction' }).last().getByText('Nonce', {
      exact: true
    })
  ).toBeVisible()
  expect(rpc.getBroadcastCount()).toBe(1)
  await captureScreenshot(popup, 'main-usdc-external-cancel-review.png')
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
  await captureScreenshot(popup, 'main-usdc-external-cancel-submitted.png')
})

test('deducts native gas from Available and Max in Public Send', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpc = await mockEvmNetwork(context, {
    allowBroadcast: false,
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
  const amountMax = popup.getByTestId('send-amount-card').getByRole('button', { name: 'Max' })
  await expect(amountMax).toBeEnabled({
    timeout: 30_000
  })
  await amountMax.click()
  await expect(popup.getByLabel('ETH amount')).toHaveValue('0.002897290456329', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('send-amount-card')).toContainText('Available 0.002897 ETH')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-native-max-main-available.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(
    popup
      .getByRole('dialog', { name: 'Sending' })
      .getByRole('button', { name: 'Send anyway', exact: true })
  ).toBeEnabled({ timeout: 30_000 })
  expect(rpc.getBroadcastCount()).toBe(0)
  await captureScreenshot(popup, 'send-native-max-main-review.png')
})

test('reviews and submits Public to Private from AssetDetail Move', async ({
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
  await expect(popup.getByTestId('home-total-assets')).toContainText('$')
  await popup.getByRole('button', { name: 'Asset category: Total assets' }).click()
  const categories = popup.getByRole('radiogroup', { name: 'Asset category' })
  for (const domain of ['Public', 'Shield', 'Private']) {
    await expect(
      categories.getByRole('radio', { name: new RegExp(`${domain} assets`) })
    ).toContainText('—')
  }
  await captureScreenshot(popup, 'home-total-assets-amount.png')
  await popup.keyboard.press('Escape')
  await popup.getByRole('button', { name: 'View ETH details on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'From: Public. Change account' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'To: Private. Change account' })).toBeVisible()
  await captureScreenshot(popup, 'balance-transfer-public-confidential-addresses.png')
  await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
  await expect(popup.getByRole('button', { name: 'Transfer', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Transfer', exact: true }).click()

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
  await expect(popup.getByText('Private', { exact: true })).toBeVisible()
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
  await expect(accountTransferRow).toContainText('Public → Private')
  await expect(
    accountTransferRow.locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
  ).toHaveCount(1)
  const transferIconLeft = await accountTransferRow
    .locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
    .evaluate(icon => icon.getBoundingClientRect().left)
  const transferRowLeft = await accountTransferRow.evaluate(row => row.getBoundingClientRect().left)
  expect(transferIconLeft - transferRowLeft).toBe(16)
  await expect(popup.getByRole('button', { name: /^View Sent ETH/ })).toHaveCount(0)
  await captureScreenshot(popup, 'activity-public-to-confidential-transfer.png')
})

test('reviews and submits Private to Public from AssetDetail Move', async ({
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
  await popup.getByRole('button', { name: 'Move', exact: true }).click()
  await popup.getByRole('button', { name: 'Switch transfer direction' }).click()
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'To: Public. Change account' })).toBeVisible()
  await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.01')
  await expect(popup.getByRole('button', { name: 'Transfer', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Transfer', exact: true }).click()

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
  await expect(popup.getByText('Private', { exact: true })).toBeVisible()
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
  await popup.getByRole('radio', { name: 'Private mode' }).click()
  await expect(popup.getByRole('radio', { name: 'Private mode' })).toBeChecked()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const accountTransferRow = popup.locator('[data-activity-kind="transfer"]')
  await expect(accountTransferRow).toHaveCount(1)
  await expect(accountTransferRow).toContainText('Account Transfer')
  await expect(accountTransferRow).toContainText('Private → Public')
  await expect(
    accountTransferRow.locator('[data-activity-avatar="swap"] [data-slot="token-icon"]')
  ).toHaveCount(1)
  await expect(popup.getByRole('button', { name: /^View Sent ETH/ })).toHaveCount(0)
  await captureScreenshot(popup, 'activity-confidential-to-public-transfer.png')
  const privateRow = popup.locator('[data-activity-account-mode="private"]').first()
  await expect(privateRow).toBeVisible()
  const privateIcon = privateRow.locator('[aria-label="Private"]')
  await expect(privateIcon).toBeVisible()
  await expect(privateIcon).toHaveText('')
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'activity-confidential-icon.png')
  await privateIcon.hover()
  await expect(popup.getByRole('tooltip')).toContainText('Private')
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
  await expect(popup.getByText('Ethereum', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'cross-chain-send-network-entry.png')
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send route, current Cross-chain' })).toBeVisible()
  await expect(popup.getByRole('dialog', { name: 'Select network' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinations = popup.getByRole('dialog', { name: 'Select network' })
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
  await popup.getByRole('button', { name: 'Choose receive account' }).click()
  const receiveAt = popup.getByRole('dialog', { name: 'Receive at' })
  await receiveAt.locator('input[id^="swap-recipient"]').fill(externalRecipient)
  await receiveAt.getByRole('button', { name: 'Done' }).click()
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
  const recipientAddress = popup.locator('span[title^="0x"]', { hasText: externalRecipient })
  await recipientAddress.scrollIntoViewIfNeeded()
  await expect(recipientAddress).toBeVisible()
  const recipientBounds = await recipientAddress.boundingBox()
  const footerBounds = await popup.locator('.page-footer').boundingBox()
  if (!recipientBounds) throw new Error('Recipient address is missing from the review')
  if (!footerBounds) throw new Error('Review footer is missing')
  expect(recipientBounds.y + recipientBounds.height).toBeLessThanOrEqual(footerBounds.y)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'cross-chain-send-review.png')

  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Send route, current Cross-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'On-chain' }).click()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send route, current On-chain' })).toBeVisible()
  await expect(popup.getByText('Ethereum', { exact: true })).toBeVisible()
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

  await importNativeOnlyEvmWallet(popup)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send USDC on Ethereum' }).click()
  await popup.getByRole('button', { name: 'Send route, current On-chain' }).click()
  await popup.getByRole('menuitemradio', { name: 'Cross-chain' }).click()
  await popup.getByRole('button', { name: 'To asset' }).click()
  const destinations = popup.getByRole('dialog', { name: 'Select network' })
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
  await expect(popup.getByText('Ethereum', { exact: true })).toBeVisible()
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
  const destinations = popup.getByRole('dialog', { name: 'Select network' })
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
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-formatted-main-amount.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  const review = popup.getByRole('dialog')
  await review.getByRole('button', { name: 'Show full ETH amount' }).first().click()
  await expect(popup.getByText('0.001234567890123456', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Copy exact amount' })).toBeVisible()
  await expect(review.locator('[title="0.001234567890123456"]')).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-formatted-amount-review.png')
  await popup.keyboard.press('Escape')
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(popup.getByLabel('ETH amount')).toHaveValue('0.001234567890123456')
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Private account/ })
    .click()
  await expect(popup.getByRole('heading', { name: 'Move', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await popup.getByRole('textbox', { name: 'Transfer amount' }).fill('0.001')
  await expect(popup.getByText('Confidential route', { exact: true })).toHaveCount(0)
  await expect(popup.getByTestId('send-network-fee')).toHaveCount(0)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-private-source-routes-to-move.png')
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
  await expect(source).toContainText('Public')
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
  await sources.getByRole('radio', { name: /Private account/ }).click()
  await expect(popup.getByRole('heading', { name: 'Move', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'From: Private. Change account' })).toBeVisible()
  await expect(popup.locator(`[title="${addresses.private}"]`)).toBeVisible()
  await popup.getByRole('button', { name: 'To: Shield. Change account' }).click()
  await popup
    .getByRole('dialog')
    .filter({ has: popup.getByRole('tablist', { name: 'Wallet accounts' }) })
    .getByRole('button', { name: 'Select Public account' })
    .click()
  await expect(popup.getByRole('button', { name: 'To: Public. Change account' })).toBeVisible()
  await expect(popup.locator(`[title="${addresses.main}"]`)).toBeVisible()
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'send-private-source-move-public-address.png')
})
