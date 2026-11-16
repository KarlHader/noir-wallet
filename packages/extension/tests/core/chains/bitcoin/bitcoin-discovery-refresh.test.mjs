import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  BitcoinDiscoveryError,
  BitcoinDiscoveryRefresher,
  assertBitcoinDiscoveryRefreshTransition
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { parseCheckpoint } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-discovery-persistence-model.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const chainAccount = {
  id: 'chain-account:bitcoin:refresh',
  scope: {
    keyDomainId: 'key-domain:bitcoin:refresh',
    accountId: 'account:bitcoin:refresh',
    chainId
  },
  derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
  identity: { kind: 'account-identifier', value: address },
  createdAt: 1_000
}

function observation(addressIndex, used = false, utxos = []) {
  return {
    derived: {
      chainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex,
      address,
      addressScheme: 'bitcoin-p2wpkh',
      derivationScheme: 'bip84',
      derivationPath: `m/84'/0'/0'/0/${addressIndex}`,
      publicKey: `0x02${'1'.repeat(64)}`
    },
    activity: {
      confirmedTransactionCount: used ? 1 : 0,
      mempoolTransactionCount: 0,
      used
    },
    utxos
  }
}

function state() {
  return {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 3,
      maximumAddressesPerTarget: 10,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 3,
          consecutiveUnused: 3,
          complete: true
        }
      ]
    },
    observations: [observation(0), observation(1), observation(2)],
    updatedAt: 1_000
  }
}

function importedState() {
  const profiles = [
    {
      addressType: 'p2wpkh',
      address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      addressScheme: 'bitcoin-p2wpkh',
      scriptPubKey: '0x0014751e76e8199196d454941c45d1b3a323f1433bd6'
    },
    {
      addressType: 'p2tr',
      address: 'bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9',
      addressScheme: 'bitcoin-p2tr',
      scriptPubKey: '0x5120da4710964f7852695de2da025290e24af6d8c281de5a0b902b7135fd9fd74d21'
    },
    {
      addressType: 'p2pkh',
      address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      addressScheme: 'bitcoin-p2pkh',
      scriptPubKey: '0x76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
    },
    {
      addressType: 'p2sh-p2wpkh',
      address: '3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN',
      addressScheme: 'bitcoin-p2sh-p2wpkh',
      scriptPubKey: '0xa914bcfeb728b584253d5f3f70bcb780e9ef218a68f487',
      redeemScript: '0x0014751e76e8199196d454941c45d1b3a323f1433bd6'
    }
  ]
  const importedChainAccount = {
    ...chainAccount,
    derivation: { scheme: 'imported', path: 'm' },
    identity: { kind: 'account-identifier', value: profiles[0].address }
  }
  return {
    chainAccount: importedChainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 1,
      cursors: profiles.map(profile => ({
        target: { addressType: profile.addressType, change: false },
        nextAddressIndex: 1,
        consecutiveUnused: 1,
        complete: true
      }))
    },
    observations: profiles.map(profile => ({
      derived: {
        chainId,
        addressType: profile.addressType,
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: profile.address,
        addressScheme: profile.addressScheme,
        derivationScheme: 'imported',
        derivationPath: 'm',
        publicKey: `0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`,
        scriptPubKey: profile.scriptPubKey,
        ...(profile.redeemScript === undefined ? {} : { redeemScript: profile.redeemScript })
      },
      activity: {
        confirmedTransactionCount: 0,
        mempoolTransactionCount: 0,
        used: false
      },
      utxos: []
    })),
    updatedAt: 1_000
  }
}

