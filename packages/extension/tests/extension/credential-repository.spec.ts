import type { Page } from '@playwright/test'
import {
  captureScreenshot,
  expect,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

interface CredentialPasswordChangeIntegrationResult {
  readonly ok: boolean
  readonly code?: string
  readonly result?: Readonly<{
    readonly status: string
    readonly generationId: string
  }>
  readonly journalPhase?: string | null
  readonly activeGenerationId: string | null
  readonly sourceRetired?: boolean
  readonly sourceZcashEnvelopePresent?: boolean | null
  readonly targetActivation?: string | null
  readonly local: Readonly<Record<string, unknown>>
}

type CredentialRepositoryIntegration = {
  reset(databaseName: string): Promise<void>
  stageAfterInterruption(databaseName: string): Promise<unknown>
  resumeAndVerify(databaseName: string): Promise<unknown>
  raceJournalAdvance(databaseName: string): Promise<unknown>
  corruptAndRead(databaseName: string): Promise<unknown>
  migrateCanonicalMnemonic24(password: string): Promise<unknown>
  migrateV1Credential(
    password: string,
    suppliedPassword?: string,
    expectedTransparent?: string,
    expectedShielded?: string,
    expectedFullUnified?: string
  ): Promise<{ readonly ok: boolean; readonly result?: unknown; readonly code?: string }>
  migrateRotatedV1Credential(
    password: string
  ): Promise<{ readonly ok: boolean; readonly result?: unknown; readonly code?: string }>
  migrateMismatchedFullUnifiedV1Credential(
    password: string
  ): Promise<{ readonly ok: boolean; readonly result?: unknown; readonly code?: string }>
  verifyV1CredentialEnvelope(envelope: unknown, password: string): Promise<boolean>
  rewrapV1Credential(currentPassword: string, targetPassword: string): Promise<unknown>
  prepareRetainedMigrationFixture(
    password: string,
    wordCount?: 12 | 24,
    options?: Readonly<{
      network?: 'mainnet' | 'testnet'
      addresses?: Readonly<{
        transparent: string
        shielded: string
        fullUnified: string
      }>
    }>
  ): Promise<Readonly<Record<string, unknown>>>
  prepareRotatedRetainedMigrationFixture(password: string): Promise<
    Readonly<{
      local: Readonly<Record<string, unknown>>
      expected: Readonly<{
        transparent: string
        shielded: string
        fullUnified: string
      }>
    }>
  >
  prepareRetainedInventoryFixture(password: string): Promise<{
    readonly initial: Readonly<Record<string, unknown>>
    readonly target: Readonly<Record<string, unknown>>
    readonly walletId: string
    readonly accountId: string
  }>
  prepareRetainedAccountInventoryFixture(password: string): Promise<{
    readonly initial: Readonly<Record<string, unknown>>
    readonly target: Readonly<Record<string, unknown>>
    readonly walletId: string
    readonly accountId: string
  }>
  prepareProductionV1WalletAndAccountInventory(password: string): Promise<{
    readonly walletId: string
    readonly accountIds: readonly [string, string]
    readonly previousWalletId: string
    readonly previousAccountId: string
  }>
  runRetainedMigration(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    local: Readonly<Record<string, unknown>>,
    password: string,
    interrupt?: 'none' | 'after-stage' | 'after-commit'
  ): Promise<unknown>
  runRetainedInventorySync(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    initial: Readonly<Record<string, unknown>>,
    target: Readonly<Record<string, unknown>>,
    password: string,
    interrupt?: 'none' | 'after-stage' | 'after-commit'
  ): Promise<unknown>
  initializeCredentialRemoval(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    initial: Readonly<Record<string, unknown>>,
    target: Readonly<Record<string, unknown>>,
    password: string
  ): Promise<unknown>
  runCredentialRemoval(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    target:
      | Readonly<{ kind: 'account'; keyDomainId: string; accountId: string }>
      | Readonly<{ kind: 'wallet'; keyDomainId: string }>,
    interrupt?: 'none' | 'after-stage' | 'after-commit'
  ): Promise<unknown>
  runRetainedV1Reconciliation(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    desired: Readonly<Record<string, unknown>>,
    password: string
  ): Promise<unknown>
  resetRetainedMigrationDatabases(
    credentialDatabaseName: string,
    storageDatabaseName: string
  ): Promise<void>
  initializeCredentialPasswordChange(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    password: string
  ): Promise<Readonly<Record<string, unknown>>>
  runCredentialPasswordChange(
    credentialDatabaseName: string,
    storageDatabaseName: string,
    local: Readonly<Record<string, unknown>>,
    currentPassword: string,
    newPassword: string,
    interrupt?: 'none' | 'after-stage' | 'after-commit'
  ): Promise<CredentialPasswordChangeIntegrationResult>
  prepareProductionV2PasswordChange(currentPassword: string): Promise<unknown>
  prepareProductionV1Migration(
    password: string,
    wordCount?: 12 | 24,
    corruptZcashAnchor?: boolean,
    options?: Readonly<{
      network?: 'mainnet' | 'testnet'
      addresses?: Readonly<{
        transparent: string
        shielded: string
        fullUnified: string
      }>
    }>
  ): Promise<{
    readonly walletId: string
    readonly wordCount: 12 | 24
    readonly network: 'mainnet' | 'testnet'
  }>
  inspectProductionV2Provisioning(): Promise<{
    readonly activeGenerationId: string | null
    readonly mainKeyDomainId: string | null
    readonly activeAccount: unknown
    readonly keyDomainIds: readonly string[]
    readonly accountIds: readonly string[]
    readonly chainAccounts: readonly Readonly<{
      keyDomainId: string
      accountId: string
      chainId: string
      path: string
      identity: string
    }>[]
    readonly addressSchemes: readonly string[]
    readonly credentialPolicies: readonly Readonly<{
      keyDomainId: string
      source: string | null
      mnemonicWordCount: number | null
      zcashSeedPolicy: string | null
    }>[]
  }>
  productionCredentialAuthentication(password?: string): Promise<
    readonly Readonly<{
      keyDomainId: string
      generationId: string
      format: 'legacy' | 'authenticated'
      aadSchemaVersions: readonly number[]
      engineFormats: readonly number[]
      verified: boolean
    }>[]
  >
  downgradeProductionCredentialAuthenticationToLegacy(password: string): Promise<
    readonly Readonly<{
      keyDomainId: string
      generationId: string
      format: 'legacy' | 'authenticated'
      aadSchemaVersions: readonly number[]
      engineFormats: readonly number[]
      verified: boolean
    }>[]
  >
  tamperProductionCredentialEnvelope(): Promise<void>
  inspectProductionActiveWalletSet(): Promise<{
    readonly generationId: string
    readonly activeAccountId: string | null
    readonly availableChainAccounts: readonly Readonly<{
      chainId: string
      chainAccountId: string
      addressSchemes: readonly string[]
      preferredReceiveAddressIds: readonly string[]
    }>[]
  } | null>
  inspectProductionV2PasswordChange(currentPassword: string, newPassword: string): Promise<unknown>
  prepareProductionV2Removal(
    password: string,
    kind: 'account' | 'wallet'
  ): Promise<
    Readonly<{
      kind: 'account' | 'wallet'
      walletId: string
      accountId: string
      credentialSetRef: string
    }>
  >
  inspectProductionV2Removal(
    target: Readonly<{
      kind: 'account' | 'wallet'
      walletId: string
      accountId: string
      credentialSetRef: string
    }>
  ): Promise<unknown>
  inspectProductionV2DatabasePresence(): Promise<{
    credentialDatabasePresent: boolean
    storageDatabasePresent: boolean
  }>
  stageStorageV2(databaseName: string, generationId: string): Promise<unknown>
  readAndCommitStorageV2(databaseName: string, generationId: string): Promise<unknown>
  raceStorageV2Commit(databaseName: string): Promise<{
    readonly results: readonly string[]
    readonly activeGenerationId: string | null
  }>
}

declare global {
  interface Window {
    credentialRepositoryIntegration?: CredentialRepositoryIntegration
  }
}

async function openIntegrationPage(popup: Page, extensionId: string): Promise<void> {
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
}

async function readActivityCacheKeys(popup: Page, seedKeys: readonly string[] = []) {
  return popup.evaluate(async keys => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-activity-history-cache', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<IDBValidKey[]>((resolve, reject) => {
        const transaction = database.transaction('records', keys.length ? 'readwrite' : 'readonly')
        const store = transaction.objectStore('records')
        for (const key of keys) {
          store.put({ schemaVersion: 2, refreshedAtByChainId: {}, items: [] }, key)
        }
        const request = store.getAllKeys()
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = transaction.onerror = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
  }, seedKeys)
}

