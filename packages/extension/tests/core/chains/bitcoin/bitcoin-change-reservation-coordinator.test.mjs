import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import { BitcoinChangeReservationCoordinator } from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const chainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const chainAccount = {
  id: 'chain-account:bitcoin:change-reservation',
  scope: {
    keyDomainId: 'key-domain:bitcoin:change-reservation',
    accountId: 'account:bitcoin:change-reservation',
    chainId
  },
  derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  },
  createdAt: 1_000
}
const scope = { chainAccount, accountIndex: 0, addressType: 'p2wpkh' }

function discoveryState({ complete = true, usedIndexes = [] } = {}) {
  return {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 2,
      maximumAddressesPerTarget: 20,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: true },
          nextAddressIndex: 10,
          consecutiveUnused: complete ? 2 : 1,
          complete
        }
      ]
    },
    observations: usedIndexes.map(addressIndex => ({
      derived: {
        chainId,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: true,
        addressIndex
      },
      activity: { used: true }
    })),
    updatedAt: 2_000
  }
}

function reservationRepository() {
  const values = new Map()
  return {
    values,
    get: async (_scope, transactionId) => values.get(transactionId) ?? null,
    allocate: async input => {
      const existing = values.get(input.transactionId)
      if (existing) {
        if (existing.state === 'abandoned') throw new Error('cannot resume abandoned')
        return existing
      }
      const addressIndex = Math.max(
        input.minimumAddressIndex,
        ...[...values.values()].map(value => value.addressIndex + 1),
        0
      )
      const value = {
        schemaVersion: 1,
        ...scope,
        transactionId: input.transactionId,
        state: 'allocating',
        addressIndex,
        address: null,
        createdAt: input.now,
        updatedAt: input.now
      }
      values.set(input.transactionId, value)
      return value
    },
    bindAddress: async input => {
      const current = values.get(input.transactionId)
      if (!current || current.state === 'abandoned') throw new Error('cannot bind')
      if (current.address) return current
      const value = { ...current, state: 'reserved', address: input.address, updatedAt: input.now }
      values.set(input.transactionId, value)
      return value
    },
    transition: async input => {
      const current = values.get(input.transactionId)
      if (!current) throw new Error('missing reservation')
      if (current.state === input.state) return current
      if (
        (input.state === 'committed' && current.state !== 'reserved') ||
        (input.state === 'abandoned' &&
          current.state !== 'allocating' &&
          current.state !== 'reserved')
      ) {
        throw new Error('invalid transition')
      }
      const value = { ...current, state: input.state, updatedAt: input.now }
      values.set(input.transactionId, value)
      return value
    },
    deleteByAccountScope: async () => 0
  }
}

function derivedAddress(input) {
  return {
    ...input,
    address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    addressScheme: 'bitcoin-p2wpkh',
    derivationScheme: 'bip84',
    derivationPath: `m/84'/0'/0'/1/${input.addressIndex}`,
    publicKey: `0x02${'1'.repeat(64)}`
  }
}

function coordinator({
  discovery = discoveryState(),
  repository = reservationRepository(),
  derive
} = {}) {
  let clock = 3_000
  const discoveryScopes = []
  return {
    repository,
    discoveryScopes,
    instance: new BitcoinChangeReservationCoordinator({
      discoveryRepository: {
        get: async requestedScope => {
          discoveryScopes.push(requestedScope)
          return discovery
        },
        putProgress: async () => {},
        deleteByAccountScope: async () => 0
      },
      reservationRepository: repository,
      derivation: {
        deriveAddress: derive ?? (async (_keyDomainId, input) => derivedAddress(input))
      },
      now: () => clock++
    })
  }
}