test.describe('Bitcoin discovery refresh', () => {
  test('accepts a used fixed current-address checkpoint for a software account', () => {
    const checkpoint = {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 1,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 0,
          complete: true
        },
        {
          target: { addressType: 'p2tr', change: false },
          nextAddressIndex: 0,
          consecutiveUnused: 0,
          complete: false
        },
        {
          target: { addressType: 'p2pkh', change: false },
          nextAddressIndex: 0,
          consecutiveUnused: 0,
          complete: false
        },
        {
          target: { addressType: 'p2sh-p2wpkh', change: false },
          nextAddressIndex: 0,
          consecutiveUnused: 0,
          complete: false
        }
      ]
    }

    expect(parseCheckpoint(checkpoint, { chainAccount, accountIndex: 0 })).toEqual(checkpoint)
  })

  test('accepts a persisted checkpoint when refresh reopens an earlier completed target', () => {
    const checkpoint = {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 3,
      maximumAddressesPerTarget: 10,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 3,
          consecutiveUnused: 1,
          complete: false
        },
        {
          target: { addressType: 'p2wpkh', change: true },
          nextAddressIndex: 3,
          consecutiveUnused: 3,
          complete: true
        }
      ]
    }

    expect(parseCheckpoint(checkpoint, { chainAccount, accountIndex: 0 })).toEqual(checkpoint)
  })

  test('refreshes existing UTXOs and reopens a completed gap after a historical address becomes used', async () => {
    let activityCall = 0
    const utxo = {
      transactionId: 'a'.repeat(64),
      outputIndex: 0,
      valueRaw: '1200',
      status: { confirmed: true, blockHeight: 100, blockHash: 'b'.repeat(64) }
    }
    const refresher = new BitcoinDiscoveryRefresher({
      concurrency: 1,
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async () => {
          const used = activityCall === 1
          activityCall += 1
          return {
            confirmedTransactionCount: used ? 1 : 0,
            mempoolTransactionCount: 0,
            used
          }
        },
        getAddressUtxos: async () => [utxo]
      }
    })
    const previous = state()

    const refreshed = await refresher.refresh({ state: previous })

    expect(refreshed.observations.map(item => item.activity.used)).toEqual([false, true, false])
    expect(refreshed.observations[1].utxos).toEqual([utxo])
    expect(refreshed.checkpoint.cursors).toEqual([
      {
        target: { addressType: 'p2wpkh', change: false },
        nextAddressIndex: 3,
        consecutiveUnused: 1,
        complete: false
      }
    ])
    expect(() =>
      assertBitcoinDiscoveryRefreshTransition(
        previous,
        refreshed.checkpoint,
        refreshed.observations
      )
    ).not.toThrow()
  })

  test('fails closed without returning a partial refresh when one address request is invalid', async () => {
    let calls = 0
    const refresher = new BitcoinDiscoveryRefresher({
      concurrency: 1,
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async () => {
          calls += 1
          if (calls === 2) throw new Error('provider unavailable')
          return {
            confirmedTransactionCount: 0,
            mempoolTransactionCount: 0,
            used: false
          }
        },
        getAddressUtxos: async () => []
      }
    })

    await expect(refresher.refresh({ state: state() })).rejects.toMatchObject({
      name: BitcoinDiscoveryError.name,
      code: 'rpc-failure'
    })
  })

  test('active refresh updates exposed, used, and next gap-frontier addresses', async () => {
    const requests = []
    const previous = state()
    previous.observations[1] = observation(1, true, [
      {
        transactionId: 'c'.repeat(64),
        outputIndex: 0,
        valueRaw: '300',
        status: { confirmed: true, blockHeight: 101, blockHash: 'd'.repeat(64) }
      }
    ])
    const refresher = new BitcoinDiscoveryRefresher({
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async value => {
          requests.push(value)
          return {
            confirmedTransactionCount: 1,
            mempoolTransactionCount: 0,
            used: true
          }
        },
        getAddressUtxos: async () => []
      }
    })

    const refreshed = await refresher.refresh({ state: previous, mode: 'active' })

    expect(requests).toHaveLength(2)
    expect(refreshed.observations[0].activity.used).toBe(true)
    expect(refreshed.observations[1].utxos).toEqual([])
    expect(refreshed.observations[2].activity.used).toBe(true)
  })

  test('active refresh updates known-used UTXOs without repeating the address activity request', async () => {
    const previous = state()
    previous.observations[1] = observation(1, true, [
      {
        transactionId: 'c'.repeat(64),
        outputIndex: 0,
        valueRaw: '300',
        status: { confirmed: true, blockHeight: 101, blockHash: 'd'.repeat(64) }
      }
    ])
    const activityRequests = []
    const utxoRequests = []
    const refresher = new BitcoinDiscoveryRefresher({
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async value => {
          activityRequests.push(value)
          return {
            confirmedTransactionCount: 0,
            mempoolTransactionCount: 0,
            used: false
          }
        },
        getAddressUtxos: async value => {
          utxoRequests.push(value)
          return []
        }
      }
    })

    const refreshed = await refresher.refresh({ state: previous, mode: 'active' })

    expect(activityRequests).toHaveLength(2)
    expect(utxoRequests).toEqual([previous.observations[1].derived.address])
    expect(refreshed.observations[1].activity).toEqual(previous.observations[1].activity)
    expect(refreshed.observations[1].utxos).toEqual([])
  })

  test('active refresh does not query cached addresses from inactive address types', async () => {
    const previous = state()
    const taproot = {
      ...observation(0),
      derived: {
        ...observation(0).derived,
        addressType: 'p2tr',
        address: 'bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9',
        addressScheme: 'bitcoin-p2tr',
        derivationScheme: 'bip86',
        derivationPath: "m/86'/0'/0'/0/0"
      }
    }
    previous.checkpoint = {
      ...previous.checkpoint,
      cursors: [
        ...previous.checkpoint.cursors,
        {
          target: { addressType: 'p2tr', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 1,
          complete: false
        }
      ]
    }
    previous.observations.push(taproot)
    const requests = []
    const refresher = new BitcoinDiscoveryRefresher({
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async value => {
          requests.push(value)
          return {
            confirmedTransactionCount: 0,
            mempoolTransactionCount: 0,
            used: false
          }
        },
        getAddressUtxos: async () => []
      }
    })

    const refreshed = await refresher.refresh({
      state: previous,
      mode: 'active',
      addressType: 'p2wpkh'
    })

    expect(requests).toEqual([previous.observations[0].derived.address])
    expect(refreshed.observations.at(-1)).toEqual(taproot)
    expect(refreshed.checkpoint.cursors.at(-1)).toEqual(previous.checkpoint.cursors.at(-1))
  })

  test('rejects refresh data that changes a persisted derived address identity', () => {
    const previous = state()
    const observations = [
      {
        ...previous.observations[0],
        derived: { ...previous.observations[0].derived, publicKey: `0x03${'2'.repeat(64)}` }
      },
      ...previous.observations.slice(1)
    ]

    expect(() =>
      assertBitcoinDiscoveryRefreshTransition(previous, previous.checkpoint, observations)
    ).toThrow(/cannot change derived address identity/)
  })

  test('refreshes an imported private key as four fixed addresses without reopening HD discovery', async () => {
    const previous = importedState()
    const refresher = new BitcoinDiscoveryRefresher({
      rpc: {
        assertExpectedChain: async () => {},
        getTipHeight: async () => 105,
        getAddressActivity: async () => ({
          confirmedTransactionCount: 1,
          mempoolTransactionCount: 0,
          used: true
        }),
        getAddressUtxos: async () => []
      }
    })

    const refreshed = await refresher.refresh({ state: previous })

    expect(refreshed.observations).toHaveLength(4)
    expect(refreshed.observations.every(item => item.activity.used)).toBe(true)
    expect(refreshed.checkpoint.cursors.every(cursor => cursor.complete)).toBe(true)
    expect(() =>
      assertBitcoinDiscoveryRefreshTransition(
        previous,
        refreshed.checkpoint,
        refreshed.observations
      )
    ).not.toThrow()
  })
})
