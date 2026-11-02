import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  RetainedV1InventoryCoordinator,
  RetainedV1MigrationCoordinator,
  RetainedV1ReconciliationCoordinator
} from '../../../src/infrastructure/keyring/migration/index.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/index.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

const chains = Object.freeze({
  zcashNetwork: 'mainnet',
  zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  evmChainId: 'eip155:1',
  bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
})

function forbiddenPort(label) {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(`${label} must not be called`)
        }
      }
    }
  )
}

function inputFor(fixtureId) {
  const fixture = V1_MIGRATION_FIXTURES.find(item => item.id === fixtureId)
  return {
    discovery: discoverV1Metadata(fixture.local),
    credentialEnvelopes: fixture.local,
    password: 'test-password',
    chains
  }
}

for (const fixtureId of ['keystone-single-account', 'software-and-keystone']) {
  test(`keeps the software-only migration coordinator closed for ${fixtureId}`, async () => {
    const storageRepository = forbiddenPort('Storage repository')
    const credentialRepository = forbiddenPort('Credential repository')
    const compatibilityWorker = forbiddenPort('Compatibility Worker')
    const options = { storageRepository, credentialRepository, compatibilityWorker }
    const input = inputFor(fixtureId)

    await expect(new RetainedV1MigrationCoordinator(options).migrate(input)).rejects.toThrow(
      /cannot include hardware Wallet Sets/
    )
    if (fixtureId === 'keystone-single-account') {
      await expect(new RetainedV1InventoryCoordinator(options).synchronize(input)).rejects.toThrow(
        /requires a software Wallet Set/
      )
      await expect(
        new RetainedV1ReconciliationCoordinator(options).synchronize(input)
      ).rejects.toThrow(/requires a software Wallet Set/)
    }
  })
}
