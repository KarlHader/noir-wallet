import { test } from 'node:test'
import { expect } from '@playwright/test'

import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

test.describe('Anonymous V1 migration fixtures', () => {
  test('covers the required wallet and corruption profiles', () => {
    expect(V1_MIGRATION_FIXTURES.map(fixture => fixture.id)).toEqual([
      'empty-profile',
      'software-single-account',
      'software-multi-account',
      'keystone-single-account',
      'software-and-keystone',
      'partially-corrupt-profile',
      'historical-legacy-wallet-data'
    ])
  })

  test('contains no recoverable fixture secrets or live endpoint data', () => {
    const serialized = JSON.stringify(V1_MIGRATION_FIXTURES)
    expect(serialized).not.toMatch(
      /\b(?:abandon|ability|about|above|absent|absorb)(?:\s+[a-z]+){11,23}\b/i
    )
    expect(serialized).not.toMatch(/"seedPhrase"\s*:/)
    expect(serialized).not.toContain('ufvk')
    expect(serialized).not.toMatch(/https?:\/\/(?:main|api|wallet)\./)
  })

  test('uses deterministic IDs and synthetic encrypted envelopes', () => {
    const serialized = JSON.stringify(V1_MIGRATION_FIXTURES)
    expect(serialized).toContain('Zml4dHVyZS1jaXBoZXJ0ZXh0')
    expect(serialized).not.toMatch(/[a-f0-9]{64}/)

    for (const fixture of V1_MIGRATION_FIXTURES) {
      expect(fixture.id).toMatch(/^[a-z0-9-]+$/)
      expect(fixture.local).toBeDefined()
      expect(fixture.session).toBeDefined()
      expect(fixture.indexedDb).toBeDefined()
      expect(fixture.expected).toBeDefined()
    }
  })

  test('preserves opaque IDs with underscores and staged failure evidence', () => {
    const multi = V1_MIGRATION_FIXTURES.find(fixture => fixture.id === 'software-multi-account')
    expect(multi.local.wallet_state).toContain('wallet_with_underscores')
    expect(multi.indexedDb.stores.syncJournal).toHaveLength(1)

    const corrupt = V1_MIGRATION_FIXTURES.find(
      fixture => fixture.id === 'partially-corrupt-profile'
    )
    expect(corrupt.expected.quarantined).toBe(true)
    expect(corrupt.local.orphan_key).toEqual({ preserved: true })
  })
})
