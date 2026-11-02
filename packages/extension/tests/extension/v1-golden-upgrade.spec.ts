import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionDir, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

type SerializedBytes = { readonly type: 'bytes'; readonly base64: string }
type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedBytes
  | readonly SerializedValue[]
  | { readonly [key: string]: SerializedValue }

type GoldenProfile = {
  readonly schemaVersion: 1
  readonly source: { readonly tag: string; readonly commit: string }
  readonly password: string
  readonly local: Readonly<Record<string, unknown>>
  readonly indexedDb: Readonly<
    Record<string, readonly { readonly key: SerializedValue; readonly value: SerializedValue }[]>
  >
  readonly expected: {
    readonly walletId: string
    readonly accountId: string
    readonly addresses: {
      readonly transparent: string
      readonly shielded: string
      readonly fullUnified: string
    }
    readonly birthdayHeight: number
  }
}

const profilePath = fileURLToPath(
  new URL('../fixtures/v1.0.30-mainnet-software-golden.json', import.meta.url)
)
const golden = JSON.parse(readFileSync(profilePath, 'utf8')) as GoldenProfile

if (
  golden.schemaVersion !== 1 ||
  golden.source.tag !== 'v1.0.30' ||
  golden.source.commit !== 'a623a1c39f89b44a139ebadfcd3e3441de0b7cf9'
) {
  throw new Error('Unexpected V1 Golden Profile provenance')
}

async function launchProfile(
  userDataDir: string,
  loadedExtensionDir = extensionDir
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${loadedExtensionDir}`,
      `--load-extension=${loadedExtensionDir}`
    ]
  })
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return new URL(worker.url()).host
}

async function reloadUnpackedExtension(
  context: BrowserContext,
  extensionId: string
): Promise<void> {
  const extensionsPage = await context.newPage()
  try {
    await extensionsPage.goto('chrome://extensions/')
    const toolbar = extensionsPage.locator('extensions-manager extensions-toolbar')
    const developerMode = toolbar.locator('#devMode')
    if ((await developerMode.getAttribute('checked')) === null) {
      await developerMode.click()
    }

    const extensionItem = extensionsPage.locator(`extensions-item#${extensionId}`)
    await expect(extensionItem).toBeVisible()
    await extensionItem.locator('#dev-reload-button').click()
  } finally {
    await extensionsPage.close()
  }
}

async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  route = '',
  options: { readonly waitForReload?: boolean } = {}
): Promise<Page> {
  const page = await context.newPage()
  await page.setViewportSize({ width: 375, height: 600 })
  const url = `chrome-extension://${extensionId}/index.html${route}`
  if (options.waitForReload) {
    await expect
      .poll(
        async () => {
          try {
            await page.goto(url)
            return true
          } catch (error) {
            if (error instanceof Error && error.message.includes('ERR_BLOCKED_BY_CLIENT')) {
              return false
            }
            throw error
          }
        },
        { timeout: 30_000, intervals: [100, 250, 500, 1_000] }
      )
      .toBe(true)
  } else {
    await page.goto(url)
  }
  return page
}

