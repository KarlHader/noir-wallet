import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  LEGACY_WALLET_DATA_KEY,
  LEGACY_WALLET_DATA_MIGRATION_KEY,
  V1_WALLET_STATE_KEY,
  buildStorageV2MetadataStage,
  discoverV1Metadata,
  fingerprintV1Source,
  migrateLegacyWalletData
} from '../../../src/infrastructure/persistence/migrations/index.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

function clone(value) {
  return structuredClone(value)
}

function createStorage(initial, setTransform = values => values) {
  const local = clone(initial)
  return {
    local,
    adapter: {
      async getAll() {
        return clone(local)
      },
      async set(values) {
        Object.assign(local, clone(setTransform(values)))
      }
    }
  }
}

test.describe('V1 metadata discovery', () => {
  for (const fixture of V1_MIGRATION_FIXTURES) {
    test(`discovers ${fixture.id} without mutating the source`, () => {
      const local = clone(fixture.local)
      const before = clone(local)
      const result = discoverV1Metadata(local)

      expect(local).toEqual(before)
      if (fixture.expected.quarantined) {
        expect(result.status).toBe('quarantined')
        expect(result.issues.length).toBeGreaterThan(0)
        return
      }
      if (fixture.expected.wallets === 0) {
        expect(result.status).toBe('empty')
        return
      }

      expect(result.status).toBe('ready')
      expect(result.wallets).toHaveLength(fixture.expected.wallets)
      expect(result.wallets.reduce((count, wallet) => count + wallet.accounts.length, 0)).toBe(
        fixture.expected.accounts
      )
      expect(result.wallets.map(wallet => wallet.keySource)).toEqual(fixture.expected.keySources)
    })
  }

  test('preserves display-name overrides and stages metadata only', () => {
    const fixture = V1_MIGRATION_FIXTURES.find(item => item.id === 'software-multi-account')
    const discovery = discoverV1Metadata(fixture.local)
    const stage = buildStorageV2MetadataStage(discovery, {
      generationId: 'migration:test',
      sourceFingerprint: 'a'.repeat(64),
      createdAt: 1_700_000_000_001
    })

    expect(discovery.wallets[0].accounts[1].displayName).toBe('Savings')
    expect(discovery.wallets[0].accounts[1]).toMatchObject({
      birthdayHeight: 2_000_002,
      addresses: {
        transparent: 't-fixture-rotated',
        shielded: 'u-fixture-rotated',
        fullUnified: 'u-full-fixture-rotated'
      }
    })
    expect(stage.manifest.status).toBe('staged')
    expect(stage.manifest.activeAccount).toEqual({
      keyDomainId: 'wallet_with_underscores',
      accountId: 'account_multi_2'
    })
    expect(stage.manifest.counts).toEqual({
      keyDomains: 1,
      accounts: 2,
      chainAccounts: 0,
      addresses: 0
    })
    expect(stage.keyDomains[0].credentialRef).toBe('v1-local:seed_wallet_with_underscores')
    expect(stage.chainAccounts).toEqual([])
    expect(stage.addresses).toEqual([])
  })

  test('rejects staging quarantined metadata', () => {
    const fixture = V1_MIGRATION_FIXTURES.find(item => item.id === 'partially-corrupt-profile')
    expect(() =>
      buildStorageV2MetadataStage(discoverV1Metadata(fixture.local), {
        generationId: 'migration:corrupt',
        sourceFingerprint: 'b'.repeat(64),
        createdAt: 1_700_000_000_001
      })
    ).toThrow(/not ready/i)
  })
})

