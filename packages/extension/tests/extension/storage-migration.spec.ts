import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  captureScreenshot,
  extensionDir,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

async function launchProfile(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  })
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return new URL(worker.url()).host
}

test('retains legacy walletData after verified browser restart migration', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-migration-e2e-'))
  let context: BrowserContext | undefined
  const walletId = 'legacy-browser-wallet'
  const accountId = 'legacy-browser-account'

  try {
    context = await launchProfile(userDataDir)
    const extensionId = await getExtensionId(context)
    const setupPage = await context.newPage()
    await setupPage.goto(`chrome-extension://${extensionId}/index.html`)
    await waitForBackgroundWalletInitialization(setupPage)
    await setupPage.evaluate(
      async ({ walletId, accountId }) => {
        await chrome.storage.local.clear()
        await chrome.storage.local.set({
          walletData: {
            wallets: [
              {
                id: walletId,
                name: 'Legacy Browser Wallet',
                seedPhraseKey: `seed_${walletId}`,
                accounts: [
                  {
                    id: accountId,
                    name: 'Account 1',
                    addresses: {
                      transparent: 't-fixture-browser',
                      shielded: 'u-fixture-browser',
                      fullUnified: 'u-full-fixture-browser'
                    },
                    derivationIndex: 0,
                    birthdayHeight: 3_000_000,
                    isPinned: false,
                    isHidden: false
                  }
                ],
                createdAt: 1_700_000_000_000,
                isPinned: false,
                keySource: 'software'
              }
            ],
            currentWalletId: walletId,
            currentAccountId: accountId,
            network: 'mainnet'
          },
          [`seed_${walletId}`]: {
            encryptedData: 'fixture-ciphertext',
            salt: 'fixture-salt',
            iv: 'fixture-iv'
          }
        })
      },
      { walletId, accountId }
    )
    await context.close()
    context = undefined

    context = await launchProfile(userDataDir)
    const restartedExtensionId = await getExtensionId(context)
    expect(restartedExtensionId).toBe(extensionId)
    const verifier = await context.newPage()
    await verifier.goto(
      `chrome-extension://${restartedExtensionId}/index.html?migration-verifier=1`
    )

    await expect
      .poll(
        () =>
          verifier.evaluate(async () => {
            const local = await chrome.storage.local.get([
              'walletData',
              'wallet_state',
              'legacy_wallet_data_migration_v1'
            ])
            const walletState =
              typeof local.wallet_state === 'string'
                ? JSON.parse(local.wallet_state)
                : local.wallet_state
            return {
              legacyRetained: local.walletData?.currentWalletId,
              currentWalletId: walletState?.state?.currentWalletId,
              migrationStatus: local.legacy_wallet_data_migration_v1?.status,
              migrationReason: local.legacy_wallet_data_migration_v1?.reason
            }
          }),
        { timeout: 15_000 }
      )
      .toEqual({
        legacyRetained: walletId,
        currentWalletId: walletId,
        migrationStatus: 'retained',
        migrationReason: 'staged-target-verified'
      })
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('quarantines invalid legacy walletData without creating an empty target', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-migration-quarantine-e2e-'))
  let context: BrowserContext | undefined

  try {
    context = await launchProfile(userDataDir)
    const extensionId = await getExtensionId(context)
    const setupPage = await context.newPage()
    await setupPage.goto(`chrome-extension://${extensionId}/index.html`)
    await waitForBackgroundWalletInitialization(setupPage)
    await setupPage.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        walletData: {
          wallets: [
            {
              id: 'invalid-legacy-wallet',
              name: 'Invalid Legacy Wallet',
              accounts: [],
              createdAt: 'invalid'
            }
          ],
          currentWalletId: 'invalid-legacy-wallet',
          currentAccountId: null,
          network: 'mainnet'
        }
      })
    })
    await context.close()
    context = undefined

    context = await launchProfile(userDataDir)
    const verifier = await context.newPage()
    await verifier.setViewportSize({ width: 375, height: 600 })
    await verifier.goto(`chrome-extension://${extensionId}/index.html?migration-quarantine=1`)

    await expect(
      verifier.getByRole('heading', { name: 'Wallet upgrade failed', exact: true })
    ).toBeVisible()
    await expect(verifier.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
    await expect(verifier.getByText('Your existing wallet data is still stored')).toBeVisible()
    await expect(verifier.getByRole('button', { name: /skip|continue|reset/i })).toHaveCount(0)
    await captureScreenshot(verifier, 'wallet-metadata-upgrade-failed.png')

    await verifier.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      verifier.getByRole('heading', { name: 'Wallet upgrade failed', exact: true })
    ).toBeVisible()

    await expect
      .poll(
        () =>
          verifier.evaluate(async () => {
            const local = await chrome.storage.local.get([
              'walletData',
              'wallet_state',
              'legacy_wallet_data_migration_v1'
            ])
            return {
              legacyRetained: local.walletData?.currentWalletId,
              targetExists: Object.prototype.hasOwnProperty.call(local, 'wallet_state'),
              migrationStatus: local.legacy_wallet_data_migration_v1?.status,
              migrationReason: local.legacy_wallet_data_migration_v1?.reason
            }
          }),
        { timeout: 15_000 }
      )
      .toEqual({
        legacyRetained: 'invalid-legacy-wallet',
        targetExists: false,
        migrationStatus: 'quarantined',
        migrationReason: 'source-quarantined'
      })
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('copies only network-provable V1 Zcash contacts into Address Book V2', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-address-book-migration-e2e-'))
  let context: BrowserContext | undefined
  const legacyEnvelope = JSON.stringify({
    state: {
      contacts: [
        {
          address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
          name: 'Legacy Zcash',
          addedAt: 1_700_000_000_000
        },
        {
          address: '0x1111111111111111111111111111111111111111',
          name: 'Ambiguous legacy record',
          addedAt: 1_700_000_000_100
        }
      ]
    },
    version: 0
  })

  try {
    context = await launchProfile(userDataDir)
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    const extensionId = new URL(worker.url()).host
    await worker.evaluate(
      ({ legacyEnvelope }) =>
        chrome.storage.local.set({
          wallet_contacts: legacyEnvelope
        }),
      { legacyEnvelope }
    )

    const verifier = await context.newPage()
    await verifier.setViewportSize({ width: 375, height: 600 })
    await verifier.goto(`chrome-extension://${extensionId}/index.html?address-book-migration=1`)

    await expect
      .poll(
        () =>
          verifier.evaluate(async original => {
            const stored = await chrome.storage.local.get(['wallet_contacts', 'address_book_v2'])
            if (typeof stored.address_book_v2 !== 'string') return null
            const addressBook = JSON.parse(stored.address_book_v2)
            const contact = addressBook.state?.contacts?.[0]
            return {
              legacyUnchanged: stored.wallet_contacts === original,
              contacts: addressBook.state?.contacts?.length,
              contact: contact
                ? {
                    chainId: contact.chainId,
                    address: contact.address,
                    name: contact.name,
                    scheme: contact.addressScheme
                  }
                : null,
              migration: addressBook.state?.legacyMigration
                ? {
                    importedCount: addressBook.state.legacyMigration.importedCount,
                    skippedCount: addressBook.state.legacyMigration.skippedCount
                  }
                : null
            }
          }, legacyEnvelope),
        { timeout: 15_000 }
      )
      .toEqual({
        legacyUnchanged: true,
        contacts: 1,
        contact: {
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
          address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
          name: 'Legacy Zcash',
          scheme: 'zcash-transparent-p2pkh'
        },
        migration: { importedCount: 1, skippedCount: 1 }
      })
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
