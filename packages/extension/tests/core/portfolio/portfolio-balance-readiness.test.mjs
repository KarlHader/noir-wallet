import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPortfolioReadModel,
  parsePortfolioReadModel
} from '../../../src/core/portfolio/index.ts'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  createInitialProductChainRegistry,
  getBundledEvmAssetDefinitions,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId
} from '../../../src/core/chains/registry/index.ts'
import { readZcashPortfolioSource } from '../../../src/infrastructure/chains/zcash/zcash-balance-reader.ts'
import { EvmPortfolioCoordinator } from '../../../src/infrastructure/chains/evm/evm-portfolio-coordinator.ts'
import { getPortfolioChainBalanceStatus } from '../../../src/popup/services/portfolio-presentation.ts'

const chainId = getZcashChainId('mainnet')
const chains = createInitialProductChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('mainnet'))
const scope = { keyDomainId: 'wallet:balance-loading', accountId: 'account:balance-loading' }
const chainAccount = {
  id: 'chain-account:balance-loading',
  scope: { ...scope, chainId },
  derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
  identity: { kind: 'account-identifier', value: 'u1example' },
  createdAt: 1000
}

function model({ balance = null, status = 'loading', errorCode, updatedAt = 0 } = {}) {
  const source = readZcashPortfolioSource({
    chainId,
    chainAccount,
    chains,
    assets,
    balance,
    status,
    updatedAt,
    ...(errorCode ? { errorCode } : {})
  })
  const result = buildPortfolioReadModel(scope, [source], chains, assets)
  return parsePortfolioReadModel(JSON.parse(JSON.stringify(result)), chains, assets)
}

test('unknown ZEC balance remains loading across the cached read contract', () => {
  const result = model()
  assert.equal(result.status, 'loading')
  assert.equal(result.assets.length, 0)
  assert.equal(result.chains[0].chain.family, 'zcash')
  assert.equal(getPortfolioChainBalanceStatus(result.chains[0]), 'loading')
})

test('cached balance remains available while refreshing and errors do not erase it', () => {
  const balance = { total: '1.5', shielded: '1.25', transparent: '0.25' }
  const refreshing = model({ balance, updatedAt: 2000 })
  assert.equal(refreshing.assets[0].balance.totalRaw, '150000000')
  assert.equal(refreshing.assets[0].freshness, 'stale')
  assert.equal(getPortfolioChainBalanceStatus(refreshing.chains[0]), 'updating')
  const failed = model({
    balance,
    status: 'error',
    errorCode: 'network-unavailable',
    updatedAt: 2000
  })
  assert.equal(failed.assets[0].balance.totalRaw, '150000000')
  assert.equal(getPortfolioChainBalanceStatus(failed.chains[0]), 'unavailable')
  const unknownFailed = model({ status: 'error', errorCode: 'network-unavailable' })
  assert.equal(unknownFailed.assets.length, 0)
  assert.equal(getPortfolioChainBalanceStatus(unknownFailed.chains[0]), 'unavailable')
})

test('an observed zero balance is ready and remains distinct from an unknown balance', () => {
  const result = model({
    balance: { total: '0', shielded: '0', transparent: '0' },
    status: 'ready',
    updatedAt: 2000
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.assets[0].balance.totalRaw, '0')
  assert.equal(result.assets[0].freshness, 'fresh')
  assert.equal(getPortfolioChainBalanceStatus(result.chains[0]), 'ready')
})

test('imported EVM accounts refresh Main-only caches before exposing combined balances', async () => {
  const chainId = 'eip155:1'
  const chains = createEvmBitcoinChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
  const scope = { keyDomainId: 'wallet:imported-evm', accountId: 'account:imported-evm:0' }
  const mainAddress = `0x${'1'.repeat(40)}`
  const privateAddress = `0x${'3'.repeat(40)}`
  const chainAccount = {
    id: 'chain-account:imported-evm',
    scope: { ...scope, chainId },
    derivation: { scheme: 'imported', path: 'm' },
    identity: { kind: 'account-identifier', value: mainAddress },
    createdAt: 1
  }
  const pointer = {
    schemaVersion: 2,
    generationId: 'storage-v2:generation:imported-evm',
    sourceFingerprint: 'a'.repeat(64),
    committedAt: 1
  }
  const snapshot = {
    manifest: {
      schemaVersion: 2,
      generationId: pointer.generationId,
      status: 'verified',
      sourceFingerprint: pointer.sourceFingerprint,
      mainKeyDomainId: scope.keyDomainId,
      activeAccount: scope,
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 0 },
      createdAt: 1,
      verifiedAt: 1
    },
    keyDomains: [
      {
        id: scope.keyDomainId,
        credentialRef: 'credential-set:imported-evm',
        source: { kind: 'private-key', chainFamily: 'eip155' },
        displayName: 'Imported EVM',
        createdAt: 1
      }
    ],
    accounts: [
      { id: scope.accountId, keyDomainId: scope.keyDomainId, accountIndex: 0, createdAt: 1 }
    ],
    chainAccounts: [chainAccount],
    addresses: []
  }
  let cached = {
    generationId: pointer.generationId,
    cachedAt: 100,
    source: {
      chainAccount,
      status: 'ready',
      balances: assets.list(chainId).map(entry => ({
        assetId: entry.asset.id,
        totalRaw: '7',
        spendableRaw: '7',
        availableRaw: '7',
        pendingRaw: '0',
        updatedAt: 100
      }))
    }
  }
  const coordinator = new EvmPortfolioCoordinator({
    storageRepository: {
      getActivePointer: async () => pointer,
      getSnapshot: async () => snapshot
    },
    cacheRepository: {
      get: async () => cached,
      put: async record => {
        cached = record
      }
    },
    chainId,
    chains,
    assets,
    rpc: {
      assertExpectedChain: async () => {},
      getNativeBalance: async address => (address === mainAddress ? '10' : '4'),
      getErc20Balance: async (_token, address) => (address === mainAddress ? '20' : '6')
    },
    resolvePrivateExecutionAddress: async () => privateAddress,
    now: () => 200
  })

  const stale = await coordinator.readCachedActiveSource()
  assert.equal(stale.source.status, 'loading')
  assert.deepEqual(stale.source.balances, [])

  const refreshed = await coordinator.refreshActiveSource()
  assert.equal(refreshed.source.status, 'ready')
  assert.deepEqual(
    refreshed.source.balances.map(({ mainRaw, privateRaw, totalRaw }) => ({
      mainRaw,
      privateRaw,
      totalRaw
    })),
    [
      { mainRaw: '10', privateRaw: '4', totalRaw: '14' },
      { mainRaw: '20', privateRaw: '6', totalRaw: '26' }
    ]
  )
  assert.deepEqual(
    (await coordinator.readCachedActiveSource()).source.balances,
    refreshed.source.balances
  )
})