test('keeps the 24-word Account 0 vector identical across both real WASM engines', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await openIntegrationPage(popup, extensionId)
  const result = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.migrateCanonicalMnemonic24('canonical-24-password')
  )
  expect(result).toMatchObject({
    operation: 'migrate',
    mnemonicWordCount: 24,
    vault: { version: 2, kdf: 'argon2id', cipher: 'xchacha20poly1305' },
    accounts: [
      {
        accountIndex: 0,
        zcash: {
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
          derivationPath: "m/32'/133'/0'",
          identity:
            'u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g'
        },
        evm: {
          chainId: 'eip155:1',
          derivationPath: "m/44'/60'/0'/0/0",
          identity: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        },
        bitcoin: {
          chainId: 'bip122:000000000019d6689c085ae165831e93',
          derivationPath: "m/84'/0'/0'/0/0",
          identity: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6'
        }
      }
    ]
  })
  expect(JSON.stringify(result)).not.toContain('abandon')
})

test('persists and resumes a staged CredentialSet in the real extension origin', async ({
  popup,
  extensionId
}) => {
  const databaseName = `credential-repository-resume-${crypto.randomUUID()}`
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), databaseName)
  await expect(
    popup.evaluate(
      name => window.credentialRepositoryIntegration!.stageAfterInterruption(name),
      databaseName
    )
  ).resolves.toEqual({ journal: 'created', zcash: 'created' })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      name => window.credentialRepositoryIntegration!.resumeAndVerify(name),
      databaseName
    )
  ).resolves.toEqual({
    multichain: 'created',
    set: 'created',
    advanced: 'advanced',
    zcashBytes: [11, 12, 13],
    credentialSetRef: 'set:credential-repository-e2e',
    activation: { status: 'transaction-not-committed' }
  })
  await popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), databaseName)
})

test('migrates a V1 envelope inside the one-shot Compatibility Worker', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await openIntegrationPage(popup, extensionId)
  const legacyPassword = `legacy-${'\u5bc6'.repeat(600)}`
  const migrated = await popup.evaluate(
    password => window.credentialRepositoryIntegration!.migrateV1Credential(password),
    legacyPassword
  )
  expect(migrated).toMatchObject({
    ok: true,
    result: {
      mnemonicWordCount: 12,
      vault: { version: 2, kdf: 'argon2id', cipher: 'xchacha20poly1305' },
      accounts: [
        {
          accountIndex: 0,
          zcash: {
            chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
            derivationPath: "m/32'/133'/0'",
            identity:
              'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
          },
          evm: {
            chainId: 'eip155:1',
            derivationPath: "m/44'/60'/0'/0/0",
            identity: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
          },
          bitcoin: {
            chainId: 'bip122:000000000019d6689c085ae165831e93',
            derivationPath: "m/84'/0'/0'/0/0",
            identity: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
          }
        }
      ]
    }
  })
  expect(JSON.stringify(migrated)).not.toContain('abandon')
  await expect(
    popup.evaluate(
      password =>
        window.credentialRepositoryIntegration!.migrateV1Credential(password, 'wrong-password'),
      legacyPassword
    )
  ).resolves.toEqual({ ok: false, code: 'DECRYPTION_FAILED' })
  await expect(
    popup.evaluate(
      password =>
        window.credentialRepositoryIntegration!.migrateV1Credential(
          password,
          password,
          't1WrongExpectedAddress11111111111111111'
        ),
      legacyPassword
    )
  ).resolves.toEqual({ ok: false, code: 'MIGRATION_FAILED' })
  await expect(
    popup.evaluate(
      password =>
        window.credentialRepositoryIntegration!.migrateV1Credential(
          password,
          password,
          undefined,
          'u1WrongExpectedShieldedAddress11111111111111111'
        ),
      legacyPassword
    )
  ).resolves.toEqual({ ok: false, code: 'MIGRATION_FAILED' })

  await expect(
    popup.evaluate(
      password => window.credentialRepositoryIntegration!.migrateRotatedV1Credential(password),
      legacyPassword
    )
  ).resolves.toMatchObject({ ok: true })
  await expect(
    popup.evaluate(
      password =>
        window.credentialRepositoryIntegration!.migrateMismatchedFullUnifiedV1Credential(password),
      legacyPassword
    )
  ).resolves.toEqual({ ok: false, code: 'MIGRATION_FAILED' })
})

test('rewraps retained V1 and Multichain credentials without returning the mnemonic', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await openIntegrationPage(popup, extensionId)
  const result = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.rewrapV1Credential('current password', 'next password')
  )
  expect(result).toMatchObject({
    ok: true,
    acceptsNewPassword: true,
    acceptsOldPassword: false,
    resumedVaultMatches: true,
    result: {
      operation: 'change-password',
      vault: { version: 2, kdf: 'argon2id', cipher: 'xchacha20poly1305' },
      retainedV1Envelope: {
        encryptedData: expect.any(String),
        salt: expect.any(String),
        iv: expect.any(String)
      },
      accounts: [
        {
          evm: {
            derivationPath: "m/44'/60'/0'/0/0",
            identity: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
          },
          bitcoin: {
            derivationPath: "m/84'/0'/0'/0/0",
            identity: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
          }
        }
      ]
    }
  })
  expect(JSON.stringify(result)).not.toContain('abandon')
})

