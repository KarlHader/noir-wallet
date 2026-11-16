import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledBitcoinAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  BitcoinDiscoveryError,
  BitcoinDiscoveryReadError,
  BitcoinPortfolioCoordinator,
  BitcoinPortfolioCoordinatorError
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
initEccLib(secp256k1)
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledBitcoinAssetDefinitions('mainnet'))
const privateKey = Buffer.alloc(32)
privateKey[31] = 1
const identity = payments.p2wpkh({
  pubkey: Buffer.from(secp256k1.pointFromScalar(privateKey, true)),
  network: networks.bitcoin
}).address
if (!identity) throw new Error('Unable to derive Bitcoin test identity')
const chainAccount = {
  id: 'chain-account:bitcoin:portfolio',
  scope: {
    keyDomainId: 'key-domain:bitcoin',
    accountId: 'account:bitcoin:0',
    chainId
  },
  derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
  identity: { kind: 'account-identifier', value: identity },
  createdAt: 1
}
const keyDomain = {
  id: chainAccount.scope.keyDomainId,
  credentialRef: 'credential-set:bitcoin:portfolio',
  source: { kind: 'software', mnemonicWordCount: 24 },
  displayName: 'Wallet 1',
  createdAt: 1
}
const context = { generationId: 'generation:bitcoin', chainAccount, accountIndex: 0 }

function observation(addressType, utxos, overrides = {}) {
  return {
    derived: { addressType, change: false, addressIndex: 0, ...overrides },
    utxos
  }
}

function state() {
  return {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      cursors: [
        { target: { addressType: 'p2wpkh', change: false }, complete: true },
        { target: { addressType: 'p2wpkh', change: true }, complete: true },
        { target: { addressType: 'p2tr', change: false }, complete: true },
        { target: { addressType: 'p2tr', change: true }, complete: true }
      ]
    },
    observations: [
      observation('p2wpkh', [
        {
          transactionId: 'a'.repeat(64),
          outputIndex: 0,
          valueRaw: '1000',
          status: { confirmed: true }
        },
        {
          transactionId: 'b'.repeat(64),
          outputIndex: 1,
          valueRaw: '200',
          status: { confirmed: false }
        }
      ]),
      observation(
        'p2wpkh',
        [
          {
            transactionId: 'd'.repeat(64),
            outputIndex: 0,
            valueRaw: '804',
            status: { confirmed: true }
          }
        ],
        { addressIndex: 3 }
      ),
      observation('p2tr', [
        {
          transactionId: 'c'.repeat(64),
          outputIndex: 0,
          valueRaw: '9000',
          status: { confirmed: true }
        }
      ])
    ],
    updatedAt: 2_000
  }
}

function harness(options = {}) {
  const stored = options.state ?? state()
  const activeChainAccount = options.chainAccount ?? chainAccount
  const storageRepository = {
    getActivePointer: async () => ({
      generationId: context.generationId,
      sourceFingerprint: 'source'
    }),
    getSnapshot: async () => ({
      manifest: {
        status: 'verified',
        generationId: context.generationId,
        sourceFingerprint: 'source',
        activeAccount: {
          keyDomainId: chainAccount.scope.keyDomainId,
          accountId: chainAccount.scope.accountId
        }
      },
      keyDomains: [
        {
          ...keyDomain,
          source: options.keyDomainSource ?? keyDomain.source
        }
      ],
      accounts: [
        {
          id: chainAccount.scope.accountId,
          keyDomainId: chainAccount.scope.keyDomainId,
          accountIndex: 0
        }
      ],
      chainAccounts: [activeChainAccount]
    })
  }
  const discovery = {
    readCachedActive: async () => (options.emptyState ? null : stored),
    scanActive: async scanOptions => {
      options.onScan?.(scanOptions)
      if (options.refreshError) {
        throw new BitcoinDiscoveryError('rpc-failure', {}, 'network unavailable')
      }
      return stored
    }
  }
  const inputReservations = {
    list: async () => [
      {
        state: options.reservationState ?? 'reserved',
        outpoints: [
          {
            transactionId: options.reservationOutpointTransactionId ?? 'a'.repeat(64),
            outputIndex: 0
          }
        ]
      }
    ]
  }
  return new BitcoinPortfolioCoordinator({
    storageRepository,
    discovery,
    inputReservations,
    chainId,
    chains,
    assets,
    getAddressType: async () => options.addressType ?? 'p2wpkh',
    onRefreshError: options.onRefreshError
  })
}

