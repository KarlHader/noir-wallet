import type { Page } from '@playwright/test'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'
import { BUILTIN_EVM_NETWORKS } from '../../src/config/networks'

const TEST_MNEMONIC_12 = `${'abandon '.repeat(11)}about`
const TEST_PASSWORD = 'private-key-testnet-password'
const NEXT_PASSWORD = 'private-key-testnet-password-next'
const EVM_PRIVATE_KEY = `0x${'00'.repeat(31)}01`
const EVM_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
const BITCOIN_MAINNET_WIF = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn'
const BITCOIN_TESTNET_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'
const BITCOIN_TESTNET_CHAIN_ID = 'bip122:000000000933ea01ad0ee984209779ba'
const SOLANA_PRIVATE_KEY = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx'
const SOLANA_DEVNET_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const NEAR_PRIVATE_KEY = 'ed25519:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN'

async function importMnemonicWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('radio', { name: '12 words' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page)
  await page.getByPlaceholder('8–64 characters').fill(TEST_PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(TEST_PASSWORD)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
}

async function openMnemonicPrivateKeyExport(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose wallet' }).click()
  await page.getByRole('button', { name: 'Account actions for Account 1' }).click()
  await page.getByRole('menuitem', { name: 'Account details' }).click()
  await page.getByText('Export private key', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Export private key' })).toBeVisible()
}

async function revealSelectedPrivateKey(page: Page): Promise<string> {
  await page.getByLabel('Enter password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Reveal private key' }).click()
  const key = page.locator('p.font-mono')
  await expect(key).toBeVisible({ timeout: 30_000 })
  return key.textContent().then(value => value ?? '')
}

async function openPrivateKeyImport(page: Page): Promise<void> {
  const chooseWallet = page.getByRole('button', { name: 'Choose wallet' })
  if (await chooseWallet.isVisible()) await chooseWallet.click()
  await page.getByRole('button', { name: 'Add Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Import Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Private Key', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import private key' })).toBeVisible()
}

async function importPrivateKeyWallet(
  page: Page,
  input: Readonly<{
    privateKey: string
    name: string
    family: 'EVM' | 'Bitcoin' | 'Solana' | 'NEAR'
  }>
): Promise<void> {
  await openPrivateKeyImport(page)
  await page.getByLabel('Wallet name').fill(input.name)
  await page.getByLabel('Private key', { exact: true }).fill(input.privateKey)
  await expect(page.getByText('Detected network', { exact: true })).toBeVisible()
  await expect(page.getByText(input.family, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText(`${input.family} address preview`, { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await page.getByRole('button', { name: 'Import wallet', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })
}

async function readLegacyActiveScope(page: Page): Promise<{
  walletId: string | null
  accountId: string | null
}> {
  return page.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const state = typeof stored === 'string' ? JSON.parse(stored).state : stored?.state
    return {
      walletId: typeof state?.currentWalletId === 'string' ? state.currentWalletId : null,
      accountId: typeof state?.currentAccountId === 'string' ? state.currentAccountId : null
    }
  })
}

test('imports and exports EVM and Bitcoin private keys in Testnet Mode', async ({
  context,
  popup
}) => {
  test.setTimeout(300_000)
  await waitForBackgroundWalletInitialization(popup)
  await importMnemonicWallet(popup)
  const retainedZcashScope = await readLegacyActiveScope(popup)
  expect(retainedZcashScope.walletId).not.toBeNull()
  expect(retainedZcashScope.accountId).not.toBeNull()

  await openMnemonicPrivateKeyExport(popup)
  const mnemonicEvmKey = await revealSelectedPrivateKey(popup)
  expect(mnemonicEvmKey).toMatch(/^0x[0-9a-f]{64}$/)
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByText('Export private key', { exact: true }).click()
  await popup.getByRole('button', { name: 'Bitcoin Testnet', exact: true }).click()
  const mnemonicBitcoinKey = await revealSelectedPrivateKey(popup)
  expect(mnemonicBitcoinKey).toMatch(/^c[1-9A-HJ-NP-Za-km-z]{51}$/)
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await importPrivateKeyWallet(popup, {
    privateKey: EVM_PRIVATE_KEY,
    name: 'Imported EVM Testnet',
    family: 'EVM'
  })
  await expect(popup.getByText('TESTNET', { exact: true })).toBeVisible()
  const evmAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported EVM Testnet'
    )
  })
  expect(evmAccount).toMatchObject({
    walletSource: { kind: 'private-key', chainFamily: 'eip155' },
    active: true
  })
  expect(evmAccount.networks).toHaveLength(BUILTIN_EVM_NETWORKS.testnet.length)
  expect(
    new Set(
      evmAccount.networks.flatMap((network: { addresses: readonly { value: string }[] }) =>
        network.addresses.map(address => address.value)
      )
    )
  ).toEqual(new Set([EVM_ADDRESS]))
  await expect
    .poll(() => readLegacyActiveScope(popup))
    .toEqual({
      walletId: null,
      accountId: null
    })
  const staleZcashResync = await popup.evaluate(
    async ({ walletId, accountId }) =>
      chrome.runtime.sendMessage({
        type: 'RESYNC_ZCASH_WALLET',
        walletId,
        accountId,
        birthdayHeight: 3_000_000
      }),
    retainedZcashScope
  )
  expect(staleZcashResync).toMatchObject({
    error: 'Active account changed. Review this action again.'
  })

  await openPrivateKeyImport(popup)
  await popup.getByLabel('Wallet name').fill('Wrong Bitcoin Network')
  await popup.getByLabel('Private key', { exact: true }).fill(BITCOIN_MAINNET_WIF)
  await expect(popup.getByText('Bitcoin', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.locator('p.text-danger')).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('Bitcoin address preview', { exact: true })).toHaveCount(0)
  await popup.getByLabel('Private key', { exact: true }).fill(BITCOIN_TESTNET_WIF)
  await popup.getByLabel('Wallet name').fill('Imported Bitcoin Testnet')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByText('Bitcoin address preview', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.locator('p.font-mono')).toContainText(/^tb1q/)
  await captureScreenshot(popup, 'private-key-testnet-bitcoin-preview.png')
  await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 60_000 })

  const bitcoinAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported Bitcoin Testnet'
    )
  })
  expect(bitcoinAccount).toMatchObject({
    walletSource: {
      kind: 'private-key',
      chainFamily: 'bip122',
      bitcoinNetwork: 'testnet'
    },
    active: true,
    networks: [{ chainId: BITCOIN_TESTNET_CHAIN_ID }]
  })
  expect(bitcoinAccount.networks[0].addresses).toHaveLength(4)

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const privateKeyGroup = popup.locator('section[aria-label="Wallet group Imported Private Key"]')
  await expect(privateKeyGroup).toBeVisible()
  await expect(privateKeyGroup.locator('[aria-label^="Account actions for "]')).toHaveCount(2)
  await expect(
    privateKeyGroup.getByRole('button', { name: 'Add Account', exact: true })
  ).toHaveCount(0)
  await expect(privateKeyGroup.getByRole('button', { name: /^Rename wallet / })).toHaveCount(0)
  await privateKeyGroup.scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'private-key-account-group.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  // A Service Worker restart does not end the browser-scoped chrome.storage.session unlock.
  // Browser restart, extension reload/update, explicit lock, and network-mode restart do.
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 15_000 })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await privateKeyGroup
    .getByRole('button', { name: `Account actions for ${bitcoinAccount.accountDisplayName}` })
    .last()
    .click()
  await popup.getByRole('menuitem', { name: 'Export private key' }).click()
  expect(await revealSelectedPrivateKey(popup)).toBe(BITCOIN_TESTNET_WIF)

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toMatchObject({ success: true })
  await popup.reload()
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByPlaceholder('Enter Password').fill(TEST_PASSWORD)
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => readLegacyActiveScope(popup))
    .toEqual({
      walletId: null,
      accountId: null
    })
  const restoredBitcoinAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported Bitcoin Testnet'
    )
  })
  expect(restoredBitcoinAccount).toMatchObject({ active: true })

  await popup.getByRole('button', { name: 'Settings', exact: true }).click()
  await popup.getByRole('button', { name: 'Security & Privacy', exact: true }).click()
  await popup.getByRole('button', { name: 'Change Password', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Change Password' })).toBeVisible()
  await popup.getByPlaceholder('Current Password').fill(TEST_PASSWORD)
  await popup.getByPlaceholder('New Password', { exact: true }).fill(NEXT_PASSWORD)
  await popup.getByPlaceholder('Confirm New Password').fill(NEXT_PASSWORD)
  await popup.getByRole('button', { name: 'Change Password', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Security & Privacy' })).toBeVisible({
    timeout: 60_000
  })

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toMatchObject({ success: true })
  await popup.reload()
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByPlaceholder('Enter Password').fill(NEXT_PASSWORD)
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const importedGroup = popup.locator('section[aria-label="Wallet group Imported Private Key"]')
  await importedGroup
    .getByRole('button', { name: `Account actions for ${evmAccount.accountDisplayName}` })
    .first()
    .click()
  await expect(popup.getByRole('menuitem', { name: 'Export private key' })).toBeVisible()
  await expect(popup.getByRole('menuitem', { name: 'Remove account' })).toBeVisible()
  await popup.keyboard.press('Escape')
  const renameEvmAccount = importedGroup
    .getByRole('button', { name: `Rename account ${evmAccount.accountDisplayName}` })
    .first()
  await renameEvmAccount.hover()
  await expect(renameEvmAccount.locator('svg')).toBeVisible()
  await renameEvmAccount.click()
  await importedGroup.getByRole('textbox', { name: 'Account name' }).fill('EVM Reserve')
  await captureScreenshot(popup, 'private-key-inline-account-rename.png')
  await importedGroup.getByRole('textbox', { name: 'Account name' }).press('Enter')
  await expect(importedGroup.getByRole('textbox', { name: 'Account name' })).toHaveCount(0)
  await expect(
    importedGroup.getByRole('button', { name: 'Account actions for EVM Reserve' })
  ).toBeVisible()
  await popup.reload()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(
    importedGroup.getByRole('button', { name: 'Account actions for EVM Reserve' })
  ).toBeVisible()
  await expect(importedGroup.locator('[aria-label^="Account actions for "]')).toHaveCount(2)
  await importedGroup.scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'private-key-account-group-renamed.png')
  const namesAfterRename = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.map(
      (account: { walletId: string; accountId: string; accountDisplayName: string }) => ({
        walletId: account.walletId,
        accountId: account.accountId,
        accountDisplayName: account.accountDisplayName
      })
    )
  })
  expect(namesAfterRename).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        walletId: evmAccount.walletId,
        accountId: evmAccount.accountId,
        accountDisplayName: 'EVM Reserve'
      }),
      expect.objectContaining({
        walletId: bitcoinAccount.walletId,
        accountId: bitcoinAccount.accountId,
        accountDisplayName: bitcoinAccount.accountDisplayName
      })
    ])
  )
  await importedGroup.getByRole('button', { name: 'Account actions for EVM Reserve' }).click()
  await popup.getByRole('menuitem', { name: 'Remove account' }).click()
  await popup.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(importedGroup.locator('[aria-label^="Account actions for "]')).toHaveCount(1)
  await expect
    .poll(async () => {
      const response = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      )
      return response.result?.accounts?.map((account: { walletId: string }) => account.walletId)
    })
    .toContain(bitcoinAccount.walletId)
  await expect
    .poll(async () => {
      const response = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      )
      return response.result?.accounts?.map((account: { walletId: string }) => account.walletId)
    })
    .not.toContain(evmAccount.walletId)
  await popup.reload()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(importedGroup.locator('[aria-label^="Account actions for "]')).toHaveCount(1)
})