test('changes every V2 software credential and removes retired ciphertext in real IndexedDB', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(300_000)
  const credentialDatabaseName = `password-change-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `password-change-storage-${crypto.randomUUID()}`
  const currentPassword = 'current-v2-password'
  const newPassword = 'new-v2-password'
  await openIntegrationPage(popup, extensionId)
  const local = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, currentPassword }) =>
      window.credentialRepositoryIntegration!.initializeCredentialPasswordChange(
        credentialDatabaseName,
        storageDatabaseName,
        currentPassword
      ),
    { credentialDatabaseName, storageDatabaseName, currentPassword }
  )
  const changed = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, local, currentPassword, newPassword }) =>
      window.credentialRepositoryIntegration!.runCredentialPasswordChange(
        credentialDatabaseName,
        storageDatabaseName,
        local,
        currentPassword,
        newPassword
      ),
    { credentialDatabaseName, storageDatabaseName, local, currentPassword, newPassword }
  )
  expect(changed).toMatchObject({
    ok: true,
    result: { status: 'committed' },
    journalPhase: 'complete',
    sourceRetired: true,
    sourceZcashEnvelopePresent: false,
    targetActivation: 'active'
  })
  expect(changed.activeGenerationId).toBe(changed.result?.generationId)
  const retainedEnvelope = changed.local['seed_wallet:retained-v1-e2e']
  await expect(
    popup.evaluate(
      ({ retainedEnvelope, newPassword }) =>
        window.credentialRepositoryIntegration!.verifyV1CredentialEnvelope(
          retainedEnvelope,
          newPassword
        ),
      { retainedEnvelope, newPassword }
    )
  ).resolves.toBe(true)
  await expect(
    popup.evaluate(
      ({ retainedEnvelope, currentPassword }) =>
        window.credentialRepositoryIntegration!.verifyV1CredentialEnvelope(
          retainedEnvelope,
          currentPassword
        ),
      { retainedEnvelope, currentPassword }
    )
  ).resolves.toBe(false)
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('routes the production password message through V2 and destroys the old session', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(300_000)
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.prepareProductionV2PasswordChange(
      'production-current-password'
    )
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'WALLET_CREATED',
        password: 'production-current-password'
      })
    )
  ).resolves.toMatchObject({ success: true })
  const unlockResponse = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'WALLET_UNLOCK',
      password: 'production-current-password'
    })
  )
  expect(unlockResponse).toMatchObject({ success: true })
  const changeResponse = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'CHANGE_WALLET_PASSWORD',
      currentPassword: 'production-current-password',
      newPassword: 'production-new-password'
    })
  )
  expect(changeResponse).toMatchObject({ success: true })
  await openIntegrationPage(popup, extensionId)
  await expect(
    popup.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2PasswordChange(
        'production-current-password',
        'production-new-password'
      )
    )
  ).resolves.toMatchObject({
    sessionPassword: null,
    acceptsNewPassword: true,
    acceptsOldPassword: false,
    pendingPhase: null,
    activeGenerationId: expect.stringContaining('storage-v2:change-password:')
  })
})

for (const scenario of [
  { interrupt: 'after-stage' as const, error: 'TEST_INTERRUPT_AFTER_STAGE' },
  { interrupt: 'after-commit' as const, error: 'TEST_INTERRUPT_AFTER_COMMIT' }
]) {
  test(`recovers V2 password change ${scenario.interrupt}`, async ({ popup, extensionId }) => {
    test.setTimeout(300_000)
    const credentialDatabaseName = `password-change-interrupt-credential-${crypto.randomUUID()}`
    const storageDatabaseName = `password-change-interrupt-storage-${crypto.randomUUID()}`
    const currentPassword = 'interrupted-current-password'
    const newPassword = 'interrupted-new-password'
    await openIntegrationPage(popup, extensionId)
    const local = await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, currentPassword }) =>
        window.credentialRepositoryIntegration!.initializeCredentialPasswordChange(
          credentialDatabaseName,
          storageDatabaseName,
          currentPassword
        ),
      { credentialDatabaseName, storageDatabaseName, currentPassword }
    )
    const interrupted = await popup.evaluate(
      ({
        credentialDatabaseName,
        storageDatabaseName,
        local,
        currentPassword,
        newPassword,
        interrupt
      }) =>
        window.credentialRepositoryIntegration!.runCredentialPasswordChange(
          credentialDatabaseName,
          storageDatabaseName,
          local,
          currentPassword,
          newPassword,
          interrupt
        ),
      {
        credentialDatabaseName,
        storageDatabaseName,
        local,
        currentPassword,
        newPassword,
        interrupt: scenario.interrupt
      }
    )
    expect(interrupted).toMatchObject({ ok: false, code: scenario.error })

    await popup.reload()
    await expect
      .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    const recovered = await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, local, currentPassword, newPassword }) =>
        window.credentialRepositoryIntegration!.runCredentialPasswordChange(
          credentialDatabaseName,
          storageDatabaseName,
          local,
          currentPassword,
          newPassword
        ),
      {
        credentialDatabaseName,
        storageDatabaseName,
        local: interrupted.local,
        currentPassword,
        newPassword
      }
    )
    expect(recovered).toMatchObject({
      ok: true,
      result: { status: 'recovered' },
      journalPhase: 'complete',
      sourceRetired: true,
      sourceZcashEnvelopePresent: false,
      targetActivation: 'active'
    })
    expect(recovered.activeGenerationId).toBe(recovered.result?.generationId)
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName }) =>
        window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
          credentialDatabaseName,
          storageDatabaseName
        ),
      { credentialDatabaseName, storageDatabaseName }
    )
  })
}

test('atomically migrates retained V1 credentials and resumes idempotently after reload', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `retained-v1-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-storage-${crypto.randomUUID()}`
  const password = `retained-${'\u5bc6'.repeat(600)}`
  await openIntegrationPage(popup, extensionId)
  const local = await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareRetainedMigrationFixture(password),
    password
  )
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )

  const migrated = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, local, password }) =>
      window.credentialRepositoryIntegration!.runRetainedMigration(
        credentialDatabaseName,
        storageDatabaseName,
        local,
        password
      ),
    { credentialDatabaseName, storageDatabaseName, local, password }
  )
  expect(migrated).toMatchObject({
    ok: true,
    result: { status: 'committed' },
    journalPhase: 'complete',
    activeAccount: {
      keyDomainId: 'wallet:retained-v1-e2e',
      accountId: 'account:retained-v1-e2e:0'
    },
    keyDomainSource: { kind: 'software', mnemonicWordCount: 12 },
    credentialPolicy: { mnemonicWordCount: 12, zcashSeedPolicy: 'direct-bip39-v1' },
    chainAccounts: expect.arrayContaining([
      {
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        path: "m/32'/133'/0'",
        identity:
          'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
      },
      {
        chainId: 'eip155:1',
        path: "m/44'/60'/0'/0/0",
        identity: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
      },
      {
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        path: "m/84'/0'/0'/0/0",
        identity: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
      }
    ]),
    addressSchemes: [
      'bitcoin-p2wpkh',
      'evm',
      'zcash-full-unified',
      'zcash-shielded-unified',
      'zcash-transparent-p2pkh'
    ]
  })
  expect(JSON.stringify(migrated)).not.toContain('abandon')

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, local, password }) =>
        window.credentialRepositoryIntegration!.runRetainedMigration(
          credentialDatabaseName,
          storageDatabaseName,
          local,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, local, password }
    )
  ).resolves.toMatchObject({
    ok: true,
    result: { status: 'already-committed' },
    journalPhase: 'complete'
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('preserves a rotated V1 shielded receive address during migration', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `retained-v1-rotated-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-rotated-storage-${crypto.randomUUID()}`
  const password = 'retained-v1-rotated-address-password'
  await openIntegrationPage(popup, extensionId)
  const fixture = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareRotatedRetainedMigrationFixture(password),
    password
  )

  const migrated = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, local, password }) =>
      window.credentialRepositoryIntegration!.runRetainedMigration(
        credentialDatabaseName,
        storageDatabaseName,
        local,
        password
      ),
    {
      credentialDatabaseName,
      storageDatabaseName,
      local: fixture.local,
      password
    }
  )
  expect(migrated).toMatchObject({
    ok: true,
    result: { status: 'committed' },
    addresses: expect.arrayContaining([
      {
        scheme: 'zcash-shielded-unified',
        value: fixture.expected.shielded
      },
      {
        scheme: 'zcash-transparent-p2pkh',
        value: fixture.expected.transparent
      }
    ])
  })
  expect(migrated).toMatchObject({
    chainAccounts: expect.arrayContaining([
      expect.objectContaining({
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        identity: expect.not.stringMatching(new RegExp(`^${fixture.expected.shielded}$`))
      })
    ])
  })

  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('atomically persists the 24-word direct BIP-39 credential policy and public identities', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `retained-v1-24-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-24-storage-${crypto.randomUUID()}`
  const password = 'retained-v1-24-password'
  await openIntegrationPage(popup, extensionId)
  const local = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareRetainedMigrationFixture(password, 24),
    password
  )
  const migrated = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, local, password }) =>
      window.credentialRepositoryIntegration!.runRetainedMigration(
        credentialDatabaseName,
        storageDatabaseName,
        local,
        password
      ),
    { credentialDatabaseName, storageDatabaseName, local, password }
  )
  expect(migrated).toMatchObject({
    ok: true,
    result: { status: 'committed' },
    journalPhase: 'complete',
    keyDomainSource: { kind: 'software', mnemonicWordCount: 24 },
    credentialPolicy: { mnemonicWordCount: 24, zcashSeedPolicy: 'direct-bip39-v1' },
    chainAccounts: expect.arrayContaining([
      {
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        path: "m/32'/133'/0'",
        identity:
          'u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g'
      },
      {
        chainId: 'eip155:1',
        path: "m/44'/60'/0'/0/0",
        identity: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
      },
      {
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        path: "m/84'/0'/0'/0/0",
        identity: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6'
      }
    ]),
    addressSchemes: [
      'bitcoin-p2wpkh',
      'evm',
      'zcash-full-unified',
      'zcash-shielded-unified',
      'zcash-transparent-p2pkh'
    ]
  })
  expect(JSON.stringify(migrated)).not.toContain('abandon')
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('silently migrates production V1 credentials into Storage V2 during unlock', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'production-v1-unlock-password'
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareProductionV1Migration(password),
    password
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(password)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByRole('tab', { name: 'Assets' })).toBeVisible({ timeout: 60_000 })
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toHaveCount(0)
  await expect(popup.getByRole('heading', { name: 'Wallet upgrade failed' })).toHaveCount(0)

  await openIntegrationPage(popup, extensionId)
  const provisioned = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioned).toMatchObject({
    mainKeyDomainId: 'wallet:retained-v1-e2e',
    activeAccount: {
      keyDomainId: 'wallet:retained-v1-e2e',
      accountId: 'account:retained-v1-e2e:0'
    },
    keyDomainIds: ['wallet:retained-v1-e2e'],
    accountIds: ['account:retained-v1-e2e:0'],
    credentialPolicies: [
      {
        keyDomainId: 'wallet:retained-v1-e2e',
        source: 'software',
        mnemonicWordCount: 12,
        zcashSeedPolicy: 'direct-bip39-v1'
      }
    ]
  })
  expect(provisioned.activeGenerationId).not.toBeNull()
  expect(provisioned.chainAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        path: "m/32'/133'/0'"
      }),
      expect.objectContaining({ chainId: 'eip155:1', path: "m/44'/60'/0'/0/0" }),
      expect.objectContaining({
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        path: "m/84'/0'/0'/0/0"
      })
    ])
  )

  const activeWalletSet = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionActiveWalletSet()
  )
  expect(activeWalletSet).toEqual({
    generationId: provisioned.activeGenerationId,
    activeAccountId: 'account:retained-v1-e2e:0',
    availableChainAccounts: [
      {
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        chainAccountId: expect.stringContaining('chain-account:'),
        addressSchemes: ['zcash-full-unified', 'zcash-shielded-unified', 'zcash-transparent-p2pkh'],
        preferredReceiveAddressIds: [expect.stringContaining('zcash-shielded')]
      }
    ]
  })

  const persistedSession = await popup.evaluate(() =>
    chrome.storage.session.get([
      'keyring_session_descriptor',
      'session_password',
      'session_key_material'
    ])
  )
  expect(persistedSession.session_password).toBeUndefined()
  expect(persistedSession.session_key_material).toBeUndefined()
  expect(persistedSession.keyring_session_descriptor).toMatchObject({
    schemaVersion: 1,
    unlockedCredentials: [
      {
        keyDomainId: 'wallet:retained-v1-e2e',
        credentialGenerationId: expect.stringContaining('credential-generation:')
      }
    ]
  })
  expect(JSON.stringify(persistedSession.keyring_session_descriptor)).not.toMatch(
    /password|mnemonic|sessionId|privateKey/i
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const originalWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const cdp = await context.newCDPSession(popup)
  const targets = await cdp.send('Target.getTargets')
  const serviceWorkerTarget = targets.targetInfos.find(
    target => target.type === 'service_worker' && target.url === originalWorker.url()
  )
  expect(serviceWorkerTarget).toBeDefined()
  await cdp.send('Target.closeTarget', { targetId: serviceWorkerTarget!.targetId })

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_WALLET_SESSION' }))
  ).resolves.toEqual({ error: 'Unauthorized runtime message sender' })
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })
  await popup.reload()
  await waitForBackgroundWalletInitialization(popup)
  await expect(popup.getByText('Enter your password', { exact: true })).toHaveCount(0)
  await expect.poll(() => new URL(popup.url()).hash).not.toContain('/unlock')

  const targetsAfterRestart = await cdp.send('Target.getTargets')
  const offscreenTarget = targetsAfterRestart.targetInfos.find(target =>
    target.url.endsWith('/src/offscreen/index.html')
  )
  expect(offscreenTarget).toBeDefined()
  await cdp.send('Target.closeTarget', { targetId: offscreenTarget!.targetId })
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: false })
  await expect(
    popup.evaluate(
      async () =>
        (await chrome.storage.session.get('keyring_session_descriptor')).keyring_session_descriptor
    )
  ).resolves.toBeUndefined()
  await popup.reload()
  await waitForBackgroundWalletInitialization(popup)
  await expect(popup.getByText('Enter your password', { exact: true })).toBeVisible()
})

test('authenticates persisted credential bindings and upgrades legacy V2 atomically', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'production-credential-authentication-password'
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareProductionV1Migration(password),
    password
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      password
    )
  ).resolves.toMatchObject({ success: true, credentialStatus: 'migrated' })

  await openIntegrationPage(popup, extensionId)
  const initial = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.productionCredentialAuthentication(password),
    password
  )
  expect(initial).toEqual([
    expect.objectContaining({
      format: 'authenticated',
      aadSchemaVersions: [2, 2],
      engineFormats: [1, 1],
      verified: true
    })
  ])
  const initialGenerationId = initial[0].generationId

  await expect(
    popup.evaluate(
      password =>
        window.credentialRepositoryIntegration!.downgradeProductionCredentialAuthenticationToLegacy(
          password
        ),
      password
    )
  ).resolves.toEqual([
    expect.objectContaining({
      format: 'legacy',
      aadSchemaVersions: [1, 1],
      engineFormats: [1, 1],
      verified: false
    })
  ])

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  const wrongPasswordResult = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'WALLET_UNLOCK',
      password: 'wrong-credential-authentication-password'
    })
  )
  expect(wrongPasswordResult).toMatchObject({
    success: false,
    failure: 'wrong_password',
    isLocked: false,
    remainingAttempts: 4
  })
  await openIntegrationPage(popup, extensionId)
  await expect(
    popup.evaluate(() =>
      window.credentialRepositoryIntegration!.productionCredentialAuthentication()
    )
  ).resolves.toEqual([
    expect.objectContaining({
      generationId: initialGenerationId,
      format: 'legacy',
      aadSchemaVersions: [1, 1],
      engineFormats: [1, 1]
    })
  ])

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      password
    )
  ).resolves.toMatchObject({ success: true, credentialStatus: 'synchronized' })

  await openIntegrationPage(popup, extensionId)
  const upgraded = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.productionCredentialAuthentication(password),
    password
  )
  expect(upgraded).toEqual([
    expect.objectContaining({
      format: 'authenticated',
      aadSchemaVersions: [2, 2],
      engineFormats: [1, 1],
      verified: true
    })
  ])
  expect(upgraded[0].generationId).not.toBe(initialGenerationId)

  await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.tamperProductionCredentialEnvelope()
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  await expect(
    popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      password
    )
  ).resolves.toEqual({ error: 'Credential envelope authentication failed' })
})

test('blocks a failed production V1 upgrade, retains source data, and allows retry', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'production-v1-anchor-failure'
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(
    ({ password }) =>
      window.credentialRepositoryIntegration!.prepareProductionV1Migration(password, 12, true),
    { password }
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(password)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByRole('heading', { name: 'Wallet upgrade failed' })).toBeVisible({
    timeout: 60_000
  })
  await expect(
    popup.getByText('Your existing wallet data is still stored on this device.', { exact: false })
  ).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(popup.getByRole('button', { name: /skip|continue|reset/i })).toHaveCount(0)
  await captureScreenshot(popup, 'wallet-upgrade-failed.png')

  await expect(
    popup.evaluate(async walletId => {
      const key = `seed_${walletId}`
      const local = await chrome.storage.local.get(key)
      const session = await chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' })
      return { retained: local[key] !== undefined, session }
    }, 'wallet:retained-v1-e2e')
  ).resolves.toEqual({ retained: true, session: { active: false } })

  await popup.getByRole('button', { name: 'Retry' }).click()
  await expect(popup.getByRole('heading', { name: 'Wallet upgrade failed' })).toBeVisible({
    timeout: 60_000
  })
  await expect(popup.getByRole('button', { name: 'Retry' })).toBeEnabled()

  await openIntegrationPage(popup, extensionId)
  const provisioned = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioned.activeGenerationId).toBeNull()
  await expect(
    popup.evaluate(() => chrome.storage.session.get(['session_password', 'session_key_material']))
  ).resolves.toEqual({})
})

test('adds a retained V1 Wallet to active Storage V2 without replacing existing credentials', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `retained-v1-inventory-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-inventory-storage-${crypto.randomUUID()}`
  const password = 'retained-inventory-password'
  await openIntegrationPage(popup, extensionId)
  const fixture = await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareRetainedInventoryFixture(password),
    password
  )
  const synchronized = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
      window.credentialRepositoryIntegration!.runRetainedInventorySync(
        credentialDatabaseName,
        storageDatabaseName,
        fixture.initial,
        fixture.target,
        password
      ),
    { credentialDatabaseName, storageDatabaseName, fixture, password }
  )
  expect(synchronized).toMatchObject({
    ok: true,
    result: {
      status: 'synchronized',
      provisionedKeyDomainIds: [fixture.walletId],
      addedAccountIds: [fixture.accountId]
    },
    counts: { keyDomains: 2, accounts: 2, chainAccounts: 6, addresses: 10 },
    activeAccount: { keyDomainId: fixture.walletId, accountId: fixture.accountId },
    addedCredentialStatus: 'active',
    pendingPhase: null
  })

  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
        window.credentialRepositoryIntegration!.runRetainedInventorySync(
          credentialDatabaseName,
          storageDatabaseName,
          fixture.initial,
          fixture.target,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, fixture, password }
    )
  ).resolves.toMatchObject({
    ok: true,
    result: {
      status: 'already-synchronized',
      provisionedKeyDomainIds: [],
      addedAccountIds: []
    },
    counts: { keyDomains: 2, accounts: 2, chainAccounts: 6, addresses: 10 }
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('adds an HD Account to active Storage V2 without creating another credential generation', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `retained-v1-account-inventory-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-account-inventory-storage-${crypto.randomUUID()}`
  const password = 'retained-account-inventory-password'
  await openIntegrationPage(popup, extensionId)
  const fixture = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareRetainedAccountInventoryFixture(password),
    password
  )
  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
        window.credentialRepositoryIntegration!.runRetainedInventorySync(
          credentialDatabaseName,
          storageDatabaseName,
          fixture.initial,
          fixture.target,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, fixture, password }
    )
  ).resolves.toMatchObject({
    ok: true,
    result: {
      status: 'synchronized',
      provisionedKeyDomainIds: [],
      addedAccountIds: [fixture.accountId]
    },
    counts: { keyDomains: 1, accounts: 2, chainAccounts: 6, addresses: 10 },
    activeAccount: { keyDomainId: fixture.walletId, accountId: fixture.accountId },
    addedCredentialStatus: null,
    pendingPhase: null
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('removes an HD Account from Storage V2 without retiring its Wallet credential', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `account-removal-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `account-removal-storage-${crypto.randomUUID()}`
  const password = 'account-removal-password'
  await openIntegrationPage(popup, extensionId)
  const fixture = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareRetainedAccountInventoryFixture(password),
    password
  )
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
      window.credentialRepositoryIntegration!.initializeCredentialRemoval(
        credentialDatabaseName,
        storageDatabaseName,
        fixture.initial,
        fixture.target,
        password
      ),
    { credentialDatabaseName, storageDatabaseName, fixture, password }
  )
  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture }) =>
        window.credentialRepositoryIntegration!.runCredentialRemoval(
          credentialDatabaseName,
          storageDatabaseName,
          {
            kind: 'account',
            keyDomainId: fixture.walletId,
            accountId: fixture.accountId
          }
        ),
      { credentialDatabaseName, storageDatabaseName, fixture }
    )
  ).resolves.toMatchObject({
    ok: true,
    result: { status: 'removed' },
    counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
    activeAccount: {
      keyDomainId: 'wallet:retained-v1-e2e',
      accountId: 'account:retained-v1-e2e:0'
    },
    targetPresent: false,
    sourceCredentialRetired: false,
    sourceCredentialActivation: 'active',
    sourceEnvelopesPresent: true,
    pendingPhase: null
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('removes a Wallet from Storage V2 and purges its retired ciphertext', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const credentialDatabaseName = `wallet-removal-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `wallet-removal-storage-${crypto.randomUUID()}`
  const password = 'wallet-removal-password'
  await openIntegrationPage(popup, extensionId)
  const fixture = await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareRetainedInventoryFixture(password),
    password
  )
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
      window.credentialRepositoryIntegration!.initializeCredentialRemoval(
        credentialDatabaseName,
        storageDatabaseName,
        fixture.initial,
        fixture.target,
        password
      ),
    { credentialDatabaseName, storageDatabaseName, fixture, password }
  )
  const removed = await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName, fixture }) =>
      window.credentialRepositoryIntegration!.runCredentialRemoval(
        credentialDatabaseName,
        storageDatabaseName,
        { kind: 'wallet', keyDomainId: fixture.walletId }
      ),
    { credentialDatabaseName, storageDatabaseName, fixture }
  )
  expect(removed).toMatchObject({
    ok: true,
    result: { status: 'removed' },
    counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
    activeAccount: {
      keyDomainId: 'wallet:retained-v1-e2e',
      accountId: 'account:retained-v1-e2e:0'
    },
    targetPresent: false,
    sourceCredentialRetired: true,
    sourceCredentialActivation: 'retired',
    sourceEnvelopesPresent: false,
    pendingPhase: null
  })
  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture }) =>
        window.credentialRepositoryIntegration!.runCredentialRemoval(
          credentialDatabaseName,
          storageDatabaseName,
          { kind: 'wallet', keyDomainId: fixture.walletId }
        ),
      { credentialDatabaseName, storageDatabaseName, fixture }
    )
  ).resolves.toMatchObject({
    ok: true,
    result: { status: 'already-removed' },
    targetPresent: false,
    sourceCredentialRetired: null,
    sourceCredentialActivation: null,
    sourceEnvelopesPresent: null,
    pendingPhase: null
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

for (const kind of ['account', 'wallet'] as const) {
  test(`routes production ${kind} removal through retained V1 and Storage V2`, async ({
    context,
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const password = `production-${kind}-removal-password`
    await openIntegrationPage(popup, extensionId)
    const target = await popup.evaluate(
      ({ password, kind }) =>
        window.credentialRepositoryIntegration!.prepareProductionV2Removal(password, kind),
      { password, kind }
    )
    const activityKeys = ['mainnet', 'testnet'].flatMap(network => [
      `activity_history_cache_v3:${network}:${target.walletId}:${target.accountId}:default`,
      `activity_history_cache_v3:${network}:${target.walletId}:${target.accountId}-survivor:default`
    ])
    await readActivityCacheKeys(popup, activityKeys)

    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    let survivorBefore: { chainAccounts: unknown[]; addresses: unknown[] } | null = null
    if (kind === 'wallet') {
      await expect(
        popup.evaluate(
          password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
          password
        )
      ).resolves.toMatchObject({ success: true })
      await openIntegrationPage(popup, extensionId)
      const before = await popup.evaluate(
        target => window.credentialRepositoryIntegration!.inspectProductionV2Removal(target),
        target
      )
      survivorBefore = {
        chainAccounts: before.survivorChainAccounts,
        addresses: before.survivorAddresses
      }
      await popup.goto(`chrome-extension://${extensionId}/index.html`)
    }
    await expect(
      popup.evaluate(
        async ({ target, password }) => {
          if (target.kind === 'account') {
            return chrome.runtime.sendMessage({
              type: 'REMOVE_ACCOUNT',
              walletId: target.walletId,
              accountId: target.accountId
            })
          }
          const seed = await chrome.runtime.sendMessage({
            type: 'GET_ZCASH_SEED_PHRASE',
            password,
            walletId: target.walletId
          })
          if (seed.success !== true || typeof seed.seedPhrase !== 'string') {
            throw new Error('Removal wallet secret phrase could not be read')
          }
          const challenge = await chrome.runtime.sendMessage({
            type: 'GET_WALLET_BACKUP_WORD_INDICES',
            walletId: target.walletId
          })
          if (challenge.success !== true || !Array.isArray(challenge.wordIndices)) {
            throw new Error('Removal wallet backup challenge is unavailable')
          }
          const phraseWords = seed.seedPhrase.trim().split(/\s+/)
          return chrome.runtime.sendMessage({
            type: 'REMOVE_WALLET',
            walletId: target.walletId,
            verification: {
              wordIndices: challenge.wordIndices,
              words: challenge.wordIndices.map((index: number) => phraseWords[index])
            }
          })
        },
        { target, password }
      )
    ).resolves.toMatchObject({ success: true })

    await openIntegrationPage(popup, extensionId)
    const inspected = await popup.evaluate(
      target => window.credentialRepositoryIntegration!.inspectProductionV2Removal(target),
      target
    )
    expect(await readActivityCacheKeys(popup)).toEqual(
      activityKeys.filter(key => key.includes(`${target.accountId}-survivor:`)).sort()
    )
    expect(inspected).toMatchObject(
      kind === 'wallet'
        ? {
            counts: { keyDomains: 1, accounts: 1 },
            targetKeyDomainPresent: false,
            targetAccountPresent: false,
            credentialRetired: true,
            credentialActivation: 'retired',
            credentialEnvelopesPresent: false,
            v1WalletPresent: false,
            v1AccountPresent: false,
            v1CredentialPresent: false,
            pendingPhase: null
          }
        : {
            counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
            targetKeyDomainPresent: true,
            targetAccountPresent: false,
            credentialRetired: false,
            credentialActivation: 'active',
            credentialEnvelopesPresent: true,
            v1WalletPresent: true,
            v1AccountPresent: false,
            v1CredentialPresent: true,
            pendingPhase: null
          }
    )
    if (kind === 'wallet') {
      expect(inspected.survivorChainAccounts).toEqual(survivorBefore?.chainAccounts)
      expect(inspected.survivorAddresses).toEqual(survivorBefore?.addresses)
      expect(inspected.counts?.chainAccounts).toBe(inspected.survivorChainAccounts.length)
      expect(inspected.counts?.addresses).toBe(inspected.survivorAddresses.length)
    }
    await terminateExtensionServiceWorker(context, popup)
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await waitForBackgroundWalletInitialization(popup)
    await expect(
      popup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        password
      )
    ).resolves.toMatchObject({ success: true })
    expect(
      await popup.evaluate(async () => {
        const local = await chrome.storage.local.get('wallet_pending_account_cleanup')
        return Object.keys(local.wallet_pending_account_cleanup ?? {}).length
      })
    ).toBe(0)
  })
}