test('scopes the portfolio balance to the active Bitcoin address', async () => {
  const portfolio = harness()
  await expect(portfolio.readCachedActiveSource()).resolves.toMatchObject({
    generationId: context.generationId,
    source: {
      status: 'ready',
      balances: [
        {
          assetId: `${chainId}/slip44:0`,
          totalRaw: '1200',
          spendableRaw: '1000',
          availableRaw: '0',
          pendingRaw: '200',
          updatedAt: 2_000
        }
      ]
    }
  })
  await expect(portfolio.refreshActiveSource()).resolves.toMatchObject({
    source: { status: 'ready', balances: [{ totalRaw: '1200' }] }
  })

  await expect(harness({ addressType: 'p2tr' }).readCachedActiveSource()).resolves.toMatchObject({
    source: {
      status: 'ready',
      balances: [{ totalRaw: '9000', spendableRaw: '9000', availableRaw: '9000', pendingRaw: '0' }]
    }
  })
})

test('aggregates Ledger receive and change balances while retaining software active-address scope', async () => {
  const root = "m/84'/0'/5'"
  const ledgerChainAccount = {
    ...chainAccount,
    derivation: { scheme: 'bip84', path: `${root}/0/0` }
  }
  const ledgerState = {
    ...state(),
    chainAccount: ledgerChainAccount,
    observations: state()
      .observations.map(observation =>
        observation.derived.addressType === 'p2wpkh'
          ? {
              ...observation,
              derived: {
                ...observation.derived,
                chainId,
                derivationPath: `${root}/0/${observation.derived.addressIndex}`
              }
            }
          : observation
      )
      .concat([
        {
          derived: {
            addressType: 'p2wpkh',
            chainId,
            change: true,
            addressIndex: 0,
            derivationPath: `${root}/1/0`
          },
          utxos: [
            {
              transactionId: 'e'.repeat(64),
              outputIndex: 0,
              valueRaw: '300',
              status: { confirmed: true }
            }
          ]
        }
      ])
  }
  const ledger = harness({
    chainAccount: ledgerChainAccount,
    state: ledgerState,
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'ledger',
      firmwareProfile: 'multi-app',
      capabilities: ['bitcoin']
    }
  })
  await expect(ledger.readCachedActiveSource()).resolves.toMatchObject({
    source: {
      balances: [{ totalRaw: '2304', spendableRaw: '2104', availableRaw: '1104' }]
    }
  })
})

test('forces reconciliation when a committed transaction input remains in discovery cache', async () => {
  const scans = []
  const portfolio = harness({
    reservationState: 'committed',
    onScan: options => scans.push(options)
  })

  await expect(portfolio.refreshActiveSource()).resolves.toMatchObject({
    source: { status: 'ready' }
  })
  expect(scans).toEqual([{ forceRefresh: true, addressType: 'p2wpkh' }])
})

test('keeps normal refresh pacing after a committed input leaves discovery cache', async () => {
  const scans = []
  const portfolio = harness({
    reservationState: 'committed',
    reservationOutpointTransactionId: 'd'.repeat(64),
    onScan: options => scans.push(options)
  })

  await portfolio.refreshActiveSource()
  expect(scans).toEqual([{ forceRefresh: false, addressType: 'p2wpkh' }])
})