test('imports Solana and NEAR private-key Wallets behind the Beta chain gates', async ({
  popup
}) => {
  test.setTimeout(180_000)
  await waitForBackgroundWalletInitialization(popup)
  await importMnemonicWallet(popup)

  await importPrivateKeyWallet(popup, {
    privateKey: SOLANA_PRIVATE_KEY,
    name: 'Imported Solana Devnet',
    family: 'Solana'
  })
  const solanaAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported Solana Devnet'
    )
  })
  expect(solanaAccount).toMatchObject({
    walletSource: { kind: 'private-key', chainFamily: 'solana' },
    active: true,
    networks: [
      {
        chainId: SOLANA_DEVNET_CHAIN_ID,
        addresses: [
          {
            scheme: 'solana',
            preferredForReceive: true
          }
        ]
      }
    ]
  })
  expect(solanaAccount.networks[0].addresses[0].value).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

  await importPrivateKeyWallet(popup, {
    privateKey: NEAR_PRIVATE_KEY,
    name: 'Imported NEAR Testnet',
    family: 'NEAR'
  })
  const nearAccount = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    return response.result?.accounts?.find(
      (account: { walletDisplayName?: string }) =>
        account.walletDisplayName === 'Imported NEAR Testnet'
    )
  })
  expect(nearAccount).toMatchObject({
    walletSource: { kind: 'private-key', chainFamily: 'near' },
    active: true,
    networks: [
      {
        chainId: 'near:testnet',
        addresses: [
          {
            scheme: 'near',
            preferredForReceive: true
          }
        ]
      }
    ]
  })
  expect(nearAccount.networks[0].addresses[0].value).toMatch(/^[0-9a-f]{64}$/)

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .getByRole('button', { name: `Account actions for ${nearAccount.accountDisplayName}` })
    .last()
    .click()
  await popup.getByRole('menuitem', { name: 'Export private key' }).click()
  expect(await revealSelectedPrivateKey(popup)).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{87,88}$/)
})