test('Reset Wallet removes both production Storage V2 databases', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.prepareProductionV2Removal(
      'production-reset-password',
      'wallet'
    )
  )
  await expect(
    popup.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2DatabasePresence()
    )
  ).resolves.toEqual({ credentialDatabasePresent: true, storageDatabasePresent: true })

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RESET_WALLET_DATA' }))
  ).resolves.toMatchObject({ success: true })

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' }))
  ).resolves.toMatchObject({ result: null })

  await openIntegrationPage(popup, extensionId)
  await expect(
    popup.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2DatabasePresence()
    )
  ).resolves.toEqual({ credentialDatabasePresent: false, storageDatabasePresent: false })
})

for (const kind of ['account', 'wallet'] as const) {
  test(`reconciles a V1 downgrade ${kind} deletion before reusing Storage V2`, async ({
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const credentialDatabaseName = `v1-reconciliation-${kind}-credential-${crypto.randomUUID()}`
    const storageDatabaseName = `v1-reconciliation-${kind}-storage-${crypto.randomUUID()}`
    const password = `v1-reconciliation-${kind}-password`
    await openIntegrationPage(popup, extensionId)
    const fixture = await popup.evaluate(
      ({ password, kind }) =>
        kind === 'wallet'
          ? window.credentialRepositoryIntegration!.prepareRetainedInventoryFixture(password)
          : window.credentialRepositoryIntegration!.prepareRetainedAccountInventoryFixture(
              password
            ),
      { password, kind }
    )
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
        window.credentialRepositoryIntegration!.initializeCredentialRemoval(
          credentialDatabaseName,
          storageDatabaseName,
          fixture.initial,
          fixture.target,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, fixture, password }
    )

    const reconciled = await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
        window.credentialRepositoryIntegration!.runRetainedV1Reconciliation(
          credentialDatabaseName,
          storageDatabaseName,
          fixture.initial,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, fixture, password }
    )
    expect(reconciled).toMatchObject({
      result: {
        status: 'synchronized',
        removedKeyDomainIds: kind === 'wallet' ? [fixture.walletId] : [],
        removedAccountIds: kind === 'account' ? [fixture.accountId] : [],
        inventory: { status: 'already-synchronized' }
      },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
      activeAccount: {
        keyDomainId: 'wallet:retained-v1-e2e',
        accountId: 'account:retained-v1-e2e:0'
      },
      keyDomainIds: ['wallet:retained-v1-e2e'],
      accountIds: ['account:retained-v1-e2e:0'],
      retiredCredentialStates:
        kind === 'wallet'
          ? [
              {
                retired: true,
                active: 'retired',
                envelopesPresent: false
              }
            ]
          : [],
      pendingRemoval: null,
      pendingInventory: null
    })

    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
          window.credentialRepositoryIntegration!.runRetainedV1Reconciliation(
            credentialDatabaseName,
            storageDatabaseName,
            fixture.initial,
            password
          ),
        { credentialDatabaseName, storageDatabaseName, fixture, password }
      )
    ).resolves.toMatchObject({
      result: {
        status: 'already-synchronized',
        removedKeyDomainIds: [],
        removedAccountIds: [],
        inventory: { status: 'already-synchronized' }
      }
    })
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName }) =>
        window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
          credentialDatabaseName,
          storageDatabaseName
        ),
      { credentialDatabaseName, storageDatabaseName }
    )
  })
}

