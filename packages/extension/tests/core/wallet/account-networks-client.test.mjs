import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '../../../src/core/chains/registry/index.ts'
import { createAccountNetworksClient } from '../../../src/popup/services/account-networks-client.ts'

const walletId = 'wallet:account-networks-client'
const accountId = 'account:account-networks-client:0'
const evmAddress = '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
const privateExecutionAddress = '0xc1d4A6EB60b9c2CFaBcDFEF60C90D04BE174E0f3'
const bitcoinAddress = 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
const bitcoinLegacyAddress = 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC'
const bitcoinNestedSegwitAddress = '2MtoVPpWDqsCuFigA4q9EbfSzJrw8ugvLfs'
const bitcoinTaprootAddress = 'tb1pqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq7vgt27'
const solanaAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const nearAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.zcash',
  'chain.evm',
  'chain.bitcoin',
  'chain.solana',
  'chain.near'
])

function address(value, scheme, privacy = 'transparent', preferredForReceive = true) {
  return { value, scheme, privacy, preferredForReceive }
}

function result(overrides = {}) {
  return {
    result: {
      generationId: 'storage-v2:generation:account-networks-client',
      accounts: [
        {
          walletId,
          walletDisplayName: 'Wallet 1',
          walletCreatedAt: 123,
          walletSource: { kind: 'software' },
          accountId,
          accountDisplayName: 'Account 1',
          accountIndex: 0,
          active: true,
          networks: [
            {
              chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
              addresses: [
                address('utest1shieldedfixture', 'zcash-shielded-unified', 'shielded'),
                address('tmtransparentfixture', 'zcash-transparent-p2pkh', 'transparent', false)
              ]
            },
            {
              chainId: 'eip155:11155111',
              addresses: [address(evmAddress, 'evm')],
              privateExecutionAddress
            },
            {
              chainId: 'bip122:000000000933ea01ad0ee984209779ba',
              addresses: [
                address(bitcoinAddress, 'bitcoin-p2wpkh'),
                address(bitcoinLegacyAddress, 'bitcoin-p2pkh', 'transparent', false),
                address(bitcoinNestedSegwitAddress, 'bitcoin-p2sh-p2wpkh', 'transparent', false),
                address(bitcoinTaprootAddress, 'bitcoin-p2tr', 'transparent', false)
              ]
            },
            {
              chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              addresses: [address(solanaAddress, 'solana')]
            },
            { chainId: 'near:testnet', addresses: [address(nearAddress, 'near')] }
          ]
        }
      ],
      ...overrides
    }
  }
}

test.describe('Account networks Popup client', () => {
  test('requests the trusted catalog and strictly resolves enabled chains', async () => {
    const messages = []
    const client = createAccountNetworksClient(async message => {
      messages.push(message)
      return result()
    }, chains)

    const catalog = await client.getCatalog()

    expect(messages).toEqual([{ type: 'GET_ACCOUNT_NETWORKS' }])
    expect(catalog).toMatchObject({
      generationId: 'storage-v2:generation:account-networks-client',
      accounts: [
        {
          walletId,
          walletDisplayName: 'Wallet 1',
          walletCreatedAt: 123,
          walletSource: { kind: 'software' },
          accountId,
          accountDisplayName: 'Account 1',
          accountIndex: 0,
          active: true,
          networks: [
            {
              chain: { family: 'zcash' },
              addresses: [{ privacy: 'shielded' }, { privacy: 'transparent' }]
            },
            {
              chain: { family: 'evm' },
              addresses: [{ value: evmAddress }],
              privateExecutionAddress
            },
            {
              chain: { family: 'bitcoin' },
              addresses: [
                { value: bitcoinAddress, scheme: 'bitcoin-p2wpkh' },
                { value: bitcoinLegacyAddress, scheme: 'bitcoin-p2pkh' },
                { value: bitcoinNestedSegwitAddress, scheme: 'bitcoin-p2sh-p2wpkh' },
                { value: bitcoinTaprootAddress, scheme: 'bitcoin-p2tr' }
              ]
            },
            { chain: { family: 'solana' }, addresses: [{ value: solanaAddress }] },
            { chain: { family: 'near' }, addresses: [{ value: nearAddress }] }
          ]
        }
      ]
    })
    expect(Object.isFrozen(catalog.accounts[0].networks)).toBe(true)
  })

  test('account catalogs retain wallet creation time and accept legacy entries without it', async () => {
    const account = result().result.accounts[0]
    const read = entry =>
      createAccountNetworksClient(async () => result({ accounts: [entry] }), chains).getCatalog()

    expect((await read(account)).accounts[0].walletCreatedAt).toBe(123)
    const legacy = { ...account }
    delete legacy.walletCreatedAt
    expect((await read(legacy)).accounts[0]).not.toHaveProperty('walletCreatedAt')
    for (const walletCreatedAt of [-1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(read({ ...account, walletCreatedAt })).rejects.toMatchObject({
        code: 'invalid-response'
      })
    }
  })

  test('maps only the canonical error and rejects malformed or disabled data', async () => {
    const unavailable = createAccountNetworksClient(
      async () => ({ error: 'Account networks unavailable' }),
      chains
    )
    await expect(unavailable.getCatalog()).rejects.toMatchObject({ code: 'unavailable' })

    const invalidResponses = [
      { ...result(), unexpected: true },
      result({ accounts: [result().result.accounts[0], result().result.accounts[0]] }),
      result({
        accounts: [
          {
            ...result().result.accounts[0],
            networks: [
              {
                chainId: 'bip122:000000000933ea01ad0ee984209779ba',
                addresses: [address('tb1q-invalid', 'bitcoin-p2wpkh')]
              }
            ]
          }
        ]
      }),
      result({
        accounts: [
          {
            ...result().result.accounts[0],
            networks: [
              {
                chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
                addresses: [
                  address(
                    'u1mainnet-address-in-testnet-build',
                    'zcash-shielded-unified',
                    'shielded'
                  )
                ]
              }
            ]
          }
        ]
      }),
      result({
        accounts: [
          {
            ...result().result.accounts[0],
            networks: [
              {
                chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
                addresses: [address('not-a-solana-address', 'solana')]
              }
            ]
          }
        ]
      }),
      result({
        accounts: [
          {
            ...result().result.accounts[0],
            networks: [
              {
                chainId: 'near:testnet',
                addresses: [address('INVALID.NEAR', 'near')]
              }
            ]
          }
        ]
      })
    ]
    for (const response of invalidResponses) {
      const client = createAccountNetworksClient(async () => response, chains)
      await expect(client.getCatalog()).rejects.toMatchObject({ code: 'invalid-response' })
    }

    const zcashOnly = createAddressGatedChainRegistry(
      createInitialProductChainRegistry('testnet'),
      ['chain.zcash']
    )
    await expect(
      createAccountNetworksClient(async () => result(), zcashOnly).getCatalog()
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })
})
