import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extensionDir, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

const PASSWORD = 'keystone-v1-upgrade-password'
const NEW_PASSWORD = 'keystone-v2-changed-password'
const WALLET_ID = 'wallet:keystone-v1-upgrade'
const ACCOUNT_ID = 'account:keystone-v1-upgrade:0'
const ADDRESSES = Object.freeze({
  transparent: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
  shielded:
    'u14hxpxnwfzfujl6n36gfpr2e90mxzupmaksy3ly7ztgcey8qa06703yutk3m3u46tfkeywk9w69atu6zmdlp0lekh8jpsxmpzngrspf379dtgyvyfggtqlyvcq3wjr5y5xngex2qtsxheywdyzdfalk5clnms8wy3fje0j560wvsjm6d8',
  fullUnified:
    'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
})
const UFVK =
  'uview1qggz6nejagvka9wtm9r7xf84kkwy4cc0cgchptr98w0cyz33cj4958q5ulkd32nz2u3s0sp9yhcw7tu2n3nlw9x6ulghyd2zgc857tnzme2zpr3vn24zhtm2rjduv9a5zxlmzz404n7l0k69gmu4tfn2g3vpcn03rhz63e3l92fn8gra37tyly7utvgveswl20vz23pu84rc2nyqess38wvlgr2xzyhgj232ne5qutpe6ql6ghzetdy7pfzcmdzd5gd5dnwk25fwv7nnzmnty7u5ax3nzzgr6pdc905ckpd0s9v2cvn7e03qm7r46e5ngax536ywz7zxjptymm90px0rhvmqtwvttuy6d7degly023lqvskclk6mezyt69dwu6c4tfzrjgq4uuh5xa9m5dclgatykgtrrw268qe5pldfkx73f2kd5yyy2tjpjql92pa6tsk2nh2h88q23nee9z379het4akl6haqmuwf9d0nl0susg4tnxyk'
const SEED_FINGERPRINT = '21ed3d7882c7e37fe012b54a6408048048cb09782d4b2938617da793ccd27815'

async function launchProfile(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  })
}

async function extensionIdFor(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return new URL(worker.url()).host
}

async function openExtensionPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.setViewportSize({ width: 375, height: 600 })
  await page.goto(`chrome-extension://${extensionId}/index.html`)
  return page
}

async function seedV1HardwareProfile(popup: Page, vendor: 'keystone' | 'ledger'): Promise<void> {
  await waitForBackgroundWalletInitialization(popup)
  await popup.evaluate(
    async ({ password, walletId, accountId, addresses, ufvk, seedFingerprintHex, vendor }) => {
      const deleteDatabase = (name: string) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () => reject(new Error(`Database deletion blocked: ${name}`))
        })
      const toBase64 = (value: Uint8Array) => {
        let binary = ''
        for (const byte of value) binary += String.fromCharCode(byte)
        return btoa(binary)
      }
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const passwordKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
      )
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      )
      const plaintext = new TextEncoder().encode(
        JSON.stringify(
          vendor === 'ledger'
            ? {
                ufvk,
                accountHdIndex: 0,
                deviceModel: 'nanoX',
                deviceName: 'Ledger Nano X',
                ledgerTransport: 'usb'
              }
            : { ufvk, seedFingerprintHex, accountHdIndex: 0 }
        )
      )
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
      await chrome.storage.local.clear()
      await chrome.storage.session.clear()
      await deleteDatabase('noir-wallet-storage-v2-db')
      await deleteDatabase('noir-wallet-credential-db')
      await chrome.storage.local.set({
        wallet_state: {
          state: {
            currentWalletId: walletId,
            currentAccountId: accountId,
            currentNetwork: 'mainnet',
            zecPrice: 0,
            wallets: [
              {
                id: walletId,
                name: `${vendor} Upgrade Fixture`,
                seedPhraseKey: '',
                accounts: [
                  {
                    id: accountId,
                    name: `${vendor} Account`,
                    addresses,
                    derivationIndex: 0,
                    birthdayHeight: 2_000_000,
                    isPinned: false,
                    isHidden: false
                  }
                ],
                createdAt: 1_700_000_000_000,
                isPinned: false,
                keySource: vendor
              }
            ],
            accountDisplayNames: {}
          },
          version: 0
        },
        [`hw_${walletId}`]: {
          encryptedData: toBase64(new Uint8Array(ciphertext)),
          salt: toBase64(salt),
          iv: toBase64(iv)
        }
      })
      plaintext.fill(0)
    },
    {
      password: PASSWORD,
      walletId: WALLET_ID,
      accountId: ACCOUNT_ID,
      addresses: ADDRESSES,
      ufvk: UFVK,
      seedFingerprintHex: SEED_FINGERPRINT,
      vendor
    }
  )
}