for (const scenario of [
  { interrupt: 'after-stage' as const, error: 'TEST_INTERRUPT_AFTER_STAGE' },
  { interrupt: 'after-commit' as const, error: 'TEST_INTERRUPT_AFTER_COMMIT' }
]) {
  test(`recovers Storage V2 Wallet removal ${scenario.interrupt}`, async ({
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const credentialDatabaseName = `wallet-removal-recovery-credential-${crypto.randomUUID()}`
    const storageDatabaseName = `wallet-removal-recovery-storage-${crypto.randomUUID()}`
    const password = 'wallet-removal-recovery-password'
    await openIntegrationPage(popup, extensionId)
    const fixture = await popup.evaluate(
      password => window.credentialRepositoryIntegration!.prepareRetainedInventoryFixture(password),
      password
    )
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
        window.credentialRepositoryIntegration!.initializeCredentialRemoval(
          credentialDatabaseName,
          storageDatabaseName,
          fixture.initial,
          fixture.target,
          password
        ),
      { credentialDatabaseName, storageDatabaseName, fixture, password }
    )
    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, fixture, interrupt }) =>
          window.credentialRepositoryIntegration!.runCredentialRemoval(
            credentialDatabaseName,
            storageDatabaseName,
            { kind: 'wallet', keyDomainId: fixture.walletId },
            interrupt
          ),
        {
          credentialDatabaseName,
          storageDatabaseName,
          fixture,
          interrupt: scenario.interrupt
        }
      )
    ).resolves.toMatchObject({ ok: false, code: scenario.error })

    await popup.reload()
    await expect
      .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, fixture }) =>
          window.credentialRepositoryIntegration!.runCredentialRemoval(
            credentialDatabaseName,
            storageDatabaseName,
            { kind: 'wallet', keyDomainId: fixture.walletId }
          ),
        { credentialDatabaseName, storageDatabaseName, fixture }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { status: 'removed' },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
      targetPresent: false,
      sourceCredentialRetired: true,
      sourceCredentialActivation: 'retired',
      sourceEnvelopesPresent: false,
      pendingPhase: null
    })
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName }) =>
        window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
          credentialDatabaseName,
          storageDatabaseName
        ),
      { credentialDatabaseName, storageDatabaseName }
    )
  })
}

