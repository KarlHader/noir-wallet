import { test } from 'node:test'
import { expect } from '@playwright/test'
import { HDKey } from '@scure/bip32'
import { deriveLedgerBitcoinAddress } from '../../../../src/lib/ledger/bitcoin-model.ts'

import {
  BitcoinAddressBalancesClientError,
  createBitcoinAddressBalancesClient
} from '../../../../src/popup/services/bitcoin-address-balances-client.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const walletId = 'key-domain:wallet'
const accountId = 'account:wallet:0'

function response(overrides = {}) {
  return {
    result: {
      walletId,
      accountId,
      accountIndex: 0,
      accountDerivationPath: "m/84'/0'/0'/0/0",
      chainId,
      updatedAt: 123,
      activeAddressType: 'p2wpkh',
      confirmedRaw: '23910',
      availableRaw: '23910',
      pendingRaw: '0',
      addresses: [
        {
          value: 'bc1q8acm2s0lr05jdlt4e6m0sc303pu0hzn86wfewl',
          addressType: 'p2wpkh',
          addressScheme: 'bitcoin-p2wpkh',
          change: false,
          addressIndex: 0,
          derivationPath: "m/84'/0'/0'/0/0",
          used: true,
          confirmedRaw: '23910',
          availableRaw: '23910',
          pendingRaw: '0',
          utxoCount: 4
        }
      ],
      ...overrides
    }
  }
}

test('parses an account-scoped active Bitcoin address balance catalog', async () => {
  const messages = []
  const client = createBitcoinAddressBalancesClient(async message => {
    messages.push(message)
    return response()
  })

  const catalog = await client.getActiveCatalog()

  expect(messages).toEqual([{ type: 'GET_BITCOIN_ADDRESS_BALANCES' }])
  expect(catalog).toMatchObject({
    walletId,
    accountId,
    accountIndex: 0,
    chainId,
    activeAddressType: 'p2wpkh',
    confirmedRaw: '23910',
    availableRaw: '23910'
  })
  expect(catalog.addresses).toHaveLength(1)
  expect(catalog.addresses[0]).toMatchObject({ addressIndex: 0, confirmedRaw: '23910' })
})

test('persists a scoped active Bitcoin address type through Background', async () => {
  const messages = []
  const client = createBitcoinAddressBalancesClient(async message => {
    messages.push(message)
    return response({
      activeAddressType: 'p2tr',
      confirmedRaw: '0',
      availableRaw: '0',
      pendingRaw: '0',
      addresses: []
    })
  })

  await expect(
    client.setActiveAddressType({ walletId, accountId, addressType: 'p2tr' })
  ).resolves.toMatchObject({ activeAddressType: 'p2tr' })
  expect(messages).toEqual([
    {
      type: 'SET_ACTIVE_BITCOIN_ADDRESS_TYPE',
      walletId,
      accountId,
      addressType: 'p2tr'
    }
  ])
})

test('rejects mismatched totals, paths, duplicate addresses, and unexpected fields', async () => {
  const invalid = [
    response({ confirmedRaw: '23911' }),
    response({
      addresses: [
        {
          ...response().result.addresses[0],
          derivationPath: "m/84'/0'/0'/1/0"
        }
      ],
      confirmedRaw: '23910'
    }),
    response({ addresses: [response().result.addresses[0], response().result.addresses[0]] }),
    { result: { ...response().result, secret: 'unexpected' } }
  ]

  for (const value of invalid) {
    const client = createBitcoinAddressBalancesClient(async () => value)
    await expect(client.getActiveCatalog()).rejects.toMatchObject({
      name: 'BitcoinAddressBalancesClientError',
      code: 'invalid-response'
    })
  }
})

test('accepts a Ledger device root only when the active address uses that root', async () => {
  const root = "m/84'/0'/5'/0/0"
  const active = response().result.addresses[0]
  const client = createBitcoinAddressBalancesClient(async () =>
    response({
      accountDerivationPath: root,
      addresses: [{ ...active, derivationPath: root }]
    })
  )
  await expect(client.getActiveCatalog()).resolves.toMatchObject({
    accountIndex: 0,
    accountDerivationPath: root,
    addresses: [{ derivationPath: root }]
  })

  const mismatched = createBitcoinAddressBalancesClient(async () =>
    response({ accountDerivationPath: root })
  )
  await expect(mismatched.getActiveCatalog()).rejects.toMatchObject({ code: 'invalid-response' })
})

test('retains the imported private-key address path', async () => {
  const client = createBitcoinAddressBalancesClient(async () =>
    response({
      accountDerivationPath: 'm',
      addresses: [{ ...response().result.addresses[0], derivationPath: 'm' }]
    })
  )
  await expect(client.getActiveCatalog()).resolves.toMatchObject({
    accountDerivationPath: 'm',
    addresses: [{ derivationPath: 'm' }]
  })
})

test('parses Ledger receive and change balances from one actual account root', async () => {
  const accountRoot = "m/84'/0'/5'"
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(5)).derive(
    accountRoot
  ).publicExtendedKey
  const addresses = [
    [false, 0, '12000'],
    [false, 3, '34000'],
    [true, 2, '56000']
  ].map(([change, addressIndex, confirmedRaw]) => ({
    ...response().result.addresses[0],
    value: deriveLedgerBitcoinAddress(xpub, 'mainnet', change, addressIndex).address,
    change,
    addressIndex,
    derivationPath: `${accountRoot}/${change ? 1 : 0}/${addressIndex}`,
    confirmedRaw,
    availableRaw: confirmedRaw,
    utxoCount: 1
  }))
  const catalog = response({
    accountDerivationPath: `${accountRoot}/0/0`,
    confirmedRaw: '102000',
    availableRaw: '102000',
    addresses
  })
  const client = createBitcoinAddressBalancesClient(async () => catalog)
  await expect(client.getActiveCatalog()).resolves.toMatchObject({
    accountIndex: 0,
    confirmedRaw: '102000',
    addresses
  })
  for (const entries of [
    [addresses[0], { ...addresses[1], derivationPath: "m/84'/0'/6'/0/3" }, addresses[2]],
    [addresses[0], addresses[1], addresses[1]],
    [addresses[0], { ...addresses[1], addressIndex: 2 }, addresses[2]]
  ]) {
    await expect(
      createBitcoinAddressBalancesClient(async () => ({
        result: { ...catalog.result, addresses: entries }
      })).getActiveCatalog()
    ).rejects.toMatchObject({ code: 'invalid-response' })
  }
})

test('distinguishes an unavailable background response', async () => {
  const client = createBitcoinAddressBalancesClient(async () => ({
    error: 'Bitcoin address balances unavailable'
  }))
  await expect(client.getActiveCatalog()).rejects.toBeInstanceOf(BitcoinAddressBalancesClientError)
  await expect(client.getActiveCatalog()).rejects.toMatchObject({ code: 'unavailable' })
})
