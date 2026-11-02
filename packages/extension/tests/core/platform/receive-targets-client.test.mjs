import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '../../../src/core/chains/registry/index.ts'
import { createReceiveTargetsClient } from '../../../src/popup/services/receive-targets-client.ts'

const keyDomainId = 'wallet:receive-client'
const accountId = 'account:receive-client:0'
const bitcoinAddress = 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
const solanaAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const nearAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.zcash',
  'chain.evm',
  'chain.bitcoin',
  'chain.solana',
  'chain.near'
])

function result(overrides = {}) {
  return {
    result: {
      generationId: 'storage-v2:generation:receive-client',
      keyDomainId,
      accountId,
      targets: [
        {
          chainId: 'eip155:11155111',
          kind: 'evm',
          address: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        },
        {
          chainId: 'bip122:000000000933ea01ad0ee984209779ba',
          kind: 'bitcoin',
          addressType: 'p2wpkh',
          address: bitcoinAddress
        },
        {
          chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          kind: 'solana',
          address: solanaAddress
        },
        {
          chainId: 'near:testnet',
          kind: 'near',
          address: nearAddress
        }
      ],
      ...overrides
    }
  }
}

test.describe('Receive targets Popup client', () => {
  test('binds the request and strictly parses enabled address-only chains', async () => {
    const messages = []
    const client = createReceiveTargetsClient(async message => {
      messages.push(message)
      return result()
    }, chains)

    const received = await client.getAdditionalTargets({ keyDomainId, accountId })

    expect(messages).toEqual([
      { type: 'GET_ADDITIONAL_RECEIVE_TARGETS', walletId: keyDomainId, accountId }
    ])
    expect(received).toMatchObject({
      generationId: 'storage-v2:generation:receive-client',
      keyDomainId,
      accountId,
      targets: [
        {
          chain: { family: 'evm', displayName: 'Ethereum Sepolia' },
          kind: 'evm',
          address: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        },
        {
          chain: { family: 'bitcoin', displayName: 'Bitcoin Testnet' },
          kind: 'bitcoin',
          addressType: 'p2wpkh',
          address: bitcoinAddress
        },
        {
          chain: { family: 'solana', displayName: 'Solana Devnet' },
          kind: 'solana',
          address: solanaAddress
        },
        {
          chain: { family: 'near', displayName: 'NEAR Testnet' },
          kind: 'near',
          address: nearAddress
        }
      ]
    })
    expect(Object.isFrozen(received)).toBe(true)
    expect(Object.isFrozen(received.targets)).toBe(true)
  })

  test('accepts one additional target for every released EVM and Bitcoin chain', async () => {
    const mainnetChains = createAddressGatedChainRegistry(
      createInitialProductChainRegistry('mainnet'),
      ['chain.zcash', 'chain.evm', 'chain.bitcoin']
    )
    const targets = mainnetChains
      .list()
      .filter(chain => chain.family === 'evm')
      .map(chain => ({
        chainId: chain.id,
        kind: 'evm',
        address: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
      }))
    targets.push({
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      kind: 'bitcoin',
      addressType: 'p2wpkh',
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
    })

    expect(targets.length).toBeGreaterThan(8)
    const client = createReceiveTargetsClient(async () => result({ targets }), mainnetChains)

    const received = await client.getAdditionalTargets({ keyDomainId, accountId })

    expect(received.targets).toHaveLength(targets.length)
    expect(received.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chain: expect.objectContaining({ displayName: 'Monad' }),
          kind: 'evm'
        }),
        expect.objectContaining({
          chain: expect.objectContaining({ displayName: 'Bitcoin' }),
          kind: 'bitcoin',
          addressType: 'p2wpkh'
        })
      ])
    )
  })

  test('maps only the canonical Background error to unavailable', async () => {
    const client = createReceiveTargetsClient(
      async () => ({ error: 'Receive targets unavailable' }),
      chains
    )

    await expect(client.getAdditionalTargets({ keyDomainId, accountId })).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  test('rejects stale scope, extra fields, duplicate chains, and malformed Bitcoin addresses', async () => {
    const invalidResponses = [
      result({ accountId: 'account:receive-client:1' }),
      { ...result(), unexpected: true },
      result({
        targets: [result().result.targets[0], result().result.targets[0]]
      }),
      result({
        targets: [
          {
            chainId: 'bip122:000000000933ea01ad0ee984209779ba',
            kind: 'bitcoin',
            addressType: 'p2wpkh',
            address: 'tb1q-invalid'
          }
        ]
      })
    ]

    for (const response of invalidResponses) {
      const client = createReceiveTargetsClient(async () => response, chains)
      await expect(client.getAdditionalTargets({ keyDomainId, accountId })).rejects.toMatchObject({
        code: 'invalid-response'
      })
    }
  })

  test('rejects a disabled chain even when the response shape is valid', async () => {
    const zcashOnly = createAddressGatedChainRegistry(
      createInitialProductChainRegistry('testnet'),
      ['chain.zcash']
    )
    const client = createReceiveTargetsClient(async () => result(), zcashOnly)

    await expect(client.getAdditionalTargets({ keyDomainId, accountId })).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })
})