test('requires completed change discovery and allocates after the highest used address', async () => {
  const missing = coordinator({ discovery: null })
  await expect(
    missing.instance.reserve({ ...scope, transactionId: 'transaction:missing' })
  ).rejects.toThrow(/discovery must complete/)

  const incomplete = coordinator({ discovery: discoveryState({ complete: false }) })
  await expect(
    incomplete.instance.reserve({ ...scope, transactionId: 'transaction:incomplete' })
  ).rejects.toThrow(/discovery must complete/)

  const ready = coordinator({ discovery: discoveryState({ usedIndexes: [0, 4, 2] }) })
  await expect(
    ready.instance.reserve({ ...scope, transactionId: 'transaction:ready' })
  ).resolves.toMatchObject({ state: 'reserved', addressIndex: 5 })
  expect(ready.discoveryScopes).toEqual([{ chainAccount, accountIndex: 0 }])
})

test('deduplicates concurrent derivation for the same transaction', async () => {
  let derives = 0
  const ready = coordinator({
    derive: async (_keyDomainId, input) => {
      derives += 1
      await Promise.resolve()
      return derivedAddress(input)
    }
  })
  const input = { ...scope, transactionId: 'transaction:concurrent' }
  const [first, second] = await Promise.all([
    ready.instance.reserve(input),
    ready.instance.reserve(input)
  ])
  expect(first).toEqual(second)
  expect(first).toMatchObject({ state: 'reserved', addressIndex: 0 })
  expect(derives).toBe(1)
})

test('resumes a crash-interrupted allocation without discovery or index reuse', async () => {
  const repository = reservationRepository()
  await repository.allocate({
    ...scope,
    transactionId: 'transaction:resume',
    minimumAddressIndex: 7,
    now: 2_500
  })
  let discoveryReads = 0
  const instance = new BitcoinChangeReservationCoordinator({
    discoveryRepository: {
      get: async () => {
        discoveryReads += 1
        throw new Error('discovery unavailable')
      },
      putProgress: async () => {},
      deleteByAccountScope: async () => 0
    },
    reservationRepository: repository,
    derivation: {
      deriveAddress: async (_keyDomainId, input) => derivedAddress(input)
    },
    now: () => 3_000
  })

  await expect(
    instance.reserve({ ...scope, transactionId: 'transaction:resume' })
  ).resolves.toMatchObject({ state: 'reserved', addressIndex: 7 })
  expect(discoveryReads).toBe(0)
})

test('keeps abandoned indexes as tombstones and committed reservations terminal', async () => {
  const ready = coordinator()
  const abandoned = { ...scope, transactionId: 'transaction:abandoned' }
  await ready.instance.reserve(abandoned)
  await expect(ready.instance.abandon(scope, abandoned.transactionId)).resolves.toMatchObject({
    state: 'abandoned',
    addressIndex: 0
  })
  await expect(ready.instance.reserve(abandoned)).rejects.toThrow(/cannot resume/)

  const next = { ...scope, transactionId: 'transaction:next' }
  await expect(ready.instance.reserve(next)).resolves.toMatchObject({
    state: 'reserved',
    addressIndex: 1
  })
  await expect(ready.instance.commit(scope, next.transactionId)).resolves.toMatchObject({
    state: 'committed',
    addressIndex: 1
  })
  await expect(ready.instance.abandon(scope, next.transactionId)).rejects.toThrow(
    /invalid transition/
  )
})

test('abandons a change index found used during required Ledger discovery', async () => {
  const repository = reservationRepository()
  const derivations = []
  const instance = new BitcoinChangeReservationCoordinator({
    discoveryRepository: { get: async () => discoveryState() },
    reservationRepository: repository,
    derivation: {
      deriveAddress: async (_keyDomainId, input) => {
        derivations.push(input)
        return derivedAddress(input)
      }
    },
    ensureDiscovered: async (_scope, addressIndex) => ({
      derived: derivedAddress({ ...scope, change: true, addressIndex }),
      activity: { used: true },
      utxos: []
    }),
    now: () => 3_000
  })
  await expect(
    instance.reserve({ ...scope, transactionId: 'transaction:used-change' })
  ).rejects.toThrow(/already used/)
  expect(repository.values.get('transaction:used-change').state).toBe('abandoned')
  expect(derivations).toHaveLength(0)
})
