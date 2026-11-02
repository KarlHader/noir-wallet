import {
  test,
  expect,
  e2eNetworkMode,
  e2eEnabledChainFeatureFlags,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization,
  captureScreenshot
} from '../helpers/extension-fixtures'
import { HDKey } from '@scure/bip32'
import { ed25519 } from '@noble/curves/ed25519'
import { publicKeyToAddress } from 'viem/accounts'
import type { Hex } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1'
import { createLedgerMultichainHardwareCredential } from '../../src/core/wallet/hardware-wallet-data'
import { deriveLedgerBitcoinAddress } from '../../src/lib/ledger/bitcoin-model'
import { encodeSolanaBase58 } from '../../src/infrastructure/chains/solana/solana-rpc-codecs'
import type { Page } from '@playwright/test'

test.skip(
  e2eNetworkMode !== 'mainnet' ||
    ['chain.evm', 'chain.bitcoin', 'chain.solana', 'chain.near'].some(
      flag => !e2eEnabledChainFeatureFlags.includes(flag)
    ),
  'Requires a Mainnet profile with EVM, Bitcoin, Solana and NEAR enabled'
)

// Registered public, permanently unfunded vectors; device I/O is not simulated.
const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(5))
const evmPublic = root.derive("m/44'/60'/0'/7").publicKey
if (!evmPublic) throw new Error('Public Ledger vector unavailable')
const evmKey =
  `0x${Buffer.from(secp256k1.ProjectivePoint.fromHex(evmPublic).toRawBytes(false)).toString('hex')}` as Hex
const evm = {
  family: 'evm' as const,
  accountIndex: 0,
  derivationPath: "m/44'/60'/0'/7",
  publicKey: evmKey,
  address: publicKeyToAddress(evmKey)
}
const btc = root.derive("m/84'/0'/8'")
const btcReceive = deriveLedgerBitcoinAddress(btc.publicExtendedKey, 'mainnet', false, 0)
const edPublic = ed25519.getPublicKey(new Uint8Array(32).fill(7))
const solanaAddress = encodeSolanaBase58(edPublic)
const nearAddress = Buffer.from(edPublic).toString('hex')
const first = createLedgerMultichainHardwareCredential({
  deviceModel: 'nanoX',
  deviceName: 'Ledger Public Vector',
  accounts: [evm]
})
const expanded = createLedgerMultichainHardwareCredential({
  ...first,
  accounts: [
    ...first.accountExport.accounts,
    {
      family: 'bitcoin',
      accountIndex: 0,
      derivationPath: "m/84'/0'/8'",
      network: 'mainnet',
      xpub: btc.publicExtendedKey,
      masterFingerprintHex: root.fingerprint.toString(16).padStart(8, '0'),
      publicKey: btcReceive.publicKey,
      address: btcReceive.address
    },
    {
      family: 'solana',
      accountIndex: 0,
      derivationPath: "m/44'/501'/4'/0'",
      publicKey: solanaAddress,
      address: solanaAddress
    },
    {
      family: 'near',
      accountIndex: 0,
      derivationPath: "m/44'/397'/0'/0'/4'",
      publicKey: `ed25519:${solanaAddress}`,
      address: nearAddress
    }
  ]
})
const secondSolanaAddress = encodeSolanaBase58(ed25519.getPublicKey(new Uint8Array(32).fill(8)))
const multiAccount = createLedgerMultichainHardwareCredential({
  ...expanded,
  accounts: [
    ...expanded.accountExport.accounts,
    {
      family: 'solana',
      accountIndex: 1,
      derivationPath: "m/44'/501'",
      publicKey: secondSolanaAddress,
      address: secondSolanaAddress
    }
  ]
})
async function send(page: Page, message: Record<string, unknown>) {
  return page.evaluate(message => chrome.runtime.sendMessage(message), message)
}