for (const scenario of [
  {
    interrupt: 'after-stage' as const,
    error: 'TEST_INTERRUPT_AFTER_STAGE',
    recoveredStatus: 'synchronized',
    addedCredentialStatus: 'active'
  },
  {
    interrupt: 'after-commit' as const,
    error: 'TEST_INTERRUPT_AFTER_COMMIT',
    recoveredStatus: 'already-synchronized',
    addedCredentialStatus: null
  }
]) {
  test(`recovers retained V1 inventory synchronization ${scenario.interrupt}`, async ({
    popup,
    extensionId
  }) => {
    test.setTimeout(180_000)
    const credentialDatabaseName = `retained-v1-inventory-recovery-credential-${crypto.randomUUID()}`
    const storageDatabaseName = `retained-v1-inventory-recovery-storage-${crypto.randomUUID()}`
    const password = 'retained-inventory-recovery-password'
    await openIntegrationPage(popup, extensionId)
    const fixture = await popup.evaluate(
      password => window.credentialRepositoryIntegration!.prepareRetainedInventoryFixture(password),
      password
    )
    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, fixture, password, interrupt }) =>
          window.credentialRepositoryIntegration!.runRetainedInventorySync(
            credentialDatabaseName,
            storageDatabaseName,
            fixture.initial,
            fixture.target,
            password,
            interrupt
          ),
        {
          credentialDatabaseName,
          storageDatabaseName,
          fixture,
          password,
          interrupt: scenario.interrupt
        }
      )
    ).resolves.toMatchObject({ ok: false, code: scenario.error })

    await popup.reload()
    await expect
      .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, fixture, password }) =>
          window.credentialRepositoryIntegration!.runRetainedInventorySync(
            credentialDatabaseName,
            storageDatabaseName,
            fixture.initial,
            fixture.target,
            password
          ),
        { credentialDatabaseName, storageDatabaseName, fixture, password }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { status: scenario.recoveredStatus },
      counts: { keyDomains: 2, accounts: 2, chainAccounts: 6, addresses: 10 },
      addedCredentialStatus: scenario.addedCredentialStatus,
      pendingPhase: null
    })
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName }) =>
        window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
          credentialDatabaseName,
          storageDatabaseName
        ),
      { credentialDatabaseName, storageDatabaseName }
    )
  })
}

