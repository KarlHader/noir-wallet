import { expect, test } from '../helpers/extension-fixtures'

test('persists Bitcoin discovery checkpoints and observations atomically across reloads', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-discovery-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.initialize(name)
    }, databaseName)
  ).resolves.toMatchObject({
    rejectedInvalidAdvance: true,
    observationsAfterFailure: 1,
    final: {
      checkpoint: { cursors: [{ nextAddressIndex: 2, complete: true }] },
      observations: [{ derived: { addressIndex: 0 } }, { derived: { addressIndex: 1 } }]
    }
  })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.inspect(name)
    }, databaseName)
  ).resolves.toMatchObject({
    state: {
      updatedAt: 2_001,
      checkpoint: { cursors: [{ nextAddressIndex: 2, complete: true }] },
      observations: [{ derived: { addressIndex: 0 } }, { derived: { addressIndex: 1 } }]
    },
    deleted: 1,
    afterDelete: null
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})

test('atomically refreshes discovered UTXOs and reopens a completed gap', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-discovery-refresh-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.refresh(name)
    }, databaseName)
  ).resolves.toMatchObject({
    rejectedIdentityChange: true,
    state: {
      updatedAt: 3_000,
      checkpoint: {
        cursors: [{ nextAddressIndex: 2, consecutiveUnused: 0, complete: false }]
      },
      observations: [
        { derived: { addressIndex: 0 }, utxos: [] },
        {
          derived: { addressIndex: 1 },
          activity: { used: true },
          utxos: [{ transactionId: 'd'.repeat(64), outputIndex: 0, valueRaw: '2500' }]
        }
      ]
    }
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})

test('extends a persisted Bitcoin discovery checkpoint without changing historical cursors', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-discovery-target-extension-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.extendDiscoveryTargets(name)
    }, databaseName)
  ).resolves.toMatchObject({
    rejectedExistingCursorChange: true,
    state: {
      updatedAt: 3_000,
      checkpoint: {
        cursors: [
          { target: { addressType: 'p2wpkh' }, nextAddressIndex: 2, complete: true },
          { target: { addressType: 'p2pkh' }, nextAddressIndex: 0, complete: false },
          { target: { addressType: 'p2sh-p2wpkh' }, nextAddressIndex: 0, complete: false }
        ]
      },
      observations: [{ derived: { addressIndex: 0 } }, { derived: { addressIndex: 1 } }]
    }
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})

test('persists an active address type before earlier address types are scanned', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-discovery-independent-target-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.initializeIndependentTarget(name)
    }, databaseName)
  ).resolves.toMatchObject({
    updatedAt: 3_500,
    checkpoint: {
      cursors: [
        { target: { addressType: 'p2wpkh' }, nextAddressIndex: 0, complete: false },
        { target: { addressType: 'p2tr' }, nextAddressIndex: 1, complete: true }
      ]
    },
    observations: [{ derived: { addressType: 'p2tr', addressIndex: 0 } }]
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})

test('persists monotonic Bitcoin change reservations and tombstones across reloads', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-change-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.initializeChanges(name)
    }, databaseName)
  ).resolves.toMatchObject({
    repeatedAllocation: { state: 'allocating', addressIndex: 3 },
    committed: { state: 'committed', addressIndex: 3 },
    abandoned: { state: 'abandoned', addressIndex: 4 },
    interrupted: { state: 'allocating', addressIndex: 5, address: null },
    rejectedTerminalTransition: true
  })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.inspectChanges(name)
    }, databaseName)
  ).resolves.toMatchObject({
    committed: { state: 'committed', addressIndex: 3 },
    abandoned: { state: 'abandoned', addressIndex: 4 },
    interruptedBeforeBind: { state: 'allocating', addressIndex: 5 },
    resumed: { state: 'reserved', addressIndex: 5 },
    next: { state: 'allocating', addressIndex: 6 },
    deleted: 4,
    afterDelete: null
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})

test('atomically prevents Bitcoin input reuse across transactions and reloads', async ({
  popup,
  extensionId
}) => {
  const databaseName = `bitcoin-input-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/bitcoin-discovery-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)

  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.initializeInputs(name)
    }, databaseName)
  ).resolves.toMatchObject({
    first: {
      state: 'reserved',
      outpoints: [
        { transactionId: 'a'.repeat(64), outputIndex: 0 },
        { transactionId: 'b'.repeat(64), outputIndex: 1 }
      ]
    },
    repeated: { state: 'reserved' },
    rejectedConflict: true,
    committed: { state: 'committed' },
    rejectedCommittedRelease: true,
    concurrentWinnerCount: 1,
    reserved: { state: 'reserved' }
  })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.bitcoinDiscoveryRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(name => {
      return window.bitcoinDiscoveryRepositoryIntegration!.inspectInputs(name)
    }, databaseName)
  ).resolves.toMatchObject({
    committed: { state: 'committed' },
    reserved: { state: 'reserved' },
    listed: [{ state: 'committed' }, { state: 'reserved' }],
    accountListed: [{ state: 'committed' }, { state: 'reserved' }],
    rejectedCommittedConflict: true,
    retiredCommitted: true,
    afterRetire: null,
    deleted: 1,
    afterDelete: null
  })
  await popup.evaluate(
    name => window.bitcoinDiscoveryRepositoryIntegration!.reset(name),
    databaseName
  )
})