test.describe('legacy walletData migration', () => {
  const legacyFixture = V1_MIGRATION_FIXTURES.find(
    item => item.id === 'historical-legacy-wallet-data'
  )

  test('stages, verifies and retains the legacy source', async () => {
    const storage = createStorage(legacyFixture.local)
    let timestamp = 1_700_000_000_010
    const result = await migrateLegacyWalletData(storage.adapter, () => timestamp++)

    expect(result).toMatchObject({
      status: 'retained',
      targetWritten: true,
      reason: 'staged-target-verified'
    })
    expect(storage.local[LEGACY_WALLET_DATA_KEY]).toEqual(
      legacyFixture.local[LEGACY_WALLET_DATA_KEY]
    )
    expect(storage.local[V1_WALLET_STATE_KEY]).toMatchObject({
      state: { currentWalletId: 'legacy-wallet' },
      version: 0
    })
    expect(storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY]).toMatchObject({
      status: 'retained',
      sourceKey: LEGACY_WALLET_DATA_KEY,
      targetKey: V1_WALLET_STATE_KEY,
      verifiedAt: 1_700_000_000_011
    })
    expect(discoverV1Metadata(storage.local).status).toBe('ready')
  })

  test('resumes a staged migration after interruption', async () => {
    const storage = createStorage(legacyFixture.local)
    const fingerprint = await fingerprintV1Source(legacyFixture.local[LEGACY_WALLET_DATA_KEY])
    const firstStorage = createStorage(legacyFixture.local)
    await migrateLegacyWalletData(firstStorage.adapter, () => 100)

    storage.local[V1_WALLET_STATE_KEY] = firstStorage.local[V1_WALLET_STATE_KEY]
    storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY] = {
      schemaVersion: 1,
      sourceKey: LEGACY_WALLET_DATA_KEY,
      targetKey: V1_WALLET_STATE_KEY,
      status: 'staged',
      sourceFingerprint: fingerprint,
      discoveredAt: 99,
      reason: 'awaiting-readback-verification'
    }

    let timestamp = 101
    const result = await migrateLegacyWalletData(storage.adapter, () => timestamp++)
    expect(result).toMatchObject({
      status: 'retained',
      targetWritten: false,
      reason: 'staged-target-verified'
    })
    expect(storage.local[LEGACY_WALLET_DATA_KEY]).toBeDefined()
    expect(storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY].verifiedAt).toBe(102)
  })

  test('preserves a verified terminal record across repeated contexts', async () => {
    const storage = createStorage(legacyFixture.local)
    let timestamp = 150
    const firstResult = await migrateLegacyWalletData(storage.adapter, () => timestamp++)
    const firstRecord = clone(storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY])

    const repeatedResult = await migrateLegacyWalletData(storage.adapter, () => timestamp++)

    expect(firstResult.reason).toBe('staged-target-verified')
    expect(repeatedResult).toEqual({
      status: 'retained',
      targetWritten: false,
      reason: 'staged-target-verified'
    })
    expect(storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY]).toEqual(firstRecord)
  })

  test('does not overwrite a pre-existing target', async () => {
    const targetFixture = V1_MIGRATION_FIXTURES.find(item => item.id === 'software-single-account')
    const originalTarget = targetFixture.local[V1_WALLET_STATE_KEY]
    const storage = createStorage({
      ...legacyFixture.local,
      ...targetFixture.local
    })

    const result = await migrateLegacyWalletData(storage.adapter, () => 200)
    expect(result).toMatchObject({
      status: 'retained',
      targetWritten: false,
      reason: 'target-preexisting'
    })
    expect(storage.local[V1_WALLET_STATE_KEY]).toBe(originalTarget)
    expect(storage.local[LEGACY_WALLET_DATA_KEY]).toBeDefined()
  })

  test('discovers both historical string and current object envelopes', () => {
    const targetFixture = V1_MIGRATION_FIXTURES.find(item => item.id === 'software-single-account')
    const stringResult = discoverV1Metadata(targetFixture.local)
    const objectResult = discoverV1Metadata({
      ...targetFixture.local,
      [V1_WALLET_STATE_KEY]: JSON.parse(targetFixture.local[V1_WALLET_STATE_KEY])
    })

    expect(objectResult).toEqual(stringResult)
  })

  test('quarantines invalid source and invalid target without deleting either', async () => {
    const invalidSource = createStorage({
      [LEGACY_WALLET_DATA_KEY]: {
        wallets: [
          {
            id: 'broken',
            name: 'Broken',
            accounts: [],
            createdAt: 'invalid'
          }
        ]
      }
    })
    const sourceResult = await migrateLegacyWalletData(invalidSource.adapter, () => 300)
    expect(sourceResult.status).toBe('quarantined')
    expect(invalidSource.local[LEGACY_WALLET_DATA_KEY]).toBeDefined()
    expect(invalidSource.local[V1_WALLET_STATE_KEY]).toBeUndefined()

    const invalidTarget = createStorage({
      ...legacyFixture.local,
      [V1_WALLET_STATE_KEY]: '{"state":'
    })
    const targetResult = await migrateLegacyWalletData(invalidTarget.adapter, () => 301)
    expect(targetResult).toMatchObject({
      status: 'quarantined',
      targetWritten: false,
      reason: 'target-invalid'
    })
    expect(invalidTarget.local[V1_WALLET_STATE_KEY]).toBe('{"state":')
    expect(invalidTarget.local[LEGACY_WALLET_DATA_KEY]).toBeDefined()
  })

  test('quarantines a corrupted staged write and keeps the source', async () => {
    const storage = createStorage(legacyFixture.local, values => {
      if (V1_WALLET_STATE_KEY in values) {
        return { ...values, [V1_WALLET_STATE_KEY]: '{"state":' }
      }
      return values
    })

    const result = await migrateLegacyWalletData(storage.adapter, () => 400)
    expect(result).toMatchObject({
      status: 'quarantined',
      targetWritten: true,
      reason: 'staged-target-verification-failed'
    })
    expect(storage.local[LEGACY_WALLET_DATA_KEY]).toBeDefined()
    expect(storage.local[LEGACY_WALLET_DATA_MIGRATION_KEY].status).toBe('quarantined')
  })
})