test('provisions a Ledger Zcash account into Storage V2 through the real background', async () => {
  test.setTimeout(120_000)
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-ledger-provision-'))
  let context: BrowserContext | undefined

  try {
    context = await launchProfile(userDataDir)
    const extensionId = await extensionIdFor(context)
    const popup = await openExtensionPage(context, extensionId)
    await waitForBackgroundWalletInitialization(popup)

    await popup.goto(`chrome-extension://${extensionId}/index.html#/hardware/ledger-connect`)
    await popup.reload()

    const result = await popup.evaluate(
      async ({ ufvk, password }) => {
        const response = await chrome.runtime.sendMessage({
          type: 'PROVISION_LEDGER_HARDWARE',
          credential: {
            schemaVersion: 2,
            vendor: 'ledger',
            firmwareProfile: 'zcash',
            capabilities: ['zcash'],
            accountExport: {
              protocol: 'zcash-accounts-v1',
              ufvk,
              seedFingerprintHex: '0'.repeat(64),
              accountHdIndex: 0
            },
            deviceModel: 'nanoX',
            deviceName: 'Ledger Nano X'
          },
          displayName: 'Ledger Test',
          birthdayHeight: 2_000_000,
          password
        })
        const walletState = await chrome.storage.local.get('wallet_state')
        return { response, walletState: walletState.wallet_state }
      },
      { ufvk: UFVK, password: PASSWORD }
    )

    expect(result.response).toMatchObject({
      success: true,
      result: { status: 'committed', accountIds: [expect.any(String)] }
    })
    expect(result.walletState.state.wallets).toEqual([
      expect.objectContaining({
        name: 'Ledger Test',
        keySource: 'ledger',
        accounts: [
          expect.objectContaining({
            derivationIndex: 0,
            addresses: expect.objectContaining({ fullUnified: ADDRESSES.fullUnified })
          })
        ]
      })
    ])
    await popup.close()
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

for (const vendor of ['keystone', 'ledger'] as const) {
  test(`migrates a retained ${vendor} UFVK through real MV3 and Zcash WASM verification`, async () => {
    test.setTimeout(240_000)
    const userDataDir = await mkdtemp(path.join(tmpdir(), `noir-v1-${vendor}-upgrade-`))
    let context: BrowserContext | undefined

    try {
      context = await launchProfile(userDataDir)
      const extensionId = await extensionIdFor(context)
      const setupPage = await openExtensionPage(context, extensionId)
      await seedV1HardwareProfile(setupPage, vendor)
      await setupPage.close()
      await context.close()
      context = undefined

      context = await launchProfile(userDataDir)
      const upgradedExtensionId = await extensionIdFor(context)
      expect(upgradedExtensionId).toBe(extensionId)
      let popup = await openExtensionPage(context, upgradedExtensionId)
      await waitForBackgroundWalletInitialization(popup)

      const unlock = await popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        PASSWORD
      )
      expect(unlock).toMatchObject({ success: true, credentialStatus: 'migrated' })

      const migrated = await popup.evaluate(
        async ({ walletId, accountId }) => {
          const readAll = (name: string, stores: readonly string[]) =>
            new Promise<Record<string, unknown[]>>((resolve, reject) => {
              const request = indexedDB.open(name)
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const database = request.result
                const transaction = database.transaction([...stores], 'readonly')
                const result: Record<string, unknown[]> = {}
                let remaining = stores.length
                for (const storeName of stores) {
                  const entries = transaction.objectStore(storeName).getAll()
                  entries.onerror = () => reject(entries.error)
                  entries.onsuccess = () => {
                    result[storeName] = entries.result
                    remaining -= 1
                    if (remaining === 0) {
                      database.close()
                      resolve(result)
                    }
                  }
                }
              }
            })
          const storage = await readAll('noir-wallet-storage-v2-db', [
            'metadata',
            'keyDomains',
            'accounts',
            'chainAccounts',
            'addresses'
          ])
          const credentials = await readAll('noir-wallet-credential-db', [
            'encryptedCredentialEnvelopes',
            'credentialSets',
            'credentialTransactionJournals'
          ])
          const local = await chrome.storage.local.get(`hw_${walletId}`)
          return {
            walletId,
            accountId,
            storage,
            credentials,
            retainedHardware: local[`hw_${walletId}`]
          }
        },
        { walletId: WALLET_ID, accountId: ACCOUNT_ID }
      )

      expect(migrated.retainedHardware).toBeTruthy()
      expect(migrated.storage.keyDomains).toEqual([
        expect.objectContaining({
          entity: expect.objectContaining({
            id: WALLET_ID,
            source: {
              kind: 'hardware',
              vendor,
              firmwareProfile: vendor === 'ledger' ? 'zcash' : 'cypherpunk',
              capabilities: ['zcash']
            }
          })
        })
      ])
      expect(migrated.storage.chainAccounts).toEqual([
        expect.objectContaining({
          entity: expect.objectContaining({
            derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
            identity: { kind: 'account-identifier', value: ADDRESSES.fullUnified }
          })
        })
      ])
      expect(migrated.credentials.credentialSets).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            source: 'hardware',
            hardware: {
              vendor,
              firmwareProfile: vendor === 'ledger' ? 'zcash' : 'cypherpunk',
              capabilities: ['zcash']
            }
          })
        })
      ])
      expect(migrated.credentials.encryptedCredentialEnvelopes).toHaveLength(1)
      expect(migrated.credentials.credentialTransactionJournals).toEqual([
        expect.objectContaining({ phase: 'complete' })
      ])

      const passwordChange = await popup.evaluate(
        ({ currentPassword, newPassword }) =>
          chrome.runtime.sendMessage({
            type: 'CHANGE_WALLET_PASSWORD',
            currentPassword,
            newPassword
          }),
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
      )
      expect(passwordChange).toEqual({ success: true })

      const oldPasswordUnlock = await popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        PASSWORD
      )
      expect(oldPasswordUnlock).toMatchObject({
        success: false,
        failure: 'wrong_password',
        isLocked: false,
        remainingAttempts: 4
      })

      const changedPasswordUnlock = await popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        NEW_PASSWORD
      )
      expect(changedPasswordUnlock).toMatchObject({
        success: true,
        credentialStatus: 'already-migrated'
      })

      const changed = await popup.evaluate(async () => {
        const readAll = (name: string, stores: readonly string[]) =>
          new Promise<Record<string, unknown[]>>((resolve, reject) => {
            const request = indexedDB.open(name)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction([...stores], 'readonly')
              const result: Record<string, unknown[]> = {}
              let remaining = stores.length
              for (const storeName of stores) {
                const entries = transaction.objectStore(storeName).getAll()
                entries.onerror = () => reject(entries.error)
                entries.onsuccess = () => {
                  result[storeName] = entries.result
                  remaining -= 1
                  if (remaining === 0) {
                    database.close()
                    resolve(result)
                  }
                }
              }
            }
          })
        return readAll('noir-wallet-credential-db', [
          'encryptedCredentialEnvelopes',
          'credentialSets',
          'credentialRetirements',
          'credentialTransactionJournals'
        ])
      })
      expect(changed.encryptedCredentialEnvelopes).toHaveLength(1)
      expect(changed.credentialSets).toHaveLength(2)
      expect(changed.credentialRetirements).toHaveLength(1)
      expect(changed.credentialTransactionJournals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'migrate', phase: 'complete' }),
          expect.objectContaining({ operation: 'change-password', phase: 'complete' })
        ])
      )

      await expect(
        popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
      ).resolves.toEqual({ success: true })
      await popup.close()
      await context.close()
      context = undefined

      context = await launchProfile(userDataDir)
      const restartedExtensionId = await extensionIdFor(context)
      expect(restartedExtensionId).toBe(extensionId)
      popup = await openExtensionPage(context, restartedExtensionId)
      await waitForBackgroundWalletInitialization(popup)
      const secondUnlock = await popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        NEW_PASSWORD
      )
      expect(secondUnlock).toMatchObject({ success: true, credentialStatus: 'already-migrated' })
    } finally {
      await context?.close().catch(() => {})
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
}
