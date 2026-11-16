import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BUILTIN_EVM_NETWORKS } from '../../src/config/networks'
import { extensionDir, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

const PASSWORD = 'mixed-v1-upgrade-password'
const NEW_PASSWORD = 'mixed-v2-changed-password'
const SOFTWARE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SOFTWARE_WALLET_ID = 'wallet:mixed-v1-software'
const SOFTWARE_ACCOUNT_ID = 'account:mixed-v1-software:0'
const HARDWARE_WALLET_ID = 'wallet:mixed-v1-keystone'
const HARDWARE_ACCOUNT_ID = 'account:mixed-v1-keystone:0'
const SOFTWARE_ADDRESSES = Object.freeze({
  transparent: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
  shielded:
    'u14hxpxnwfzfujl6n36gfpr2e90mxzupmaksy3ly7ztgcey8qa06703yutk3m3u46tfkeywk9w69atu6zmdlp0lekh8jpsxmpzngrspf379dtgyvyfggtqlyvcq3wjr5y5xngex2qtsxheywdyzdfalk5clnms8wy3fje0j560wvsjm6d8',
  fullUnified:
    'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
})
const HARDWARE_ADDRESSES = Object.freeze({
  transparent: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
  shielded:
    'u14hxpxnwfzfujl6n36gfpr2e90mxzupmaksy3ly7ztgcey8qa06703yutk3m3u46tfkeywk9w69atu6zmdlp0lekh8jpsxmpzngrspf379dtgyvyfggtqlyvcq3wjr5y5xngex2qtsxheywdyzdfalk5clnms8wy3fje0j560wvsjm6d8',
  fullUnified:
    'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
})
const UFVK =
  'uview1qggz6nejagvka9wtm9r7xf84kkwy4cc0cgchptr98w0cyz33cj4958q5ulkd32nz2u3s0sp9yhcw7tu2n3nlw9x6ulghyd2zgc857tnzme2zpr3vn24zhtm2rjduv9a5zxlmzz404n7l0k69gmu4tfn2g3vpcn03rhz63e3l92fn8gra37tyly7utvgveswl20vz23pu84rc2nyqess38wvlgr2xzyhgj232ne5qutpe6ql6ghzetdy7pfzcmdzd5gd5dnwk25fwv7nnzmnty7u5ax3nzzgr6pdc905ckpd0s9v2cvn7e03qm7r46e5ngax536ywz7zxjptymm90px0rhvmqtwvttuy6d7degly023lqvskclk6mezyt69dwu6c4tfzrjgq4uuh5xa9m5dclgatykgtrrw268qe5pldfkx73f2kd5yyy2tjpjql92pa6tsk2nh2h88q23nee9z379het4akl6haqmuwf9d0nl0susg4tnxyk'
const SEED_FINGERPRINT = '21ed3d7882c7e37fe012b54a6408048048cb09782d4b2938617da793ccd27815'
const SOFTWARE_CHAIN_ACCOUNT_COUNT =
  BUILTIN_EVM_NETWORKS.mainnet.length + BUILTIN_EVM_NETWORKS.testnet.length + 2
const SOFTWARE_ADDRESS_COUNT = SOFTWARE_CHAIN_ACCOUNT_COUNT + 2

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

async function seedMixedV1Profile(page: Page): Promise<void> {
  await waitForBackgroundWalletInitialization(page)
  await page.evaluate(
    async input => {
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
      const encrypt = async (plaintextValue: unknown) => {
        const salt = crypto.getRandomValues(new Uint8Array(16))
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const passwordKey = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(input.password),
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
        const plaintext = new TextEncoder().encode(JSON.stringify(plaintextValue))
        try {
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
          return {
            encryptedData: toBase64(new Uint8Array(encrypted)),
            salt: toBase64(salt),
            iv: toBase64(iv)
          }
        } finally {
          plaintext.fill(0)
        }
      }

      const [softwareEnvelope, hardwareEnvelope] = await Promise.all([
        encrypt({ seedPhrase: input.softwareMnemonic }),
        encrypt({
          ufvk: input.ufvk,
          seedFingerprintHex: input.seedFingerprintHex,
          accountHdIndex: 0
        })
      ])
      await chrome.storage.local.clear()
      await chrome.storage.session.clear()
      await deleteDatabase('noir-wallet-storage-v2-db')
      await deleteDatabase('noir-wallet-credential-db')
      await chrome.storage.local.set({
        wallet_state: {
          state: {
            currentWalletId: input.softwareWalletId,
            currentAccountId: input.softwareAccountId,
            currentNetwork: 'mainnet',
            zecPrice: 0,
            wallets: [
              {
                id: input.softwareWalletId,
                name: 'Software V1 Fixture',
                seedPhraseKey: `seed_${input.softwareWalletId}`,
                accounts: [
                  {
                    id: input.softwareAccountId,
                    name: 'Software Account',
                    addresses: input.softwareAddresses,
                    derivationIndex: 0,
                    birthdayHeight: 2_000_000,
                    isPinned: false,
                    isHidden: false
                  }
                ],
                createdAt: 1_700_000_000_000,
                isPinned: false,
                keySource: 'software'
              },
              {
                id: input.hardwareWalletId,
                name: 'Keystone V1 Fixture',
                seedPhraseKey: '',
                accounts: [
                  {
                    id: input.hardwareAccountId,
                    name: 'Keystone Account',
                    addresses: input.hardwareAddresses,
                    derivationIndex: 0,
                    birthdayHeight: 2_000_000,
                    isPinned: false,
                    isHidden: false
                  }
                ],
                createdAt: 1_700_000_000_001,
                isPinned: false,
                keySource: 'keystone'
              }
            ],
            accountDisplayNames: {}
          },
          version: 0
        },
        [`seed_${input.softwareWalletId}`]: softwareEnvelope,
        [`hw_${input.hardwareWalletId}`]: hardwareEnvelope
      })
    },
    {
      password: PASSWORD,
      softwareMnemonic: SOFTWARE_MNEMONIC,
      softwareWalletId: SOFTWARE_WALLET_ID,
      softwareAccountId: SOFTWARE_ACCOUNT_ID,
      softwareAddresses: SOFTWARE_ADDRESSES,
      hardwareWalletId: HARDWARE_WALLET_ID,
      hardwareAccountId: HARDWARE_ACCOUNT_ID,
      hardwareAddresses: HARDWARE_ADDRESSES,
      ufvk: UFVK,
      seedFingerprintHex: SEED_FINGERPRINT
    }
  )
}

async function inspectV2(page: Page) {
  return page.evaluate(async () => {
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
    const activeGenerationId = await new Promise<string>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-storage-v2-db')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('metadata', 'readonly')
        const pointer = transaction.objectStore('metadata').get('active-pointer')
        pointer.onerror = () => reject(pointer.error)
        pointer.onsuccess = () => {
          const generationId = (pointer.result as { generationId?: unknown } | undefined)
            ?.generationId
          if (typeof generationId !== 'string') {
            reject(new Error('Active Storage V2 pointer is missing'))
            return
          }
          resolve(generationId)
        }
        transaction.oncomplete = () => database.close()
      }
    })
    for (const storeName of ['keyDomains', 'accounts', 'chainAccounts', 'addresses']) {
      storage[storeName] = storage[storeName].filter(
        record => (record as { generationId?: unknown }).generationId === activeGenerationId
      )
    }
    const credentials = await readAll('noir-wallet-credential-db', [
      'encryptedCredentialEnvelopes',
      'credentialSets',
      'credentialRetirements',
      'credentialTransactionJournals'
    ])
    return { storage, credentials }
  })
}

