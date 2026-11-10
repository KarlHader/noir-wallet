import { test } from 'node:test'
import { expect } from '@playwright/test'
import bs58check from 'bs58check'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import {
  nextDashChangeIndex,
  nextDashChangeStartIndex
} from '../../../../src/infrastructure/chains/dash/dash-change-reservation-model.ts'
import { DashTransferPreparationCoordinator } from '../../../../src/infrastructure/chains/dash/dash-transfer-preparation-coordinator.ts'

const CHAIN = DASH_CHAIN_IDS.testnet

function p2pkh(index) {
  const hash = Buffer.alloc(20, index)
  return bs58check.encode(Buffer.concat([Buffer.from([140]), hash]))
}

function discoveredAccount() {
  const address = p2pkh(1)
  const chainAccount = {
    id: 'chain-account-dash-fee',
    scope: { keyDomainId: 'wallet-dash', accountId: 'account-dash', chainId: CHAIN },
    derivation: { scheme: 'bip44', path: "m/44'/1'/0'/0/0" },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1
  }
  return {
    chainAccount,
    accountIndex: 0,
    network: 'testnet',
    imported: false,
    checkpoint: {
      cursors: [{ change: false, complete: true }]
    },
    observations: [
      {
        derived: { change: false, addressIndex: 0, address },
        utxos: []
      }
    ],
    updatedAt: 1
  }
}

test('uses the Insight relay fee as duffs per kilobyte', async () => {
  const state = discoveredAccount()
  let requested = 0
  const coordinator = new DashTransferPreparationCoordinator({
    discoveryRepository: { get: async () => state },
    derivation: {
      deriveAddress: async () => {
        throw new Error('fee parsing should finish before derivation')
      }
    },
    rpc: {
      getNetworkFeeRate: async () => {
        requested += 1
        return '1000'
      },
      getRawTransaction: async () => {
        throw new Error('fee parsing should finish before raw transactions')
      }
    },
    inputReservations: {
      list: async () => [],
      reserve: async () => {
        throw new Error('fee parsing should finish before reservation')
      },
      release: async () => undefined
    },
    changeReservations: {
      list: async () => [],
      allocate: async () => {
        throw new Error('unused')
      },
      bindAddress: async () => {
        throw new Error('unused')
      },
      transition: async () => undefined
    }
  })

  await expect(
    coordinator.prepare({
      ...state,
      transactionId: 'transaction:dash:fee',
      recipient: p2pkh(2),
      amount: { mode: 'exact', valueDuffs: '1000' }
    })
  ).rejects.toThrow('No spendable Dash UTXOs')
  expect(requested).toBe(1)
})

test('uses the first change address when the scanned gap has not been used', () => {
  const observations = [...Array(20).keys()].map(addressIndex => ({
    derived: { change: true, addressIndex, address: p2pkh(addressIndex) },
    transactions: [],
    utxos: []
  }))
  observations.push({
    derived: { change: false, addressIndex: 7, address: p2pkh(70) },
    transactions: [{ transactionId: 'receive' }],
    utxos: [{ valueDuffs: '1' }]
  })
  expect(nextDashChangeStartIndex(observations)).toBe(0)
  expect(nextDashChangeIndex([], nextDashChangeStartIndex(observations))).toBe(0)

  const used = observations.map(observation =>
    observation.derived.change && observation.derived.addressIndex === 4
      ? { ...observation, utxos: [{ valueDuffs: '1' }] }
      : observation
  )
  expect(nextDashChangeStartIndex(used)).toBe(5)
  expect(
    nextDashChangeIndex(
      [{ state: 'reserved', addressIndex: 5 }, { state: 'abandoned', addressIndex: 6 }],
      nextDashChangeStartIndex(used)
    )
  ).toBe(6)
})