for (const scenario of [
  {
    name: 'before the active pointer switch',
    interrupt: 'after-stage' as const,
    error: 'TEST_INTERRUPT_AFTER_STAGE',
    expectsActiveGeneration: false
  },
  {
    name: 'after the active pointer switch',
    interrupt: 'after-commit' as const,
    error: 'TEST_INTERRUPT_AFTER_COMMIT',
    expectsActiveGeneration: true
  }
]) {
  test(`resumes retained V1 migration ${scenario.name}`, async ({ popup, extensionId }) => {
    test.setTimeout(180_000)
    const credentialDatabaseName = `retained-v1-interrupt-credential-${crypto.randomUUID()}`
    const storageDatabaseName = `retained-v1-interrupt-storage-${crypto.randomUUID()}`
    const password = 'retained-interruption-password'
    await openIntegrationPage(popup, extensionId)
    const local = await popup.evaluate(
      password => window.credentialRepositoryIntegration!.prepareRetainedMigrationFixture(password),
      password
    )
    const interrupted = await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, local, password, interrupt }) =>
        window.credentialRepositoryIntegration!.runRetainedMigration(
          credentialDatabaseName,
          storageDatabaseName,
          local,
          password,
          interrupt
        ),
      {
        credentialDatabaseName,
        storageDatabaseName,
        local,
        password,
        interrupt: scenario.interrupt
      }
    )
    expect(interrupted).toMatchObject({ ok: false, code: scenario.error })
    if (scenario.expectsActiveGeneration) {
      expect(interrupted).toMatchObject({ activeGenerationId: expect.any(String) })
    } else {
      expect(interrupted).toMatchObject({ activeGenerationId: null })
    }

    await popup.reload()
    await expect
      .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    await expect(
      popup.evaluate(
        ({ credentialDatabaseName, storageDatabaseName, local, password }) =>
          window.credentialRepositoryIntegration!.runRetainedMigration(
            credentialDatabaseName,
            storageDatabaseName,
            local,
            password
          ),
        { credentialDatabaseName, storageDatabaseName, local, password }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { status: 'committed' },
      journalPhase: 'complete'
    })
    await popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName }) =>
        window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
          credentialDatabaseName,
          storageDatabaseName
        ),
      { credentialDatabaseName, storageDatabaseName }
    )
  })
}