async function seedGoldenProfile(
  page: Page,
  options: { readonly waitForBackgroundInitialization?: boolean } = {}
): Promise<void> {
  if (options.waitForBackgroundInitialization !== false) {
    await waitForBackgroundWalletInitialization(page)
  }
  await page.evaluate(async profile => {
    const deleteDatabase = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () =>
          reject(new Error(`Golden Profile database deletion blocked: ${name}`))
      })

    await chrome.storage.local.clear()
    await chrome.storage.session.clear()
    await deleteDatabase('zcash-wallet-db')

    const decode = (value: SerializedValue): unknown => {
      if (
        value &&
        !Array.isArray(value) &&
        typeof value === 'object' &&
        value.type === 'bytes' &&
        typeof value.base64 === 'string'
      ) {
        const binary = atob(value.base64)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index)
        }
        return bytes
      }
      if (Array.isArray(value)) return value.map(decode)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]))
      }
      return value
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zcash-wallet-db', 5)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('walletData')
        database.createObjectStore('transactions')
        database.createObjectStore('transparentTransactionCache')
        const journal = database.createObjectStore('syncJournal', {
          keyPath: ['walletKey', 'seq']
        })
        journal.createIndex('byWallet', 'walletKey', { unique: false })
        database.createObjectStore('syncJournalManifest')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    await new Promise<void>((resolve, reject) => {
      const storeNames = Object.keys(profile.indexedDb)
      const transaction = database.transaction(storeNames, 'readwrite')
      for (const storeName of storeNames) {
        const store = transaction.objectStore(storeName)
        for (const entry of profile.indexedDb[storeName]) {
          const value = decode(entry.value)
          if (store.keyPath === null) {
            store.put(value, decode(entry.key) as IDBValidKey)
          } else {
            store.put(value)
          }
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
    await chrome.storage.local.set(profile.local)
  }, golden)
}

async function inspectRetainedV1Data(page: Page) {
  return page.evaluate(async expected => {
    const local = await chrome.storage.local.get(['wallet_state', `seed_${expected.walletId}`])
    const walletState =
      typeof local.wallet_state === 'string' ? JSON.parse(local.wallet_state) : local.wallet_state

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zcash-wallet-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const dbKey = `mainnet_${expected.walletId}`
    const transaction = database.transaction('walletData', 'readonly')
    const store = transaction.objectStore('walletData')
    const [manifest, chunk] = await Promise.all(
      [dbKey, `${dbKey}::c::0`].map(
        key =>
          new Promise<unknown>((resolve, reject) => {
            const request = store.get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
      )
    )
    const quarantine = database.objectStoreNames.contains('walletPersistenceQuarantine')
      ? await new Promise<unknown>((resolve, reject) => {
          const request = database
            .transaction('walletPersistenceQuarantine', 'readonly')
            .objectStore('walletPersistenceQuarantine')
            .get(dbKey)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      : undefined
    const version = database.version
    database.close()

    const chunkBytes = chunk instanceof Uint8Array ? chunk : new Uint8Array()
    const chunkDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', chunkBytes))
    )
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')

    return {
      version,
      currentWalletId: walletState?.state?.currentWalletId,
      currentAccountId: walletState?.state?.currentAccountId,
      addresses: walletState?.state?.wallets?.[0]?.accounts?.[0]?.addresses,
      envelope: local[`seed_${expected.walletId}`],
      manifest,
      quarantine,
      chunkLength: chunkBytes.byteLength,
      chunkDigest
    }
  }, golden.expected)
}

async function openIntegrationPage(page: Page, extensionId: string): Promise<void> {
  await page.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => page.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
}

test('upgrades the frozen v1.0.30 Golden Profile and remains idempotent after restart', async () => {
  const v1ExtensionDir = process.env.V1_EXTENSION_DIR?.trim()
  test.setTimeout(v1ExtensionDir ? 900_000 : 240_000)
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-v1-golden-upgrade-'))
  const stagedRoot = v1ExtensionDir
    ? await mkdtemp(path.join(tmpdir(), 'noir-v1-binary-upgrade-'))
    : undefined
  const loadedExtensionDir = stagedRoot ? path.join(stagedRoot, 'extension') : extensionDir
  let context: BrowserContext | undefined
  let v1SyncedSnapshot: Awaited<ReturnType<typeof inspectRetainedV1Data>> | undefined

  try {
    if (v1ExtensionDir) {
      const v1Manifest = JSON.parse(
        readFileSync(path.join(v1ExtensionDir, 'manifest.json'), 'utf8')
      ) as { version?: unknown }
      expect(v1Manifest.version).toBe('1.0.31')
      await cp(v1ExtensionDir, loadedExtensionDir, { recursive: true })
    }

    context = await launchProfile(userDataDir, loadedExtensionDir)
    const extensionId = await getExtensionId(context)
    const setupPage = await openExtensionPage(context, extensionId, '?v1-golden-setup=1')
    await seedGoldenProfile(setupPage, {
      waitForBackgroundInitialization: !v1ExtensionDir
    })
    await setupPage.close()
    await context.close()
    context = undefined

    if (v1ExtensionDir) {
      context = await launchProfile(userDataDir, loadedExtensionDir)
      const v1ExtensionId = await getExtensionId(context)
      expect(v1ExtensionId).toBe(extensionId)
      const v1Popup = await openExtensionPage(context, v1ExtensionId, '?v1-live-sync=1')

      const unlockV1 = await v1Popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        golden.password
      )
      expect(unlockV1).toMatchObject({ success: true })
      await v1Popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC' }))

      await expect
        .poll(
          () =>
            v1Popup.evaluate(async expected => {
              const state = await chrome.runtime.sendMessage({
                type: 'GET_SYNC_STATE',
                walletId: expected.walletId,
                accountId: expected.accountId
              })
              const currentHeight = Number(state?.currentHeight || 0)
              const latestHeight = Number(state?.latestHeight || 0)
              return (
                state?.isSyncing !== true &&
                currentHeight >= expected.birthdayHeight &&
                latestHeight >= currentHeight
              )
            }, golden.expected),
          { timeout: 600_000, intervals: [500, 1_000, 2_000, 5_000] }
        )
        .toBe(true)

      const completedSync = await v1Popup.evaluate(async expected => {
        const state = await chrome.runtime.sendMessage({
          type: 'GET_SYNC_STATE',
          walletId: expected.walletId,
          accountId: expected.accountId
        })
        return {
          currentHeight: Number(state?.currentHeight || 0),
          latestHeight: Number(state?.latestHeight || 0)
        }
      }, golden.expected)
      expect(completedSync.currentHeight).toBeGreaterThanOrEqual(golden.expected.birthdayHeight)
      expect(completedSync.latestHeight).toBeGreaterThanOrEqual(completedSync.currentHeight)

      v1SyncedSnapshot = await inspectRetainedV1Data(v1Popup)
      expect(
        v1SyncedSnapshot.chunkLength !== 20_449 ||
          v1SyncedSnapshot.chunkDigest !==
            '8686bc54fd5504946c4a611faf25670946c236631d37ce99298234f324e0bf76'
      ).toBe(true)
      await rm(loadedExtensionDir, { recursive: true, force: true })
      await cp(extensionDir, loadedExtensionDir, { recursive: true })
      await reloadUnpackedExtension(context, extensionId)
    } else {
      context = await launchProfile(userDataDir, loadedExtensionDir)
    }

    const upgradedExtensionId = await getExtensionId(context)
    expect(upgradedExtensionId).toBe(extensionId)
    const popup = await openExtensionPage(context, upgradedExtensionId, '?v1-golden-upgrade=1', {
      waitForReload: Boolean(v1ExtensionDir)
    })
    expect(await popup.evaluate(() => chrome.runtime.getManifest().version)).toBe('2.0.0')
    await waitForBackgroundWalletInitialization(popup)

    const retainedBeforeUnlock = await inspectRetainedV1Data(popup)
    expect(retainedBeforeUnlock).toMatchObject({
      version: 9,
      currentWalletId: golden.expected.walletId,
      currentAccountId: golden.expected.accountId,
      addresses: golden.expected.addresses
    })
    if (v1SyncedSnapshot) {
      expect(retainedBeforeUnlock.manifest).toEqual(v1SyncedSnapshot.manifest)
      expect(retainedBeforeUnlock.chunkLength).toBe(v1SyncedSnapshot.chunkLength)
      expect(retainedBeforeUnlock.chunkDigest).toBe(v1SyncedSnapshot.chunkDigest)
    } else {
      expect(retainedBeforeUnlock).toMatchObject({
        manifest: {
          metadata: {
            version: 1,
            network: 'mainnet',
            walletId: golden.expected.walletId
          },
          chunked: true,
          chunkCount: 1,
          chunkSizes: [20_449],
          totalBytes: 20_449
        },
        chunkLength: 20_449,
        chunkDigest: '8686bc54fd5504946c4a611faf25670946c236631d37ce99298234f324e0bf76'
      })
    }
    expect(retainedBeforeUnlock.envelope).toEqual(golden.local[`seed_${golden.expected.walletId}`])
    expect(retainedBeforeUnlock.quarantine).toBeUndefined()

    const wrongPassword = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password: 'wrong-golden-password' })
    )
    expect(wrongPassword?.success).not.toBe(true)
    expect((await inspectRetainedV1Data(popup)).envelope).toEqual(retainedBeforeUnlock.envelope)

    const unlock = await popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      golden.password
    )
    expect(unlock).toMatchObject({ success: true, credentialStatus: 'migrated' })
    const retainedAfterUnlock = await inspectRetainedV1Data(popup)
    expect(retainedAfterUnlock.envelope).toEqual(retainedBeforeUnlock.envelope)
    expect(retainedAfterUnlock.quarantine).toBeUndefined()

    await openIntegrationPage(popup, upgradedExtensionId)
    const firstProvisioning = await popup.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
    )
    expect(firstProvisioning).toMatchObject({
      mainKeyDomainId: golden.expected.walletId,
      activeAccount: {
        keyDomainId: golden.expected.walletId,
        accountId: golden.expected.accountId
      },
      keyDomainIds: [golden.expected.walletId],
      accountIds: [golden.expected.accountId],
      credentialPolicies: [
        {
          keyDomainId: golden.expected.walletId,
          source: 'software',
          mnemonicWordCount: 24,
          zcashSeedPolicy: 'direct-bip39-v1'
        }
      ]
    })
    expect(firstProvisioning.activeGenerationId).not.toBeNull()
    expect(firstProvisioning.chainAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
          path: "m/32'/133'/0'",
          identity: golden.expected.addresses.fullUnified
        }),
        expect.objectContaining({
          chainId: 'eip155:1',
          path: "m/44'/60'/0'/0/0",
          identity: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        }),
        expect.objectContaining({
          chainId: 'bip122:000000000019d6689c085ae165831e93',
          path: "m/84'/0'/0'/0/0",
          identity: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6'
        })
      ])
    )
    await popup.close()
    await context.close()
    context = undefined

    context = await launchProfile(userDataDir, loadedExtensionDir)
    const restartedExtensionId = await getExtensionId(context)
    expect(restartedExtensionId).toBe(extensionId)
    const restartedPopup = await openExtensionPage(
      context,
      restartedExtensionId,
      '?v1-golden-restart=1'
    )
    await waitForBackgroundWalletInitialization(restartedPopup)
    await expect(
      restartedPopup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' })
      )
    ).resolves.toEqual({ active: false })

    const secondUnlock = await restartedPopup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      golden.password
    )
    expect(secondUnlock).toMatchObject({ success: true })
    await openIntegrationPage(restartedPopup, restartedExtensionId)
    const secondProvisioning = await restartedPopup.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
    )
    expect(secondProvisioning.activeGenerationId).toBe(firstProvisioning.activeGenerationId)
    expect(secondProvisioning.keyDomainIds).toEqual([golden.expected.walletId])
    expect(secondProvisioning.accountIds).toEqual([golden.expected.accountId])

    const retainedAfterRestart = await inspectRetainedV1Data(restartedPopup)
    expect(retainedAfterRestart.envelope).toEqual(retainedBeforeUnlock.envelope)
    expect(retainedAfterRestart.quarantine).toBeUndefined()
    const legacySession = await restartedPopup.evaluate(() =>
      chrome.storage.session.get(['session_password', 'session_key_material'])
    )
    expect(legacySession).toEqual({})
    await restartedPopup.close()
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
    if (stagedRoot) await rm(stagedRoot, { recursive: true, force: true })
  }
})
