import {
  registerProtocolFixtures,
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
import { seedFreshAssetPrices, seedSettledZcashBalance } from '../../helpers/release-default'

registerProtocolFixtures()

test('keeps Home totals account-scoped without querying Lending positions', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  const queriedWallets: string[] = []
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, {
    mcaByWallet: wallet => {
      queriedWallets.push(JSON.stringify(wallet))
      return 'rhea00000x.multica.near'
    }
  })
  await context.unroute('https://assets.zknoir.com/**')
  await context.unroute('https://assets-cdn.trustwallet.com/**')
  await context.unroute('https://coin-images.coingecko.com/**')
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const importEvmAccount = (digit: number) =>
    popup.evaluate(async keyDigit => {
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_PRIVATE_KEY_WALLET',
        privateKey: `0x${'00'.repeat(31)}0${keyDigit}`,
        chainFamily: 'eip155',
        displayName: `EVM ${keyDigit}`
      })
      if (response.success !== true) throw new Error('Synthetic EVM import failed')
      return { walletId: response.result.keyDomainId, accountId: response.result.accountId }
    }, digit)
  const unlockIfNeeded = async () => {
    if (await popup.getByPlaceholder('Enter Password').isVisible()) {
      await popup.getByPlaceholder('Enter Password').fill('protocol-wallet-source-password')
      await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
    }
    await expect(popup.getByRole('tab', { name: 'Activity', exact: true })).toBeVisible({
      timeout: 30_000
    })
  }
  const homeTotal = async () => {
    const total = popup.getByTestId('home-total-assets')
    await expect(total).toContainText('$', { timeout: 30_000 })
    return await total.innerText()
  }

  const first = await importEvmAccount(1)
  await unlockIfNeeded()
  const emptyTotal = await homeTotal()
  await importEvmAccount(2)
  await unlockIfNeeded()
  await expect.poll(homeTotal, { timeout: 30_000 }).toBe(emptyTotal)
  await popup.getByRole('button', { name: 'Portfolio options' }).click()
  await popup.getByRole('menuitem', { name: 'Refresh list' }).click()
  await expect.poll(homeTotal).toBe(emptyTotal)

  await popup.evaluate(async scope => {
    const local = await chrome.storage.local.get('account_data')
    const stored = local.account_data
    const accountData = typeof stored === 'string' ? JSON.parse(stored) : stored
    const key = `mainnet_${scope.walletId}_${scope.accountId}`
    const next = {
      ...accountData,
      state: {
        ...accountData.state,
        portfolioValues: {
          ...(accountData.state.portfolioValues ?? {}),
          [key]: { totalUsd: '3750', updatedAt: Date.now(), complete: true }
        }
      }
    }
    await chrome.storage.local.set({
      account_data: typeof stored === 'string' ? JSON.stringify(next) : next
    })
  }, first)
  await popup.reload()
  await unlockIfNeeded()
  await expect.poll(homeTotal).toBe(emptyTotal)
  await popup.waitForFunction(() => Array.from(document.images).every(image => image.complete))
  await captureScreenshot(popup, 'protocol-wallet-home-without-lending.png')
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .getByRole('dialog', { name: 'Accounts' })
    .getByRole('button', { name: 'Accounts' })
    .click()
  const importedAccounts = popup.getByRole('region', {
    name: 'Wallet group Imported Private Key'
  })
  await expect(importedAccounts.getByRole('button', { name: 'Switch to Account 1' })).toHaveCount(2)
  await expect(importedAccounts.getByText('—', { exact: true })).toBeVisible()
  await expect(popup.getByText('$3,750.00', { exact: true })).toHaveCount(0)
  await popup.waitForFunction(() => Array.from(document.images).every(image => image.complete))
  await captureScreenshot(popup, 'protocol-wallet-accounts-without-lending.png')
  await popup.goto(new URL('/index.html', popup.url()).toString())

  await expect(
    popup.evaluate(scope => chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', ...scope }), first)
  ).resolves.toMatchObject({ success: true })
  await unlockIfNeeded()
  await expect.poll(homeTotal).toBe(emptyTotal)
  expect(queriedWallets).toEqual([])
  await expectNoOverflow(popup)
})

test('ignores Lending holdings on Home and retires the old tab route', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const queriedWallets: string[] = []
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, {
    mcaByWallet: wallet => {
      queriedWallets.push(JSON.stringify(wallet))
      return 'rhea00000x.multica.near'
    }
  })
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
  await popup.reload()
  await expect(popup.getByRole('button', { name: 'View ETH details on Ethereum' })).toBeVisible({
    timeout: 30_000
  })
  const homeTotal = popup.getByTestId('home-total-assets')
  await expect(homeTotal).toContainText('$')
  const beforeRefresh = await homeTotal.innerText()
  await popup.getByRole('button', { name: 'Portfolio options' }).click()
  await popup.getByRole('menuitem', { name: 'Refresh list' }).click()
  await expect(homeTotal).toHaveText(beforeRefresh)
  expect(queriedWallets).toEqual([])
  await expect(popup.getByRole('tab', { name: 'Lending', exact: true })).toHaveCount(0)
  await expectNoOverflow(popup)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .getByRole('dialog', { name: 'Accounts' })
    .getByRole('button', { name: 'Accounts' })
    .click()
  await expect(popup.getByRole('heading', { name: 'Accounts' })).toBeVisible()
  await popup.goto(`chrome-extension://${extensionId}/index.html?tab=lending`)
  await expect(popup.getByRole('tab', { name: 'Total assets', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await popup.getByRole('radio', { name: 'Private mode' }).click()
  await expect(popup.getByRole('radio', { name: 'Private mode' })).toBeChecked()
  await expect(popup.getByRole('tab', { name: 'Lending', exact: true })).toHaveCount(0)
  expect(queriedWallets).toEqual([])
})