test('Ledger native provisioning preserves one KeyDomain across adding chains, restart and lock', async ({
  context,
  popup,
  extensionId
}) => {
  await waitForBackgroundWalletInitialization(popup)
  const url = `chrome-extension://${extensionId}/index.html#/hardware/ledger-connect`
  await popup.goto(url)
  await popup.reload()
  await expect(popup.getByRole('button', { name: 'EVM', exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Zcash', exact: true }).click()
  await popup.getByRole('button', { name: 'EVM', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Connect Ledger', exact: true })).toBeEnabled()
  await expect
    .poll(
      () =>
        popup
          .locator('fieldset img')
          .evaluateAll(
            images =>
              images.length === 5 &&
              images.every(
                image =>
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
              )
          ),
      { timeout: 15_000 }
    )
    .toBe(true)
  await popup.evaluate(() => document.fonts.ready)
  expect(
    await popup
      .locator('.page-content')
      .evaluate(element => element.scrollHeight <= element.clientHeight + 1)
  ).toBe(true)
  await popup.getByRole('button', { name: 'Bitcoin', exact: true }).click()
  await popup.getByRole('button', { name: 'Solana', exact: true }).click()
  await expect(popup.locator('fieldset button[aria-pressed="true"]')).toHaveCount(3)
  await captureScreenshot(popup, 'ledger-connect-account-discovery.png')
  const provision = await send(popup, {
    type: 'PROVISION_LEDGER_HARDWARE',
    credential: first,
    displayName: 'Ledger Public Vector',
    password: 'ledger-public-test-password'
  })
  expect(provision).toMatchObject({
    success: true,
    result: {
      status: 'committed',
      keyDomainId: expect.stringMatching(/^wallet:ledger-v3:/),
      accountIds: [expect.any(String)]
    }
  })
  const walletId = provision.result.keyDomainId
  const accountIds = provision.result.accountIds
  const readCatalog = () => send(popup, { type: 'GET_ACCOUNT_NETWORKS' })
  await expect.poll(async () => (await readCatalog()).result?.accounts.length).toBe(1)
  const before = await readCatalog()
  expect(
    before.result.accounts[0].networks.every((entry: { chainId: string }) =>
      entry.chainId.startsWith('eip155:')
    )
  ).toBe(true)

  await popup.goto(url)
  await popup.reload()
  await popup.selectOption('#ledger-wallet', walletId)
  await expect(popup.getByRole('button', { name: 'EVM Added', exact: true })).toBeDisabled()
  await popup.getByRole('button', { name: 'Bitcoin', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Connect Ledger', exact: true })).toBeEnabled()
  await expect(
    popup.getByRole('button', { name: 'Use Bluetooth instead', exact: true })
  ).toBeVisible()
  await popup.evaluate(() => document.fonts.ready)
  expect(
    await popup
      .locator('.page-content')
      .evaluate(element => element.scrollHeight <= element.clientHeight + 1)
  ).toBe(true)
  await popup.locator('summary').filter({ hasText: 'Advanced' }).click()
  await expect(popup.locator('#ledger-account-index')).toBeVisible()
  const badAnchor = { ...first.accountExport.accounts[0], derivationPath: "m/44'/60'/8'/0/2" }
  const rejected = await send(popup, {
    type: 'PROVISION_LEDGER_HARDWARE',
    credential: expanded,
    displayName: 'Ledger Public Vector',
    existingKeyDomainId: walletId,
    anchorProof: badAnchor
  })
  expect(rejected.error).toBeTruthy()
  const added = await send(popup, {
    type: 'PROVISION_LEDGER_HARDWARE',
    credential: expanded,
    displayName: 'Ledger Public Vector',
    existingKeyDomainId: walletId,
    anchorProof: first.accountExport.accounts[0]
  })
  expect(added).toMatchObject({ success: true, result: { keyDomainId: walletId, accountIds } })
  const catalog = await readCatalog()
  expect(catalog.result.accounts).toHaveLength(1)
  const account = catalog.result.accounts[0]
  expect(account.walletSource.hardware.capabilities).toEqual(['bitcoin', 'evm', 'solana', 'near'])
  for (const namespace of ['eip155:', 'bip122:', 'solana:', 'near:']) {
    expect(
      account.networks.some((entry: { chainId: string }) => entry.chainId.startsWith(namespace))
    ).toBe(true)
  }
  expect(
    account.networks.flatMap((entry: { addresses: { value: string }[] }) =>
      entry.addresses.map(address => address.value)
    )
  ).toEqual(expect.arrayContaining([btcReceive.address, solanaAddress, nearAddress]))

  const secondAccount = await send(popup, {
    type: 'PROVISION_LEDGER_HARDWARE',
    credential: multiAccount,
    displayName: 'Ledger Public Vector',
    existingKeyDomainId: walletId,
    anchorProof: first.accountExport.accounts[0]
  })
  expect(secondAccount).toMatchObject({
    success: true,
    result: { keyDomainId: walletId, accountIds: [accountIds[0], expect.any(String)] }
  })
  const multiCatalog = (await readCatalog()).result.accounts
  expect(multiCatalog).toHaveLength(2)
  const newAccount = multiCatalog.find(
    (entry: { accountIndex: number }) => entry.accountIndex === 1
  )
  expect(newAccount.walletId).toBe(walletId)
  expect(
    newAccount.networks.every((entry: { chainId: string }) => entry.chainId.startsWith('solana:'))
  ).toBe(true)
  expect(
    newAccount.networks.flatMap((entry: { addresses: { value: string }[] }) =>
      entry.addresses.map(address => address.value)
    )
  ).toContain(secondSolanaAddress)

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const ledgerGroup = popup.locator('section[aria-label="Wallet group Ledger Public Vector"]')
  await expect(ledgerGroup).toBeVisible()
  await expect(ledgerGroup.locator('[aria-label^="Account actions for "]')).toHaveCount(2)
  await expect(ledgerGroup.getByRole('button', { name: 'Add Account', exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'ledger-account-group.png')

  const renameLedgerAccount = ledgerGroup.getByRole('button', {
    name: `Rename account ${newAccount.accountDisplayName}`
  })
  await renameLedgerAccount.hover()
  await expect(renameLedgerAccount.locator('svg')).toBeVisible()
  await renameLedgerAccount.click()
  await ledgerGroup.getByRole('textbox', { name: 'Account name' }).fill('Ledger Savings')
  await ledgerGroup.getByRole('textbox', { name: 'Account name' }).press('Enter')
  await expect(ledgerGroup.getByRole('textbox', { name: 'Account name' })).toHaveCount(0)
  await expect(
    ledgerGroup.getByRole('button', { name: 'Account actions for Ledger Savings' })
  ).toBeVisible()
  await expect(
    ledgerGroup.getByRole('button', { name: `Account actions for ${account.accountDisplayName}` })
  ).toBeVisible()
  const renameLedgerWallet = popup.getByRole('button', {
    name: 'Rename wallet Ledger Public Vector'
  })
  await renameLedgerWallet.hover()
  await expect(renameLedgerWallet.locator('svg')).toBeVisible()
  await renameLedgerWallet.click()
  await ledgerGroup.getByRole('textbox', { name: 'Wallet name' }).fill('Ledger Archive')
  await ledgerGroup.getByRole('textbox', { name: 'Wallet name' }).press('Enter')
  await expect(ledgerGroup.getByRole('textbox', { name: 'Wallet name' })).toHaveCount(0)
  const renamedLedgerGroup = popup.locator('section[aria-label="Wallet group Ledger Archive"]')
  await expect(renamedLedgerGroup).toBeVisible()
  await popup.reload()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(
    renamedLedgerGroup.getByRole('button', { name: 'Account actions for Ledger Savings' })
  ).toBeVisible()
  await expect(
    renamedLedgerGroup.getByRole('button', {
      name: `Account actions for ${account.accountDisplayName}`
    })
  ).toBeVisible()
  const renamedLedgerCatalog = (await readCatalog()).result.accounts
  expect(renamedLedgerCatalog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        walletId,
        accountId: accountIds[0],
        walletDisplayName: 'Ledger Archive',
        accountDisplayName: account.accountDisplayName
      }),
      expect.objectContaining({
        walletId,
        accountId: newAccount.accountId,
        walletDisplayName: 'Ledger Archive',
        accountDisplayName: 'Ledger Savings'
      })
    ])
  )

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  expect((await readCatalog()).result.accounts[0].accountId).toBe(accountIds[0])
  await popup.goto(url)
  await popup.reload()
  expect(await send(popup, { type: 'GET_LEDGER_PROVISIONING_CREDENTIAL', walletId })).toMatchObject(
    { result: multiAccount }
  )
  await popup.goto(
    `chrome-extension://${extensionId}/index.html#/hardware/ledger-sign?requestId=invalid`
  )
  await popup.reload()
  expect(
    (
      await send(popup, {
        type: 'PROVISION_LEDGER_HARDWARE',
        credential: expanded,
        displayName: 'Wrong Route',
        existingKeyDomainId: walletId,
        anchorProof: first.accountExport.accounts[0]
      })
    ).error
  ).toBeTruthy()
  expect(
    (await send(popup, { type: 'GET_LEDGER_PROVISIONING_CREDENTIAL', walletId })).error
  ).toBeTruthy()
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.reload()
  await expect(popup.getByRole('button', { name: 'Lending', exact: true })).toHaveCount(0)
  const lock = await send(popup, { type: 'WALLET_LOCKED' })
  expect(lock.error).toBeUndefined()
  await popup.goto(url)
  await popup.reload()
  expect(
    (await send(popup, { type: 'GET_LEDGER_PROVISIONING_CREDENTIAL', walletId })).error
  ).toBeTruthy()
})
