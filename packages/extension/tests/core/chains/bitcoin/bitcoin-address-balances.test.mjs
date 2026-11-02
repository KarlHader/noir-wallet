import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  BitcoinAddressBalancesCoordinator,
  projectBitcoinAddressBalanceCatalog
} from '../../../../src/background/bitcoin-address-balances.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'

function observation(addressType, change, addressIndex, used, values) {
  const purpose =
    addressType === 'p2pkh'
      ? 44
      : addressType === 'p2sh-p2wpkh'
        ? 49
        : addressType === 'p2wpkh'
          ? 84
          : 86
  const scheme = {
    p2pkh: 'bitcoin-p2pkh',
    'p2sh-p2wpkh': 'bitcoin-p2sh-p2wpkh',
    p2wpkh: 'bitcoin-p2wpkh',
    p2tr: 'bitcoin-p2tr'
  }[addressType]
  const transactionDigit = {
    p2wpkh: addressIndex === 0 ? '1' : '2',
    'p2sh-p2wpkh': '3',
    p2tr: '4',
    p2pkh: '5'
  }[addressType]
  return {
    derived: {
      chainId,
      addressType,
      addressScheme: scheme,
      change,
      addressIndex,
      derivationPath: `m/${purpose}'/0'/0'/${change ? 1 : 0}/${addressIndex}`,
      address: `${addressType}:${change}:${addressIndex}`
    },
    activity: { used },
    utxos: values.map(({ valueRaw, confirmed, transactionId, outputIndex = 0 }, index) => ({
      transactionId: transactionId ?? transactionDigit.repeat(63 - index) + String(index + 1),
      outputIndex,
      valueRaw,
      status: { confirmed }
    }))
  }
}

test('projects only the active Bitcoin address and excludes other derived balances', () => {
  const catalog = projectBitcoinAddressBalanceCatalog(
    {
      chainAccount: {
        scope: {
          keyDomainId: 'key-domain:wallet',
          accountId: 'account:0',
          chainId
        },
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
      },
      accountIndex: 0,
      updatedAt: 123,
      observations: [
        observation('p2wpkh', false, 0, true, [{ valueRaw: '23910', confirmed: true }]),
        observation('p2wpkh', false, 3, true, [{ valueRaw: '804', confirmed: true }]),
        observation('p2sh-p2wpkh', false, 2, true, [{ valueRaw: '1299', confirmed: true }]),
        observation('p2tr', false, 1, true, [{ valueRaw: '560', confirmed: true }]),
        observation('p2pkh', false, 0, true, [{ valueRaw: '5000', confirmed: true }]),
        observation('p2wpkh', true, 0, false, []),
        observation('p2tr', false, 0, false, []),
        observation('p2tr', false, 4, false, [])
      ]
    },
    new Set(['1111111111111111111111111111111111111111111111111111111111111111:0'])
  )

  expect(catalog).toMatchObject({
    walletId: 'key-domain:wallet',
    accountId: 'account:0',
    accountIndex: 0,
    chainId,
    updatedAt: 123,
    activeAddressType: 'p2wpkh',
    confirmedRaw: '23910',
    availableRaw: '0',
    pendingRaw: '0'
  })
  expect(catalog.addresses.map(address => address.derivationPath)).toEqual(["m/84'/0'/0'/0/0"])
  expect(catalog.addresses.find(address => address.confirmedRaw === '23910')).toMatchObject({
    availableRaw: '0'
  })
  expect(catalog.addresses.some(address => address.addressIndex !== 0)).toBe(false)

  const legacy = projectBitcoinAddressBalanceCatalog(
    {
      ...catalog,
      chainAccount: {
        scope: { keyDomainId: catalog.walletId, accountId: catalog.accountId, chainId },
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
      },
      observations: [
        observation('p2wpkh', false, 0, true, [{ valueRaw: '23910', confirmed: true }]),
        observation('p2pkh', false, 0, true, [{ valueRaw: '5000', confirmed: true }])
      ]
    },
    new Set(),
    'p2pkh'
  )
  expect(legacy).toMatchObject({
    activeAddressType: 'p2pkh',
    confirmedRaw: '5000',
    availableRaw: '5000'
  })
  expect(legacy.addresses).toHaveLength(1)
  expect(legacy.addresses[0]).toMatchObject({ addressType: 'p2pkh', confirmedRaw: '5000' })
})