test('leaves Storage V2 inactive when retained V1 credential verification fails', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const credentialDatabaseName = `retained-v1-failure-credential-${crypto.randomUUID()}`
  const storageDatabaseName = `retained-v1-failure-storage-${crypto.randomUUID()}`
  await openIntegrationPage(popup, extensionId)
  const local = await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareRetainedMigrationFixture(password),
    'correct-password'
  )
  await expect(
    popup.evaluate(
      ({ credentialDatabaseName, storageDatabaseName, local }) =>
        window.credentialRepositoryIntegration!.runRetainedMigration(
          credentialDatabaseName,
          storageDatabaseName,
          local,
          'wrong-password'
        ),
      { credentialDatabaseName, storageDatabaseName, local }
    )
  ).resolves.toMatchObject({
    ok: false,
    code: 'Credential compatibility migration failed: DECRYPTION_FAILED',
    activeGenerationId: null
  })
  await popup.evaluate(
    ({ credentialDatabaseName, storageDatabaseName }) =>
      window.credentialRepositoryIntegration!.resetRetainedMigrationDatabases(
        credentialDatabaseName,
        storageDatabaseName
      ),
    { credentialDatabaseName, storageDatabaseName }
  )
})

test('serializes journal CAS and rejects corrupted persisted records', async ({
  popup,
  extensionId
}) => {
  const raceDatabase = `credential-repository-race-${crypto.randomUUID()}`
  const corruptDatabase = `credential-repository-corrupt-${crypto.randomUUID()}`
  await openIntegrationPage(popup, extensionId)
  const race = await popup.evaluate(
    name => window.credentialRepositoryIntegration!.raceJournalAdvance(name),
    raceDatabase
  )
  expect([race.verified, race.failed].sort()).toEqual(['advanced', 'revision-conflict'])
  expect(race.phase).toMatch(/^(verified|failed)$/)
  await expect(
    popup.evaluate(
      name => window.credentialRepositoryIntegration!.corruptAndRead(name),
      corruptDatabase
    )
  ).resolves.toBe('rejected')
  await Promise.all([
    popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), raceDatabase),
    popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), corruptDatabase)
  ])
})

test('persists Storage V2 generations and atomically switches one active pointer', async ({
  popup,
  extensionId
}) => {
  const databaseName = `storage-v2-resume-${crypto.randomUUID()}`
  const raceDatabaseName = `storage-v2-race-${crypto.randomUUID()}`
  const generationId = 'metadata:storage-v2-e2e'
  await openIntegrationPage(popup, extensionId)
  await popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), databaseName)
  await expect(
    popup.evaluate(
      ({ databaseName, generationId }) =>
        window.credentialRepositoryIntegration!.stageStorageV2(databaseName, generationId),
      { databaseName, generationId }
    )
  ).resolves.toEqual({ generationId })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      ({ databaseName, generationId }) =>
        window.credentialRepositoryIntegration!.readAndCommitStorageV2(databaseName, generationId),
      { databaseName, generationId }
    )
  ).resolves.toEqual({
    snapshotGenerationId: generationId,
    chainIdentity: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    accountIds: ['account:storage-v2-e2e'],
    commit: 'committed',
    activeGenerationId: generationId,
    discard: 'rejected'
  })
  const race = await popup.evaluate(
    name => window.credentialRepositoryIntegration!.raceStorageV2Commit(name),
    raceDatabaseName
  )
  expect(race.results).toEqual(['active-generation-changed', 'committed'])
  expect(race.activeGenerationId).toMatch(/^metadata:storage-v2-race:(?:first|second)$/)
  await Promise.all([
    popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), databaseName),
    popup.evaluate(name => window.credentialRepositoryIntegration!.reset(name), raceDatabaseName)
  ])
})