test('projects the trusted BTC asset while the first discovery scan is still loading', async () => {
  await expect(harness({ emptyState: true }).readCachedActiveSource()).resolves.toMatchObject({
    source: {
      status: 'loading',
      balances: [
        {
          assetId: `${chainId}/slip44:0`,
          totalRaw: '0',
          spendableRaw: '0',
          availableRaw: '0',
          pendingRaw: '0',
          updatedAt: 0
        }
      ]
    }
  })
})

test('retains cached Bitcoin balances as stale when discovery refresh fails', async () => {
  const failures = []
  await expect(
    harness({
      refreshError: true,
      onRefreshError: (error, activeContext) => failures.push({ error, activeContext })
    }).refreshActiveSource()
  ).resolves.toMatchObject({
    source: {
      status: 'error',
      errorCode: 'network-unavailable',
      balances: [{ totalRaw: '1200' }]
    }
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({
    error: { name: 'BitcoinDiscoveryError' },
    activeContext: {
      chainAccount: {
        scope: {
          keyDomainId: chainAccount.scope.keyDomainId,
          accountId: chainAccount.scope.accountId
        }
      }
    }
  })
})

test('does not read Bitcoin Portfolio state when the Keystone profile lacks Bitcoin', async () => {
  const portfolio = harness({
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'keystone',
      firmwareProfile: 'cypherpunk',
      capabilities: ['zcash']
    }
  })
  await expect(portfolio.readCachedActiveSource()).resolves.toBeNull()
  await expect(portfolio.refreshActiveSource()).resolves.toBeNull()
})

test('reads public Bitcoin Portfolio state for a Bitcoin-capable Keystone Wallet', async () => {
  const portfolio = harness({
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'keystone',
      firmwareProfile: 'cypherpunk',
      capabilities: ['zcash', 'bitcoin']
    }
  })
  await expect(portfolio.readCachedActiveSource()).resolves.toMatchObject({
    source: { status: 'ready', balances: [{ totalRaw: '1200' }] }
  })
  await expect(portfolio.refreshActiveSource()).resolves.toMatchObject({
    source: { status: 'ready', balances: [{ totalRaw: '1200' }] }
  })
})

test('reports a bounded stage without exposing discovery repository details', async () => {
  const failure = new Error('sensitive discovery repository detail')
  const repositoryFailure = new BitcoinDiscoveryReadError('state', failure)
  const portfolio = new BitcoinPortfolioCoordinator({
    storageRepository: {
      getActivePointer: async () => ({
        generationId: context.generationId,
        sourceFingerprint: 'source'
      }),
      getSnapshot: async () => ({
        manifest: {
          status: 'verified',
          generationId: context.generationId,
          sourceFingerprint: 'source',
          activeAccount: {
            keyDomainId: chainAccount.scope.keyDomainId,
            accountId: chainAccount.scope.accountId
          }
        },
        keyDomains: [keyDomain],
        accounts: [
          {
            id: chainAccount.scope.accountId,
            keyDomainId: chainAccount.scope.keyDomainId,
            accountIndex: 0
          }
        ],
        chainAccounts: [chainAccount]
      })
    },
    discovery: {
      readCachedActive: async () => {
        throw repositoryFailure
      },
      scanActive: async () => null
    },
    inputReservations: { list: async () => [] },
    chainId,
    chains,
    assets
  })

  const error = await portfolio.readCachedActiveSource().then(
    () => null,
    reason => reason
  )
  expect(error).toBeInstanceOf(BitcoinPortfolioCoordinatorError)
  expect(error).toMatchObject({
    name: 'BitcoinPortfolioCoordinatorError',
    message: 'Bitcoin Portfolio discovery-cache operation failed',
    stage: 'discovery-cache',
    cause: repositoryFailure
  })
  expect(error.cause).toMatchObject({
    message: 'Bitcoin discovery state read failed',
    stage: 'state',
    cause: failure
  })
})