test('aggregates Ledger receive and change children under the stored account root', () => {
  const root = "m/84'/0'/5'"
  const observations = [
    observation('p2wpkh', false, 0, true, [
      { valueRaw: '1000', confirmed: true, transactionId: 'a'.repeat(64) }
    ]),
    observation('p2wpkh', false, 1, true, [
      { valueRaw: '2000', confirmed: true, transactionId: 'b'.repeat(64) }
    ]),
    observation('p2wpkh', true, 0, true, [
      { valueRaw: '3000', confirmed: true, transactionId: 'c'.repeat(64) }
    ])
  ].map(item => ({
    ...item,
    derived: {
      ...item.derived,
      derivationPath: `${root}/${item.derived.change ? 1 : 0}/${item.derived.addressIndex}`
    }
  }))
  const state = {
    chainAccount: {
      scope: { keyDomainId: 'key-domain:ledger', accountId: 'account:ledger:0', chainId },
      derivation: { scheme: 'bip84', path: `${root}/0/0` }
    },
    accountIndex: 0,
    updatedAt: 2_000,
    observations
  }
  const catalog = projectBitcoinAddressBalanceCatalog(state, new Set(), 'p2wpkh', root)
  expect(catalog.addresses).toHaveLength(3)
  expect(catalog).toMatchObject({ confirmedRaw: '6000', availableRaw: '6000' })
  expect(() =>
    projectBitcoinAddressBalanceCatalog(
      {
        ...state,
        observations: [
          observations[0],
          {
            ...observations[1],
            utxos: observations[0].utxos
          }
        ]
      },
      new Set(),
      'p2wpkh',
      root
    )
  ).toThrow(/duplicate outpoint/)
  expect(() =>
    projectBitcoinAddressBalanceCatalog(
      {
        ...state,
        observations: [
          {
            ...observations[1],
            derived: { ...observations[1].derived, derivationPath: "m/84'/0'/6'/0/1" }
          }
        ]
      },
      new Set(),
      'p2wpkh',
      root
    )
  ).toThrow(/another account/)
})

test('persists an address-type switch only after the target scan completes', async () => {
  const chainAccount = {
    id: 'chain-account:bitcoin:address-balances',
    scope: {
      keyDomainId: 'key-domain:bitcoin:address-balances',
      accountId: 'account:bitcoin:address-balances',
      chainId
    },
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: {
      kind: 'account-identifier',
      value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
    },
    createdAt: 1_000
  }
  const pointer = {
    schemaVersion: 2,
    generationId: 'metadata:generation:bitcoin-address-balances',
    sourceFingerprint: 'a'.repeat(64),
    committedAt: 1_000
  }
  const snapshot = {
    manifest: {
      schemaVersion: 2,
      generationId: pointer.generationId,
      status: 'verified',
      sourceFingerprint: pointer.sourceFingerprint,
      createdAt: 1_000,
      verifiedAt: 1_000,
      entityCounts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 0 },
      activeAccount: {
        keyDomainId: chainAccount.scope.keyDomainId,
        accountId: chainAccount.scope.accountId
      }
    },
    keyDomains: [
      {
        id: chainAccount.scope.keyDomainId,
        credentialRef: 'credential-set:bitcoin:address-balances',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: chainAccount.scope.accountId,
        keyDomainId: chainAccount.scope.keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [chainAccount],
    addresses: []
  }
  const state = {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 1,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 1,
          complete: true
        },
        {
          target: { addressType: 'p2tr', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 0,
          complete: true
        }
      ]
    },
    observations: [
      observation('p2wpkh', false, 0, false, []),
      observation('p2tr', false, 0, true, [{ valueRaw: '560', confirmed: true }])
    ],
    updatedAt: 2_000
  }
  const storageRepository = {
    getActivePointer: async () => pointer,
    getSnapshot: async () => snapshot
  }
  const discoveryRepository = { get: async () => state }
  const inputReservations = {
    list: async scope => {
      expect(scope.addressType).toBe('p2tr')
      return []
    }
  }
  let selected = 'p2wpkh'
  const writes = []
  const preferences = {
    get: async () => selected,
    set: async (_scope, addressType) => {
      writes.push(addressType)
      selected = addressType
      return addressType
    }
  }
  const failing = new BitcoinAddressBalancesCoordinator(
    storageRepository,
    discoveryRepository,
    inputReservations,
    chainId,
    preferences,
    async () => {
      throw new Error('provider unavailable')
    }
  )

  await expect(
    failing.setActive({
      walletId: chainAccount.scope.keyDomainId,
      accountId: chainAccount.scope.accountId,
      addressType: 'p2tr'
    })
  ).rejects.toThrow(/provider unavailable/)
  expect(writes).toEqual([])
  expect(selected).toBe('p2wpkh')

  const successful = new BitcoinAddressBalancesCoordinator(
    storageRepository,
    discoveryRepository,
    inputReservations,
    chainId,
    preferences,
    async addressType => {
      expect(addressType).toBe('p2tr')
      expect(writes).toEqual([])
      return state
    }
  )
  await expect(
    successful.setActive({
      walletId: chainAccount.scope.keyDomainId,
      accountId: chainAccount.scope.accountId,
      addressType: 'p2tr'
    })
  ).resolves.toMatchObject({
    activeAddressType: 'p2tr',
    confirmedRaw: '560',
    availableRaw: '560'
  })
  expect(writes).toEqual(['p2tr'])
})