test('migrates mixed retained software and Keystone Wallets through real MV3', async () => {
  test.setTimeout(300_000)
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-v1-mixed-upgrade-'))
  let context: BrowserContext | undefined

  try {
    context = await launchProfile(userDataDir)
    const extensionId = await extensionIdFor(context)
    const setupPage = await openExtensionPage(context, extensionId)
    await seedMixedV1Profile(setupPage)
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

    const migrated = await inspectV2(popup)
    expect(migrated.storage.keyDomains).toHaveLength(2)
    expect(
      migrated.storage.keyDomains.map(record => (record as { entity: unknown }).entity)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SOFTWARE_WALLET_ID,
          source: { kind: 'software', mnemonicWordCount: 12 }
        }),
        expect.objectContaining({
          id: HARDWARE_WALLET_ID,
          source: {
            kind: 'hardware',
            vendor: 'keystone',
            firmwareProfile: 'cypherpunk',
            capabilities: ['zcash']
          }
        })
      ])
    )
    expect(migrated.storage.accounts).toHaveLength(2)
    expect(migrated.storage.chainAccounts).toHaveLength(SOFTWARE_CHAIN_ACCOUNT_COUNT + 1)
    expect(migrated.storage.addresses).toHaveLength(SOFTWARE_ADDRESS_COUNT + 3)
    expect(migrated.credentials.credentialSets).toHaveLength(2)
    expect(migrated.credentials.encryptedCredentialEnvelopes).toHaveLength(3)
    expect(migrated.credentials.credentialTransactionJournals).toEqual([
      expect.objectContaining({
        operation: 'migrate',
        phase: 'complete',
        transitions: expect.any(Array)
      })
    ])
    expect(
      (migrated.credentials.credentialTransactionJournals[0] as { transitions: unknown[] })
        .transitions
    ).toHaveLength(2)

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
    expect(oldPasswordUnlock).not.toHaveProperty('success', true)
    const changedPasswordUnlock = await popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      NEW_PASSWORD
    )
    expect(changedPasswordUnlock).toMatchObject({
      success: true,
      credentialStatus: 'already-synchronized'
    })

    const changed = await inspectV2(popup)
    expect(changed.credentials.encryptedCredentialEnvelopes).toHaveLength(3)
    expect(changed.credentials.credentialSets).toHaveLength(4)
    expect(changed.credentials.credentialRetirements).toHaveLength(2)
    expect(changed.credentials.credentialTransactionJournals).toEqual(
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
    const restartedUnlock = await popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      NEW_PASSWORD
    )
    expect(restartedUnlock).toMatchObject({
      success: true,
      credentialStatus: 'already-synchronized'
    })
    const restarted = await inspectV2(popup)
    expect(restarted.credentials.credentialSets).toHaveLength(4)
    expect(restarted.credentials.credentialTransactionJournals).toHaveLength(2)
  } finally {
    await context?.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true })
  }
})
