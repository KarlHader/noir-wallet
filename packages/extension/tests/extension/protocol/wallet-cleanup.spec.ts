import {
  expect,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/extension-fixtures'
import { importTestWallet, registerProtocolFixtures } from '../../helpers/protocol-wallet'

const TEST_MNEMONIC = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'protocol-wallet-source-password'
const TEST_PRIVATE_KEY = `0x${'00'.repeat(31)}01`

test.describe('authenticated wallet removal', () => {
  registerProtocolFixtures()

  test('protects the final wallet and removes a verified software wallet beside a private-key wallet', async ({
    popup
  }, testInfo) => {
    test.setTimeout(240_000)
    await waitForBackgroundWalletInitialization(popup)
    await importTestWallet(popup)
    await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })

    const finalWalletResponses = await popup.evaluate(
      async verification => {
        const catalog = (await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })).result
        const account = catalog?.accounts?.[0]
        if (!account) throw new Error('Imported wallet is missing')
        const removeAccount = await chrome.runtime.sendMessage({
          type: 'REMOVE_ACCOUNT',
          walletId: account.walletId,
          accountId: account.accountId,
          verification
        })
        const removeWallet = await chrome.runtime.sendMessage({
          type: 'REMOVE_WALLET',
          walletId: account.walletId,
          verification
        })
        return { removeAccount, removeWallet }
      },
      { wordIndices: [0, 23], words: [TEST_MNEMONIC.split(' ')[0], TEST_MNEMONIC.split(' ')[23]] }
    )
    expect(finalWalletResponses.removeAccount).toMatchObject({
      error: 'Cannot remove the last wallet. Use Reset Wallet instead.'
    })
    expect(finalWalletResponses.removeWallet).toMatchObject({
      error: 'Cannot remove the last wallet. Use Reset Wallet instead.'
    })

    await popup.getByRole('button', { name: 'Choose wallet' }).click()
    await popup
      .getByRole('dialog', { name: 'Accounts' })
      .getByRole('button', { name: 'Accounts', exact: true })
      .click()
    await popup.getByRole('button', { name: 'Account actions for Account 1' }).click()
    await popup.getByRole('menuitem', { name: 'Account details' }).click()
    await popup.getByRole('button', { name: 'Delete Account' }).click()
    await expect(popup.getByRole('dialog', { name: 'Remove wallet' })).toHaveCount(0)
    const finalWalletAlert = popup.getByRole('dialog', { name: 'Unable to remove wallet' })
    await expect(finalWalletAlert).toContainText(
      'Cannot remove the last wallet. Use Reset Wallet instead.'
    )
    if (process.env.E2E_SCREENSHOTS === '1') {
      await finalWalletAlert.screenshot({ path: testInfo.outputPath('final-wallet-protected.png') })
    }
    await popup.getByRole('button', { name: 'OK' }).click()
    await popup.getByRole('button', { name: 'Back' }).click()

    await popup.getByRole('button', { name: 'Add Wallet', exact: true }).click()
    await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
    await popup.getByRole('button', { name: 'Private Key', exact: true }).click()
    await popup.getByLabel('Wallet name').fill('Independent EVM wallet')
    await popup.getByLabel('Private key', { exact: true }).fill(TEST_PRIVATE_KEY)
    await popup.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(popup.getByText('EVM address preview', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })

    const before = await popup.evaluate(async () => {
      const catalog = (await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })).result
      const accounts = catalog?.accounts ?? []
      return {
        softwareWalletId: accounts.find(
          (account: { walletSource: { kind: string } }) => account.walletSource.kind === 'software'
        )?.walletId as string | undefined,
        privateWalletId: accounts.find(
          (account: { walletSource: { kind: string } }) =>
            account.walletSource.kind === 'private-key'
        )?.walletId as string | undefined
      }
    })
    expect(before.softwareWalletId).toBeTruthy()
    expect(before.privateWalletId).toBeTruthy()

    await popup.getByRole('button', { name: 'Choose wallet' }).click()
    await popup
      .getByRole('dialog', { name: 'Accounts' })
      .getByRole('button', { name: 'Accounts', exact: true })
      .click()
    const softwareGroup = popup.locator('section[aria-label^="Wallet group "]').first()
    await softwareGroup.getByRole('button', { name: 'Account actions for Account 1' }).click()
    await popup.getByRole('menuitem', { name: 'Account details' }).click()
    await popup.getByRole('button', { name: 'Delete Account' }).click()
    const removal = popup.getByRole('dialog', { name: 'Remove wallet' })
    await expect(removal).toBeVisible()
    const wordLabels = removal.locator('label').filter({ hasText: /^Word \d+/ })
    await expect(wordLabels).toHaveCount(2)
    for (const label of await wordLabels.all()) {
      const index = Number((await label.textContent())?.match(/Word (\d+)/)?.[1])
      expect(index).toBeGreaterThan(0)
      await label.locator('input').fill(TEST_MNEMONIC.split(' ')[index - 1])
    }
    await removal.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(removal).toHaveCount(0, { timeout: 60_000 })

    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
    await popup.reload()
    await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
    await popup.getByPlaceholder('Enter Password').fill(TEST_PASSWORD)
    await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
    const after = await popup.evaluate(async () => {
      const catalog = (await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })).result
      const saved = (await chrome.storage.local.get('wallet_state')).wallet_state
      const state = typeof saved === 'string' ? JSON.parse(saved).state : saved?.state
      return {
        walletIds: [
          ...new Set(
            (catalog?.accounts ?? []).map((account: { walletId: string }) => account.walletId)
          )
        ],
        legacyWalletCount: state?.wallets?.length ?? 0
      }
    })
    expect(after.walletIds).toEqual([before.privateWalletId])
    expect(after.legacyWalletCount).toBe(0)
    if (process.env.E2E_SCREENSHOTS === '1') {
      await popup.getByRole('button', { name: 'Choose wallet' }).click()
      await popup
        .getByRole('dialog', { name: 'Accounts' })
        .getByRole('button', { name: 'Accounts', exact: true })
        .click()
      const privateKeyGroup = popup.locator(
        'section[aria-label="Wallet group Imported Private Key"]'
      )
      await expect(privateKeyGroup).toBeVisible()
      await privateKeyGroup.screenshot({
        path: testInfo.outputPath('private-key-wallet-retained.png')
      })
    }
  })
})
